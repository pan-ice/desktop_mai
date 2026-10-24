import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const builderRequire = createRequire(
  import.meta.resolve("electron-builder/package.json"),
);
export const packagingRequire = createRequire(
  builderRequire.resolve("app-builder-lib/package.json"),
);
const tar = packagingRequire("tar");

// Match the pinned electron-builder 26.15.3 toolsets, including their upstream SHA-256.
const artifacts = {
  sevenZip: {
    release: "7zip@1.0.0",
    filename: "7zip-win-x64.tar.gz",
    sha256: "be071f15bd6da2f78fe81c6ddef2009b0c4d8a51f36b780cb806c7e6df95e1b3",
    entry: "bin/7za.exe",
    strip: 1,
  },
  nsis: {
    release: "nsis-3.0.4.1",
    filename: "nsis-3.0.4.1.7z",
    sha256: "9877df902530f96357d13a7a31ae2b9df67f48b11ffc9a1700a7c961574ec5fa",
    entry: "Bin/makensis.exe",
  },
  nsisResources: {
    release: "nsis-resources-3.4.1",
    filename: "nsis-resources-3.4.1.7z",
    sha256: "593a9a92ef958321293ac6a2ee61e64bf1bd543142a5bd6b3d310709cc924103",
    entry: "plugins/x86-unicode",
  },
};

export const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );
export const fileHash = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

export function run(file, args, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(file, args, {
      windowsHide: true,
      stdio: "inherit",
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) done();
      else reject(new Error(`${file} 退出失败（${signal || code}）`));
    });
  });
}

async function explicitPath(name, directory = false) {
  if (!process.env[name]) return undefined;
  const value = resolve(process.env[name]);
  const info = await stat(value).catch(() => null);
  if (!info || (directory ? !info.isDirectory() : !info.isFile()))
    throw new Error(
      `${name} 指向不存在的${directory ? "目录" : "文件"}：${value}`,
    );
  return value;
}

async function prepareArtifact(key, sevenZip, allowDownload) {
  const artifact = artifacts[key];
  const cache = resolve(".cache/packaging-tools");
  const archive = join(cache, artifact.filename);
  const directory = join(cache, artifact.release);
  await mkdir(cache, { recursive: true });
  const caches = [
    process.env.ELECTRON_BUILDER_CACHE,
    process.env.LOCALAPPDATA &&
      join(process.env.LOCALAPPDATA, "electron-builder/Cache"),
    join(homedir(), "AppData/Local/electron-builder/Cache"),
  ].filter(Boolean);
  const candidates = [
    archive,
    ...caches.map((root) => join(root, artifact.release, artifact.filename)),
  ];
  let found = false;
  for (const candidate of new Set(candidates)) {
    if (!(await exists(candidate))) continue;
    if ((await fileHash(candidate)) !== artifact.sha256) continue;
    if (resolve(candidate) !== archive) await copyFile(candidate, archive);
    found = true;
    break;
  }
  if (!found) {
    if (!allowDownload)
      throw new Error(
        `缺少已校验的 ${artifact.release}。允许下载官方构建工具后重试；--zip 可显式选择 ZIP，不会生成 Portable EXE。`,
      );
    const url = `https://github.com/electron-userland/electron-builder-binaries/releases/download/${artifact.release}/${artifact.filename}`;
    console.log(`下载官方构建工具：${artifact.release}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok)
      throw new Error(`${artifact.release} 下载失败：HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(data).digest("hex") !== artifact.sha256)
      throw new Error(`${artifact.release} SHA-256 不匹配，拒绝使用`);
    const temporary = `${archive}.${process.pid}.tmp`;
    await writeFile(temporary, data);
    await rename(temporary, archive);
  }
  // Extract from the verified archive every time; incomplete global caches are never trusted.
  await mkdir(directory, { recursive: true });
  if (artifact.filename.endsWith(".tar.gz"))
    await tar.x({ file: archive, cwd: directory, strip: artifact.strip });
  else
    await run(sevenZip, ["x", archive, `-o${directory}`, "-y", "-bd", "-bso0"]);
  if (!(await exists(join(directory, artifact.entry))))
    throw new Error(`${artifact.release} 解压不完整：缺少 ${artifact.entry}`);
  return directory;
}

export async function windowsPackagingTools({
  portable = true,
  allowDownload = true,
} = {}) {
  if (process.platform !== "win32")
    throw new Error("此发行流程需在本机 Windows 上运行");
  const sevenZip =
    (await explicitPath("ELECTRON_BUILDER_7ZIP_PATH")) ||
    join(
      await prepareArtifact("sevenZip", undefined, allowDownload),
      artifacts.sevenZip.entry,
    );
  const env = { ...process.env, ELECTRON_BUILDER_7ZIP_PATH: sevenZip };
  if (portable) {
    env.ELECTRON_BUILDER_NSIS_DIR =
      (await explicitPath("ELECTRON_BUILDER_NSIS_DIR", true)) ||
      (await prepareArtifact("nsis", sevenZip, allowDownload));
    env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR =
      (await explicitPath("ELECTRON_BUILDER_NSIS_RESOURCES_DIR", true)) ||
      (await prepareArtifact("nsisResources", sevenZip, allowDownload));
    const compiler = env.ELECTRON_BUILDER_NSIS_DIR;
    if (
      !(await exists(join(compiler, "Bin/makensis.exe"))) &&
      !(await exists(join(compiler, "makensis.cmd")))
    )
      throw new Error("NSIS 目录缺少编译器，无法生成 Portable EXE");
    const resources = env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR;
    if (
      !(await exists(join(resources, "plugins/x86-unicode"))) &&
      !(await exists(join(resources, "windows/Plugins/x86-unicode")))
    )
      throw new Error("缺少 NSIS Unicode 插件资源，无法生成 Portable EXE");
  }
  return env;
}
