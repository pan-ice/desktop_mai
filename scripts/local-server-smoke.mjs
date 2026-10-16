import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, createConnection } from "node:net";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";

const base = resolve(".cache/local-server-smoke");
await mkdir(base, { recursive: true });
const folder = await mkdtemp(join(base, "run-"));
const coreRoot = join(folder, "MaiBot");
const source = resolve("MaiBot/plugins/desktop_pet_adapter");
const target = join(coreRoot, "plugins/desktop_pet_adapter");
await mkdir(join(target, "tools"), { recursive: true });
await cp(join(source, "desktop_adapter"), join(target, "desktop_adapter"), {
  recursive: true,
  filter: (path) => !path.includes("__pycache__"),
});
await cp(join(source, "tools/server.py"), join(target, "tools/server.py"));
await writeFile(join(coreRoot, "bot.py"), "# 测试目录，不启动真实 MaiBot\n");
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((done) => probe.close(done));
const url = `ws://127.0.0.1:${port}/desktop`;
const profile = join(folder, "profile");
await mkdir(profile);
await writeFile(
  join(profile, "state.json"),
  JSON.stringify({
    version: 2,
    settings: {
      corePath: coreRoot,
      connectionMode: "server",
      serverUrl: `wss://127.0.0.1:${port}/desktop`,
      autoConnect: false,
      petVisible: false,
    },
    models: [],
    history: [],
    encrypted: {},
  }),
);
const python =
  process.env.MAI_PYTHON || join(source, ".venv/Scripts/python.exe");
let app;
let host;
let page;
const errors = [];

async function until(check, message) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(message);
}
async function open() {
  const env = { ...process.env, MAI_USER_DATA: profile, MAI_PYTHON: python };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: resolve("node_modules/electron/dist/electron.exe"),
    args: ["."],
    cwd: resolve("."),
    env,
  });
  await app.firstWindow();
  await until(() => {
    page = app
      .windows()
      .find((candidate) => candidate.url().includes("view=dashboard"));
    return Boolean(page);
  }, "控制面板未启动");
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("button", { name: "连接与账号", exact: true }).click();
}
async function portClosed() {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      done(false);
    });
    socket.once("error", (error) => {
      socket.destroy();
      done(error.code === "ECONNREFUSED");
    });
  });
}
try {
  await open();
  await page.locator(".local-testing > summary").click();
  await page
    .getByRole("button", { name: "本机测试（自动初始化）", exact: true })
    .click();
  await until(
    async () => (await page.getByLabel("服务器地址").inputValue()) === url,
    "本机地址未自动更正为 ws",
  );
  await until(async () => {
    const current = await page.evaluate(() => window.mai.snapshot());
    return current.activity.some(
      (item) => item.text === "本机中继已就绪，退出桌宠时会自动停止",
    );
  }, "本机中继未就绪");
  const configPath = join(coreRoot, "data/desktop-server/server.json");
  const configBefore = await readFile(configPath);
  const adapterBefore = await readFile(join(target, "config.toml"));
  host = spawn(
    python,
    [join(source, "tests/host_fixture.py"), join(target, "config.toml")],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUTF8: "1" },
    },
  );
  host.stderr.resume();
  let hostReady = false;
  host.stdout.on("data", (chunk) => {
    if (chunk.toString().includes('"event": "started"')) hostReady = true;
  });
  await until(() => hostReady, "模拟 MaiBot 未启动");
  await page.getByLabel("这台设备的名称").fill("本机测试电脑");
  await page.getByRole("button", { name: "通过 QQ 登录", exact: true }).click();
  const command = page.getByRole("textbox", {
    name: "QQ 登录命令",
    exact: true,
  });
  await command.waitFor();
  host.stdin.write(
    `QQ 12345678 ${(await command.inputValue()).split(" ").at(-1)}\n`,
  );
  await page.getByLabel("新桌宠的名称").waitFor({ timeout: 20000 });
  await page.getByLabel("新桌宠的名称").fill("本机小麦");
  await page
    .getByRole("button", { name: "新建桌宠并连接", exact: true })
    .click();
  await until(
    async () =>
      (await page.evaluate(() => window.mai.snapshot())).connection.phase ===
      "connected",
    "桌宠未连接",
  );
  await page.screenshot({
    path: join(base, "local-ready.png"),
    fullPage: true,
  });
  await app.close();
  app = undefined;
  await until(portClosed, "退出桌宠后中继端口仍在监听");
  // 同一设备重启不需要再次 QQ 授权，账号面板会按需启动本机中继并读取原账号。
  await open();
  await page
    .locator(".server-account")
    .filter({ hasText: "本机小麦" })
    .waitFor({ timeout: 20000 });
  assert.deepEqual(await readFile(configPath), configBefore);
  assert.deepEqual(await readFile(join(target, "config.toml")), adapterBefore);
  await app.close();
  app = undefined;
  await until(portClosed, "再次退出后中继端口未清理");
  assert.deepEqual(errors, []);
  console.log(
    "PASS 本机自动初始化、更正 ws 地址、QQ 登录、创建桌宠、重启复用原账号与令牌、退出回收中继",
  );
  console.log(`预览：${join(base, "local-ready.png")}`);
} catch (error) {
  await page
    ?.screenshot({ path: join(base, "failure.png"), fullPage: true })
    .catch(() => {});
  throw error;
} finally {
  await app?.close().catch(() => {});
  if (host && host.exitCode === null) {
    const stopped = once(host, "exit");
    host.stdin.end("STOP\n");
    const timer = setTimeout(() => host.kill(), 5000);
    try {
      await stopped;
    } finally {
      clearTimeout(timer);
    }
  }
}
