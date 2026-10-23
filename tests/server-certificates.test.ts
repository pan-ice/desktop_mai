import { afterEach, describe, expect, it } from "vitest";
import { X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ServerCertificateStore } from "../electron/server-certificates";
import { TEST_CERTIFICATE, TEST_PRIVATE_KEY } from "./fixtures/self-signed-tls";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function directory() {
  const base = resolve(".cache/tests");
  await mkdir(base, { recursive: true });
  const value = await mkdtemp(join(base, "server-certificate-"));
  directories.push(value);
  return value;
}

describe("自定义 WSS 证书存储", () => {
  it("主机达到上限时拒绝新增，允许替换，重启后原证书全部保留", async () => {
    const root = await directory();
    const store = new ServerCertificateStore(root);
    const certificate = Buffer.from(TEST_CERTIFICATE);
    for (let index = 0; index < 32; index++)
      await store.install(`wss://host-${index}.example/desktop`, certificate);
    await expect(
      store.install("wss://overflow.example/desktop", certificate),
    ).rejects.toThrow("32");
    await store.install("wss://host-0.example/desktop", certificate);
    const restored = new ServerCertificateStore(root);
    await restored.load();
    expect(restored.list()).toHaveLength(32);
    expect(restored.list()).toEqual(store.list());
  });

  it("按主机保存证书链，允许同主机不同路径与端口，重启后仍可读取", async () => {
    const root = await directory();
    const store = new ServerCertificateStore(root);
    const imported = await store.install(
      "wss://127.0.0.1:18766/desktop",
      Buffer.from(TEST_CERTIFICATE),
    );
    expect(imported).toMatchObject({
      host: "127.0.0.1",
      certificateCount: 1,
    });
    expect(imported.validTo).toBeGreaterThan(Date.now());
    expect(
      store.authority(new URL("wss://127.0.0.1:443/account")),
    ).toHaveLength(1);
    expect(store.authority(new URL("wss://localhost/desktop"))).toBeUndefined();
    expect(store.authority(new URL("ws://127.0.0.1/desktop"))).toBeUndefined();

    const restored = new ServerCertificateStore(root);
    await restored.load();
    expect(restored.list()).toEqual([imported]);
    expect(
      await readFile(join(root, "server-certificates.json"), "utf8"),
    ).not.toContain("PRIVATE KEY");
    expect(await restored.remove("wss://127.0.0.1/desktop")).toBe(true);
    expect(restored.list()).toEqual([]);
  });

  it("支持 DER，拒绝明文 WS、私钥及无效证书", async () => {
    const store = new ServerCertificateStore(await directory());
    await expect(
      store.install(
        "wss://127.0.0.1/desktop",
        new X509Certificate(TEST_CERTIFICATE).raw,
      ),
    ).resolves.toMatchObject({ host: "127.0.0.1" });
    await expect(
      store.install("ws://127.0.0.1/desktop", Buffer.from(TEST_CERTIFICATE)),
    ).rejects.toThrow("仅用于 wss://");
    await expect(
      store.install(
        "wss://127.0.0.1/desktop",
        Buffer.from(`${TEST_CERTIFICATE}\n${TEST_PRIVATE_KEY}`),
      ),
    ).rejects.toThrow("不能包含私钥");
    await expect(
      store.install("wss://127.0.0.1/desktop", Buffer.from("not a cert")),
    ).rejects.toThrow("无法解析证书");
  });
});
