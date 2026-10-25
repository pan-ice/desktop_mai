import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { exists, run } from "./packaging-tools.mjs";
import { productionBuildCurrent } from "./build-state.mjs";

if (process.platform !== "darwin")
  throw new Error(
    "macOS 发行包需要在 Mac 上构建；也可使用 GitHub Actions 的 macOS 构建任务",
  );
if (!["x64", "arm64"].includes(process.arch))
  throw new Error(`不支持的 Mac 架构：${process.arch}`);
if (process.argv.length > 2)
  throw new Error("Mac 打包自动使用当前 Node.js 的架构，无需额外参数");
if (!(await productionBuildCurrent()))
  throw new Error("生产构建已过期或不完整，请先运行 npm run build 再打包");

const info = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const electronDist = resolve("node_modules/electron/dist");
const electronInfo = JSON.parse(
  await readFile(resolve("node_modules/electron/package.json"), "utf8"),
);
if (
  !(await exists(join(electronDist, "Electron.app/Contents/MacOS/Electron"))) ||
  (await readFile(join(electronDist, "version"), "utf8")).trim() !==
    electronInfo.version
)
  throw new Error("本地 Electron 发行文件缺失或版本不符，请先完成 npm ci");

// Package the native Electron installed by npm ci. SVG conversion belongs to
// electron-builder; no generated icon files are added to the source tree.
const config = {
  ...info.build,
  electronDist,
  npmRebuild: false,
};
const configPath = resolve(".cache/packaging-tools/mac-build.json");
await mkdir(resolve(".cache/packaging-tools"), { recursive: true });
await writeFile(configPath, JSON.stringify(config, null, 2));
await run(
  process.execPath,
  [
    resolve("node_modules/electron-builder/cli.js"),
    "--mac",
    "dmg",
    "zip",
    `--${process.arch}`,
    "--publish",
    "never",
    "--config",
    configPath,
  ],
  {
    cwd: resolve("."),
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
  },
);
for (const extension of ["dmg", "zip"]) {
  const artifact = resolve(
    "release",
    `Mai-Desktop-Pet-${info.version}-mac-${process.arch}.${extension}`,
  );
  if (!(await exists(artifact)))
    throw new Error(`打包未生成预期文件：${artifact}`);
  console.log(
    `PASS Mac ${process.arch} ${extension.toUpperCase()}：${artifact}`,
  );
}
