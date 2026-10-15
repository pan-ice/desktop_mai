import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

const directory = resolve("MaiBot/plugins/desktop_pet_adapter");
const python =
  process.env.MAI_PYTHON ||
  join(
    directory,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
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
