import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { _electron as electron } from "playwright";

const base = resolve(".cache/qq-login-smoke");
await mkdir(base, { recursive: true });
const folder = await mkdtemp(join(base, "run-"));
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((done) => probe.close(done));
const serverUrl = `ws://127.0.0.1:${port}/desktop`;
const token = "qq-smoke-backend-" + "x".repeat(40);
const relayPath = join(folder, "server.json");
const adapterPath = join(folder, "adapter.toml");
await writeFile(
  relayPath,
  JSON.stringify({
    port,
    backend_token_sha256: createHash("sha256").update(token).digest("hex"),
    users: [],
  }),
);
await writeFile(
  adapterPath,
  `[plugin]\nmode = "server"\nconfig_version = "1.1.0"\n[server]\nrelay_url = "ws://127.0.0.1:${port}/adapter"\ntoken = "${token}"\n[identity]\nplatform = "desktop_pet"\naccount_id = "mai_desktop_pet"\nuser_id = "server"\nscope = ""\n`,
);
const plugin = resolve("MaiBot/plugins/desktop_pet_adapter");
const desktops = new Set();
const errors = [];
let adapter;
let stderr = "";
const events = [];

async function until(check, message) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(message);
}
async function state(page) {
  return page.evaluate(() => window.mai.snapshot());
}
async function openDesktop(deviceName) {
  const profile = await mkdtemp(join(folder, "profile-"));
  await writeFile(
    join(profile, "state.json"),
    JSON.stringify({
      version: 2,
      settings: {
        autoConnect: false,
        petVisible: false,
        connectionMode: "server",
        serverUrl,
      },
      models: [],
      history: [],
      encrypted: {},
    }),
  );
  const env = { ...process.env, MAI_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: resolve("node_modules/electron/dist/electron.exe"),
    args: ["."],
    cwd: resolve("."),
    env,
  });
  desktops.add(app);
  await app.firstWindow();
  let page;
  await until(() => {
    page = app
      .windows()
      .find((candidate) => candidate.url().includes("view=dashboard"));
    return Boolean(page);
  }, "桌宠控制面板未启动");
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("button", { name: "连接与账号", exact: true }).click();
  assert.equal(
    await page
      .getByRole("heading", { name: "本地内核进程", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page.getByLabel("个人接入令牌", { exact: true }).count(),
    0,
  );
  assert.equal(await page.getByLabel("平台标识", { exact: true }).count(), 0);
  assert.equal(
    await page.evaluate(() => typeof window.mai.startCore),
    "undefined",
  );
  await page.getByLabel("这台设备的名称").fill(deviceName);
  await page.getByRole("button", { name: "通过 QQ 登录", exact: true }).click();
  const command = page.getByRole("textbox", {
    name: "QQ 登录命令",
    exact: true,
  });
  await command.waitFor();
  const code = (await command.inputValue()).split(" ").at(-1);
  if (desktops.size === 1)
    await page.screenshot({ path: join(base, "qq-login.png"), fullPage: true });
  adapter.stdin.write(`QQ 12345678 ${code}\n`);
  await page.getByLabel("新桌宠的名称").waitFor({ timeout: 20000 });
  return { app, page, profile };
}
async function connected(page, id) {
  await until(async () => {
    const current = await state(page);
    return (
      current.connection.phase === "connected" &&
      current.settings.serverAccountId === id &&
      !current.historySync.loading
    );
  }, "桌宠账号连接或历史同步未完成");
}
async function select(page, name, id) {
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.locator(".server-account").filter({ hasText: name }).click();
  await connected(page, id);
}
async function create(page, name) {
  await page.getByLabel("新桌宠的名称").fill(name);
  await page
    .getByRole("button", { name: "新建桌宠并连接", exact: true })
    .click();
  let id;
  await until(async () => {
    const current = await state(page);
    if (current.settings.nickname !== name || !current.settings.serverAccountId)
      return false;
    id = current.settings.serverAccountId;
    return (
      current.connection.phase === "connected" && !current.historySync.loading
    );
  }, "新建桌宠未完成");
  return id;
}
async function send(page, text) {
  await page.evaluate((text) => window.mai.send({ text }), text);
  await until(
    async () =>
      (await state(page)).history.some(
        (message) => message.role === "user" && message.text === text,
      ) &&
      (await state(page)).history.some(
        (message) => message.role === "assistant",
      ),
    "聊天与回复未完成",
  );
}

try {
  adapter = spawn(
    process.env.MAI_PYTHON || join(plugin, ".venv/Scripts/python.exe"),
    [join(plugin, "tests/host_fixture.py"), adapterPath, relayPath],
    {
      stdio: "pipe",
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: "1" },
    },
  );
  adapter.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: adapter.stdout });
  lines.on("line", (line) => events.push(JSON.parse(line)));
  adapter.once("exit", () => lines.close());
  await until(() => {
    if (adapter.exitCode !== null)
      throw new Error(stderr || "QQ 登录测试 Host 已退出");
    return events.some((event) => event.event === "started");
  }, "QQ 登录测试 Host 未启动");

  const first = await openDesktop("办公室电脑");
  const petA = await create(first.page, "小麦");
  await send(first.page, "小麦的专属聊天记录");
  const second = await openDesktop("家里的电脑");
  await select(second.page, "小麦", petA);
  assert.ok(
    (await state(second.page)).history.some(
      (message) => message.text === "小麦的专属聊天记录",
    ),
  );
  assert.equal((await state(first.page)).connection.phase, "connected");
  await send(second.page, "来自第二台电脑");
  await until(
    async () =>
      (await state(first.page)).history.some(
        (message) => message.text === "来自第二台电脑",
      ),
    "另一台设备没有同步用户发言",
  );

  const petB = await create(first.page, "小橘");
  assert.equal((await state(first.page)).history.length, 0);
  await send(first.page, "小橘独立保存的记录");
  assert.ok(
    !(await state(second.page)).history.some(
      (message) => message.text === "小橘独立保存的记录",
    ),
  );
  await select(first.page, "小麦", petA);
  assert.ok(
    !(await state(first.page)).history.some(
      (message) => message.text === "小橘独立保存的记录",
    ),
  );
  await select(second.page, "小橘", petB);
  assert.ok(
    (await state(second.page)).history.some(
      (message) => message.text === "小橘独立保存的记录",
    ),
  );
  await first.page.getByRole("button", { name: "刷新", exact: true }).click();
  await first.page.screenshot({
    path: join(base, "accounts.png"),
    fullPage: true,
  });
  assert.equal(
    await first.page
      .locator("body")
      .evaluate((node) => node.scrollWidth > innerWidth),
    false,
  );

  // 全新数据目录登录已有账号，证明恢复来自服务器而非复制本地缓存。
  const third = await openDesktop("新电脑");
  await select(third.page, "小麦", petA);
  assert.ok(
    (await state(third.page)).history.some(
      (message) => message.text === "来自第二台电脑",
    ),
  );
  const devices = await first.page.evaluate(() => window.mai.serverDevices());
  const newest = devices.find((device) => device.name === "新电脑");
  await first.page.evaluate(
    (id) => window.mai.revokeServerDevice(id),
    newest.id,
  );
  await until(
    async () => (await state(third.page)).connection.phase === "error",
    "被移除的设备未断开",
  );
  assert.equal((await state(first.page)).connection.phase, "connected");

  // 移除只改变这台设备的列表，不向服务端删除账号或记录。
  const removePetB = first.page.getByRole("button", {
    name: "从本机移除桌宠 小橘",
    exact: true,
  });
  await removePetB.click();
  await first.page.getByRole("button", { name: "取消", exact: true }).click();
  assert.ok(!(await state(first.page)).removedServerAccounts.includes(petB));
  await removePetB.click();
  await first.page
    .getByRole("button", { name: "确认移除", exact: true })
    .click();
  await until(
    async () => (await state(first.page)).removedServerAccounts.includes(petB),
    "本机移除偏好未保存",
  );
  assert.equal((await state(first.page)).settings.serverAccountId, petA);
  assert.equal((await state(first.page)).connection.phase, "connected");
  assert.equal((await state(second.page)).connection.phase, "connected");
  assert.ok(
    (await first.page.evaluate(() => window.mai.serverAccounts())).some(
      (account) => account.id === petB,
    ),
  );
  await send(second.page, "本机移除后另一台电脑继续聊天");
  await first.page.locator(".server-account-restore summary").click();
  await first.page
    .getByRole("button", { name: "添加已有桌宠 小橘", exact: true })
    .click();
  await connected(first.page, petB);
  assert.ok(
    (await state(first.page)).history.some(
      (message) => message.text === "小橘独立保存的记录",
    ),
  );
  assert.ok(
    (await state(first.page)).history.some(
      (message) => message.text === "本机移除后另一台电脑继续聊天",
    ),
  );

  // 移除当前桌宠只断开本机，重载面板也不会自动把移除项重新放回。
  await first.page
    .getByRole("button", { name: "从本机移除桌宠 小橘", exact: true })
    .click();
  await first.page
    .getByRole("button", { name: "确认移除", exact: true })
    .click();
  await until(
    async () => !(await state(first.page)).settings.serverAccountId,
    "移除当前桌宠未取消本机选择",
  );
  assert.equal((await state(first.page)).connection.phase, "disconnected");
  assert.equal((await state(first.page)).connection.sessionId, undefined);
  assert.equal((await state(first.page)).connection.userId, undefined);
  assert.equal((await state(first.page)).credentials.serverToken, true);
  assert.equal((await state(second.page)).connection.phase, "connected");
  await send(second.page, "移除当前桌宠后其他设备仍可聊天");
  await first.page.reload();
  await first.page
    .getByRole("button", { name: "连接与账号", exact: true })
    .click();
  await first.page.locator(".server-account-restore summary").waitFor();
  assert.equal(
    await first.page
      .locator(".server-account")
      .filter({ hasText: "小橘" })
      .count(),
    0,
  );
  await first.page.screenshot({
    path: join(base, "account-removed.png"),
    fullPage: true,
  });
  await first.page.locator(".server-account-restore summary").click();
  await first.page
    .getByRole("button", { name: "添加已有桌宠 小橘", exact: true })
    .click();
  await connected(first.page, petB);
  assert.ok(!(await state(first.page)).removedServerAccounts.includes(petB));
  assert.ok(
    (await state(first.page)).history.some(
      (message) => message.text === "移除当前桌宠后其他设备仍可聊天",
    ),
  );
  await select(first.page, "小麦", petA);

  await first.page
    .getByRole("button", { name: "和麦麦聊聊", exact: true })
    .click();
  await first.page.screenshot({
    path: join(base, "cloud-chat.png"),
    fullPage: true,
  });
  await first.page.evaluate(() => window.mai.clearHistory());
  assert.equal((await state(first.page)).history.length, 0);
  await select(second.page, "小麦", petA);
  assert.equal((await state(second.page)).history.length, 0);
  await select(second.page, "小橘", petB);
  assert.ok(
    (await state(second.page)).history.some(
      (message) => message.text === "小橘独立保存的记录",
    ),
  );
  for (const desktop of [first, second, third]) {
    const data = await readFile(join(desktop.profile, "state.json"), "utf8");
    assert.ok(!data.includes("12345678"));
    assert.ok(!data.includes("person_id"));
    assert.ok(!data.includes(token));
  }
  assert.deepEqual(errors, []);
  assert.ok(!stderr.includes("Traceback"), stderr);
  console.log(
    "PASS QQ 登录与多设备同步、本机移除与重新添加、其他设备继续聊天、聊天历史保留、撤销设备及分账号清空",
  );
  console.log(`预览：${join(base, "accounts.png")}`);
} catch (error) {
  let index = 0;
  for (const app of desktops) {
    const page = app
      .windows()
      .find((candidate) => candidate.url().includes("view=dashboard"));
    await page
      ?.screenshot({
        path: join(base, `failure-${index++}.png`),
        fullPage: true,
      })
      .catch(() => {});
  }
  throw error;
} finally {
  for (const app of desktops) await app.close().catch(() => {});
  if (adapter && adapter.exitCode === null) {
    const stopped = once(adapter, "exit");
    adapter.stdin.end("STOP\n");
    const timer = setTimeout(() => adapter.kill(), 5000);
    try {
      await stopped;
    } finally {
      clearTimeout(timer);
    }
  }
}
