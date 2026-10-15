import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { importModelFile, safeAssetPath } from "../electron/models";

const folders: string[] = [];
async function folder() {
  await mkdir(resolve(".cache/tests"), { recursive: true });
  const path = await mkdtemp(resolve(".cache/tests/model-"));
  folders.push(path);
  await mkdir(join(path, "source"));
  await mkdir(join(path, "models"));
  return path;
}
afterEach(async () => {
  for (const path of folders.splice(0))
    await rm(path, { recursive: true, force: true });
});

describe("本地模型导入", () => {
  it("支持 PNGTuber 双图，复制资源并生成局部资源地址", async () => {
    const root = await folder();
    await writeFile(join(root, "source/idle.png"), "idle");
    await writeFile(join(root, "source/talking.png"), "talking");
    await writeFile(
      join(root, "source/avatar.json"),
      JSON.stringify({
        name: "测试角色",
        idle: "idle.png",
        talking: "talking.png",
      }),
    );
    const model = await importModelFile(
      join(root, "source/avatar.json"),
      join(root, "models"),
    );
    expect(model.kind).toBe("pngtuber");
    expect(model.name).toBe("测试角色");
    expect(model.assetUrl).toBe(`mai-asset://model/${model.id}/idle.png`);
    expect(
      await readFile(join(root, "models", model.id, "talking.png"), "utf8"),
    ).toBe("talking");
  });

  it("Live2D 导入包含贴图、动作、表情与用户提供的 Core", async () => {
    const root = await folder(),
      source = join(root, "source");
    for (const file of [
      "model.moc3",
      "texture.png",
      "idle.motion3.json",
      "smile.exp3.json",
      "core.js",
    ])
      await writeFile(join(source, file), "{}");
    await writeFile(
      join(source, "cat.model3.json"),
      JSON.stringify({
        FileReferences: {
          Moc: "model.moc3",
          Textures: ["texture.png"],
          Motions: { Idle: [{ File: "idle.motion3.json", FadeInTime: 0.5 }] },
          Expressions: [{ Name: "smile", File: "smile.exp3.json" }],
        },
      }),
    );
    const model = await importModelFile(
      join(source, "cat.model3.json"),
      join(root, "models"),
      join(source, "core.js"),
    );
    expect(model.kind).toBe("live2d");
    expect(
      await readFile(join(root, "models", model.id, "texture.png"), "utf8"),
    ).toBe("{}");
    expect(model.coreUrl).toContain("live2dcubismcore.min.js");
  });

  it("拒绝越界、绝对路径及远程模型引用", async () => {
    const root = await folder();
    for (const path of [
      "../outside.png",
      "/private/file",
      "https://remote/model.png",
      "C:\\outside\\file",
    ])
      expect(() => safeAssetPath(join(root, "source"), path)).toThrow();
    await writeFile(
      join(root, "source/bad.json"),
      JSON.stringify({ idle: "../outside.png", talking: "talking.png" }),
    );
    await expect(
      importModelFile(join(root, "source/bad.json"), join(root, "models")),
    ).rejects.toThrow();
  });
});
