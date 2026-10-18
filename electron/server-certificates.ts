import { X509Certificate } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { serverUrlSchema } from "../shared/schemas";
import type { ServerCertificateInfo } from "../shared/types";

const MAX_IMPORT_SIZE = 256 * 1024;
const MAX_STORE_SIZE = 4 * 1024 * 1024;
const MAX_CERTIFICATES = 16;
const CERTIFICATE_PATTERN =
  /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/;

const storedSchema = z
  .object({
    version: z.literal(1),
    records: z
      .array(
        z
          .object({
            host: z.string().min(1).max(253),
            ca: z.array(z.string().min(1).max(MAX_IMPORT_SIZE)).min(1).max(16),
            importedAt: z.number().int().positive(),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();

type StoredRecord = z.infer<typeof storedSchema>["records"][number];
export type CertificateAuthorityProvider = (url: URL) => string[] | undefined;

function normalizedPem(certificate: X509Certificate): string {
  const body = certificate.raw
    .toString("base64")
    .match(/.{1,64}/g)
    ?.join("\n");
  if (!body) throw new Error("证书内容为空");
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}

function parseCertificates(content: Buffer): string[] {
  const text = content.toString("utf8");
  if (PRIVATE_KEY_PATTERN.test(text))
    throw new Error("证书文件不能包含私钥，请只导入 CA 或服务器证书");
  const blocks = text.match(CERTIFICATE_PATTERN) ?? [];
  let certificates: X509Certificate[];
  try {
    certificates = blocks.length
      ? blocks.map((block) => new X509Certificate(block))
      : [new X509Certificate(content)];
  } catch {
    throw new Error("无法解析证书，请选择 PEM、CRT 或 DER 格式的 X.509 证书");
  }
  if (certificates.length > MAX_CERTIFICATES)
    throw new Error(`证书链最多包含 ${MAX_CERTIFICATES} 张证书`);
  const unique = new Map<string, string>();
  for (const certificate of certificates)
    unique.set(certificate.fingerprint256, normalizedPem(certificate));
  return [...unique.values()];
}

function hostFor(serverUrl: string): string {
  const parsed = new URL(serverUrlSchema.parse(serverUrl));
  if (parsed.protocol !== "wss:")
    throw new Error("自定义证书仅用于 wss:// 服务器地址");
  return parsed.hostname.toLowerCase();
}

function validateStored(record: StoredRecord): StoredRecord {
  const host = hostFor(`wss://${record.host}/desktop`);
  const ca = record.ca.map((pem) => normalizedPem(new X509Certificate(pem)));
  return { host, ca, importedAt: record.importedAt };
}

function info(record: StoredRecord): ServerCertificateInfo {
  const certificate = new X509Certificate(record.ca[0]);
  return {
    host: record.host,
    subject: certificate.subject,
    issuer: certificate.issuer,
    fingerprint256: certificate.fingerprint256,
    validFrom: Date.parse(certificate.validFrom),
    validTo: Date.parse(certificate.validTo),
    certificateCount: record.ca.length,
    importedAt: record.importedAt,
  };
}

export function isCertificateValidationError(error: unknown): boolean {
  const code =
    typeof error === "object" && error && "code" in error
      ? String(error.code)
      : "";
  return [
    "CERT_HAS_EXPIRED",
    "CERT_NOT_YET_VALID",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_GET_ISSUER_CERT",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  ].includes(code);
}

/** 按服务器主机保存用户明确导入的 CA，并只向对应 WSS 连接提供信任链。 */
export class ServerCertificateStore {
  private records = new Map<string, StoredRecord>();
  private readonly file: string;

  constructor(private readonly directory: string) {
    this.file = join(directory, "server-certificates.json");
  }

  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    try {
      if ((await stat(this.file)).size > MAX_STORE_SIZE)
        throw new Error("自定义证书存储文件过大");
      const stored = storedSchema.parse(
        JSON.parse(await readFile(this.file, "utf8")),
      );
      const records = new Map<string, StoredRecord>();
      for (const raw of stored.records) {
        const record = validateStored(raw);
        if (records.has(record.host))
          throw new Error(`主机 ${record.host} 存在重复证书记录`);
        records.set(record.host, record);
      }
      this.records = records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`无法读取自定义服务器证书：${String(error)}`);
    }
  }

  list(): ServerCertificateInfo[] {
    return [...this.records.values()]
      .map(info)
      .sort((left, right) => right.importedAt - left.importedAt);
  }

  authority(url: URL): string[] | undefined {
    if (url.protocol !== "wss:") return undefined;
    const record = this.records.get(url.hostname.toLowerCase());
    return record ? [...record.ca] : undefined;
  }

  async importFile(
    serverUrl: string,
    file: string,
  ): Promise<ServerCertificateInfo> {
    if ((await stat(file)).size > MAX_IMPORT_SIZE)
      throw new Error("证书文件过大，最大支持 256 KiB");
    return this.install(serverUrl, await readFile(file));
  }

  async install(
    serverUrl: string,
    content: Buffer,
  ): Promise<ServerCertificateInfo> {
    if (content.byteLength > MAX_IMPORT_SIZE)
      throw new Error("证书文件过大，最大支持 256 KiB");
    const host = hostFor(serverUrl);
    const record: StoredRecord = {
      host,
      ca: parseCertificates(content),
      importedAt: Date.now(),
    };
    const records = new Map(this.records);
    records.set(host, record);
    await this.persist(records);
    this.records = records;
    return info(record);
  }

  async remove(serverUrl: string): Promise<boolean> {
    const host = hostFor(serverUrl);
    if (!this.records.has(host)) return false;
    const records = new Map(this.records);
    records.delete(host);
    await this.persist(records);
    this.records = records;
    return true;
  }

  private async persist(records: Map<string, StoredRecord>): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const target = this.file;
    await writeFile(
      `${target}.tmp`,
      JSON.stringify({ version: 1, records: [...records.values()] }, null, 2),
      "utf8",
    );
    await rename(`${target}.tmp`, target);
  }
}
