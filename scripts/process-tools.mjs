import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const projectRequire = createRequire(
  resolve(projectRoot, "package.json"),
);

export function launchEnvironment(mode) {
  const env = { ...process.env, NODE_ENV: mode };
  // These are process launch switches, not application configuration.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  delete env.ELECTRON_ENTRY;
  delete env.ELECTRON_CLI_ARGS;
  delete env.ELECTRON_EXEC_PATH;
  return env;
}

export function toolEntry(name, command) {
  const packageFile = projectRequire.resolve(`${name}/package.json`);
  const info = projectRequire(packageFile);
  const bin = typeof info.bin === "string" ? info.bin : info.bin?.[command];
  if (!bin) throw new Error(`缺少 ${command}，请先运行 npm ci 安装完整依赖`);
  return resolve(dirname(packageFile), bin);
}

export function runProcess(executable, args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, {
      cwd: projectRoot,
      env,
      windowsHide: true,
      stdio: "inherit",
    });
    const stop = () => {
      if (child.exitCode !== null || !child.pid) return;
      if (process.platform === "win32") {
        const cleaner = spawn(
          "taskkill.exe",
          ["/PID", String(child.pid), "/T", "/F"],
          {
            windowsHide: true,
            stdio: "ignore",
          },
        );
        cleaner.on("error", () => child.kill());
      } else child.kill("SIGTERM");
    };
    const removeHandlers = () => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    child.once("error", (error) => {
      removeHandlers();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      removeHandlers();
      if (code === 0) resolveRun();
      else reject(new Error(`${executable} 退出：${signal || code}`));
    });
  });
}
