import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve, sep } from "node:path";
import { _electron as electron } from "playwright";
import WebSocket from "ws";
import { createGlb } from "./model-fixture.mjs";

// One interaction suite, three real application entries. Never replace the
// packaged entry with a bootstrap or redefine app.isPackaged/getAppPath.
const option = (name) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const mode = option("mode") || "build";
const withLive2D = process.argv.includes("--live2d");
assert.ok(
  ["dev", "build", "packaged"].includes(mode),
  "Use --mode=dev|build|packaged",
);
const executable =
  mode === "packaged"
    ? resolve(
        option("exe") ||
          process.env.MAI_TEST_EXE ||
          "release/win-unpacked/Mai 桌面伙伴.exe",
      )
    : resolve("node_modules/electron/dist/electron.exe");
await access(executable);
const packageInfo = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const live2dCache = resolve(".cache/live2d-compat");
const live2dFixtures = [
  {
    name: "Shizuku",
    file: join(live2dCache, "Shizuku/shizuku.model.json"),
    core: "legacy",
  },
  {
    name: "Haru",
    file: join(live2dCache, "Haru/haru_greeter_t03.model3.json"),
    core: "modern",
  },
  {
    name: "Mao",
    file: join(live2dCache, "Mao/mao_pro.model3.json"),
    core: "modern",
  },
];
const coreSources = {};
if (withLive2D) {
  for (const fixture of live2dFixtures) await access(fixture.file);
  for (const core of [
    {
      file: "live2d.min.js",
      digest:
        "96cd98047edc7ff319c35c344ede4dc62a286d3c7e1173e5365e7a7ea6bad69e",
      url: "https://raw.githubusercontent.com/Project-N-E-K-O/N.E.K.O/c65adc2bb467c812c5fd948c8031aa96d48c0e14/static/libs/live2d.min.js",
    },
    {
      file: "live2dcubismcore.min.js",
      digest:
        "25ae938cb4fe282ce189b357bcc97e603d1e1f7ec78bf04150d401c23cdc792f",
      url: "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js",
    },
  ]) {
    const bytes = await readFile(join(live2dCache, core.file));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      core.digest,
      "Cached Core must match the independently pinned digest",
    );
    coreSources[core.url] = bytes.toString("utf8");
  }
}
const base = resolve(".cache/runtime-smoke", mode);
await mkdir(base, { recursive: true });
const profile = await mkdtemp(join(base, "run-"));
const errors = [];
const requests = [];
const mediaRequests = [];
const sockets = new Set();
const live2dModels = [];
const assetErrors = [];
const report = {
  mode,
  executable,
  entry: null,
  rendererOrigin: null,
  checks: [],
};
const pixel = await readFile(resolve("resources/icon.png"));
await writeFile(join(profile, "runtime-image.png"), pixel);
await writeFile(join(profile, "runtime-model.glb"), createGlb());
const wav = Buffer.alloc(44 + 16000);
wav.write("RIFF");
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(wav.length - 44, 40);
const service = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    mediaRequests.push({ path: request.url, bytes: bytes.length });
    if (request.url === "/v1/audio/transcriptions") {
      assert.equal(request.headers.authorization, "Bearer runtime-fake-key");
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ text: "虚拟麦克风的运行时转写" }));
    } else if (request.url === "/v1/audio/speech") {
      response.setHeader("Content-Type", "audio/wav");
      response.end(wav);
    } else response.writeHead(404).end();
  } catch (error) {
    errors.push(`Local media fixture: ${error.message}`);
    response.writeHead(500).end();
  }
});
service.listen(0, "127.0.0.1");
await once(service, "listening");
const origin = `http://127.0.0.1:${service.address().port}`;
await writeFile(
  join(profile, "state.json"),
  JSON.stringify({
    version: 2,
    settings: {
      autoConnect: false,
      launchAtLogin: false,
      reducedMotion: true,
      voiceEnabled: false,
      adapterPort: 0,
      speechBaseUrl: `${origin}/v1`,
      sttModel: "runtime-asr",
      speechVolume: 0,
    },
    history: [],
    models: [],
    encrypted: {},
  }),
);

let desktop;
let dashboard;
let pet;
let renderer;
let watcherLock;
let watcherLockFile;
let config;
let launchLog = "";
let rendererUrl = option("renderer-url");
let offlineCores = false;
const pause = (milliseconds) =>
  new Promise((done) => setTimeout(done, milliseconds));
async function until(check, message, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(30);
  }
  throw new Error(message);
}
function localOrigin(value) {
  const url = new URL(value);
  assert.ok(["http:", "https:"].includes(url.protocol));
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
    "Development renderer must be loopback only",
  );
  return url.origin;
}
const state = () => dashboard.evaluate(() => window.mai.snapshot());
async function navigate(name, page) {
  await dashboard
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
  await dashboard.locator(`.page-${page}`).waitFor();
}
async function capture(filename, view = "dashboard") {
  const encoded = await desktop.evaluate(async ({ BrowserWindow }, view) => {
    const window = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes(`view=${view}`),
    );
    // A first capture wakes a never-shown compositor but can contain its prior
    // frame. Read a second frame after invalidation instead of using it as proof.
    await window.webContents.capturePage(undefined, {
      stayHidden: true,
      stayAwake: true,
    });
    window.webContents.invalidate();
    await new Promise((done) => setTimeout(done, 100));
    const image = await window.webContents.capturePage(undefined, {
      stayHidden: true,
      stayAwake: true,
    });
    if (image.isEmpty()) throw new Error("Runtime capture was empty");
    return image.toPNG().toString("base64");
  }, view);
  await writeFile(join(base, filename), Buffer.from(encoded, "base64"));
}
async function installFixtures() {
  await desktop.evaluate(
    (
      {
        BrowserWindow,
        desktopCapturer,
        dialog,
        nativeImage,
        net,
        session,
        shell,
      },
      fixture,
    ) => {
      globalThis.__runtimeNetworkBlocked = [];
      globalThis.__runtimeCoreRequests = [];
      const loopback = (host) =>
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
          !loopback(url.hostname.replace(/^\[|\]$/g, ""))
        ) {
          globalThis.__runtimeNetworkBlocked.push(url.origin);
          throw new Error(
            "Runtime smoke blocked a non-loopback request: " + url.origin,
          );
        }
      };
      for (const owner of [globalThis, net]) {
        const original = owner.fetch.bind(owner);
        owner.fetch = (value, ...args) => {
          const source = fixture.coreSources[String(value)];
          if (owner === net && source) {
            globalThis.__runtimeCoreRequests.push(String(value));
            if (fixture.offlineCores)
              throw new Error(
                "Offline restart attempted to download a cached Core",
              );
            return Promise.resolve(
              new Response(source, {
                headers: { "Content-Type": "application/javascript" },
              }),
            );
          }
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
        if (!loopback(host)) {
          globalThis.__runtimeNetworkBlocked.push(String(host));
          throw new Error(
            "Runtime smoke blocked a non-loopback socket: " + host,
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
      // Patch fixtures only after the real main entry has been executed.
      BrowserWindow.prototype.show = function () {};
      BrowserWindow.prototype.showInactive = function () {};
      for (const window of BrowserWindow.getAllWindows()) window.hide();
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.setBackgroundThrottling(false);
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: fixture.configPath,
      });
      dialog.showOpenDialog = async () =>
        globalThis.__runtimeOpenDialog || { canceled: true, filePaths: [] };
      globalThis.__runtimeOpenDialog = null;
      shell.openExternal = async (url) => {
        check(url);
      };
      desktopCapturer.getSources = async () => [
        {
          id: "screen:runtime:0",
          name: "运行时测试屏幕",
          display_id: "runtime",
          appIcon: null,
          thumbnail: nativeImage.createFromBuffer(
            Buffer.from(fixture.pixel, "base64"),
          ),
        },
      ];
    },
    {
      configPath: join(profile, "runtime-config.toml"),
      pixel: pixel.toString("base64"),
      coreSources,
      offlineCores,
    },
  );
}
async function launch() {
  const env = { ...process.env, MAI_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  delete env.NODE_OPTIONS;
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
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--mute-audio",
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
  assert.equal(
    proof.packaged,
    mode === "packaged",
    "A packaged run must use a real packaged executable",
  );
  assert.equal(
    proof.version,
    packageInfo.version,
    "Run the current application version rather than an older release",
  );
  assert.equal(resolve(proof.userData).toLowerCase(), profile.toLowerCase());
  assert.equal(
    resolve(proof.executable).toLowerCase(),
    executable.toLowerCase(),
  );
  if (mode === "packaged")
    assert.match(proof.appPath, /[\\/]resources[\\/]app\.asar$/i);
  else
    assert.equal(
      resolve(proof.appPath).toLowerCase(),
      resolve(".").toLowerCase(),
    );
  report.entry = proof;
  await installFixtures();
  await desktop.firstWindow();
  await until(() => {
    dashboard = desktop
      .windows()
      .find((page) => page.url().includes("view=dashboard"));
    pet = desktop.windows().find((page) => page.url().includes("view=pet"));
    return Boolean(dashboard && pet);
  }, "Real application entry did not open both views");
  for (const page of [dashboard, pet])
    page.on("pageerror", (error) => errors.push(error.message));
  // Respect the real entry's awaited first navigation before installing a
  // reload-time observer; aborting that navigation correctly fails startup.
  await Promise.all([
    dashboard.waitForLoadState("load"),
    pet.waitForLoadState("load"),
  ]);
  await dashboard.locator(".app-shell").waitFor({ timeout: 20000 });
  await pet.locator(".pet-character").waitFor({ timeout: 20000 });
  if (withLive2D) {
    for (const page of [dashboard, pet]) {
      page.on("response", (response) => {
        if (
          response.url().startsWith("mai-asset:") &&
          response.status() >= 400 &&
          !response.url().includes(".cdi3.json")
        )
          assetErrors.push(`${response.status()} ${response.url()}`);
      });
      await page.addInitScript(observeLive2D);
      await page.reload();
    }
  }
  await dashboard.locator(".app-shell").waitFor({ timeout: 20000 });
  await pet.locator(".pet-character").waitFor({ timeout: 20000 });
  for (const page of [dashboard, pet]) {
    const url = new URL(page.url());
    if (mode === "dev")
      assert.equal(
        url.origin,
        rendererUrl,
        "Development run must load the local Vite renderer",
      );
    else
      assert.equal(
        url.protocol,
        "file:",
        "Build and packaged runs must load bundled renderer files",
      );
  }
  report.rendererOrigin = mode === "dev" ? rendererUrl : dashboard.url();
  if (mode === "packaged") {
    assert.equal(proof.rendererEnvironment, "http://127.0.0.1:1");
    report.checks.push(
      "Real packaged GUI entry ignores ELECTRON_RUN_AS_NODE=1 and an intentionally stale loopback ELECTRON_RENDERER_URL, loading bundled files",
    );
  }
  assert.equal(
    await pet
      .locator("html")
      .evaluate((element) => getComputedStyle(element).backgroundColor),
    "rgba(0, 0, 0, 0)",
  );
  await dashboard.evaluate(() => {
    window.__runtimeTracks = [];
    window.__runtimeMediaPlayed = 0;
    const originalGet = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (options) => {
      const stream = await originalGet(options);
      window.__runtimeTracks.push(...stream.getTracks());
      return stream;
    };
    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      window.__runtimeMediaPlayed++;
      return originalPlay.apply(this, args);
    };
  });
}
async function closeDesktop() {
  const blocked = await desktop.evaluate(
    () => globalThis.__runtimeNetworkBlocked,
  );
  assert.deepEqual(blocked, []);
  await desktop.close();
  desktop = undefined;
}
async function readExport() {
  let text;
  await until(async () => {
    try {
      text = await readFile(join(profile, "runtime-config.toml"), "utf8");
      return text.includes("[desktop]") && text.includes("[identity]");
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }, "UI export did not write a complete configuration");
  const section = text.match(/\[desktop\]([\s\S]*?)(?=\n\[|$)/)?.[1];
  assert.ok(
    section,
    "Independent adapter config must include its desktop section",
  );
  const value = (key) =>
    JSON.parse(section.match(new RegExp(`^${key} = (".*")$`, "m"))[1]);
  const url = value("url");
  const port = Number(new URL(url).port);
  assert.ok(port > 0);
  assert.equal(port, (await state()).settings.adapterPort);
  const disk = JSON.parse(await readFile(join(profile, "state.json"), "utf8"));
  assert.equal(disk.settings.adapterPort, port);
  return { url, port, token: value("token") };
}
async function connectAdapter() {
  const current = await state();
  const socket = new WebSocket(config.url, {
    headers: { Authorization: `Bearer ${config.token}` },
  });
  const sessionId = `runtime-${randomUUID()}`;
  const frame = (value) => socket.send(JSON.stringify(value));
  sockets.add(socket);
  socket.on("error", (error) => errors.push(`Adapter: ${error.message}`));
  socket.on("message", (raw) => {
    const value = JSON.parse(raw.toString());
    if (value.type === "welcome")
      frame({
        v: 1,
        type: "ready",
        sessionId,
        transport: "legacy",
        capabilities: ["chat", "image", "audio"],
      });
    if (value.type === "request") {
      requests.push(value);
      frame({ v: 1, type: "result", id: value.id, ok: true });
      frame({
        v: 1,
        type: "reply",
        id: randomUUID(),
        sessionId,
        segments: [{ type: "text", text: `本机收到：${value.params.text}` }],
      });
    }
  });
  await once(socket, "open");
  frame({
    v: 1,
    type: "hello",
    protocol: "mai-desktop",
    pluginVersion: "0.4.5",
    instanceId: randomUUID(),
    startedAt: Date.now(),
    identity: {
      platform: current.settings.platform,
      accountId: current.settings.botId,
      userId: current.settings.userId,
      scope: current.settings.adapterScope,
    },
  });
  await until(
    async () =>
      (await state()).connection.sessionId === sessionId &&
      (await state()).connection.phase === "connected",
    "Real local adapter handshake failed",
  );
  return { socket, sessionId };
}
async function checkPagesAndSettings() {
  for (const [name, page] of [
    ["此刻", "home"],
    ["和麦麦聊聊", "chat"],
    ["角色衣橱", "models"],
    ["声音与感知", "senses"],
    ["连接与账号", "core"],
    ["偏好设置", "settings"],
  ]) {
    await navigate(name, page);
    assert.equal(
      await dashboard
        .locator("body")
        .evaluate((body) => body.scrollWidth > innerWidth),
      false,
      `${page} must fit the actual runtime window`,
    );
  }
  const nickname = dashboard.getByRole("textbox", {
    name: "桌宠的名字",
    exact: true,
  });
  await nickname.fill("运行时伙伴");
  const toggle = dashboard.getByRole("switch", {
    name: "始终置顶",
    exact: true,
  });
  await toggle.click();
  await until(
    async () => !(await state()).settings.alwaysOnTop,
    "Setting switch did not save through real IPC",
  );
  assert.equal(await nickname.inputValue(), "运行时伙伴");
  await dashboard
    .getByRole("button", { name: "保存称呼", exact: true })
    .click();
  await until(
    async () => (await state()).settings.nickname === "运行时伙伴",
    "Name did not save",
  );
  const metrics = await dashboard.evaluate(() => ({
    width: innerWidth,
    font: getComputedStyle(document.querySelector("h1")).fontSize,
  }));
  const slider = dashboard.getByRole("slider", { name: /角色大小/ });
  await slider.focus();
  await dashboard.keyboard.press("ArrowRight");
  await dashboard.keyboard.press("ArrowRight");
  await until(
    async () => Math.abs((await state()).settings.petScale - 1.1) < 0.00001,
    "Repeated keyboard scale changes did not persist",
  );
  assert.equal(
    await slider.evaluate((element) => element === document.activeElement),
    true,
  );
  assert.deepEqual(
    await dashboard.evaluate(() => ({
      width: innerWidth,
      font: getComputedStyle(document.querySelector("h1")).fontSize,
    })),
    metrics,
  );
  await pet.waitForFunction(() => Math.abs(innerWidth - 374) <= 1);
  report.checks.push(
    "Six real pages, UI setting/draft save, repeated keyboard scale and independent window sizing",
  );
}
async function checkPortsAndChat() {
  await navigate("连接与账号", "core");
  const exportButton = dashboard.getByRole("button", {
    name: "导出配置并开启接入",
    exact: true,
  });
  await exportButton.click();
  await until(
    async () => (await state()).settings.adapterPort > 0,
    "UI export did not allocate a real port",
  );
  config = await readExport();
  await until(
    () => exportButton.isEnabled(),
    "Initial UI export did not complete",
  );
  const peer = await connectAdapter();
  await exportButton.click();
  await until(
    () => exportButton.isEnabled(),
    "Repeated UI export did not complete",
  );
  await until(
    async () => (await state()).connection.sessionId === peer.sessionId,
    "Repeat export interrupted the active session",
  );
  assert.equal((await readExport()).port, config.port);
  assert.equal(peer.socket.readyState, WebSocket.OPEN);
  await navigate("和麦麦聊聊", "chat");
  const text = dashboard.getByRole("textbox", {
    name: "消息内容",
    exact: true,
  });
  await text.fill(`真实${mode}入口的文字交互`);
  await text.press("Enter");
  await dashboard
    .getByText(`本机收到：真实${mode}入口的文字交互`, { exact: true })
    .waitFor();
  await until(
    async () => (await text.inputValue()) === "",
    "Successful chat did not clear its submitted draft",
  );
  report.checks.push(
    "Automatic port export, saved real port, real hello/ready, repeated export and UI text roundtrip",
  );
}
async function checkMedia() {
  const before = requests.length;
  await dashboard
    .getByRole("button", { name: "选择屏幕截图", exact: true })
    .click();
  await dashboard
    .getByRole("button", { name: "开启并选择屏幕", exact: true })
    .click();
  await dashboard
    .locator(".screen-grid button")
    .filter({ hasText: "运行时测试屏幕" })
    .click();
  await dashboard.getByAltText("待发送截图", { exact: true }).waitFor();
  assert.equal(
    requests.length,
    before,
    "Screen capture must wait for explicit send",
  );
  await dashboard
    .getByRole("button", { name: "发送消息", exact: true })
    .click();
  await until(
    () => requests.length === before + 1,
    "Fixture screenshot did not reach the local adapter",
  );
  assert.match(requests.at(-1).params.image, /^data:image\/jpeg;base64,/);
  await dashboard
    .getByRole("button", { name: "摄像头分享", exact: true })
    .click();
  await dashboard.waitForFunction(
    () => document.querySelector(".camera-preview video")?.videoWidth > 0,
  );
  await dashboard
    .getByRole("button", { name: "拍照并预览", exact: true })
    .click();
  await dashboard.getByAltText("待发送的摄像头照片", { exact: true }).waitFor();
  await dashboard
    .getByRole("button", { name: "发送给运行时伙伴", exact: true })
    .click();
  await dashboard
    .getByRole("dialog", { name: "分享眼前的小世界", exact: true })
    .waitFor({ state: "detached" });
  await until(
    () => requests.length === before + 2,
    "Virtual-camera photo did not reach the local adapter",
  );
  await dashboard.waitForFunction(() =>
    window.__runtimeTracks.every((track) => track.readyState === "ended"),
  );
  await dashboard.evaluate(async () => {
    await window.mai.setCredential("speechKey", "runtime-fake-key");
  });
  await dashboard
    .getByRole("button", { name: "语音输入", exact: true })
    .click();
  await dashboard
    .getByRole("button", { name: "结束录音并发送", exact: true })
    .waitFor();
  await pause(1800);
  await dashboard
    .getByRole("button", { name: "结束录音并发送", exact: true })
    .click();
  await until(
    () =>
      requests.some(
        (request) => request.params.text === "虚拟麦克风的运行时转写",
      ),
    "Virtual microphone did not transcribe and send through real media/IPC",
  );
  assert.ok(
    mediaRequests.some(
      (request) =>
        request.path === "/v1/audio/transcriptions" && request.bytes > 1500,
    ),
  );
  await dashboard.waitForFunction(() =>
    window.__runtimeTracks.every((track) => track.readyState === "ended"),
  );
  await capture("chat-media.png");
  report.checks.push(
    "Explicit fixture screenshot send, Chromium virtual camera photo, actual MediaRecorder/local ASR and track release",
  );
  await dashboard.evaluate(async (origin) => {
    await window.mai.updateSettings({
      ttsEngine: "api",
      ttsProvider: "openai",
      speechVolume: 0,
      ttsProfiles: {
        openai: {
          baseUrl: `${origin}/v1`,
          model: "tts-1",
          voice: "alloy",
          resourceId: "",
        },
      },
    });
  }, origin);
  await navigate("声音与感知", "senses");
  const beforePlayed = await dashboard.evaluate(
    () => window.__runtimeMediaPlayed,
  );
  await dashboard
    .getByRole("button", { name: "试听声音", exact: true })
    .click();
  await until(
    async () =>
      (await dashboard.evaluate(() => window.__runtimeMediaPlayed)) >
      beforePlayed,
    "Local synthesis did not reach real HTMLMediaElement playback",
  );
  assert.ok(
    mediaRequests.some((request) => request.path === "/v1/audio/speech"),
  );
  report.checks.push(
    "Local TTS fixture and real muted HTMLMediaElement playback",
  );
}
async function checkModels() {
  await navigate("角色衣橱", "models");
  for (const filename of ["runtime-image.png", "runtime-model.glb"]) {
    await desktop.evaluate(
      ({ dialog }, path) => {
        globalThis.__runtimeOpenDialog = { canceled: false, filePaths: [path] };
      },
      join(profile, filename),
    );
    await dashboard
      .getByRole("button", { name: "导入角色", exact: true })
      .click();
    await dashboard
      .getByRole("heading", {
        name: filename.replace(/\.[^.]+$/, ""),
        exact: true,
      })
      .waitFor();
  }
  await until(
    async () => (await state()).models.length === 2,
    "Both fixture models must be persisted",
  );
  await navigate("此刻", "home");
  await dashboard.locator(".stage-avatar canvas").waitFor({ timeout: 20000 });
  await pet.locator(".model-canvas canvas").waitFor({ timeout: 20000 });
  const imageModel = (await state()).models.find(
    (model) => model.kind === "image",
  );
  assert.equal(
    await dashboard.evaluate(
      (url) => fetch(url).then((response) => response.status),
      imageModel.assetUrl,
    ),
    200,
  );
  await capture("home-model.png");
  report.checks.push(
    "Image and GLB import through real dialogs/IPC, packaged asset protocol and actual 3D canvases in both views",
  );
}

function observeLive2D() {
  window.__runtimeLive2dApps = [];
  const registered = new Set();
  let pixi;
  Object.defineProperty(window, "PIXI", {
    configurable: true,
    get: () => pixi,
    set(value) {
      pixi = value;
      if (registered.has(value.Application)) return;
      registered.add(value.Application);
      value.extensions.add({
        extension: value.ExtensionType.Application,
        init() {
          window.__runtimeLive2dApps.push(this);
        },
        destroy() {},
      });
    },
  });
}
function live2dStats() {
  const app = window.__runtimeLive2dApps?.findLast(
    (candidate) =>
      candidate.stage?.children.length && candidate.view.isConnected,
  );
  if (!app) return null;
  app.render();
  const pixels = app.renderer.extract.pixels();
  let visible = 0;
  for (let index = 3; index < pixels.length; index += 4)
    if (pixels[index]) visible++;
  const internal = app.stage.children[0].internalModel;
  return {
    entry: internal.settings.url,
    visible,
    physics: Boolean(internal.physics),
    pose: Boolean(internal.pose),
    motions: Object.keys(internal.motionManager.definitions),
  };
}
async function assertLive2D(model, name, phase) {
  const views = [];
  for (const [view, page] of [
    ["dashboard", dashboard],
    ["pet", pet],
  ]) {
    await until(
      async () => {
        const failures = await page.locator(".avatar-error").allTextContents();
        if (failures.length)
          throw new Error(`${phase} ${name} ${view}: ${failures.join(" ")}`);
        const stats = await page.evaluate(live2dStats);
        return stats?.entry.includes(model.id) && stats.visible > 100;
      },
      `${phase} ${name} ${view} did not render visible model pixels`,
      25000,
    );
    const scripts = await page.evaluate(() =>
      [...document.head.querySelectorAll("script[src]")].map(
        (script) => script.src,
      ),
    );
    assert.ok(
      scripts.includes(model.coreUrl),
      `${name} must execute its verified mai-asset runtime script`,
    );
    const canvasImage = `live2d-${name}-${phase}-${view}-pixels.png`;
    const pixels = await page.evaluate(() => {
      const app = window.__runtimeLive2dApps.findLast(
        (candidate) =>
          candidate.stage?.children.length && candidate.view.isConnected,
      );
      app.render();
      return app.renderer.extract.canvas().toDataURL("image/png").split(",")[1];
    });
    await writeFile(join(base, canvasImage), Buffer.from(pixels, "base64"));
    views.push({ view, canvasImage, ...(await page.evaluate(live2dStats)) });
  }
  (report.live2d ||= []).push({ name, phase, id: model.id, views });
}
async function checkLive2D() {
  for (const fixture of live2dFixtures) {
    await navigate("角色衣橱", "models");
    const before = (await state()).models.length;
    await desktop.evaluate((_, path) => {
      globalThis.__runtimeOpenDialog = { canceled: false, filePaths: [path] };
    }, fixture.file);
    await dashboard
      .getByRole("button", { name: "导入角色", exact: true })
      .click();
    await until(
      async () => (await state()).models.length === before + 1,
      `${fixture.name} was not imported through the wardrobe`,
      25000,
    );
    const model = (await state()).models.at(-1);
    assert.equal(model.kind, "live2d");
    assert.ok(model.coreUrl.startsWith("mai-asset://runtime/"));
    assert.equal(
      model.coreUrl.includes("/live2d.min.js?"),
      fixture.core === "legacy",
    );
    live2dModels.push({ ...model, fixtureName: fixture.name });
    await navigate("此刻", "home");
    await assertLive2D(model, fixture.name, "import");
    await capture(`live2d-${fixture.name}.png`);
    await capture(`live2d-${fixture.name}-pet.png`, "pet");
  }
  const coreRequests = await desktop.evaluate(
    () => globalThis.__runtimeCoreRequests,
  );
  assert.equal(
    coreRequests.length,
    2,
    "Three model generations must reuse two pinned local Core responses",
  );
  assert.equal(new Set(coreRequests).size, 2);
  assert.deepEqual(assetErrors, []);
  report.checks.push(
    "Wardrobe imports Shizuku/Haru/Mao through real IPC; two digest-verified Core fixtures, mai-asset scripts/textures and visible pixels in both windows",
  );
}
async function checkOfflineLive2D() {
  for (const model of live2dModels) {
    await navigate("角色衣橱", "models");
    if ((await state()).settings.activeModelId !== model.id)
      await dashboard
        .getByRole("button", { name: `使用 ${model.name}`, exact: true })
        .click();
    await until(
      async () => (await state()).settings.activeModelId === model.id,
      "Offline wardrobe selection did not save",
    );
    await navigate("此刻", "home");
    await assertLive2D(model, model.fixtureName, "offline-restart");
  }
  assert.deepEqual(
    await desktop.evaluate(() => globalThis.__runtimeCoreRequests),
    [],
    "Restart must use persisted runtime files without even requesting a Core fixture",
  );
  assert.deepEqual(assetErrors, []);
  report.checks.push(
    "Real-entry offline restart reuses both persisted Cores and all three model generations without a download request",
  );
}

async function lockBuildArtifact() {
  if (process.platform !== "win32") return;
  const release = resolve("release");
  await mkdir(release, { recursive: true });
  watcherLockFile = join(release, `runtime-watch-${randomUUID()}.pak`);
  const script = join(profile, "watch-lock.ps1");
  await writeFile(
    script,
    `param([string]$Target)
$runtimeStream = [IO.File]::Open($Target, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
  $runtimeStream.WriteByte(1)
  $runtimeStream.Flush()
  [Console]::WriteLine('LOCKED')
  [Console]::Out.Flush()
  $null = [Console]::ReadLine()
} finally {
  $runtimeStream.Dispose()
}
`,
  );
  watcherLock = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-Target",
      watcherLockFile,
    ],
    { windowsHide: true, stdio: "pipe" },
  );
  let ready = false;
  let diagnostic = "";
  watcherLock.stdout.on("data", (chunk) => {
    if (chunk.toString().includes("LOCKED")) ready = true;
  });
  watcherLock.stderr.on("data", (chunk) => {
    diagnostic += chunk.toString();
  });
  await until(() => {
    if (watcherLock.exitCode !== null)
      throw new Error(`Exclusive artifact lock failed: ${diagnostic}`);
    return ready;
  }, "Windows fixture did not acquire its exclusive release artifact lock");
  report.checks.push(
    "Development renderer remains usable while a release artifact is held with Windows FileShare.None",
  );
}

try {
  if (mode === "dev") {
    await lockBuildArtifact();
    if (rendererUrl) rendererUrl = localOrigin(rendererUrl);
    else {
      const { createServer: createViteServer } = await import("vite");
      renderer = await createViteServer({
        configFile: resolve("vite.config.ts"),
        cacheDir: join(profile, "vite-cache"),
        server: {
          host: "127.0.0.1",
          port: 0,
          strictPort: false,
        },
      });
      renderer.watcher.on("error", (error) =>
        errors.push(`Vite watcher: ${error.message}`),
      );
      await renderer.listen();
      rendererUrl = `http://127.0.0.1:${renderer.httpServer.address().port}`;
    }
  } else
    assert.equal(
      rendererUrl,
      undefined,
      "Only dev mode may use a development renderer URL",
    );
  await launch();
  report.checks.push(`Real ${mode} entry: ${report.entry.appPath}`);
  await checkPagesAndSettings();
  await checkPortsAndChat();
  await checkMedia();
  await checkModels();
  if (withLive2D) await checkLive2D();
  const beforeRestart = await state();
  await closeDesktop();
  const persisted = await readFile(join(profile, "state.json"), "utf8");
  assert.ok(!persisted.includes("runtime-fake-key"));
  offlineCores = withLive2D;
  await launch();
  assert.equal((await state()).settings.nickname, "运行时伙伴");
  assert.equal((await state()).settings.adapterPort, config.port);
  assert.equal((await state()).models.length, beforeRestart.models.length);
  assert.equal((await state()).history.length, beforeRestart.history.length);
  await dashboard.evaluate(() => window.mai.connect());
  await connectAdapter();
  if (withLive2D) await checkOfflineLive2D();
  report.checks.push(
    "Actual-entry restart preserves configuration, media history, models and usable saved port",
  );
  assert.deepEqual(errors, []);
  await closeDesktop();
  await writeFile(
    join(base, "result.json"),
    JSON.stringify(
      { passed: true, ...report, mediaRequests, errors, assetErrors },
      null,
      2,
    ),
  );
  console.log(
    `PASS ${mode} 真实入口：双窗口、UI、端口、聊天、虚拟媒体、模型和重启恢复`,
  );
} catch (error) {
  if (desktop && dashboard) await capture("failure.png").catch(() => {});
  await writeFile(
    join(base, "failure.json"),
    JSON.stringify(
      {
        ...report,
        passed: false,
        message: String(error.message || error),
        stack: error.stack,
        errors,
        assetErrors,
        mediaRequests,
        launchLog,
        windows: desktop?.windows().map((page) => page.url()) || [],
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  for (const socket of sockets)
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  await desktop?.close().catch(() => {});
  await renderer?.close();
  if (watcherLock && watcherLock.exitCode === null) {
    const exited = once(watcherLock, "exit");
    watcherLock.stdin.end("STOP\n");
    const timeout = setTimeout(() => watcherLock.kill(), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timeout);
    }
  }
  if (watcherLockFile) {
    assert.ok(resolve(watcherLockFile).startsWith(resolve("release") + sep));
    await rm(watcherLockFile, { force: true });
  }
  await new Promise((done) => {
    service.close(done);
    service.closeAllConnections();
  });
  const target = resolve(profile);
  assert.ok(
    target.startsWith(base + sep),
    "Runtime profile cleanup must stay in the test cache",
  );
  await rm(target, { recursive: true, force: true });
}
