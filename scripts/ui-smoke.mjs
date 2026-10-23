import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { _electron as electron } from "playwright";
import { WebSocketServer } from "ws";
import { createGlb } from "./model-fixture.mjs";

// Real renderer/preload/IPC, with isolated storage and loopback-only services.
const captureOnly = process.argv.includes("--capture-only");
const skipCapture = process.argv.includes("--skip-capture");
const settingsOnly = process.argv.includes("--settings-only");
const phase =
  process.argv.find((value) => value.startsWith("--phase="))?.slice(8) ||
  "after";
assert.match(phase, /^[a-z0-9-]+$/);
const base = resolve(".cache/ui-smoke");
const output = join(base, phase);
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(base, "run-"));
const entry = join(profile, "bootstrap.mjs");
const packageInfo = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const pages = [
  ["home", "此刻"],
  ["chat", "和麦麦聊聊"],
  ["models", "角色衣橱"],
  ["senses", "声音与感知"],
  ["core", "连接与账号"],
  ["settings", "偏好设置"],
];
const viewports = [
  [1280, 860],
  [960, 680],
];
const pixel = await readFile(resolve("resources/icon.png"));
await writeFile(
  join(profile, "state.json"),
  JSON.stringify({
    version: 2,
    settings: {
      autoConnect: false,
      reducedMotion: true,
      voiceEnabled: false,
      launchAtLogin: false,
    },
    history: [],
    models: [],
    encrypted: {},
  }),
);
await writeFile(join(profile, "ui-fixture.png"), pixel);
await writeFile(join(profile, "ui-fixture.glb"), createGlb());
await writeFile(
  entry,
  `
import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, nativeImage, net as electronNet, session, shell } from "electron";
import { Socket } from "node:net";
app.getVersion = () => ${JSON.stringify(packageInfo.version)};
const loopback = (host) => !host || host === "localhost" || host === "::1" || /^127\\.\\d+\\.\\d+\\.\\d+$/.test(host);
globalThis.__uiNetworkBlocked = [];
globalThis.__uiSystemActions = [];
globalThis.__uiDialogQueue = [];
function checkUrl(value) {
  const url = new URL(typeof value === "string" || value instanceof URL ? value : value.url);
  if (["http:", "https:", "ws:", "wss:"].includes(url.protocol) && !loopback(url.hostname.replace(/^\\[|\\]$/g, ""))) {
    globalThis.__uiNetworkBlocked.push(url.href);
    throw new Error("UI smoke blocked non-loopback request: " + url.origin);
  }
}
const originalConnect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = first && typeof first === "object" ? first.host : typeof args[1] === "string" ? args[1] : undefined;
  if (!loopback(host)) {
    globalThis.__uiNetworkBlocked.push(String(host));
    throw new Error("UI smoke blocked non-loopback socket: " + host);
  }
  return originalConnect.apply(this, args);
};
for (const target of [globalThis, electronNet]) {
  const original = target.fetch.bind(target);
  target.fetch = function (url, ...args) { checkUrl(url); return original(url, ...args); };
}
app.on("ready", () => {
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    (request, done) => {
      try { checkUrl(request.url); done({}); }
      catch { done({ cancel: true }); }
    },
  );
});
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.showInactive = function () {};
app.setLoginItemSettings = (value) => globalThis.__uiSystemActions.push({ type: "login", value });
globalShortcut.register = () => true;
globalShortcut.unregisterAll = () => {};
shell.openExternal = async (url) => { globalThis.__uiSystemActions.push({ type: "external", url }); };
shell.openPath = async (path) => { globalThis.__uiSystemActions.push({ type: "folder", path }); return ""; };
dialog.showOpenDialog = async () => globalThis.__uiDialogQueue.shift() || { canceled: true, filePaths: [] };
dialog.showSaveDialog = async () => ({ canceled: true });
desktopCapturer.getSources = async (options) => {
  if (globalThis.__uiHoldCapture && options.thumbnailSize.width > 320) {
    globalThis.__uiCaptureRequested = true;
    await new Promise((done) => { globalThis.__uiReleaseCapture = done; });
  }
  return [{
    id: "screen:fixture:0", name: "测试屏幕", display_id: "fixture", appIcon: null,
    thumbnail: nativeImage.createFromBuffer(Buffer.from(${JSON.stringify(pixel.toString("base64"))}, "base64")).resize({ width: 320, height: 180 }),
  }];
};
await import(${JSON.stringify(pathToFileURL(resolve("out/main/index.js")).href)});
`,
);

const pause = (milliseconds) =>
  new Promise((done) => setTimeout(done, milliseconds));
async function until(check, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(25);
  }
  throw new Error(message);
}
async function settle(page) {
  await page.evaluate(
    () =>
      new Promise((done) => {
        const timer = setTimeout(done, 100);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            clearTimeout(timer);
            done();
          }),
        );
      }),
  );
}
let desktop;
let dashboard;
let pet;
const errors = [];
const report = { phase, captureOnly, screenshots: [], checks: [] };

async function navigate(id) {
  const name = pages.find(([key]) => key === id)[1];
  await dashboard
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
  await dashboard.locator(`.page-${id}`).waitFor();
  await settle(dashboard);
}
async function resize(width, height) {
  await desktop.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()
        .find((window) =>
          window.webContents.getURL().includes("view=dashboard"),
        )
        .setContentSize(...size);
    },
    [width, height],
  );
  await dashboard.waitForFunction(
    ([width, height]) => innerWidth === width && innerHeight === height,
    [width, height],
  );
  await settle(dashboard);
}
async function screenshot(filename) {
  // Electron's native capture explicitly keeps hidden windows hidden; CDP's
  // screenshot command can wait forever for a frame on a never-shown window.
  const encoded = await desktop.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes("view=dashboard"),
    );
    window.webContents.invalidate();
    const image = await window.webContents.capturePage(undefined, {
      stayHidden: true,
      stayAwake: true,
    });
    if (window.isVisible()) throw new Error("Capture revealed a hidden window");
    if (image.isEmpty()) throw new Error("Hidden window capture was empty");
    return image.toPNG().toString("base64");
  });
  await writeFile(join(output, filename), Buffer.from(encoded, "base64"));
}
async function capturePages() {
  const issues = [];
  for (const [width, height] of viewports) {
    await resize(width, height);
    for (const [id] of pages) {
      await navigate(id);
      const filename = `${width}x${height}-${id}.png`;
      await screenshot(filename);
      const overflow = await dashboard.evaluate(() => ({
        viewport: innerWidth,
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
      }));
      const metrics = { filename, overflow };
      if (Math.max(overflow.document, overflow.body) > width + 1)
        issues.push(`${id} at ${width}px overflows horizontally`);
      if (id === "chat") {
        metrics.composer = await composerMetrics();
        if (!metrics.composer.contained || !metrics.composer.hit)
          issues.push(
            `Chat send button at ${width}x${height} is clipped or covered: ${JSON.stringify(metrics.composer)}`,
          );
        metrics.emptyState = await dashboard
          .locator(".chat-messages")
          .evaluate((list) => {
            const heading = list.querySelector(".chat-empty-state h3");
            if (!heading) return null;
            const area = list.getBoundingClientRect();
            const rect = heading.getBoundingClientRect();
            return {
              top: rect.top,
              bottom: rect.bottom,
              areaTop: area.top,
              areaBottom: area.bottom,
              visible:
                rect.top >= area.top - 1 && rect.bottom <= area.bottom + 1,
            };
          });
        if (metrics.emptyState && !metrics.emptyState.visible)
          issues.push(
            `Chat empty-state heading at ${width}x${height} is clipped: ${JSON.stringify(metrics.emptyState)}`,
          );
      }
      if (id === "models") {
        metrics.defaultAvatar = await dashboard
          .locator(".model-card-preview.placeholder")
          .evaluate((preview) => {
            const svg = preview.querySelector(".placeholder-avatar svg");
            if (!svg) return { contained: false, missing: true };
            const area = preview.getBoundingClientRect();
            const rect = svg.getBoundingClientRect();
            return {
              width: rect.width,
              height: rect.height,
              previewWidth: area.width,
              previewHeight: area.height,
              contained:
                rect.width > 0 &&
                rect.height > 0 &&
                rect.left >= area.left - 1 &&
                rect.right <= area.right + 1 &&
                rect.top >= area.top - 1 &&
                rect.bottom <= area.bottom + 1,
            };
          });
        if (!metrics.defaultAvatar.contained)
          issues.push(
            `Default wardrobe avatar at ${width}x${height} exceeds its preview: ${JSON.stringify(metrics.defaultAvatar)}`,
          );
      }
      report.screenshots.push(metrics);
    }
  }
  report.layoutIssues = issues;
  if (!captureOnly)
    assert.deepEqual(
      issues,
      [],
      "All six pages must remain usable at both dashboard sizes",
    );
}

async function composerMetrics() {
  return dashboard.locator(".send-button").evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const panel = button.closest(".chat-panel").getBoundingClientRect();
    const within =
      rect.left >= panel.left - 1 &&
      rect.right <= panel.right + 1 &&
      rect.top >= panel.top - 1 &&
      rect.bottom <= panel.bottom + 1 &&
      rect.bottom <= innerHeight;
    const x = rect.left + rect.width / 2;
    const points = [rect.top + 2, rect.top + rect.height / 2, rect.bottom - 2];
    return {
      buttonTop: rect.top,
      buttonBottom: rect.bottom,
      panelBottom: panel.bottom,
      viewportHeight: innerHeight,
      contained: within,
      hit: points.every((y) =>
        button.contains(document.elementFromPoint(x, y)),
      ),
    };
  });
}

async function createFixture() {
  const token = `ui-test-${"x".repeat(40)}`;
  const fixture = {
    accounts: [],
    devices: [
      {
        id: "ui-current-device-0001",
        name: "当前测试设备",
        createdAt: 1,
        current: true,
      },
      {
        id: "ui-other-device-00002",
        name: "测试备用设备",
        createdAt: 2,
        current: false,
      },
    ],
    histories: new Map(),
    earlier: [],
    calls: [],
    requests: [],
    replyAcks: new Set(),
    loginStatus: "pending",
    nextSend: "ok",
    pendingSend: null,
    asrRequests: 0,
    chat: null,
  };
  const http = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* consume test recording */
    }
    if (request.url === "/v1/audio/transcriptions") {
      fixture.asrRequests++;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ text: "虚拟麦克风的测试转写" }));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  const sockets = new WebSocketServer({ server: http });
  const frame = (socket, message) => socket.send(JSON.stringify(message));
  sockets.on("headers", (headers) => headers.push("X-Mai-Account-Reuse: 1"));
  sockets.on("connection", (socket, request) => {
    if (request.url === "/account") {
      socket.on("message", (raw) => {
        const call = JSON.parse(raw.toString());
        fixture.calls.push(call);
        let value;
        switch (call.method) {
          case "login.begin":
            value = {
              loginId: "ui-login-proof-0001",
              secret: "s".repeat(40),
              code: "ABCD234567",
              expiresAt: Date.now() + 300000,
            };
            break;
          case "login.poll":
            value =
              fixture.loginStatus === "confirmed"
                ? { status: "confirmed", token }
                : { status: fixture.loginStatus };
            break;
          case "login.cancel":
          case "history.clear":
            value = {};
            break;
          case "accounts.list":
            value = { accounts: fixture.accounts };
            break;
          case "accounts.create": {
            value = {
              id: `pet_${(fixture.accounts.length + 1).toString(16).padStart(32, "0")}`,
              name: call.params.name,
              createdAt: Date.now(),
            };
            fixture.accounts.push(value);
            fixture.histories.set(value.id, []);
            break;
          }
          case "devices.list":
            value = { devices: fixture.devices };
            break;
          case "devices.revoke":
            fixture.devices = fixture.devices.filter(
              (device) => device.id !== call.params.deviceId,
            );
            value = {};
            break;
          case "history.list": {
            const messages = call.params.before
              ? fixture.earlier
              : fixture.histories.get(call.params.accountId) || [];
            const hasMore = !call.params.before && fixture.earlier.length > 0;
            value = {
              messages,
              before: hasMore ? messages[0]?.timestamp || 1 : null,
              hasMore,
            };
            break;
          }
          default:
            frame(socket, {
              v: 1,
              id: call.id,
              ok: false,
              error: `Unsupported test RPC: ${call.method}`,
            });
            return;
        }
        frame(socket, { v: 1, id: call.id, ok: true, value });
      });
      return;
    }
    const sessionId = randomUUID();
    fixture.chat = {
      socket,
      sessionId,
      accountId: request.headers["x-mai-account"],
    };
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "welcome") {
        frame(socket, {
          v: 1,
          type: "ready",
          sessionId,
          capabilities: ["chat", "image", "audio", "proactive"],
        });
      } else if (message.type === "reply_ack") {
        fixture.replyAcks.add(message.id);
      } else if (message.type === "request") {
        fixture.requests.push(message);
        const sendResult = (ok = true) =>
          frame(socket, {
            v: 1,
            type: "result",
            id: message.id,
            ok,
            ...(ok
              ? {}
              : {
                  error: {
                    code: "test_unavailable",
                    message: "测试服务暂不可用，请重试",
                  },
                }),
          });
        const mode = fixture.nextSend;
        fixture.nextSend = "ok";
        if (mode === "hold") fixture.pendingSend = sendResult;
        else sendResult(mode !== "fail");
      }
    });
    frame(socket, {
      v: 1,
      type: "hello",
      protocol: "mai-desktop",
      pluginVersion: "0.4.5",
      instanceId: randomUUID(),
      startedAt: Date.now(),
      identity: {
        platform: "desktop_pet",
        accountId: "mai_desktop_pet",
        userId: fixture.chat.accountId,
        scope: "",
      },
    });
  });
  http.listen(0, "127.0.0.2");
  await once(http, "listening");
  fixture.url = `ws://127.0.0.2:${http.address().port}/desktop`;
  fixture.speechUrl = `http://127.0.0.2:${http.address().port}/v1`;
  fixture.reply = async (id, text) => {
    const { socket, sessionId } = fixture.chat;
    frame(socket, {
      v: 1,
      type: "reply",
      sessionId,
      id,
      segments: [{ type: "text", text }],
    });
    await until(
      () => fixture.replyAcks.has(id),
      "Reply must be saved and acknowledged",
    );
  };
  fixture.close = async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((done) => sockets.close(done));
    http.closeAllConnections();
    await new Promise((done) => http.close(done));
  };
  return fixture;
}

const state = () => dashboard.evaluate(() => window.mai.snapshot());
async function check(name, action) {
  report.stage = name;
  console.log(`CHECK ${name}`);
  await action();
  report.checks.push(name);
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(`PASS ${name}`);
}
async function dismissToast() {
  const close = dashboard.getByRole("button", {
    name: "关闭提示",
    exact: true,
  });
  if (await close.isVisible()) await close.click();
}
async function assertFocused(locator, message) {
  assert.equal(
    await locator.evaluate((element) => element === document.activeElement),
    true,
    message,
  );
}
async function queueDialog(file) {
  await desktop.evaluate((_, path) => {
    globalThis.__uiDialogQueue.push(
      path
        ? { canceled: false, filePaths: [path] }
        : { canceled: true, filePaths: [] },
    );
  }, file);
}

async function checkSettings() {
  await navigate("settings");
  const nickname = dashboard.getByLabel("桌宠的名字", { exact: true });
  const userName = dashboard.getByLabel("你的名字", { exact: true });
  await nickname.fill("本地验收麦麦");
  await userName.fill("测试用户");
  await dashboard
    .getByRole("switch", { name: "始终置顶", exact: true })
    .click();
  await until(
    async () => !(await state()).settings.alwaysOnTop,
    "Switch must save",
  );
  assert.equal(
    await nickname.inputValue(),
    "本地验收麦麦",
    "An unrelated setting broadcast must preserve an unsaved name",
  );
  assert.equal(await userName.inputValue(), "测试用户");
  await dashboard
    .getByRole("button", { name: "保存称呼", exact: true })
    .click();
  await until(
    async () => (await state()).settings.nickname === "本地验收麦麦",
    "Names must save",
  );
  await userName.fill("   ");
  const save = dashboard.getByRole("button", { name: "保存称呼", exact: true });
  if (await save.isEnabled()) await save.click();
  assert.equal(
    (await state()).settings.userName,
    "测试用户",
    "Whitespace cannot replace the saved user name",
  );
  await userName.fill("测试用户");
  await dismissToast();
  const slider = dashboard.getByRole("slider", { name: /角色大小/ });
  const before = await dashboard.evaluate(() => ({
    width: innerWidth,
    font: getComputedStyle(document.querySelector("h1")).fontSize,
  }));
  await slider.focus();
  await dashboard.keyboard.press("ArrowLeft");
  await until(
    async () => (await state()).settings.petScale === 0.95,
    "Keyboard scale adjustment must save",
  );
  const after = await dashboard.evaluate(() => ({
    width: innerWidth,
    font: getComputedStyle(document.querySelector("h1")).fontSize,
  }));
  assert.deepEqual(
    after,
    before,
    "Pet scale must not resize dashboard text or viewport",
  );
  await assertFocused(
    slider,
    "Saving a keyboard scale change must retain slider focus",
  );
  await dashboard.keyboard.press("ArrowLeft");
  await until(
    async () => (await state()).settings.petScale === 0.9,
    "A second arrow key without refocusing must also save",
  );
  const persisted = JSON.parse(
    await readFile(join(profile, "state.json"), "utf8"),
  );
  assert.equal(persisted.settings.nickname, "本地验收麦麦");
  assert.equal(persisted.settings.petScale, 0.9);
}

async function checkAccounts(fixture) {
  await navigate("core");
  const address = dashboard.getByLabel(/^服务器地址/);
  await address.fill("https://127.0.0.2/invalid-protocol");
  await dashboard
    .getByRole("button", { name: "保存地址", exact: true })
    .click();
  await dashboard.locator(".toast.error").waitFor();
  assert.equal(
    await address.inputValue(),
    "https://127.0.0.2/invalid-protocol",
    "Invalid address stays editable",
  );
  await dismissToast();
  await address.fill(fixture.url);
  await dashboard
    .getByRole("button", { name: "保存地址", exact: true })
    .click();
  await until(
    async () => (await state()).settings.serverUrl === fixture.url,
    "Server address must save",
  );
  await dashboard.getByLabel("这台设备的名称").fill("UI 本地测试设备");
  const login = dashboard.getByRole("button", {
    name: "通过 QQ 登录",
    exact: true,
  });
  await login.click();
  await dashboard
    .getByRole("textbox", { name: "QQ 登录命令", exact: true })
    .waitFor();
  await dashboard
    .getByRole("button", { name: "取消登录", exact: true })
    .click();
  await until(
    () => fixture.calls.some((call) => call.method === "login.cancel"),
    "Cancel login must reach the account fixture",
  );
  fixture.loginStatus = "confirmed";
  await login.click();
  const accountName = dashboard.getByLabel("新桌宠的名称", { exact: true });
  await accountName.waitFor();
  await accountName.fill("验收小麦");
  await dashboard
    .getByRole("button", { name: "新建桌宠并连接", exact: true })
    .click();
  await until(
    async () =>
      (await state()).connection.phase === "connected" &&
      !(await state()).historySync.loading,
    "Created account must connect and synchronize",
  );
  const primary = (await state()).settings.serverAccountId;
  await accountName.fill("备用小麦");
  await dashboard
    .getByRole("button", { name: "新建桌宠并连接", exact: true })
    .click();
  await until(
    async () =>
      (await state()).settings.serverAccountId !== primary &&
      (await state()).connection.phase === "connected",
    "Second account must become active",
  );
  await dashboard
    .locator(".server-account")
    .filter({ hasText: "验收小麦" })
    .click();
  await until(
    async () =>
      (await state()).settings.serverAccountId === primary &&
      (await state()).connection.phase === "connected" &&
      !(await state()).historySync.loading,
    "Account switching must restore the primary account",
  );
  await dashboard
    .getByRole("button", { name: "从本机移除桌宠 备用小麦", exact: true })
    .click();
  const removal = dashboard.locator(".server-account-removal");
  await removal.getByRole("button", { name: "取消", exact: true }).click();
  await dashboard
    .getByRole("button", { name: "从本机移除桌宠 备用小麦", exact: true })
    .click();
  await removal.getByRole("button", { name: "确认移除", exact: true }).click();
  await until(
    async () => (await state()).removedServerAccounts.length === 1,
    "Remove confirmation must update the local account list",
  );
  await dashboard.locator(".server-devices > summary").click();
  await dashboard
    .locator(".server-device")
    .filter({ hasText: "测试备用设备" })
    .getByRole("button", { name: "移除", exact: true })
    .click();
  await until(
    () => fixture.devices.length === 1,
    "Device removal must reach the account fixture",
  );
  return primary;
}

async function checkChat(fixture) {
  await navigate("chat");
  const text = dashboard.getByRole("textbox", {
    name: "消息内容",
    exact: true,
  });
  const send = dashboard.getByRole("button", { name: "发送消息", exact: true });
  assert.equal(await send.isDisabled(), true, "Empty chat cannot send");
  assert.equal(
    await dashboard.locator(".message-row").count(),
    0,
    "New account starts with an empty history",
  );
  await text.fill("按钮发送");
  await send.click();
  await until(
    () => fixture.requests.length === 1,
    "Send button must deliver one request",
  );
  await until(
    async () => (await text.inputValue()) === "",
    "Successful send clears the submitted draft",
  );
  await text.fill("第一行");
  await text.press("Shift+Enter");
  await text.press("End");
  await text.type("第二行");
  assert.equal(fixture.requests.length, 1, "Shift+Enter must not send");
  assert.equal(await text.inputValue(), "第一行\n第二行");
  await text.dispatchEvent("compositionstart", { data: "中" });
  await text.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
  });
  await text.dispatchEvent("compositionend", { data: "中" });
  assert.equal(fixture.requests.length, 1, "IME confirmation must not send");
  await text.press("Enter");
  await until(
    () => fixture.requests.length === 2,
    "Enter must send once after composition",
  );
  await until(
    async () => (await text.inputValue()) === "",
    "Keyboard send must finish",
  );
  fixture.nextSend = "fail";
  await text.fill("失败时保留这份草稿");
  await send.click();
  await dashboard
    .getByRole("alert")
    .filter({ hasText: "测试服务暂不可用" })
    .waitFor();
  assert.equal(await text.inputValue(), "失败时保留这份草稿");
  assert.equal(await send.isEnabled(), true, "Failed send must allow retry");
  await dismissToast();
  fixture.nextSend = "hold";
  await text.fill("发送中的旧草稿");
  await send.click();
  await until(
    () => Boolean(fixture.pendingSend),
    "Fixture must hold the outgoing acknowledgement",
  );
  assert.equal(
    await send.isDisabled(),
    true,
    "Pending send cannot be submitted twice",
  );
  await text.fill("发送期间新写的草稿");
  fixture.pendingSend();
  fixture.pendingSend = null;
  await until(
    async () => (await state()).replyStatus !== "sending",
    "Acknowledgement must complete the pending send",
  );
  assert.equal(
    await text.inputValue(),
    "发送期间新写的草稿",
    "Completing an older send must preserve newer editing",
  );
  await text.fill("");
  await fixture.reply("ui-reply-1", "本机夹具的即时回复");
  await dashboard.getByText("本机夹具的即时回复", { exact: true }).waitFor();
}

async function checkModalKeyboard(trigger, dialog) {
  await trigger.click();
  await dialog.waitFor();
  await until(
    async () =>
      dialog.evaluate((element) => element.contains(document.activeElement)),
    "Modal must receive initial focus",
  );
  const count = await dialog
    .locator(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]',
    )
    .count();
  for (let index = 0; index < count + 2; index++) {
    await dashboard.keyboard.press("Tab");
    assert.equal(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
      true,
      "Tab must stay within the modal",
    );
  }
  await dashboard.keyboard.press("Shift+Tab");
  assert.equal(
    await dialog.evaluate((element) =>
      element.contains(document.activeElement),
    ),
    true,
  );
  await dialog.dispatchEvent("keydown", {
    key: "Escape",
    code: "Escape",
    isComposing: true,
    keyCode: 229,
  });
  assert.equal(
    await dialog.isVisible(),
    true,
    "IME Escape must not close the dialog",
  );
  await dashboard.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  await assertFocused(trigger, "Closing a modal restores focus to its trigger");
}

async function checkMedia(fixture) {
  await navigate("chat");
  const screenshotButton = dashboard.getByRole("button", {
    name: "选择屏幕截图",
    exact: true,
  });
  await checkModalKeyboard(
    screenshotButton,
    dashboard.getByRole("dialog", { name: "一起看看你的世界", exact: true }),
  );
  const before = fixture.requests.length;
  await screenshotButton.click();
  await dashboard
    .getByRole("button", { name: "开启并选择屏幕", exact: true })
    .click();
  await dashboard
    .locator(".screen-grid button")
    .filter({ hasText: "测试屏幕" })
    .click();
  await dashboard.getByAltText("待发送截图", { exact: true }).waitFor();
  assert.equal(
    fixture.requests.length,
    before,
    "Capturing a fixture image must only create a local preview",
  );
  await dashboard
    .getByRole("button", { name: "移除截图", exact: true })
    .click();
  await screenshotButton.click();
  await dashboard
    .locator(".screen-grid button")
    .filter({ hasText: "测试屏幕" })
    .click();
  await dashboard
    .getByRole("button", { name: "发送消息", exact: true })
    .click();
  await until(
    () => fixture.requests.length === before + 1,
    "Image-only message must send after confirmation",
  );
  assert.ok(
    fixture.requests.at(-1).params.image,
    "The adapter must receive the selected image",
  );
  await dashboard
    .getByAltText("待发送截图", { exact: true })
    .waitFor({ state: "detached" });
  // An old capture may resolve after Escape and after a new picker has opened.
  // Hold only the full-size capture; the new picker's source listing stays live.
  await desktop.evaluate(() => {
    globalThis.__uiHoldCapture = true;
    globalThis.__uiCaptureRequested = false;
  });
  const picker = dashboard.getByRole("dialog", {
    name: "一起看看你的世界",
    exact: true,
  });
  await screenshotButton.click();
  await dashboard
    .locator(".screen-grid button")
    .filter({ hasText: "测试屏幕" })
    .click();
  await until(
    () => desktop.evaluate(() => globalThis.__uiCaptureRequested),
    "Full-size fixture capture must be pending",
  );
  await dashboard.keyboard.press("Escape");
  await picker.waitFor({ state: "detached" });
  await screenshotButton.click();
  await picker.waitFor();
  await desktop.evaluate(() => {
    globalThis.__uiHoldCapture = false;
    globalThis.__uiReleaseCapture();
  });
  await pause(250);
  assert.equal(
    await picker.isVisible(),
    true,
    "A stale capture must not close a newly opened picker",
  );
  assert.equal(
    await dashboard.getByAltText("待发送截图", { exact: true }).count(),
    0,
    "A canceled capture must not attach its late image",
  );
  await dashboard.keyboard.press("Escape");
  await picker.waitFor({ state: "detached" });
  await dashboard.evaluate(() => {
    window.__uiCameraStreams = [];
    window.__uiOriginalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (options) => {
      if (!options.video) return window.__uiOriginalGetUserMedia(options);
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      canvas.getContext("2d").fillRect(0, 0, 320, 180);
      const stream = canvas.captureStream(2);
      window.__uiCameraStreams.push(stream);
      window.__uiCameraCanvas = canvas;
      return stream;
    };
    navigator.mediaDevices.enumerateDevices = async () => [];
  });
  await checkModalKeyboard(
    dashboard.getByRole("button", { name: "摄像头分享", exact: true }),
    dashboard.getByRole("dialog", { name: "分享眼前的小世界", exact: true }),
  );
  const cameraButton = dashboard.getByRole("button", {
    name: "摄像头分享",
    exact: true,
  });
  const camera = dashboard.getByRole("dialog", {
    name: "分享眼前的小世界",
    exact: true,
  });
  await cameraButton.click();
  await camera.getByRole("button", { name: "拍照并预览", exact: true }).click();
  await camera.getByAltText("待发送的摄像头照片", { exact: true }).waitFor();
  fixture.nextSend = "hold";
  await camera.getByRole("button", { name: /^发送给/ }).click();
  await until(
    () => Boolean(fixture.pendingSend),
    "Photo delivery must wait for its acknowledgement",
  );
  await dashboard.keyboard.press("Escape");
  await camera.waitFor({ state: "detached" });
  await cameraButton.click();
  await camera.waitFor();
  fixture.pendingSend();
  fixture.pendingSend = null;
  await until(
    async () => (await state()).replyStatus !== "sending",
    "The earlier photo must complete delivery",
  );
  await pause(150);
  assert.equal(
    await camera.isVisible(),
    true,
    "An earlier photo send must not close a new camera dialog",
  );
  await dashboard.keyboard.press("Escape");
  await camera.waitFor({ state: "detached" });
  await until(
    async () =>
      dashboard.evaluate(() =>
        window.__uiCameraStreams.every((stream) =>
          stream.getTracks().every((track) => track.readyState === "ended"),
        ),
      ),
    "Closing the camera modal must release its virtual tracks",
  );
  await navigate("senses");
  await dashboard
    .getByRole("textbox", { name: /^API Base URL/ })
    .fill(fixture.speechUrl);
  await dashboard
    .getByRole("button", { name: "保存转写设置", exact: true })
    .click();
  await until(
    async () => (await state()).settings.speechBaseUrl === fixture.speechUrl,
    "ASR URL must save before recording",
  );
  await navigate("chat");
  await dashboard
    .getByRole("button", { name: "语音输入", exact: true })
    .click();
  await dashboard
    .getByRole("button", { name: "结束录音并发送", exact: true })
    .waitFor();
  await pause(1100);
  await dashboard
    .getByRole("button", { name: "结束录音并发送", exact: true })
    .click();
  await until(
    () => fixture.asrRequests === 1,
    "Virtual recording must reach the loopback ASR service",
  );
  await until(
    () =>
      fixture.requests.some(
        (request) => request.params.text === "虚拟麦克风的测试转写",
      ),
    "Transcribed speech must reach the adapter",
  );
  await until(
    async () => (await state()).voiceInput === "idle",
    "Recording must return to idle",
  );
}

async function checkSpeechDraft() {
  await navigate("senses");
  await dashboard.locator(".tts-advanced > summary").click();
  const engine = dashboard.getByRole("combobox", {
    name: "朗读方式",
    exact: true,
  });
  const automatic = dashboard.getByRole("switch", {
    name: "自动朗读回复",
    exact: true,
  });
  await engine.selectOption("api");
  await automatic.click();
  await until(
    async () => (await state()).settings.voiceEnabled,
    "Automatic read-aloud toggle must save",
  );
  assert.equal(
    await engine.inputValue(),
    "api",
    "Saving an independent switch must preserve an unsaved TTS engine",
  );
  await automatic.click();
  await until(
    async () => !(await state()).settings.voiceEnabled,
    "Automatic read-aloud must be disabled before chat fixtures run",
  );
  const endpoint = dashboard.getByRole("textbox", { name: /^合成服务地址/ });
  const unsaved = "http://127.0.0.1:1/unsaved-openai-draft";
  await endpoint.fill(unsaved);
  // MiMo reference import is local and requires neither a key nor synthesis.
  // It must intentionally select the imported voice without saving another
  // provider's unrelated, still-dirty advanced settings.
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
  await dashboard.getByLabel("音色服务", { exact: true }).selectOption("mimo");
  await dashboard.getByLabel("选择音色音频", { exact: true }).setInputFiles({
    name: "ui-reference.wav",
    mimeType: "audio/wav",
    buffer: wav,
  });
  await until(
    async () => (await state()).clonedVoices.length === 1,
    "Local reference import must finish without an online request",
  );
  const provider = dashboard.getByRole("combobox", {
    name: "语音服务商",
    exact: true,
  });
  await until(
    async () => (await provider.inputValue()) === "mimo",
    "Explicit voice import must select its provider in advanced settings",
  );
  assert.notEqual(
    (await state()).settings.ttsProfiles.openai?.baseUrl,
    unsaved,
    "Importing a voice must not persist another provider's unsaved endpoint",
  );
  await provider.selectOption("openai");
  assert.equal(
    await endpoint.inputValue(),
    unsaved,
    "Returning to another provider restores its local draft",
  );
  await engine.selectOption("system");
}

async function checkScroll(fixture, accountId) {
  const timestamp = Date.now() - 100000;
  fixture.histories.set(
    accountId,
    Array.from({ length: 55 }, (_, index) => ({
      id: `scroll-${index}`,
      role: index % 2 ? "user" : "assistant",
      text:
        `滚动测试第 ${index + 1} 条。` +
        "这段内容用来检查阅读位置不会被新消息打断。".repeat(3),
      timestamp: timestamp + index * 1000,
      source: index % 2 ? "text" : "core",
    })),
  );
  fixture.earlier = Array.from({ length: 15 }, (_, index) => ({
    id: `earlier-${index}`,
    role: "assistant",
    text: `更早的历史 ${index + 1}。` + "保留原有阅读锚点。".repeat(8),
    timestamp: timestamp - 20000 + index * 1000,
    source: "core",
  }));
  await navigate("core");
  await dashboard
    .getByRole("button", { name: "重新连接服务器", exact: true })
    .click();
  await until(
    async () =>
      (await state()).history.length === 55 &&
      !(await state()).historySync.loading,
    "Fixture history must synchronize",
  );
  await navigate("chat");
  const log = dashboard.getByRole("log", { name: "聊天记录", exact: true });
  await log.waitFor();
  await until(
    async () =>
      log.evaluate(
        (element) =>
          element.scrollHeight - element.clientHeight - element.scrollTop < 8,
      ),
    "Opening history initially follows the newest message",
  );
  await log.evaluate((element) => {
    element.scrollTop = element.scrollHeight / 3;
    element.dispatchEvent(new Event("scroll"));
  });
  await settle(dashboard);
  const previous = await log.evaluate((element) => element.scrollTop);
  await fixture.reply("while-reading", "上翻阅读时到达的新消息");
  await pause(150);
  assert.ok(
    Math.abs((await log.evaluate((element) => element.scrollTop)) - previous) <
      3,
    "A new message must not jump an upward-scrolled reader to the bottom",
  );
  await dashboard
    .getByRole("button", { name: "回到最新消息", exact: true })
    .click();
  await until(
    async () =>
      log.evaluate(
        (element) =>
          element.scrollHeight - element.clientHeight - element.scrollTop < 8,
      ),
    "Back to latest must reach the bottom",
  );
  await log.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await settle(dashboard);
  const anchor = await log.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const message = [...element.querySelectorAll("[data-message-key]")].find(
      (item) => item.getBoundingClientRect().bottom > bounds.top + 1,
    );
    return {
      key: message.dataset.messageKey,
      offset: message.getBoundingClientRect().top - bounds.top,
    };
  });
  await dashboard
    .getByRole("button", { name: "加载更早的聊天记录", exact: true })
    .click();
  await until(
    async () =>
      (await state()).history.some((message) => message.id === "earlier-0") &&
      !(await state()).historySync.loading,
    "Earlier messages must load",
  );
  await settle(dashboard);
  const offset = await log.evaluate((element, key) => {
    const message = [...element.querySelectorAll("[data-message-key]")].find(
      (item) => item.dataset.messageKey === key,
    );
    return (
      message.getBoundingClientRect().top - element.getBoundingClientRect().top
    );
  }, anchor.key);
  assert.ok(
    Math.abs(offset - anchor.offset) < 4,
    `Prepending history preserves its reading anchor (${anchor.offset} -> ${offset})`,
  );
  await screenshot("chat-history-anchor.png");
}

async function checkModels() {
  await navigate("models");
  const importButton = dashboard.getByRole("button", {
    name: "导入角色",
    exact: true,
  });
  await queueDialog(null);
  await importButton.click();
  await until(
    async () => importButton.isEnabled(),
    "Canceling import must unlock the wardrobe",
  );
  assert.equal((await state()).models.length, 0);
  for (const extension of ["png", "glb"]) {
    await queueDialog(join(profile, `ui-fixture.${extension}`));
    await importButton.click();
    await until(
      async () =>
        (await state()).models.length === (extension === "png" ? 1 : 2),
      `${extension} model must import`,
    );
    await until(
      async () => importButton.isEnabled(),
      "Import operation must finish",
    );
  }
  const models = (await state()).models;
  await pet.locator(".model-canvas canvas").waitFor();
  const image = models.find((model) => model.kind === "image");
  const card = dashboard
    .locator(".model-card")
    .filter({ has: dashboard.locator(".model-type", { hasText: /^IMAGE$/ }) });
  await card
    .getByRole("button", { name: `使用 ${image.name}`, exact: true })
    .click();
  await until(
    async () => (await state()).settings.activeModelId === image.id,
    "Selecting a model must update the shared state",
  );
  assert.equal(
    await card
      .getByRole("button", { name: `当前使用 ${image.name}`, exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  const remove = card.getByRole("button", {
    name: `删除 ${image.name}`,
    exact: true,
  });
  await remove.click();
  await dashboard.keyboard.press("Escape");
  await remove.waitFor();
  assert.equal(
    (await state()).models.length,
    2,
    "Canceling deletion must preserve the model",
  );
  await remove.click();
  await card
    .getByRole("button", { name: `确认删除 ${image.name}`, exact: true })
    .click();
  await until(
    async () => (await state()).models.length === 1,
    "Confirmed deletion removes only the selected model",
  );
  if ((await state()).settings.activeModelId !== null)
    await dashboard
      .getByRole("button", { name: "使用默认占位角色", exact: true })
      .click();
  await until(
    async () => (await state()).settings.activeModelId === null,
    "Default character remains selectable",
  );
}

async function checkActivity() {
  const trigger = dashboard.getByRole("button", {
    name: "运行动态",
    exact: true,
  });
  await trigger.click();
  await dashboard.locator(".activity-popover").waitFor();
  await dashboard.keyboard.press("Escape");
  await dashboard.locator(".activity-popover").waitFor({ state: "detached" });
  await assertFocused(trigger, "Closing activity restores its trigger focus");
  await trigger.click();
  await dashboard.locator(".page-heading h1").click();
  await dashboard.locator(".activity-popover").waitFor({ state: "detached" });
}

const fixture = captureOnly ? null : await createFixture();

try {
  const env = { ...process.env, MAI_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  desktop = await electron.launch({
    executablePath: resolve("node_modules/electron/dist/electron.exe"),
    args: [
      entry,
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-features=CalculateNativeWinOcclusion",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
    cwd: resolve("."),
    env,
    timeout: 30000,
  });
  await until(() => {
    dashboard = desktop
      .windows()
      .find((page) => page.url().includes("view=dashboard"));
    pet = desktop.windows().find((page) => page.url().includes("view=pet"));
    return dashboard && pet;
  }, "Hidden dashboard and pet windows must load");
  for (const page of [dashboard, pet])
    page.on("pageerror", (error) => errors.push(error.message));
  await desktop.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      assertHidden(window);
      window.webContents.setAudioMuted(true);
      window.webContents.setBackgroundThrottling(false);
    }
    function assertHidden(window) {
      if (window.isVisible())
        throw new Error("UI smoke must keep windows hidden");
    }
  });
  await dashboard.getByRole("navigation", { name: "主导航" }).waitFor();
  desktop.context().setDefaultTimeout(10000);
  if (!skipCapture) {
    console.log(`Capturing six pages at two window sizes: ${output}`);
    await capturePages();
  }
  if (fixture) {
    await resize(1280, 860);
    await check(
      "Settings drafts, switches, names, persistence and keyboard scale",
      checkSettings,
    );
    if (!settingsOnly) {
      await check(
        "Unsaved speech settings survive independent toggle broadcasts",
        checkSpeechDraft,
      );
      let accountId;
      await check(
        "Connection validation, QQ flow, accounts and device actions",
        async () => {
          accountId = await checkAccounts(fixture);
        },
      );
      await check(
        "Chat empty state, keyboard, IME, failure and in-flight editing",
        () => checkChat(fixture),
      );
      await check(
        "Modal focus, fixture attachments, virtual camera and microphone",
        () => checkMedia(fixture),
      );
      await check(
        "Chat upward reading, new-message action and pagination anchor",
        () => checkScroll(fixture, accountId),
      );
      await check(
        "Wardrobe import, selection and cancelable removal",
        checkModels,
      );
      await check(
        "Activity popover Escape, focus restoration and outside click",
        checkActivity,
      );
      await resize(960, 680);
      await navigate("chat");
      await check("Modal keyboard behavior at minimum dashboard size", () =>
        checkModalKeyboard(
          dashboard.getByRole("button", { name: "选择屏幕截图", exact: true }),
          dashboard.getByRole("dialog", {
            name: "一起看看你的世界",
            exact: true,
          }),
        ),
      );
      await screenshot("960x680-chat-connected.png");
    }
  }
  assert.deepEqual(errors, []);
  report.blockedRequests = await desktop.evaluate(
    () => globalThis.__uiNetworkBlocked,
  );
  assert.deepEqual(report.blockedRequests, [], "Unexpected network attempts");
  console.log(`PASS UI ${captureOnly ? "capture" : "smoke"}: ${output}`);
} catch (error) {
  report.failure = error.stack || String(error);
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  if (dashboard && !dashboard.isClosed())
    await screenshot("failure.png").catch(() => {});
  throw error;
} finally {
  report.errors = errors;
  if (desktop)
    report.blockedRequests = await desktop
      .evaluate(() => globalThis.__uiNetworkBlocked)
      .catch(() => report.blockedRequests || []);
  if (fixture)
    report.fixture = {
      accountMethods: fixture.calls.map((call) => call.method),
      outgoingMessages: fixture.requests.length,
      acknowledgedReplies: fixture.replyAcks.size,
      asrRequests: fixture.asrRequests,
    };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await desktop?.close();
  await fixture?.close();
  assert.ok(resolve(profile).startsWith(base + sep));
  await rm(profile, { recursive: true, force: true });
}
