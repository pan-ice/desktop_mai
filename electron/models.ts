import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { randomUUID } from "node:crypto";
import type { ImportedModel, ModelKind } from "../shared/types";
import {
  findLive2DCore,
  installLive2DCore,
  live2dCoreUrl,
  type Live2DCore,
} from "./live2d-core";
import { LIVE2D_RUNTIME_FILES, live2dRuntimeForEntry } from "../shared/live2d";

export async function resolveModelEntry(path: string): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error("模型入口不能是符号链接");
  if (info.isFile()) return path;
  if (!info.isDirectory()) throw new Error("请选择模型文件或文件夹");
  const entries: string[] = [];
  let visited = 0;
  const walk = async (directory: string, depth: number) => {
    if (depth > 10) throw new Error("模型目录层级超过限制");
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (++visited > 5000)
        throw new Error("模型目录文件过多，请选择单个模型的文件夹");
      if (item.name.startsWith(".") || item.isSymbolicLink()) continue;
      const file = join(directory, item.name);
      if (item.isDirectory()) await walk(file, depth + 1);
      else if (/\.model3?\.json$/i.test(item.name)) entries.push(file);
    }
  };
  await walk(path, 0);
  if (entries.length !== 1)
    throw new Error(
      entries.length
        ? "文件夹中有多个 Live2D 模型，请直接选择要导入的 .model3.json 或 .model.json"
        : "未找到 Live2D 模型入口，请先解压模型包；编辑器工程需先导出运行时模型",
    );
  return entries[0];
}

function live2dResources(
  config: Record<string, unknown>,
  legacy: boolean,
  optional: Set<string>,
): string[] {
  const files: string[] = [];
  const file = (value: unknown, label: string, required = false) => {
    if (value === undefined && !required) return;
    if (typeof value !== "string" || !value.trim())
      throw new Error(`Live2D 模型缺少或包含无效的 ${label}`);
    files.push(value);
  };
  const array = (value: unknown, label: string): unknown[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error(`Live2D ${label} 必须是数组`);
    return value;
  };
  const object = (value: unknown, label: string): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`Live2D ${label} 格式不正确`);
    return value as Record<string, unknown>;
  };
  const refs = legacy
    ? config
    : object(config.FileReferences, "FileReferences");
  file(
    refs[legacy ? "model" : "Moc"],
    legacy ? "model" : "FileReferences.Moc",
    true,
  );
  for (const texture of array(
    refs[legacy ? "textures" : "Textures"],
    "Textures",
  ))
    file(texture, "Texture", true);
  for (const key of legacy
    ? ["physics", "pose"]
    : ["Physics", "Pose", "UserData"])
    file(refs[key], key);
  const motions = refs[legacy ? "motions" : "Motions"];
  if (motions !== undefined)
    for (const group of Object.values(object(motions, "Motions"))) {
      for (const value of array(group, "Motion group")) {
        const motion = object(value, "Motion");
        file(motion[legacy ? "file" : "File"], "Motion.File", true);
        file(motion[legacy ? "sound" : "Sound"], "Motion.Sound");
      }
    }
  for (const value of array(
    refs[legacy ? "expressions" : "Expressions"],
    "Expressions",
  ))
    file(
      object(value, "Expression")[legacy ? "file" : "File"],
      "Expression.File",
      true,
    );
  // DisplayInfo 仅是编辑器参数标签；不少可运行模型不会随包分发此文件。
  if (!legacy && refs.DisplayInfo !== undefined) {
    const metadata = refs.DisplayInfo;
    if (typeof metadata === "string" && !files.includes(metadata))
      optional.add(metadata);
    file(metadata, "DisplayInfo");
  }
  return files;
}

export function safeAssetPath(root: string, requested: string): string {
  if (
    !requested ||
    requested.includes("\0") ||
    isAbsolute(requested) ||
    /^[a-z]+:/i.test(requested)
  )
    throw new Error("模型资源路径必须为相对路径");
  const target = resolve(root, requested);
  const inside = relative(resolve(root), target);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    throw new Error("模型资源超出了导入目录");
  return target;
}

export function assetUrl(id: string, entry: string) {
  return `mai-asset://model/${id}/${entry.split(/[\\/]/).map(encodeURIComponent).join("/")}`;
}

export function withModelUrls(model: ImportedModel): ImportedModel {
  return {
    ...model,
    assetUrl: assetUrl(model.id, model.entry),
    talkingUrl: model.talkingEntry
      ? assetUrl(model.id, model.talkingEntry)
      : undefined,
    // 旧模型目录里的脚本不能直接执行；由主进程提供校验过的共享运行库。
    coreUrl: undefined,
  };
}

export async function containedFile(root: string, requested: string) {
  const target = safeAssetPath(root, requested);
  const actual = await realpath(target);
  const actualRoot = await realpath(root);
  safeAssetPath(actualRoot, relative(actualRoot, actual));
  if (!(await lstat(actual)).isFile()) throw new Error("模型资源不是文件");
  return actual;
}

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const modelExtensions = new Set([
  ".json",
  ".moc3",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".bmp",
  ".tga",
  ".dds",
  ".sph",
  ".spa",
  ".pmx",
  ".pmd",
  ".vmd",
  ".wav",
  ".mp3",
]);

export async function importModelFile(
  file: string,
  modelsRoot: string,
  coreFile?: string,
): Promise<ImportedModel> {
  file = await resolveModelEntry(file);
  const id = randomUUID();
  const source = dirname(file);
  const entry = basename(file);
  const target = join(modelsRoot, id);
  const ext = extname(entry).toLowerCase();
  let kind: ModelKind;
  let talkingEntry: string | undefined;
  let coreEntry: string | undefined;
  let name = basename(file, ext);
  const resources = new Set([entry]);
  const optionalResources = new Set<string>();
  if (imageExtensions.has(ext)) kind = "image";
  else if (ext === ".vrm" || ext === ".glb") kind = "vrm";
  else if (ext === ".pmx" || ext === ".pmd") {
    kind = "mmd";
    // PMX/PMD 的贴图引用在二进制中，复制同目录内的模型资源，拒绝链接及可执行文件。
    const walk = async (folder: string, depth = 0) => {
      if (depth > 10) throw new Error("模型目录层级超过限制");
      for (const item of await readdir(folder, { withFileTypes: true })) {
        if (item.isSymbolicLink()) throw new Error("模型目录不能包含符号链接");
        if (item.name.startsWith(".")) continue;
        const path = join(folder, item.name);
        if (item.isDirectory()) await walk(path, depth + 1);
        else if (modelExtensions.has(extname(item.name).toLowerCase()))
          resources.add(relative(source, path));
        if (resources.size > 3000)
          throw new Error("模型目录文件过多，请放入独立文件夹后导入");
      }
    };
    await walk(source);
  } else if (/\.model3?\.json$/i.test(entry)) {
    kind = "live2d";
    const runtime = live2dRuntimeForEntry(entry);
    const config = JSON.parse(await readFile(file, "utf8")) as Record<
      string,
      unknown
    >;
    for (const resource of live2dResources(
      config,
      runtime === "legacy",
      optionalResources,
    )) {
      safeAssetPath(source, resource);
      resources.add(resource);
    }
    coreFile ??= (await findLive2DCore(modelsRoot, runtime))?.file;
    if (!coreFile)
      throw new Error(
        `请先设置一次 ${runtime === "legacy" ? "Cubism 2 兼容运行库（live2d.min.js）" : "官方 Cubism Core（live2dcubismcore.min.js）"}，之后导入 Live2D 会自动复用`,
      );
    coreEntry = LIVE2D_RUNTIME_FILES[runtime];
  } else if (ext === ".json") {
    const config = JSON.parse(await readFile(file, "utf8")) as {
      name?: string;
      idle?: string;
      talking?: string;
    };
    if (typeof config.idle !== "string" || typeof config.talking !== "string")
      throw new Error("PNGTuber JSON 必须包含 idle 和 talking 图片路径");
    kind = "pngtuber";
    for (const image of [config.idle, config.talking]) {
      if (!imageExtensions.has(extname(image).toLowerCase()))
        throw new Error("PNGTuber 仅支持本地图片");
      resources.add(image);
    }
    name = config.name?.slice(0, 80) || name;
    talkingEntry = config.talking;
    resources.delete(entry);
    resources.add(config.idle);
    return copyModel(config.idle);
  } else
    throw new Error(
      "支持图片、PNGTuber JSON、Live2D model.json / model3.json、VRM / GLB 和 PMX / PMD",
    );

  return copyModel(entry);

  async function copyModel(modelEntry: string): Promise<ImportedModel> {
    try {
      let core: Live2DCore | undefined;
      let bytes = 0;
      const copies: [string, string][] = [];
      for (const resource of resources) {
        let original: string;
        try {
          original = await containedFile(source, resource);
        } catch (error) {
          if (
            optionalResources.has(resource) &&
            (error as NodeJS.ErrnoException).code === "ENOENT"
          )
            continue;
          throw error;
        }
        bytes += (await lstat(original)).size;
        if (bytes > 512 * 1024 * 1024)
          throw new Error("模型资源超过 512 MB，请精简后导入");
        copies.push([original, safeAssetPath(target, resource)]);
      }
      await mkdir(target, { recursive: true });
      for (const [original, destination] of copies) {
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(original, destination);
      }
      if (coreEntry && coreFile) {
        core = await installLive2DCore(
          modelsRoot,
          coreFile,
          live2dRuntimeForEntry(entry),
        );
        await copyFile(core.file, join(target, coreEntry));
      }
      const model = withModelUrls({
        id,
        name,
        kind,
        entry: modelEntry,
        talkingEntry,
        coreEntry,
        addedAt: Date.now(),
        assetUrl: "",
      });
      return { ...model, coreUrl: core ? live2dCoreUrl(core) : undefined };
    } catch (error) {
      // target 只能是本次生成的 UUID 子目录。
      await rm(target, { recursive: true, force: true });
      throw error;
    }
  }
}
