import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  importModelFile,
  safeAssetPath,
  withModelUrls,
  resolveModelEntry,
} from "../electron/models";
import { downloadLive2DCore } from "../electron/live2d-core";

const folders: string[] = [];
const coreSource =
  "var Live2DCubismCore = { Version: { csmGetVersion() { return 0; } } };";
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
  it("历史模型中的脚本路径不能作为渲染器运行库地址", () => {
    const model = withModelUrls({
      id: "old-model",
      kind: "live2d",
      name: "旧角色",
      entry: "model.model3.json",
      coreEntry: "live2dcubismcore.min.js",
      coreUrl: "mai-asset://model/old-model/live2dcubismcore.min.js",
      addedAt: 0,
      assetUrl: "",
    });
    expect(model.coreUrl).toBeUndefined();
  });

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
    ])
      await writeFile(join(source, file), "{}");
    await writeFile(join(source, "core.js"), coreSource);
    await downloadLive2DCore(
      join(root, "models"),
      async () => new Response(coreSource),
    );
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

  it("导入其他 Live2D 时复用 Core，原始文件和首个角色删除后仍可使用", async () => {
    const root = await folder();
    for (const name of ["first", "second"]) {
      const source = join(root, "source", name);
      await mkdir(source);
      await writeFile(join(source, "model.moc3"), "moc");
      await writeFile(
        join(source, `${name}.model3.json`),
        JSON.stringify({ FileReferences: { Moc: "model.moc3" } }),
      );
    }
    const originalCore = join(root, "source", "core.js");
    await writeFile(originalCore, coreSource);
    const modelsRoot = join(root, "models");
    await downloadLive2DCore(modelsRoot, async () => new Response(coreSource));
    const first = await importModelFile(
      join(root, "source", "first", "first.model3.json"),
      modelsRoot,
      originalCore,
    );
    await rm(originalCore);
    await rm(join(modelsRoot, first.id), { recursive: true });

    const second = await importModelFile(
      join(root, "source", "second", "second.model3.json"),
      modelsRoot,
    );
    expect(second.kind).toBe("live2d");
    expect(second.coreUrl).toContain("live2dcubismcore.min.js");
    expect(
      await readFile(join(modelsRoot, second.id, second.coreEntry!), "utf8"),
    ).toBe(coreSource);
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

  it("旧版模型可以被识别，并要求独立的 Cubism 2 运行库", async () => {
    const root = await folder();
    const entry = join(root, "source", "legacy.model.json");
    await writeFile(entry, JSON.stringify({ model: "legacy.moc" }));
    await expect(importModelFile(entry, join(root, "models"))).rejects.toThrow(
      "Cubism 2 兼容运行库",
    );
  });

  it("文件夹导入发现嵌套入口，多个入口要求明确选择", async () => {
    const root = await folder();
    const nested = join(root, "source", "角色");
    await mkdir(nested);
    const entry = join(nested, "角色.model3.json");
    await writeFile(entry, "{}");
    expect(await resolveModelEntry(join(root, "source"))).toBe(entry);
    await writeFile(join(nested, "legacy.model.json"), "{}");
    await expect(resolveModelEntry(join(root, "source"))).rejects.toThrow(
      "多个 Live2D 模型",
    );
    expect(await resolveModelEntry(entry)).toBe(entry);
  });

  it("现代资源引用只收集文件，保留自定义元数据及物理、姿势和音效", async () => {
    const root = await folder();
    const source = join(root, "source");
    const files = [
      "model.moc3",
      "physics.physics3.json",
      "pose.pose3.json",
      "info.cdi3.json",
      "user.userdata3.json",
      "voice.wav",
      "idle.motion3.json",
    ];
    for (const file of files) await writeFile(join(source, file), "{}");
    await downloadLive2DCore(
      join(root, "models"),
      async () => new Response(coreSource),
    );
    const config = {
      FileReferences: {
        Moc: files[0],
        Physics: files[1],
        Pose: files[2],
        DisplayInfo: files[3],
        UserData: files[4],
        Motions: {
          Idle: [
            {
              File: files[6],
              Sound: files[5],
              Name: "待机",
              CustomLabel: "不是文件路径",
            },
          ],
        },
        CustomMetadata: "不是资源文件",
      },
      Groups: [{ Target: "Parameter", Name: "LipSync", Ids: ["CustomMouth"] }],
    };
    const entry = join(source, "avatar.model3.json");
    await writeFile(entry, JSON.stringify(config));
    const model = await importModelFile(entry, join(root, "models"));
    for (const file of files)
      expect(await readFile(join(root, "models", model.id, file), "utf8")).toBe(
        "{}",
      );
    expect(
      JSON.parse(
        await readFile(join(root, "models", model.id, model.entry), "utf8"),
      ),
    ).toEqual(config);
  });

  it("旧版模型的动作和表情不能引用模型目录外的文件", async () => {
    const root = await folder();
    const entry = join(root, "source", "legacy.model.json");
    await writeFile(
      entry,
      JSON.stringify({
        model: "legacy.moc",
        motions: { idle: [{ file: "../outside.mtn" }] },
      }),
    );
    await expect(importModelFile(entry, join(root, "models"))).rejects.toThrow(
      "超出了导入目录",
    );
  });

  it("缺少编辑器显示元数据时仍可导入，但缺少贴图或 moc 仍拒绝", async () => {
    const root = await folder();
    const source = join(root, "source");
    await writeFile(join(source, "avatar.moc3"), "fixture");
    await downloadLive2DCore(
      join(root, "models"),
      async () => new Response(coreSource),
    );
    const entry = join(source, "avatar.model3.json");
    const refs = { Moc: "avatar.moc3", DisplayInfo: "optional.cdi3.json" };
    await writeFile(entry, JSON.stringify({ FileReferences: refs }));
    expect((await importModelFile(entry, join(root, "models"))).kind).toBe(
      "live2d",
    );
    await writeFile(
      entry,
      JSON.stringify({
        FileReferences: { ...refs, Textures: ["missing.png"] },
      }),
    );
    await expect(
      importModelFile(entry, join(root, "models")),
    ).rejects.toThrow();
  });
});
