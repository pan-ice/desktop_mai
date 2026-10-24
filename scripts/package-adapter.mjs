import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import {
  pluginDirectory as directory,
  pluginPython as python,
} from "./plugin-paths.mjs";

const child = spawn(
  python,
  [join(directory, "tools/package.py"), resolve("release")],
  { windowsHide: true, stdio: "inherit" },
);
child.once("error", (error) => {
  console.error(`插件打包失败：${error.message}。先在插件目录执行 uv sync。`);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
