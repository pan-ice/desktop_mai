import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { _electron as electron } from "playwright";

// Run the real package main or actual EXE with the plugin factory and SDK context.
// Native dialogs and non-loopback network access are the only replaced edges.
const option = (name) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const mode = option("mode") || "build";
assert.ok(["dev", "build", "packaged"].includes(mode));
const connection = option("connection") || "local";
assert.ok(["local", "server"].includes(connection));
const pluginRoot = resolve(
  option("plugin-root") ||
    process.env.MAI_DESKTOP_ADAPTER_ROOT ||
    "MaiBot/plugins/desktop_pet_adapter",
);
const python =
  process.env.MAI_PYTHON || join(pluginRoot, ".venv/Scripts/python.exe");
await access(python);
await access(join(pluginRoot, "tests/host_fixture.py"));
const executable =
  mode === "packaged"
    ? resolve(
        option("exe") ||
          process.env.MAI_TEST_EXE ||
          "release/win-unpacked/Mai 桌面伙伴.exe",
      )
    : resolve("node_modules/electron/dist/electron.exe");
await access(executable);
const version = JSON.parse(
  await readFile(resolve("package.json"), "utf8"),
).version;
const base = resolve(".cache/gateway-bot-name-smoke", `${mode}-${connection}`);
await mkdir(base, { recursive: true });
const profile = await mkdtemp(join(base, "run-"));
const configPath = join(profile, "config.toml");
const relayPath = join(profile, "relay.json");
const credentialPath = join(profile, "connection.json");
const errors = [];
const events = [];
const report = {
  mode,
  connection,
  pluginRoot,
  version,
  executable,
  entries: [],
  names: [],
  checks: [],
};
let desktop;
let dashboard;
let pet;
let renderer;
let rendererUrl;
let sdk;
let sdkErrors = "";
let launchLog = "";

async function until(check, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (sdk?.exitCode !== null && sdk?.exitCode !== undefined)
      throw new Error(
        `SDK fixture exited (${sdk.exitCode}): ${sdkErrors.slice(-3000)}`,
      );
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(message);
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

const state = () => dashboard.evaluate(() => window.mai.snapshot());
async function navigate(name, page) {
  await dashboard
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
  await dashboard.locator(`.page-${page}`).waitFor();
}

async function launch() {
  const env = { ...process.env, MAI_USER_DATA: profile };
  for (const name of [
    "ELECTRON_RUN_AS_NODE",
    "ELECTRON_RENDERER_URL",
    "ELECTRON_ENTRY",
    "ELECTRON_CLI_ARGS",
    "ELECTRON_EXEC_PATH",
    "NODE_OPTIONS",
  ])
    delete env[name];
  if (mode === "dev") env.ELECTRON_RENDERER_URL = rendererUrl;
  if (mode === "packaged") {
    env.ELECTRON_RUN_AS_NODE = "1";
    env.ELECTRON_RENDERER_URL = "http://127.0.0.1:1";
  }
  desktop = await electron.launch({
    executablePath: executable,
    args: [
      ...(mode === "packaged" ? [] : ["."]),
      "--disable-renderer-backgrounding",
      "--disable-background-networking",
      "--disable-component-update",
    ],
    cwd: mode === "packaged" ? dirname(executable) : resolve("."),
    env,
    timeout: 30000,
  });
  desktop.process().stderr.on("data", (chunk) => {
    launchLog = (launchLog + chunk.toString()).slice(-12000);
  });
  const proof = await desktop.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    executable: process.execPath,
    version: app.getVersion(),
    userData: app.getPath("userData"),
    rendererEnvironment: process.env.ELECTRON_RENDERER_URL || null,
    runAsNodeEnvironment: process.env.ELECTRON_RUN_AS_NODE || null,
  }));
  assert.equal(proof.version, version);
  assert.equal(resolve(proof.userData).toLowerCase(), profile.toLowerCase());
  assert.equal(proof.packaged, mode === "packaged");
  if (mode === "packaged") {
    assert.match(proof.appPath, /[\\/]resources[\\/]app\.asar$/i);
    assert.equal(
      resolve(proof.executable).toLowerCase(),
      executable.toLowerCase(),
    );
    assert.equal(proof.runAsNodeEnvironment, "1");
    assert.equal(proof.rendererEnvironment, "http://127.0.0.1:1");
  } else
    assert.equal(
      resolve(proof.appPath).toLowerCase(),
      resolve(".").toLowerCase(),
    );
  report.entries.push(proof);
  await desktop.evaluate(
    ({ BrowserWindow, dialog, net, session }, paths) => {
      globalThis.__botNameBlockedNetwork = [];
      const local = (host) =>
        !host ||
        host === "localhost" ||
        host === "::1" ||
        /^127\.\d+\.\d+\.\d+$/.test(host);
      const check = (value) => {
        const url = new URL(
          typeof value === "string" || value instanceof URL ? value : value.url,
        );
        if (
          ["http:", "https:", "ws:", "wss:"].includes(url.protocol) &&
          !local(url.hostname.replace(/^\[|\]$/g, ""))
        ) {
          globalThis.__botNameBlockedNetwork.push(url.origin);
          throw new Error(
            "Bot-name smoke blocked non-loopback access: " + url.origin,
          );
        }
      };
      for (const owner of [globalThis, net]) {
        const original = owner.fetch.bind(owner);
        owner.fetch = (value, ...args) => {
          check(value);
          return original(value, ...args);
        };
      }
      const { Socket } = process.getBuiltinModule("node:net");
      const originalConnect = Socket.prototype.connect;
      Socket.prototype.connect = function (...args) {
        const first = Array.isArray(args[0]) ? args[0][0] : args[0];
        const host =
          first && typeof first === "object"
            ? first.host
            : typeof args[1] === "string"
              ? args[1]
              : undefined;
        if (!local(host)) {
          globalThis.__botNameBlockedNetwork.push(String(host));
          throw new Error(
            "Bot-name smoke blocked non-loopback socket: " + host,
          );
        }
        return originalConnect.apply(this, args);
      };
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
        (request, done) => {
          try {
            check(request.url);
            done({});
          } catch {
            done({ cancel: true });
          }
        },
      );
      BrowserWindow.prototype.show = function () {};
      BrowserWindow.prototype.showInactive = function () {};
      for (const window of BrowserWindow.getAllWindows()) window.hide();
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: paths.config,
      });
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [paths.credential],
      });
    },
    { config: configPath, credential: credentialPath },
  );
  await until(() => {
    dashboard = desktop
      .windows()
      .find((page) => page.url().includes("view=dashboard"));
    pet = desktop.windows().find((page) => page.url().includes("view=pet"));
    return dashboard && pet;
  }, "Both real application windows must exist");
  for (const page of [dashboard, pet])
    page.on("pageerror", (error) => errors.push(error.message));
  await dashboard.getByRole("navigation", { name: "主导航" }).waitFor();
  await pet.locator(".pet-character").waitFor();
  const current = await state();
  assert.equal(current.desktop, true);
  assert.equal(current.botName, null);
  if (mode === "dev") {
    assert.equal(new URL(dashboard.url()).origin, rendererUrl);
    assert.equal(new URL(pet.url()).origin, rendererUrl);
  } else {
    assert.ok(dashboard.url().startsWith("file:"));
    assert.ok(pet.url().startsWith("file:"));
  }
}

async function closeDesktop() {
  if (!desktop) return;
  assert.deepEqual(
    await desktop.evaluate(() => globalThis.__botNameBlockedNetwork),
    [],
  );
  await desktop.close();
  desktop = undefined;
}

async function assertName(name, petMode = "connected") {
  await navigate("此刻", "home");
  await until(
    async () =>
      (await dashboard.locator(".stage-name h2").innerText()).includes(name),
    `Home must show ${name}`,
  );
  await navigate("和麦麦聊聊", "chat");
  await dashboard
    .getByRole("heading", { name: `和${name}聊聊`, exact: true })
    .waitFor();
  if (petMode === "connected" || petMode === "greeting") {
    await pet.locator(".pet-character").click();
    await pet.locator(".pet-bubble").waitFor({ state: "visible" });
  }
  if (petMode === "connected")
    await until(
      async () =>
        (await pet.locator(".pet-bubble-status").innerText()).includes(name),
      `Pet must show ${name}`,
    );
  else if (petMode === "greeting")
    assert.ok(
      (await pet.locator(".pet-bubble > p").innerText()).includes(name),
    );
  const current = await state();
  report.names.push({
    name,
    botName: current.botName,
    nickname: current.settings.nickname,
    followBotName: current.settings.followBotName,
    connection: current.connection.phase,
  });
}

async function send(text, expectedBotName, throughUi = true) {
  const repliesBefore = (await state()).history.filter(
    (message) => message.role === "assistant",
  ).length;
  if (throughUi) {
    await navigate("和麦麦聊聊", "chat");
    await dashboard
      .getByRole("textbox", { name: "消息内容", exact: true })
      .fill(text);
    await dashboard
      .getByRole("button", { name: "发送消息", exact: true })
      .click();
  } else await dashboard.evaluate((text) => window.mai.send({ text }), text);
  await until(async () => {
    const current = await state();
    return (
      current.botName === expectedBotName &&
      current.history.some(
        (message) => message.role === "user" && message.text === text,
      ) &&
      current.history.filter((message) => message.role === "assistant").length >
        repliesBefore
    );
  }, "A real SDK reply must deliver its current bot nickname");
}

async function renameCore(name) {
  const before = events.filter((event) => event.event === "bot_name").length;
  sdk.stdin.write(`BOT_NAME ${name}\n`);
  await until(
    () =>
      events.filter((event) => event.event === "bot_name").length ===
      before + 1,
    "SDK fixture must acknowledge the name change",
  );
}

async function setFollowing(follow) {
  await navigate("偏好设置", "settings");
  const toggle = dashboard.getByRole("switch", {
    name: "跟随 MaiBot 名称",
    exact: true,
  });
  if ((await toggle.getAttribute("aria-checked")) !== String(follow))
    await toggle.click();
  await until(
    async () => (await state()).settings.followBotName === follow,
    "The actual follow-name preference must save",
  );
  await dashboard.waitForFunction(
    (value) => {
      const button = document.querySelector(
        'button[role="switch"][aria-label="跟随 MaiBot 名称"]',
      );
      return (
        button?.getAttribute("aria-checked") === String(value) &&
        !button.disabled
      );
    },
    follow,
    { polling: 50, timeout: 10000 },
  );
}

async function reconnect(expectedBotName) {
  await dashboard.evaluate(() => window.mai.connect());
  await until(
    async () =>
      (await state()).connection.phase === "connected" &&
      (await state()).botName === expectedBotName,
    "The actual plugin must reconnect and read the current SDK config name before a reply",
  );
}

async function capture(name) {
  const image = await desktop.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes("view=dashboard"),
    );
    window.webContents.invalidate();
    await window.webContents.capturePage(undefined, {
      stayHidden: true,
      stayAwake: true,
    });
    await new Promise((done) => setTimeout(done, 50));
    return (
      await window.webContents.capturePage(undefined, {
        stayHidden: true,
        stayAwake: true,
      })
    )
      .toPNG()
      .toString("base64");
  });
  await writeFile(join(base, name), Buffer.from(image, "base64"));
}

try {
  await writeFile(
    join(profile, "state.json"),
    JSON.stringify({
      version: 2,
      settings: {
        nickname: "本地备用",
        userName: "初始用户",
        followBotName: true,
        adapterPort: 0,
        autoConnect: false,
        launchAtLogin: false,
        reducedMotion: true,
        voiceEnabled: false,
      },
      history: [],
      models: [],
      encrypted: {},
    }),
  );
  if (mode === "dev") {
    const { createServer: createViteServer } = await import("vite");
    renderer = await createViteServer({
      configFile: resolve("vite.config.ts"),
      cacheDir: join(profile, "vite-cache"),
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    renderer.watcher.on("error", (error) =>
      errors.push(`Vite watcher: ${error.message}`),
    );
    await renderer.listen();
    rendererUrl = `http://127.0.0.1:${renderer.httpServer.address().port}`;
  }
  await launch();
  assert.equal((await state()).settings.followBotName, true);
  await assertName("本地备用", "greeting");
  if (connection === "local") {
    assert.equal(
      await dashboard.evaluate(() => window.mai.exportAdapterConfig()),
      true,
    );
    await until(async () => {
      try {
        await access(configPath);
        return (await state()).connection.phase === "connecting";
      } catch {
        return false;
      }
    }, "The actual exportAdapterConfig must bind and export the plugin port");
  } else {
    const relayPort = await freePort();
    const backendToken = "gateway-name-backend-" + "b".repeat(40);
    const desktopToken = "gateway-name-desktop-" + "d".repeat(40);
    const digest = (value) => createHash("sha256").update(value).digest("hex");
    await writeFile(
      relayPath,
      JSON.stringify({
        port: relayPort,
        backend_token_sha256: digest(backendToken),
        users: [
          {
            id: "gateway_name_user",
            name: "测试用户",
            token_sha256: digest(desktopToken),
          },
        ],
      }),
    );
    await writeFile(
      configPath,
      `[plugin]\nmode = "server"\nconfig_version = "1.1.0"\n[server]\nrelay_url = "ws://127.0.0.1:${relayPort}/adapter"\ntoken = "${backendToken}"\nauto_start = false\n[identity]\nplatform = "desktop_pet"\naccount_id = "mai_desktop_pet"\nuser_id = "server"\nscope = ""\n`,
    );
    await writeFile(
      credentialPath,
      JSON.stringify({
        format: "mai-desktop-server",
        version: 1,
        serverUrl: `ws://127.0.0.1:${relayPort}/desktop`,
        token: desktopToken,
      }),
    );
    assert.equal(
      await dashboard.evaluate(() => window.mai.importServerConnection()),
      true,
    );
  }
  const sdkEnv = {
    ...process.env,
    PYTHONUTF8: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    MAI_TEST_BOT_NAME: "云端一号",
  };
  delete sdkEnv.MAIBOT_TOKEN;
  delete sdkEnv.MAI_DESKTOP_TOKEN;
  sdk = spawn(
    python,
    [
      join(pluginRoot, "tests/host_fixture.py"),
      configPath,
      ...(connection === "server" ? [relayPath] : []),
    ],
    { cwd: profile, windowsHide: true, stdio: "pipe", env: sdkEnv },
  );
  sdk.stderr.on("data", (data) => {
    sdkErrors = (sdkErrors + data.toString()).slice(-16000);
  });
  sdk.on("error", (error) => errors.push(`SDK fixture: ${error.message}`));
  const lines = createInterface({ input: sdk.stdout });
  lines.on("line", (line) => {
    try {
      events.push(JSON.parse(line));
    } catch {
      /* SDK diagnostics */
    }
  });
  sdk.once("exit", () => lines.close());
  await until(
    () => events.some((event) => event.event === "started"),
    "The real plugin factory must load",
  );
  if (connection === "server")
    await dashboard.evaluate(() => window.mai.connect());
  await until(
    async () =>
      (await state()).connection.phase === "connected" &&
      (await state()).botName === "云端一号",
    "Real plugin ready must supply the configured SDK name before any chat reply",
  );
  assert.equal((await state()).connection.transport, "gateway");
  assert.equal(
    (await state()).history.filter((message) => message.role === "assistant")
      .length,
    0,
  );
  assert.equal(events.filter((event) => event.event === "inbound").length, 0);
  assert.ok(events.some((event) => event.event === "config-get"));
  await assertName("云端一号");
  await send("首次自动取名", "云端一号");
  await assertName("云端一号");
  assert.equal((await state()).settings.nickname, "本地备用");
  report.checks.push(
    "Real plugin factory and public SDK config.get(bot.nickname) populate ready before any chat request, preserving manual fallback in dashboard/chat/pet",
  );

  await renameCore("云端二号");
  assert.equal((await state()).botName, "云端一号");
  await send("内核改名同步", "云端二号");
  await assertName("云端二号");
  await setFollowing(false);
  await assertName("本地备用");
  await setFollowing(true);
  await assertName("云端二号");
  report.checks.push(
    "Changed SDK bot.nickname config updates on the next valid reply; disabling/re-enabling follow preserves both names",
  );

  await navigate("偏好设置", "settings");
  await dashboard.getByLabel("你的名字", { exact: true }).fill("改后的用户");
  await dashboard
    .getByRole("button", { name: "保存称呼", exact: true })
    .click();
  await until(
    async () => (await state()).settings.userName === "改后的用户",
    "User-only name change must save",
  );
  assert.equal((await state()).settings.followBotName, true);
  assert.equal((await state()).settings.nickname, "本地备用");
  await reconnect("云端二号");
  await send("用户名修改后重新取名", "云端二号");
  await navigate("偏好设置", "settings");
  const nickname = dashboard.getByLabel("桌宠的名字", { exact: true });
  await nickname.fill("未保存草稿");
  await renameCore("云端三号");
  await send("草稿期间同步名字", "云端三号", false);
  assert.equal(await nickname.inputValue(), "未保存草稿");
  assert.equal((await state()).settings.nickname, "本地备用");
  await nickname.fill("我的专属名");
  await dashboard
    .getByRole("button", { name: "保存称呼", exact: true })
    .click();
  await until(
    async () =>
      (await state()).settings.nickname === "我的专属名" &&
      !(await state()).settings.followBotName,
    "Explicit manual-name save must disable follow",
  );
  await assertName("我的专属名");
  await setFollowing(true);
  await assertName("云端三号");
  report.checks.push(
    "Saving only user name keeps follow enabled; incoming metadata preserves an unsaved manual draft; explicit manual-name save disables follow and remains reversible",
  );

  await dashboard.evaluate(() => window.mai.disconnect());
  assert.equal((await state()).botName, null);
  await assertName("我的专属名", "none");
  await renameCore("重连后的名字");
  await reconnect("重连后的名字");
  await assertName("重连后的名字");
  await renameCore("重载后的名字");
  const reloadsBefore = events.filter(
    (event) => event.event === "reloaded",
  ).length;
  sdk.stdin.write("RELOAD\n");
  await until(
    () =>
      events.filter((event) => event.event === "reloaded").length ===
      reloadsBefore + 1,
    "The real plugin must unload and reload",
  );
  await until(
    async () =>
      (await state()).connection.phase === "connected" &&
      (await state()).botName === "重载后的名字",
    "Plugin reload must supply a fresh config name",
  );
  await assertName("重载后的名字");
  await send("插件重载后继续聊天", "重载后的名字");
  await navigate("偏好设置", "settings");
  assert.equal(
    await dashboard.getByLabel("桌宠的名字", { exact: true }).inputValue(),
    "我的专属名",
  );
  await capture("settings-auto-name.png");
  await closeDesktop();
  const persisted = JSON.parse(
    await readFile(join(profile, "state.json"), "utf8"),
  );
  assert.equal(persisted.settings.nickname, "我的专属名");
  assert.equal(persisted.settings.followBotName, true);
  assert.equal("botName" in persisted, false);
  assert.equal("botName" in persisted.settings, false);
  await launch();
  assert.equal((await state()).settings.nickname, "我的专属名");
  assert.equal((await state()).settings.followBotName, true);
  assert.equal((await state()).botName, null);
  await assertName("我的专属名", "none");
  await reconnect("重载后的名字");
  await send("重启后继续聊天", "重载后的名字");
  await assertName("重载后的名字");
  await navigate("此刻", "home");
  await capture("home-auto-name.png");
  report.checks.push(
    "Disconnect clears runtime names; reconnect and actual plugin reload read current config at ready; application restart preserves manual preference without persisting botName",
  );
  const nameReads = events.filter((event) => event.event === "config-get");
  assert.ok(nameReads.length >= 5);
  for (const event of nameReads)
    assert.deepEqual(event.args, { key: "bot.nickname", default: null });
  report.configReads = nameReads;
  assert.deepEqual(errors, []);
  assert.equal(sdkErrors.includes("Traceback"), false);
  await closeDesktop();
  await rm(join(base, "failure.json"), { force: true });
  await writeFile(
    join(base, "result.json"),
    JSON.stringify({ passed: true, ...report, errors }, null, 2),
  );
  console.log(
    `PASS ${mode}/${connection} 网关自动MaiBot名称：真实插件与SDK、ready取名、三视图、手动名、断开与重载`,
  );
} catch (error) {
  if (desktop && dashboard) await capture("failure.png").catch(() => {});
  await writeFile(
    join(base, "failure.json"),
    JSON.stringify(
      {
        passed: false,
        ...report,
        message: error.message,
        stack: error.stack,
        errors,
        sdkErrors,
        launchLog,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  if (sdk && sdk.exitCode === null) {
    const exited = once(sdk, "exit");
    sdk.stdin.end("STOP\n");
    const timeout = setTimeout(() => sdk.kill(), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timeout);
    }
  }
  await desktop?.close().catch(() => {});
  await renderer?.close();
  assert.ok(resolve(profile).startsWith(base + sep));
  await rm(profile, { recursive: true, force: true });
}
