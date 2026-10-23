import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Script } from "node:vm";
import { LIVE2D_RUNTIME_FILES, type Live2DRuntime } from "../shared/live2d";

export const LIVE2D_CORE_FILE = "live2dcubismcore.min.js";
export const LIVE2D_CORE_DOWNLOAD_URL =
  "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js";
// Cubism 2 已停止官方分发；使用 N.E.K.O 的固定归档，并强制校验字节摘要。
export const LIVE2D_LEGACY_DOWNLOAD_URL =
  "https://raw.githubusercontent.com/Project-N-E-K-O/N.E.K.O/c65adc2bb467c812c5fd948c8031aa96d48c0e14/static/libs/live2d.min.js";
const LEGACY_REVISION =
  "96cd98047edc7ff319c35c344ede4dc62a286d3c7e1173e5365e7a7ea6bad69e";
const MAX_CORE_BYTES = 10 * 1024 * 1024;
const OFFICIAL_DIGEST_FILE = "official.sha256";
// 从上面的官方 HTTPS 地址核对的 Core 5.1；仅保存摘要，不分发运行库。
const OFFICIAL_REVISIONS = new Set([
  "25ae938cb4fe282ce189b357bcc97e603d1e1f7ec78bf04150d401c23cdc792f",
]);

export interface Live2DCore {
  file: string;
  revision: string;
  runtime: Live2DRuntime;
}

function coreDirectory(modelsRoot: string) {
  return join(modelsRoot, ".live2d-core");
}

function validateCore(bytes: Buffer, expected?: Live2DRuntime) {
  if (bytes.length > MAX_CORE_BYTES)
    throw new Error("Cubism Core 文件超过 10 MB 限制");
  const source = bytes.toString("utf8");
  const runtime =
    expected ?? (source.includes("Live2DCubismCore") ? "modern" : "legacy");
  try {
    if (
      runtime === "modern"
        ? !source.includes("Live2DCubismCore") ||
          !source.includes("csmGetVersion")
        : !source.includes("Live2DModelWebGL") ||
          !source.includes("Live2DMotion")
    )
      throw new Error("unrecognized core");
    // 语法检查不能建立信任；本地文件还必须通过官方摘要校验。
    new Script(source);
  } catch {
    throw new Error(
      "无法识别 Cubism Core，请选择 live2dcubismcore.min.js 或旧版 live2d.min.js",
    );
  }
  return {
    bytes,
    runtime,
    revision: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function readCore(file: string, runtime?: Live2DRuntime) {
  const info = await lstat(file);
  if (!info.isFile()) throw new Error("Cubism Core 必须是本地 JavaScript 文件");
  if (info.size > MAX_CORE_BYTES)
    throw new Error("Cubism Core 文件超过 10 MB 限制");
  return validateCore(await readFile(file), runtime);
}

async function readTrustedCore(
  modelsRoot: string,
  file: string,
  runtime?: Live2DRuntime,
) {
  const core = await readCore(file, runtime);
  if (core.runtime === "legacy") {
    if (core.revision === LEGACY_REVISION) return core;
    throw new Error("Cubism 2 运行库未通过归档 SHA-256 校验，请下载兼容运行库");
  }
  if (OFFICIAL_REVISIONS.has(core.revision)) return core;
  // 只记录应用从固定官方地址直接下载的摘要；模型导入不能建立新信任。
  const receipt = join(coreDirectory(modelsRoot), OFFICIAL_DIGEST_FILE);
  try {
    const info = await lstat(receipt);
    if (
      info.isFile() &&
      info.size === 64 &&
      (await readFile(receipt, "utf8")) === core.revision
    )
      return core;
  } catch {
    // 旧安装和没有下载过官方运行库的目录没有摘要记录。
  }
  throw new Error(
    "Cubism Core 未通过官方 SHA-256 校验，请下载官方运行库后重试",
  );
}

async function saveCore(
  modelsRoot: string,
  { bytes, revision, runtime }: ReturnType<typeof validateCore>,
  fromOfficial = false,
): Promise<Live2DCore> {
  const directory = coreDirectory(modelsRoot);
  const file = join(directory, LIVE2D_RUNTIME_FILES[runtime]);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `${randomUUID()}.tmp`);
  try {
    let unchanged = false;
    try {
      unchanged = (await readCore(file, runtime)).revision === revision;
    } catch {
      // 缺失或损坏的缓存需要替换。
    }
    // Windows 的协议读取可能仍持有文件句柄；相同内容无需重复替换。
    if (!unchanged) {
      await writeFile(temporary, bytes);
      await rename(temporary, file);
    }
    if (fromOfficial && runtime === "modern") {
      await writeFile(temporary, revision, "utf8");
      await rename(temporary, join(directory, OFFICIAL_DIGEST_FILE));
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return { file, revision, runtime };
}

export async function installLive2DCore(
  modelsRoot: string,
  source: string,
  runtime?: Live2DRuntime,
): Promise<Live2DCore> {
  return saveCore(
    modelsRoot,
    await readTrustedCore(modelsRoot, source, runtime),
  );
}

export async function downloadLive2DCore(
  modelsRoot: string,
  request: (url: string, options: RequestInit) => Promise<Response> = fetch,
  runtime: Live2DRuntime = "modern",
): Promise<Live2DCore> {
  try {
    const response = await request(
      runtime === "legacy"
        ? LIVE2D_LEGACY_DOWNLOAD_URL
        : LIVE2D_CORE_DOWNLOAD_URL,
      {
        signal: AbortSignal.timeout(30000),
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    if (Number(response.headers.get("content-length")) > MAX_CORE_BYTES) {
      await response.body?.cancel();
      throw new Error("Cubism Core 文件超过 10 MB 限制");
    }
    if (!response.body) throw new Error("官方服务器返回了空文件");
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_CORE_BYTES)
          throw new Error("Cubism Core 文件超过 10 MB 限制");
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const core = validateCore(Buffer.concat(chunks), runtime);
    if (runtime === "legacy" && core.revision !== LEGACY_REVISION)
      throw new Error("Cubism 2 运行库归档摘要校验失败");
    return await saveCore(modelsRoot, core, true);
  } catch (error) {
    throw new Error(
      `${runtime === "modern" ? "官方 Live2D" : "Cubism 2 兼容"}运行库下载失败：${error instanceof Error ? error.message : String(error)}。请检查网络或系统代理后重试，也可从本地导入运行库。`,
    );
  }
}

export async function findLive2DCore(
  modelsRoot: string,
  runtime: Live2DRuntime = "modern",
): Promise<Live2DCore | undefined> {
  const file = join(coreDirectory(modelsRoot), LIVE2D_RUNTIME_FILES[runtime]);
  try {
    return {
      file,
      revision: (await readTrustedCore(modelsRoot, file, runtime)).revision,
      runtime,
    };
  } catch {
    // 缺失或损坏时仍可重新设置，也可从旧版导入的角色中恢复。
  }
  let entries;
  try {
    entries = await readdir(modelsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/i.test(entry.name)) continue;
    try {
      return await installLive2DCore(
        modelsRoot,
        join(modelsRoot, entry.name, LIVE2D_RUNTIME_FILES[runtime]),
        runtime,
      );
    } catch {
      // 一个旧角色缺少或带有无效的 Core 时继续检查其他角色。
    }
  }
}

export function live2dCoreUrl(core: Live2DCore) {
  return `mai-asset://runtime/${LIVE2D_RUNTIME_FILES[core.runtime]}?v=${core.revision}`;
}
