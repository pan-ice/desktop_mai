import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { developmentRendererUrl } from "../electron/renderer-source";

const buildStateUrl = new URL("../scripts/build-state.mjs", import.meta.url)
  .href;
const { sourceDigest, productionBuildCurrent, recordProductionBuild } =
  (await import(buildStateUrl)) as {
    sourceDigest(root: string): Promise<string>;
    productionBuildCurrent(root: string): Promise<boolean>;
    recordProductionBuild(root: string, before?: string): Promise<void>;
  };

describe("启动页面来源", () => {
  it("正式包始终使用自身页面，忽略继承的开发地址", () => {
    for (const url of [
      undefined,
      "http://127.0.0.1:5173",
      "https://example.invalid/",
      "not a URL",
    ])
      expect(developmentRendererUrl(true, url)).toBeUndefined();
  });

  it("源码的正式启动没有开发地址时使用本地页面", () => {
    expect(developmentRendererUrl(false)).toBeUndefined();
    expect(developmentRendererUrl(false, "")).toBeUndefined();
  });

  it.each([
    ["http://127.0.0.1:5174/", "http://127.0.0.1:5174"],
    ["http://localhost:5255", "http://localhost:5255"],
    ["https://[::1]:5400/", "https://[::1]:5400"],
  ])("开发启动使用实际本机服务 %s", (url, expected) => {
    expect(developmentRendererUrl(false, url)).toBe(expected);
  });

  it.each([
    "not a URL",
    "https://example.invalid/",
    "http://127.0.0.1.example.invalid/",
    "http://localhost@evil.invalid/",
    "http://user:password@127.0.0.1:5173/",
    "http://127.0.0.1:5173/application/",
    "http://127.0.0.1:5173/?view=other",
    "http://127.0.0.1:5173/#fragment",
    "file:///tmp/renderer.html",
    "javascript:alert(1)",
  ])("开发启动拒绝非本机页面入口 %s", (url) => {
    expect(() => developmentRendererUrl(false, url)).toThrow(/开发页面/);
  });
});

describe("正式构建完整性", () => {
  const base = resolve(".cache/startup-unit");
  let root = "";
  const put = async (path: string, content: string) => {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  };

  beforeEach(async () => {
    await mkdir(base, { recursive: true });
    root = await mkdtemp(join(base, "run-"));
    for (const [path, content] of Object.entries({
      "electron/main.ts": 'export const title = "Mai";',
      "src/main.tsx": 'export const greeting = "你好";',
      "resources/icon.png": "test-icon",
      "package.json": '{"name":"startup-fixture","type":"module"}',
      "index.html": '<script src="/src/main.tsx"></script>',
      "out/main/index.js": 'console.log("main");',
      "out/preload/index.cjs": 'console.log("preload");',
      "out/renderer/index.html": '<script src="./assets/index.js"></script>',
      "out/renderer/assets/index.js": 'console.log("renderer");',
    }))
      await put(path, content);
  });

  afterEach(async () => {
    if (!root) return;
    expect(resolve(root).startsWith(`${base}${sep}`)).toBe(true);
    await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("未经确认的产物不能直接启动，完整构建登记后可复用", async () => {
    expect(await productionBuildCurrent(root)).toBe(false);
    await recordProductionBuild(root, await sourceDigest(root));
    expect(await productionBuildCurrent(root)).toBe(true);
    await put(".cache/test-run/state.json", "{}");
    expect(await productionBuildCurrent(root)).toBe(true);
  });

  it.each(["electron/main.ts", "src/main.tsx", "resources/icon.png"])(
    "修改 %s 后须重建",
    async (path) => {
      await recordProductionBuild(root);
      await put(path, "changed source");
      expect(await productionBuildCurrent(root)).toBe(false);
    },
  );

  it("开发构建覆盖主进程产物后须重建正式页面", async () => {
    await recordProductionBuild(root);
    await put("out/main/index.js", 'console.log("development build");');
    expect(await productionBuildCurrent(root)).toBe(false);
  });

  it.each([
    "out/main/index.js",
    "out/preload/index.cjs",
    "out/renderer/index.html",
    "out/renderer/assets/index.js",
  ])("缺少 %s 时须重建", async (path) => {
    await recordProductionBuild(root);
    await rm(join(root, path));
    expect(await productionBuildCurrent(root)).toBe(false);
  });

  it("缺少 renderer 时不能登记为完整正式构建", async () => {
    await rm(join(root, "out/renderer/index.html"));
    await expect(recordProductionBuild(root)).rejects.toThrow();
    expect(await productionBuildCurrent(root)).toBe(false);
  });

  it("缺失或损坏的构建清单会触发重建", async () => {
    await recordProductionBuild(root);
    await rm(join(root, "out/.production-build.json"));
    expect(await productionBuildCurrent(root)).toBe(false);
    await put("out/.production-build.json", "invalid json");
    expect(await productionBuildCurrent(root)).toBe(false);
  });

  it("构建期间变化的源码不能被登记为已构建", async () => {
    const before = await sourceDigest(root);
    await put("src/main.tsx", 'export const greeting = "new source";');
    await expect(recordProductionBuild(root, before)).rejects.toThrow(
      "构建期间源码发生变化",
    );
    expect(await productionBuildCurrent(root)).toBe(false);
  });
});
