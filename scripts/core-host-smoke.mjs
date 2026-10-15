import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const python =
  process.env.MAI_PYTHON ||
  resolve(
    "MaiBot/plugins/desktop_pet_adapter/.venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
const folder = resolve(".cache/core-host-fixture");
await mkdir(folder, { recursive: true });
await writeFile(
  join(folder, "bot.py"),
  `import os, signal, subprocess, sys, time
stopped = False
def stop(signum, frame):
    global stopped
    stopped = True
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
if os.name == 'nt': signal.signal(signal.SIGBREAK, stop)
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])
print('HOST_READY', flush=True)
try:
    while not stopped: time.sleep(0.05)
finally:
    child.terminate()
    child.wait(timeout=5)
    print('HOST_STOPPED', flush=True)
`,
  "utf8",
);

for (const mode of ["command", "parent_closed"]) {
  const child = spawn(
    python,
    ["-u", resolve("resources/core_host.py"), folder],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  let logs = "";
  child.stdout.on("data", (chunk) => {
    logs += chunk;
  });
  child.stderr.on("data", (chunk) => {
    logs += chunk;
  });
  try {
    await new Promise((ready, reject) => {
      const timer = setInterval(() => {
        if (logs.includes("HOST_READY")) {
          clearInterval(timer);
          clearTimeout(deadline);
          ready();
        }
      }, 50);
      const deadline = setTimeout(() => {
        clearInterval(timer);
        reject(new Error(logs || "内核托管器未就绪"));
      }, 10000);
      child.once("error", (error) => {
        clearInterval(timer);
        clearTimeout(deadline);
        reject(error);
      });
    });
    const stopped = new Promise((finished, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`内核未正常退出：${logs}`)),
        10000,
      );
      child.once("exit", (code) => {
        clearTimeout(timer);
        finished(code);
      });
    });
    if (mode === "command") child.stdin.write("STOP\n");
    else child.stdin.end();
    assert.equal(await stopped, 0);
    assert.ok(logs.includes("HOST_STOPPED"));
    console.log(`PASS 内核托管 ${mode}：正常停止并回收子进程`);
  } finally {
    if (child.exitCode === null) {
      if (process.platform === "win32")
        await new Promise((resolveStop) =>
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          }).once("exit", resolveStop),
        );
      else child.kill("SIGKILL");
    }
  }
}
