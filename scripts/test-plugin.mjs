import { spawn } from "node:child_process";
import { resolve, join } from "node:path";

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
  ["-m", "unittest", "discover", "-s", "tests", "-v"],
  {
    cwd: directory,
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, PYTHONUTF8: "1" },
  },
);
child.once("error", (error) => {
  console.error(
    `插件测试无法启动：${error.message}。先在插件目录执行 uv sync。`,
  );
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
