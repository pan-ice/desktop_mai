import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { exists, run, windowsPackagingTools } from "./packaging-tools.mjs";
import { productionBuildCurrent } from "./build-state.mjs";

const args = new Set(process.argv.slice(2));
for (const arg of args)
  if (!["--portable", "--zip", "--check", "--offline"].includes(arg))
    throw new Error(`未知打包参数：${arg}`);
if (args.has("--portable") && args.has("--zip"))
  throw new Error("请选择 --portable 或 --zip 中的一项");
const target = args.has("--zip") ? "zip" : "portable";
if (!args.has("--check") && !(await productionBuildCurrent()))
  throw new Error("生产构建已过期或不完整，请先运行 npm run build 再打包");
const info = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const electronDist = resolve("node_modules/electron/dist");
const electronInfo = JSON.parse(
  await readFile(resolve("node_modules/electron/package.json"), "utf8"),
);
if (
  !(await exists(join(electronDist, "electron.exe"))) ||
  (await readFile(join(electronDist, "version"), "utf8")).trim() !==
    electronInfo.version
)
  throw new Error("本地 Electron 发行文件缺失或版本不符，请先完成 npm ci");

const env = await windowsPackagingTools({
  portable: target === "portable",
  allowDownload: !args.has("--offline"),
});
// This project's releases are unsigned. Avoid inspecting local signing identities or credentials.
env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
const powershell = join(
  process.env.SystemRoot || "C:\\Windows",
  "System32/WindowsPowerShell/v1.0",
);
const pathKey =
  Object.keys(env).find((key) => key.toLowerCase() === "path") || "Path";
env[pathKey] = `${env[pathKey] || ""};${powershell}`;
const artifactName = `Mai-Desktop-Pet-${info.version}-win-x64.${target === "zip" ? "zip" : "exe"}`;
const artifact = resolve("release", artifactName);
if (args.has("--check")) {
  console.log(
    `PASS 打包依赖：Electron ${electronInfo.version}、已校验构建工具，目标 ${artifactName}`,
  );
} else {
  for (const file of [
    "out/main/index.js",
    "out/preload/index.cjs",
    "out/renderer/index.html",
  ])
    if (!(await exists(resolve(file))))
      throw new Error(`缺少 ${file}，请先运行 npm run build`);
  // Use the installed Electron, preserve icon/version editing, and never publish from a local build.
  const config = {
    ...info.build,
    electronDist,
    npmRebuild: false,
    win: {
      ...info.build.win,
      target: [{ target, arch: ["x64"] }],
      signExecutable: false,
    },
    artifactName,
    portable: { ...info.build.portable, artifactName },
  };
  const configPath = resolve(".cache/packaging-tools/local-build.json");
  await mkdir(resolve(".cache/packaging-tools"), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2));
  await run(
    process.execPath,
    [
      resolve("node_modules/electron-builder/cli.js"),
      "--win",
      target,
      "--publish",
      "never",
      "--config",
      configPath,
    ],
    { env, cwd: resolve(".") },
  );
  if (!(await exists(artifact)))
    throw new Error(`打包未生成预期文件：${artifact}`);
  console.log(
    `PASS 本机 ${target === "portable" ? "Portable EXE" : "ZIP"}：${artifact}`,
  );
}
