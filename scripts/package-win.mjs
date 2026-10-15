import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const env = { ...process.env };
if (process.platform === "win32") {
  const powershell = join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  try {
    await access(powershell);
    const pathKey =
      Object.keys(env).find((key) => key.toLowerCase() === "path") || "Path";
    env[pathKey] = `${env[pathKey] || ""};${dirname(powershell)}`;
  } catch {
    /* electron-builder 将提供缺少系统 PowerShell 的具体错误。 */
  }
}
const child = spawn(
  process.execPath,
  [resolve("node_modules/electron-builder/cli.js"), "--win", "portable"],
  { env, cwd: resolve("."), windowsHide: true, stdio: "inherit" },
);
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
