import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  findLive2DCore,
  downloadLive2DCore,
  installLive2DCore,
  LIVE2D_CORE_FILE,
  LIVE2D_CORE_DOWNLOAD_URL,
  live2dCoreUrl,
} from "../electron/live2d-core";

const roots: string[] = [];
const coreSource =
  "var Live2DCubismCore = { Version: { csmGetVersion() { return 1; } } };";

async function folder() {
  await mkdir(resolve(".cache/tests"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/tests/live2d-core-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("可复用的 Live2D 运行库", () => {
  it("重复设置相同版本直接复用缓存，不替换可能正在加载的运行库文件", async () => {
    const root = await folder();
    const core = await downloadLive2DCore(
      root,
      async () => new Response(coreSource),
    );
    const source = join(root, "same-core.js");
    await writeFile(source, coreSource);
    const modified = new Date("2020-01-01T00:00:00Z");
    await utimes(core.file, modified, modified);
    expect(await installLive2DCore(root, source)).toEqual(core);
    expect((await stat(core.file)).mtimeMs).toBe(modified.getTime());
    await downloadLive2DCore(root, async () => new Response(coreSource));
    expect((await stat(core.file)).mtimeMs).toBe(modified.getTime());
  });

  it("旧运行库的本地导入和归档下载均校验固定摘要，不覆盖现代运行库", async () => {
    const root = await folder();
    const modern = await downloadLive2DCore(
      root,
      async () => new Response(coreSource),
    );
    const legacy =
      "/* Live2DModelWebGL Live2DMotion */ globalThis.untrusted = true;";
    const file = join(root, "legacy.js");
    await writeFile(file, legacy);
    await expect(installLive2DCore(root, file)).rejects.toThrow(
      "归档 SHA-256 校验",
    );
    await expect(
      downloadLive2DCore(root, async () => new Response(legacy), "legacy"),
    ).rejects.toThrow("归档摘要校验失败");
    expect(await findLive2DCore(root, "legacy")).toBeUndefined();
    expect(await findLive2DCore(root)).toEqual(modern);
  });
  it("拒绝仅伪造 Core 标记的本地脚本，也不从旧角色自动信任它", async () => {
    const root = await folder();
    const modelsRoot = join(root, "models");
    const oldModel = join(modelsRoot, randomUUID());
    const source = join(oldModel, LIVE2D_CORE_FILE);
    await mkdir(oldModel, { recursive: true });
    await writeFile(
      source,
      "/* Live2DCubismCore csmGetVersion */ globalThis.untrustedCore = true;",
    );
    await expect(installLive2DCore(modelsRoot, source)).rejects.toThrow("校验");
    expect(await findLive2DCore(modelsRoot)).toBeUndefined();
  });

  it("已有运行库被替换后不会继续报告就绪", async () => {
    const root = await folder();
    const modelsRoot = join(root, "models");
    const core = await downloadLive2DCore(
      modelsRoot,
      async () => new Response(coreSource),
    );
    await writeFile(
      core.file,
      `${coreSource}\nglobalThis.untrustedCore = true;`,
    );
    expect(await findLive2DCore(modelsRoot)).toBeUndefined();
  });

  it("只有模型没有 Core 时从官方地址下载，保存后可离线复用", async () => {
    const root = await folder();
    const modelsRoot = join(root, "models");
    const request = vi.fn(async () => new Response(coreSource));
    const core = await downloadLive2DCore(modelsRoot, request);
    expect(request).toHaveBeenCalledWith(
      LIVE2D_CORE_DOWNLOAD_URL,
      expect.objectContaining({ redirect: "error", credentials: "omit" }),
    );
    expect(await readFile(core.file, "utf8")).toBe(coreSource);
    expect(await findLive2DCore(modelsRoot)).toEqual(core);
  });

  it.each([
    [
      "网络中断",
      async () => {
        throw new Error("connection interrupted");
      },
    ],
    ["HTTP 失败", async () => new Response("unavailable", { status: 503 })],
    ["错误页面", async () => new Response("<html>download failed</html>")],
    [
      "超大文件声明",
      async () =>
        new Response("", { headers: { "content-length": "10485761" } }),
    ],
    ["超大文件流", async () => new Response(new Uint8Array(10485761))],
    [
      "文件流中断",
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("truncated download"));
            },
          }),
        ),
    ],
  ] as const)("%s 时提示重试并保留已经配置的运行库", async (_, request) => {
    const root = await folder();
    const modelsRoot = join(root, "models");
    const source = join(root, "core.js");
    await writeFile(source, coreSource);
    const installed = await downloadLive2DCore(
      modelsRoot,
      async () => new Response(coreSource),
    );
    await expect(downloadLive2DCore(modelsRoot, request)).rejects.toThrow(
      "检查网络或系统代理后重试",
    );
    expect(await findLive2DCore(modelsRoot)).toEqual(installed);
  });

  it("只从旧版角色中恢复已验证的 Core，移除旧角色后仍可使用", async () => {
    const root = await folder();
    const modelsRoot = join(root, "models");
    const oldModel = join(modelsRoot, randomUUID());
    await mkdir(oldModel, { recursive: true });
    await writeFile(join(oldModel, LIVE2D_CORE_FILE), coreSource);
    const downloaded = await downloadLive2DCore(
      modelsRoot,
      async () => new Response(coreSource),
    );
    await rm(downloaded.file);

    const core = await findLive2DCore(modelsRoot);
    expect(core).toBeDefined();
    await rm(oldModel, { recursive: true });
    expect(await readFile(core!.file, "utf8")).toBe(coreSource);
    expect(await findLive2DCore(modelsRoot)).toEqual(core);
  });

  it("更换 Core 后资源地址更新，无效文件不会覆盖已保存的运行库", async () => {
    const root = await folder();
    const modelsRoot = join(root, "models");
    const source = join(root, "core.js");
    await writeFile(source, coreSource);
    const first = await downloadLive2DCore(
      modelsRoot,
      async () => new Response(coreSource),
    );
    await writeFile(source, `${coreSource}\n// updated runtime`);
    await expect(installLive2DCore(modelsRoot, source)).rejects.toThrow("校验");
    expect(await findLive2DCore(modelsRoot)).toEqual(first);
    await downloadLive2DCore(
      modelsRoot,
      async () => new Response(`${coreSource}\n// updated runtime`),
    );
    const updated = await installLive2DCore(modelsRoot, source);
    expect(live2dCoreUrl(updated)).not.toBe(live2dCoreUrl(first));

    for (const invalid of [
      "<html>download failed</html>",
      "var Live2DCubismCore = { csmGetVersion: ; }",
    ]) {
      await writeFile(source, invalid);
      await expect(installLive2DCore(modelsRoot, source)).rejects.toThrow(
        "无法识别 Cubism Core",
      );
      expect(await findLive2DCore(modelsRoot)).toEqual(updated);
    }
  });

  it("首次启动没有运行库，检查状态不会创建假的就绪状态", async () => {
    const root = await folder();
    expect(await findLive2DCore(join(root, "models"))).toBeUndefined();
  });
});
