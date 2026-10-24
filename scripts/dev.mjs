import { launchEnvironment, runProcess, toolEntry } from "./process-tools.mjs";

try {
  await runProcess(
    process.execPath,
    [
      toolEntry("electron-vite", "electron-vite"),
      "dev",
      ...process.argv.slice(2),
    ],
    launchEnvironment("development"),
  );
} catch (error) {
  console.error(`开发启动失败：${error.message}`);
  process.exitCode = 1;
}
