import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { _electron as electron } from "playwright";

const base = resolve(".cache/server-desktop-smoke");
await mkdir(base, { recursive: true });
const folder = await mkdtemp(join(base, "run-"));
const profile = join(folder, "profile");
await mkdir(profile);
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
await new Promise((done) => probe.close(done));
const tokens = {
  alice: "test-alice-" + "a".repeat(40),
  bob: "test-bob-" + "b".repeat(40),
  adapter: "test-adapter-" + "x".repeat(40),
};
const digest = (value) => createHash("sha256").update(value).digest("hex");
const relayPath = join(folder, "server.json");
const adapterPath = join(folder, "adapter.toml");
await writeFile(
  relayPath,
  JSON.stringify({
    port,
    backend_token_sha256: digest(tokens.adapter),
    users: ["alice", "bob"].map((id) => ({
      id,
      name: id,
      token_sha256: digest(tokens[id]),
    })),
  }),
);
await writeFile(
  adapterPath,
  `[plugin]\nmode = "server"\nconfig_version = "1.1.0"\n[server]\nrelay_url = "ws://127.0.0.1:${port}/adapter"\ntoken = "${tokens.adapter}"\n[identity]\nplatform = "desktop_pet"\naccount_id = "mai_desktop_pet"\nuser_id = "server"\nscope = ""\n`,
);
for (const id of ["alice", "bob"])
  await writeFile(
    join(folder, `${id}.json`),
    JSON.stringify({
      format: "mai-desktop-server",
      version: 1,
      serverUrl: `ws://127.0.0.1:${port}/desktop`,
      token: tokens[id],
    }),
  );
const plugin = resolve("MaiBot/plugins/desktop_pet_adapter");
let adapter;
let desktop;
let stderr = "";
const events = [];
async function waitFor(check, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 30));
  }
  throw new Error(message);
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
  await waitFor(
    () => events.some((event) => event.event === "started"),
    "测试适配器未启动",
  );
  const env = { ...process.env, MAI_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({
    executablePath:
      process.env.MAI_TEST_EXE ||
      resolve("node_modules/electron/dist/electron.exe"),
    args: process.env.MAI_TEST_EXE ? [] : ["."],
    cwd: resolve("."),
    env,
  });
  await desktop.firstWindow();
  let page;
  await waitFor(() => {
    page = desktop
      .windows()
      .find((candidate) => candidate.url().includes("view=dashboard"));
    return Boolean(page);
  }, "控制面板未打开");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("button", { name: "连接与账号", exact: true }).click();
  await page.locator(".legacy-connection > summary").click();
  // 先保留一个本机凭证，确认导入服务器账号不会覆盖它。
  await page.evaluate(() =>
    window.mai.setCredential(
      "adapterToken",
      "local-test-token-" + "l".repeat(40),
    ),
  );

  async function login(id) {
    await desktop.evaluate(
      ({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [path],
        });
      },
      join(folder, `${id}.json`),
    );
    await page
      .getByRole("button", { name: "导入服务器凭证", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("heading", { name: "本地内核进程", exact: true })
        .count(),
      0,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "打开 MaiBot 管理界面", exact: true })
        .count(),
      0,
    );
    await waitFor(
      async () =>
        (await page.evaluate(() => window.mai.snapshot())).connection.userId ===
        id,
      "服务器账号未连接",
    );
  }
  await login("alice");
  await page.evaluate(() => window.mai.send({ text: "Alice 的私聊记录" }));
  await waitFor(
    async () =>
      (await page.evaluate(() => window.mai.snapshot())).history.some(
        (item) => item.role === "assistant",
      ),
    "Alice 回复未保存",
  );
  await page.screenshot({ path: join(base, "server.png"), fullPage: true });
  assert.equal(
    await page
      .locator("body")
      .evaluate((node) => node.scrollWidth > innerWidth),
    false,
  );
  await login("bob");
  assert.equal(
    (await page.evaluate(() => window.mai.snapshot())).history.length,
    0,
  );
  await page.evaluate(() => window.mai.send({ text: "Bob 的私聊记录" }));
  await login("alice");
  const state = await page.evaluate(() => window.mai.snapshot());
  assert.ok(state.history.some((item) => item.text === "Alice 的私聊记录"));
  assert.ok(!state.history.some((item) => item.text === "Bob 的私聊记录"));
  assert.equal(state.credentials.adapterToken, true);
  assert.equal(state.credentials.serverToken, true);
  const persisted = await readFile(join(profile, "state.json"), "utf8");
  for (const token of Object.values(tokens))
    assert.ok(!persisted.includes(token));
  assert.deepEqual(errors, []);
  assert.ok(!stderr.includes("Traceback"));
  console.log(
    "PASS 多人桌面流程：旧版凭证导入并连接、真实会话、账号历史切换、独立加密凭证、无内核管理入口",
  );
  console.log(`截图：${join(base, "server.png")}`);
} finally {
  await desktop?.close();
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
