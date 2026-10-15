import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

// NSIS 便携启动器不转发 Electron 调试管道，使用独立 CDP 端口验证最终入口。
const base = resolve(".cache/portable-smoke");
const version = JSON.parse(
  await readFile(resolve("package.json"), "utf8"),
).version;
await mkdir(base, { recursive: true });
const profile = await mkdtemp(join(base, "profile-"));
await writeFile(
  join(profile, "state.json"),
  JSON.stringify({
    version: 2,
    settings: { autoConnect: false },
    history: [],
    models: [],
    encrypted: {},
  }),
);
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((resolveClose) => probe.close(resolveClose));
const env = { ...process.env, MAI_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
const launcher = spawn(
  resolve(`release/Mai-Desktop-Pet-${version}-win-x64.exe`),
  [`--remote-debugging-port=${port}`],
  { windowsHide: true, stdio: "ignore", env },
);
let failure;
launcher.once("error", (error) => {
  failure = error;
});
let browser;
try {
  const deadline = Date.now() + 30000;
  let available = false;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        available = true;
        break;
      }
    } catch {
      /* 等待便携包解压和 Chromium 启动。 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(available, "便携包应启动独立调试端口");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let page;
  for (let attempt = 0; attempt < 100; attempt++) {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().includes("view=dashboard"));
    if (page) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(page, "最终便携包能打开控制面板");
  await page.waitForFunction(() => Boolean(window.mai));
  const state = await page.evaluate(() => window.mai.snapshot());
  assert.equal(state.version, version);
  assert.equal(state.desktop, true);
  assert.equal(state.connection.phase, "disconnected");
  await page.screenshot({ path: join(base, "portable.png") });
  await page.evaluate(() => window.mai.quit()).catch(() => {});
  console.log(
    `PASS 最终便携 EXE：独立数据目录、控制面板、v${version} 状态、正常退出`,
  );
} finally {
  await browser?.close().catch(() => {});
  if (launcher.exitCode === null && launcher.pid) {
    await Promise.race([
      once(launcher, "exit"),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
    if (launcher.exitCode === null) {
      const cleaner = spawn(
        "taskkill.exe",
        ["/PID", String(launcher.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      await once(cleaner, "exit");
    }
  }
}
