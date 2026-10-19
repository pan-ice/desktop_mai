import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { messageAdapterPython } from "./message-adapter-python.mjs";

const base = resolve(".cache/message-adapter-smoke");
await mkdir(base, { recursive: true });
const profile = await mkdtemp(join(base, "profile-"));
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
const adapterPort = await freePort();
const corePort = await freePort();
await writeFile(
  join(profile, "state.json"),
  JSON.stringify({
    version: 2,
    settings: {
      adapterPort,
      autoConnect: false,
      serverAccountId: "pet_" + "a".repeat(32),
    },
    history: [],
    models: [],
    encrypted: {},
  }),
);
let desktop;
let adapter;
const events = [];
const pageErrors = [];
let adapterErrors = "";
const configPath = join(profile, "config.toml");

async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("独立适配器桌面验收等待超时");
}

try {
  const env = { ...process.env, MAI_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({
    executablePath: resolve("node_modules/electron/dist/electron.exe"),
    args: ["."],
    cwd: resolve("."),
    env,
    timeout: 30000,
  });
  await desktop.firstWindow();
  let page;
  await until(() => {
    page = desktop
      .windows()
      .find((candidate) => candidate.url().includes("view=dashboard"));
    return Boolean(page);
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.getByRole("button", { name: "连接与账号", exact: true }).click();
  await desktop.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, configPath);
  await page
    .getByRole("button", { name: "导出配置并开启接入", exact: true })
    .click();
  await until(
    async () =>
      (await page.evaluate(() => window.mai.snapshot())).connection.phase ===
      "connecting",
  );
  const exported = await readFile(configPath, "utf8");
  assert.ok(exported.includes("[maibot]") && exported.includes("[desktop]"));
  assert.ok(!exported.includes("[plugin]"));
  await writeFile(
    configPath,
    exported
      .replace("127.0.0.1:8000", `127.0.0.1:${corePort}`)
      .replace('token = ""', 'token = "smoke-test-core-token"'),
  );
  const adapterEnv = { ...process.env, PYTHONUTF8: "1" };
  delete adapterEnv.MAIBOT_TOKEN;
  delete adapterEnv.MAI_DESKTOP_TOKEN;
  adapter = spawn(
    messageAdapterPython(),
    [resolve("adapter/tests/sdk_fixture.py"), configPath],
    {
      windowsHide: true,
      stdio: "pipe",
      env: adapterEnv,
    },
  );
  adapter.stderr.on("data", (data) => {
    adapterErrors += data.toString();
  });
  const lines = createInterface({ input: adapter.stdout });
  lines.on("line", (line) => {
    try {
      events.push(JSON.parse(line));
    } catch {
      /* SDK logs */
    }
  });
  adapter.once("exit", () => lines.close());
  await until(
    async () =>
      (await page.evaluate(() => window.mai.snapshot())).connection.phase ===
      "connected",
  );
  const connected = await page.evaluate(() => window.mai.snapshot());
  assert.equal(connected.connection.transport, "legacy");
  assert.equal(connected.historySync.enabled, false);
  assert.equal(connected.connection.capabilities.includes("proactive"), false);
  assert.equal(
    await page
      .locator("body")
      .evaluate((body) => body.scrollWidth > innerWidth),
    false,
  );
  await page.screenshot({ path: join(base, "connection.png"), fullPage: true });
  await page.getByRole("button", { name: "声音与感知", exact: true }).click();
  assert.equal(
    await page
      .getByRole("switch", { name: "主动陪伴", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "和麦麦聊聊", exact: true }).click();
  await page
    .getByRole("textbox", { name: "消息内容" })
    .fill("独立适配器桌面验收");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page
    .getByText("真实消息服务回复独立适配器桌面验收", { exact: true })
    .waitFor();
  await until(() => events.some((event) => event.event === "echo"));
  const state = await page.evaluate(() => window.mai.snapshot());
  assert.equal(
    state.history.filter((message) => message.role === "assistant").length,
    1,
  );
  assert.equal(
    state.history.find((message) => message.role === "user").delivery,
    "sent",
  );
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
  await page.evaluate(async (image) => {
    await window.mai.updateSettings({ screenEnabled: true });
    await window.mai.send({ text: "图文顺序测试", image });
  }, `data:image/png;base64,${png}`);
  await page.getByText("图片之后", { exact: true }).waitFor();
  const mixed = page.locator(".message-row.assistant .chat-bubble").last();
  assert.deepEqual(
    await mixed.evaluate((bubble) =>
      Array.from(bubble.children, (child) => child.tagName),
    ),
    ["DIV", "IMG", "DIV"],
  );
  await until(
    () => events.filter((event) => event.event === "echo").length === 2,
  );
  await page.screenshot({ path: join(base, "chat.png"), fullPage: true });
  await page.evaluate(() => window.mai.quit()).catch(() => {});
  await desktop.close();
  desktop = undefined;
  const saved = JSON.parse(await readFile(join(profile, "state.json"), "utf8"));
  assert.equal(
    saved.history.filter((message) => message.role === "assistant").length,
    2,
  );
  assert.deepEqual(saved.history.at(-1).parts, [
    { type: "text", text: "图片之前" },
    { type: "attachment", index: 0 },
    { type: "text", text: "图片之后" },
  ]);
  assert.ok(saved.encrypted.adapterToken);
  assert.deepEqual(pageErrors, []);
  assert.equal(adapterErrors.includes("Traceback"), false);
  await writeFile(
    join(base, "result.json"),
    JSON.stringify(
      {
        passed: true,
        checks: [
          "实际 UI 配置导出与 IPC",
          "系统加密令牌",
          "官方消息服务往返",
          "保存后 ID 回执",
          "未知收件人拒绝",
          "主动任务能力限制",
          "退出后历史持久化",
          "混合消息原始顺序",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS 独立适配器桌面验收：配置导出、真实聊天、保存回执、能力限制、持久化与退出",
  );
} finally {
  if (adapter && adapter.exitCode === null) {
    const exited = once(adapter, "exit");
    adapter.stdin.end("STOP\n");
    const timeout = setTimeout(() => adapter.kill(), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timeout);
    }
  }
  await desktop?.close().catch(() => {});
}
