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
    coreUrl: model.coreEntry ? assetUrl(model.id, model.coreEntry) : undefined,
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
  } else if (entry.toLowerCase().endsWith(".model3.json")) {
    kind = "live2d";
    const config = JSON.parse(await readFile(file, "utf8")) as {
      FileReferences?: Record<string, unknown>;
    };
    if (!config.FileReferences || typeof config.FileReferences.Moc !== "string")
      throw new Error("Live2D 模型缺少 FileReferences.Moc");
    const collect = (value: unknown) => {
      if (typeof value === "string") {
        safeAssetPath(source, value);
        resources.add(value);
      } else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          if (["Name", "FadeInTime", "FadeOutTime"].includes(key)) continue;
          collect(child);
        }
      }
    };
    collect(config.FileReferences);
    if (!coreFile)
      throw new Error(
        "Live2D 需要导入官方 Cubism Core（live2dcubismcore.min.js）",
      );
    coreEntry = "live2dcubismcore.min.js";
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
      "支持图片、PNGTuber JSON、Live2D model3.json、VRM / GLB 和 PMX / PMD",
    );

  return copyModel(entry);

  async function copyModel(modelEntry: string): Promise<ImportedModel> {
    try {
      let bytes = 0;
      const copies: [string, string][] = [];
      for (const resource of resources) {
        const original = await containedFile(source, resource);
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
        if ((await lstat(coreFile)).size > 10 * 1024 * 1024)
          throw new Error("Cubism Core 文件超过限制");
        await copyFile(coreFile, join(target, coreEntry));
      }
      return withModelUrls({
        id,
        name,
        kind,
        entry: modelEntry,
        talkingEntry,
        coreEntry,
        addedAt: Date.now(),
        assetUrl: "",
      });
    } catch (error) {
      // target 只能是本次生成的 UUID 子目录。
      await rm(target, { recursive: true, force: true });
      throw error;
    }
  }
}
