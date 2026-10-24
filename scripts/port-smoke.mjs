import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { _electron as electron } from "playwright";
import WebSocket from "ws";

// Real preload/IPC and WebSocket handshake; no existing profile or remote service.
const base = resolve(".cache/port-smoke");
await mkdir(base, { recursive: true });
const profile = await mkdtemp(join(base, "run-"));
const entry = join(profile, "bootstrap.mjs");
const packageInfo = JSON.parse(await readFile(resolve("package.json"), "utf8"));
await writeFile(
  join(profile, "state.json"),
  JSON.stringify({
    version: 2,
    settings: { autoConnect: false, launchAtLogin: false, reducedMotion: true },
    history: [],
    models: [],
    encrypted: {},
  }),
);
await writeFile(
  entry,
  `
import { app, BrowserWindow, globalShortcut, net as electronNet, session, shell } from "electron";
import filesystem from "node:fs/promises";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { Server, Socket } from "node:net";
import { join } from "node:path";
app.getVersion = () => ${JSON.stringify(packageInfo.version)};
globalThis.__portBlocked = [];
globalThis.__portListenAttempts = [];
globalThis.__portConfigWrites = [];
globalThis.__portRejectPositiveSave = false;
const originalEmit = EventEmitter.prototype.emit;
EventEmitter.prototype.emit = function (event, ...args) {
  if (event === "status" && typeof this.connect === "function" && "localPort" in this)
    globalThis.__portBridge = this;
  return originalEmit.call(this, event, ...args);
};
const servers = [];
const loopback = (host) => !host || host === "localhost" || host === "::1" || /^127\\.\\d+\\.\\d+\\.\\d+$/.test(host);
const checkUrl = (value) => {
  const url = new URL(typeof value === "string" || value instanceof URL ? value : value.url);
  if (["http:", "https:", "ws:", "wss:"].includes(url.protocol) && !loopback(url.hostname.replace(/^\\[|\\]$/g, ""))) {
    globalThis.__portBlocked.push(url.origin);
    throw new Error("Port regression blocked a non-loopback URL: " + url.origin);
  }
};
const originalConnect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = first && typeof first === "object" ? first.host : typeof args[1] === "string" ? args[1] : undefined;
  if (!loopback(host)) {
    globalThis.__portBlocked.push(String(host));
    throw new Error("Port regression blocked a non-loopback socket: " + host);
  }
  return originalConnect.apply(this, args);
};
for (const owner of [globalThis, electronNet]) {
  const original = owner.fetch.bind(owner);
  owner.fetch = (value, ...args) => { checkUrl(value); return original(value, ...args); };
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
const originalListen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  const attempt = {
    requestedPort: typeof args[0] === "object" ? args[0].port : args[0],
    port: null,
    closed: false,
  };
  globalThis.__portListenAttempts.push(attempt);
  servers.push(this);
  this.once("listening", () => { attempt.port = this.address().port; });
  this.once("close", () => { attempt.closed = true; });
  return originalListen.apply(this, args);
};
const originalWrite = filesystem.writeFile.bind(filesystem);
filesystem.writeFile = async (path, content, ...args) => {
  if (globalThis.__portRejectPositiveSave && String(path).endsWith("state.json.tmp") && JSON.parse(String(content)).settings.adapterPort > 0)
    throw Object.assign(new Error("Port smoke injected a state write failure"), { code: "EACCES" });
  if (String(path).endsWith(".toml")) {
    const match = String(content).match(/(?:desktop_url|url)\\s*=\\s*"ws:\\/\\/127\\.0\\.0\\.1:(\\d+)\\/maibot"/);
    if (!match) throw new Error("Export must contain a desktop WebSocket URL");
    const port = Number(match[1]);
    const disk = JSON.parse(await filesystem.readFile(join(process.env.MAI_USER_DATA, "state.json"), "utf8"));
    if (port <= 0 || disk.settings.adapterPort !== port)
      throw new Error("Export attempted before the actual port was persisted");
    if (!servers.some((server) => server.listening && server.address()?.port === port))
      throw new Error("Export attempted before the desktop listener was bound");
    globalThis.__portConfigWrites.push({ port, persisted: true, bound: true });
  }
  return originalWrite(path, content, ...args);
};
syncBuiltinESMExports();
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.showInactive = function () {};
app.setLoginItemSettings = () => {};
globalShortcut.register = () => true;
globalShortcut.unregisterAll = () => {};
shell.openExternal = async (url) => { checkUrl(url); };
shell.openPath = async () => "";
await import(${JSON.stringify(pathToFileURL(resolve("out/main/index.js")).href)});
`,
);

let desktop;
let page;
let startedAt = Date.now();
const clients = new Set();
const blockers = new Set();
const pageErrors = [];
const report = { checks: [], initialPort: null, replacementPort: null };
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
const snapshot = () => page.evaluate(() => window.mai.snapshot());
const diskState = async () =>
  JSON.parse(await readFile(join(profile, "state.json"), "utf8"));
const audit = () =>
  desktop.evaluate(({ BrowserWindow }) => ({
    blocked: globalThis.__portBlocked,
    attempts: globalThis.__portListenAttempts,
    writes: globalThis.__portConfigWrites,
    visible: BrowserWindow.getAllWindows().some((window) => window.isVisible()),
  }));
async function launch() {
  const env = { ...process.env, MAI_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  desktop = await electron.launch({
    executablePath: resolve("node_modules/electron/dist/electron.exe"),
    args: [entry, "--disable-renderer-backgrounding"],
    cwd: resolve("."),
    env,
    timeout: 30000,
  });
  await desktop.firstWindow();
  await until(() => {
    page = desktop
      .windows()
      .find((candidate) => candidate.url().includes("view=dashboard"));
    return Boolean(page);
  }, "Hidden dashboard did not open");
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.locator(".app-shell").waitFor();
}
async function closeDesktop() {
  if (!desktop) return;
  const result = await audit();
  assert.deepEqual(
    result.blocked,
    [],
    "Regression must not request remote services",
  );
  assert.equal(
    result.visible,
    false,
    "Regression must keep both windows hidden",
  );
  await desktop.close();
  desktop = undefined;
}
async function dialogPath(path) {
  await desktop.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () =>
      path ? { canceled: false, filePath: path } : { canceled: true };
  }, path);
}
async function exportConfig(kind, filename) {
  const path = join(profile, filename);
  await dialogPath(path);
  assert.equal(await page.evaluate((kind) => window.mai[kind](), kind), true);
  const text = await readFile(path, "utf8");
  const section =
    kind === "exportMessageAdapterConfig" ? "desktop" : "connection";
  const sectionText = text.match(
    new RegExp(`\\[${section}\\]([\\s\\S]*?)(?=\\n\\[|$)`),
  )?.[1];
  assert.ok(sectionText, `Export must include [${section}]`);
  const field = (name) =>
    JSON.parse(sectionText.match(new RegExp(`^${name} = (".*")$`, "m"))[1]);
  const url = field(section === "desktop" ? "url" : "desktop_url");
  const port = Number(new URL(url).port);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  assert.equal(port, (await snapshot()).settings.adapterPort);
  assert.equal(port, (await diskState()).settings.adapterPort);
  assert.ok(
    (await audit()).writes.some(
      (write) => write.port === port && write.persisted && write.bound,
    ),
  );
  return { port, url, token: field("token"), text };
}
async function connectAdapter(config, transport = "gateway") {
  const state = await snapshot();
  const socket = new WebSocket(config.url, {
    headers: { Authorization: `Bearer ${config.token}` },
    handshakeTimeout: 5000,
  });
  const frames = [];
  const errors = [];
  const sessionId = `port-smoke-${randomUUID()}`;
  clients.add(socket);
  socket.on("error", (error) => errors.push(error.message));
  socket.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    frames.push(frame);
    if (frame.type === "welcome")
      socket.send(
        JSON.stringify({
          v: 1,
          type: "ready",
          sessionId,
          transport,
          capabilities:
            transport === "legacy"
              ? ["chat", "image", "audio"]
              : ["chat", "image", "audio", "proactive"],
        }),
      );
    if (frame.type === "request")
      socket.send(
        JSON.stringify({ v: 1, type: "result", id: frame.id, ok: true }),
      );
  });
  await once(socket, "open");
  socket.send(
    JSON.stringify({
      v: 1,
      type: "hello",
      protocol: "mai-desktop",
      pluginVersion: "0.4.5",
      instanceId: randomUUID(),
      startedAt: ++startedAt,
      identity: {
        platform: state.settings.platform,
        accountId: state.settings.botId,
        userId: state.settings.userId,
        scope: state.settings.adapterScope,
      },
    }),
  );
  await until(async () => {
    const state = await snapshot();
    return (
      state.connection.phase === "connected" &&
      state.connection.sessionId === sessionId
    );
  }, "Exported port did not accept a real hello/ready handshake");
  assert.ok(frames.some((frame) => frame.type === "welcome"));
  assert.deepEqual(errors, []);
  return { socket, sessionId };
}
async function occupy(port = 0) {
  const server = createServer((socket) => socket.destroy());
  blockers.add(server);
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return server;
}
async function closeBlocker(server) {
  await new Promise((done) => server.close(done));
  blockers.delete(server);
}

async function verifyCanceledBinding(patch, label) {
  await page.evaluate(() => window.mai.disconnect());
  assert.equal((await snapshot()).connection.phase, "disconnected");
  const previous = (await snapshot()).settings;
  const before = (await audit()).attempts.length;
  await desktop.evaluate(() => {
    const bridge = globalThis.__portBridge;
    if (!bridge) throw new Error("Real MaiBotBridge instance was not observed");
    const original = bridge.connect;
    let release;
    const waiting = new Promise((done) => {
      release = done;
    });
    const gate = { bridge, original, release, entered: false, wrapper: null };
    gate.wrapper = async function (...args) {
      gate.entered = true;
      await waiting;
      return original.apply(this, args);
    };
    bridge.connect = gate.wrapper;
    globalThis.__portBindGate = gate;
  });
  try {
    await page.evaluate(() => {
      window.__portPendingConnect = window.mai.connect().then(
        () => ({ ok: true, message: "" }),
        (error) => ({ ok: false, message: String(error.message || error) }),
      );
    });
    await until(
      () => desktop.evaluate(() => globalThis.__portBindGate.entered),
      `${label}: connect did not reach the scheduling gate`,
    );
    assert.equal(
      (await snapshot()).connection.phase,
      "disconnected",
      "Configuration changes must occur before the real bind starts",
    );
    await page.evaluate((patch) => window.mai.updateSettings(patch), patch);
    await desktop.evaluate(() => globalThis.__portBindGate.release());
    const result = await page.evaluate(() => window.__portPendingConnect);
    assert.equal(result.ok, false, `${label}: the stale opening must reject`);
    assert.match(result.message, /已取消|配置已变更/);
    const state = await snapshot();
    const disk = await diskState();
    for (const [key, value] of Object.entries(patch)) {
      assert.equal(
        state.settings[key],
        value,
        `${label}: newer in-memory settings must survive`,
      );
      assert.equal(
        disk.settings[key],
        value,
        `${label}: newer persisted settings must survive`,
      );
    }
    assert.equal(
      state.connection.phase,
      "disconnected",
      `${label}: stale listener must be stopped`,
    );
    assert.equal(
      await desktop.evaluate(() => globalThis.__portBridge.localPort ?? null),
      null,
    );
    const attempts = (await audit()).attempts.slice(before);
    assert.equal(
      attempts.length,
      1,
      `${label}: the old operation must execute one real bind`,
    );
    assert.equal(attempts[0].requestedPort, previous.adapterPort);
    assert.equal(attempts[0].port, previous.adapterPort);
    assert.equal(
      attempts[0].closed,
      true,
      `${label}: the bound stale listener must close`,
    );
    const released = await occupy(previous.adapterPort);
    await closeBlocker(released);
  } finally {
    await desktop.evaluate(() => {
      const gate = globalThis.__portBindGate;
      if (!gate) return;
      gate.release();
      if (gate.bridge.connect === gate.wrapper)
        gate.bridge.connect = gate.original;
      delete globalThis.__portBindGate;
    });
  }
}

async function verifyFailedPortSave() {
  await page.evaluate(() => window.mai.updateSettings({ adapterPort: 0 }));
  const path = join(profile, "save-failed.toml");
  await dialogPath(path);
  const before = await audit();
  await desktop.evaluate(() => {
    globalThis.__portRejectPositiveSave = true;
  });
  try {
    const result = await page.evaluate(async () => {
      try {
        await window.mai.exportMessageAdapterConfig();
        return { ok: true, message: "" };
      } catch (error) {
        return { ok: false, message: String(error.message || error) };
      }
    });
    assert.equal(
      result.ok,
      false,
      "A positive port that cannot be persisted must not be exported",
    );
    assert.match(result.message, /自动分配的端口未能保存/);
    assert.equal((await snapshot()).settings.adapterPort, 0);
    assert.equal((await diskState()).settings.adapterPort, 0);
    assert.equal((await snapshot()).connection.phase, "disconnected");
    assert.equal(
      await desktop.evaluate(() => globalThis.__portBridge.localPort ?? null),
      null,
    );
    await assert.rejects(readFile(path), { code: "ENOENT" });
    const after = await audit();
    assert.equal(after.writes.length, before.writes.length);
    const attempts = after.attempts.slice(before.attempts.length);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].requestedPort, 0);
    assert.ok(attempts[0].port > 0);
    assert.equal(
      attempts[0].closed,
      true,
      "Save failure must release the actual listener",
    );
  } finally {
    await desktop.evaluate(() => {
      globalThis.__portRejectPositiveSave = false;
    });
  }
  const recovered = await exportConfig(
    "exportMessageAdapterConfig",
    "save-retried.toml",
  );
  await connectAdapter(recovered, "legacy");
  report.checks.push(
    "Injected positive-port persistence failure restores memory/disk to 0, closes the listener, prevents TOML export, and permits retry",
  );
}

try {
  await launch();
  assert.equal(
    (await snapshot()).settings.adapterPort,
    0,
    "A fresh installation must defer port selection",
  );
  const beforeCancel = (await audit()).attempts.length;
  for (const kind of ["exportMessageAdapterConfig", "exportAdapterConfig"]) {
    await dialogPath(null);
    assert.equal(
      await page.evaluate((kind) => window.mai[kind](), kind),
      false,
    );
  }
  assert.equal(
    (await snapshot()).settings.adapterPort,
    0,
    "Cancel must leave automatic port selection pending",
  );
  assert.equal((await snapshot()).connection.phase, "disconnected");
  assert.equal(
    (await audit()).attempts.length,
    beforeCancel,
    "Cancel must not open a listener",
  );
  report.checks.push(
    "Fresh default 0; canceled exports do not bind or allocate",
  );

  const standalone = await exportConfig(
    "exportMessageAdapterConfig",
    "standalone.toml",
  );
  report.initialPort = standalone.port;
  assert.ok(standalone.text.includes("[maibot]"));
  assert.equal(
    (await audit()).attempts.at(-1).requestedPort,
    0,
    "First export must ask the OS for an available port",
  );
  const independentPeer = await connectAdapter(standalone, "legacy");
  const stableAttempts = (await audit()).attempts.length;
  const repeated = await exportConfig(
    "exportMessageAdapterConfig",
    "standalone-again.toml",
  );
  const legacy = await exportConfig("exportAdapterConfig", "legacy.toml");
  assert.equal(repeated.port, standalone.port);
  assert.equal(legacy.port, standalone.port);
  assert.ok(legacy.text.includes("[plugin]"));
  assert.equal(
    (await audit()).attempts.length,
    stableAttempts,
    "Repeat export must not restart the listener",
  );
  assert.equal(independentPeer.socket.readyState, WebSocket.OPEN);
  assert.equal(
    (await snapshot()).connection.sessionId,
    independentPeer.sessionId,
    "Repeat export must preserve the active adapter",
  );
  report.checks.push(
    "Both TOML formats use an already bound, persisted actual port; real standalone handshake; repeated exports preserve connection",
  );

  const legacyPeer = await connectAdapter(legacy);
  assert.equal((await snapshot()).connection.transport, "gateway");
  const beforeLegacy = (await audit()).attempts.length;
  await exportConfig("exportAdapterConfig", "legacy-again.toml");
  assert.equal((await audit()).attempts.length, beforeLegacy);
  assert.equal(legacyPeer.socket.readyState, WebSocket.OPEN);
  assert.equal((await snapshot()).connection.sessionId, legacyPeer.sessionId);
  await page.evaluate(() => window.mai.disconnect());
  await until(
    () => legacyPeer.socket.readyState === WebSocket.CLOSED,
    "Disconnect did not close the adapter",
  );
  await page.evaluate(() => window.mai.connect());
  assert.equal((await snapshot()).settings.adapterPort, standalone.port);
  assert.equal((await audit()).attempts.at(-1).requestedPort, standalone.port);
  await connectAdapter(legacy);
  report.checks.push(
    "Legacy handshake and repeated export; disconnect/reconnect reuse the saved port",
  );

  await closeDesktop();
  assert.equal((await diskState()).settings.adapterPort, standalone.port);
  await launch();
  assert.equal((await snapshot()).settings.adapterPort, standalone.port);
  await page.evaluate(() => window.mai.connect());
  assert.equal((await audit()).attempts.at(-1).requestedPort, standalone.port);
  await connectAdapter(legacy);
  report.checks.push(
    "Main-process restart preserves the selected port and exported credentials",
  );

  await page.evaluate(() => window.mai.updateSettings({ adapterPort: 0 }));
  assert.equal((await snapshot()).settings.adapterPort, 0);
  const oldPort = await occupy(standalone.port);
  const replacement = await exportConfig(
    "exportMessageAdapterConfig",
    "new-automatic.toml",
  );
  report.replacementPort = replacement.port;
  assert.notEqual(
    replacement.port,
    standalone.port,
    "Explicit automatic mode must choose an available port while the old port is busy",
  );
  assert.equal((await audit()).attempts.at(-1).requestedPort, 0);
  await connectAdapter(replacement, "legacy");
  const replacementLegacy = await exportConfig(
    "exportAdapterConfig",
    "new-automatic-legacy.toml",
  );
  assert.equal(replacementLegacy.port, replacement.port);
  await closeBlocker(oldPort);
  report.checks.push(
    "Explicit automatic selection binds a new available port and updates both export formats",
  );

  const occupied = await occupy();
  const occupiedPort = occupied.address().port;
  await page.evaluate(
    (adapterPort) => window.mai.updateSettings({ adapterPort }),
    occupiedPort,
  );
  const beforeConflict = (await audit()).attempts.length;
  const error = await page.evaluate(async () => {
    try {
      await window.mai.connect();
      return "";
    } catch (error) {
      return String(error.message || error);
    }
  });
  assert.ok(error, "A manually selected busy port must report an error");
  assert.equal((await snapshot()).connection.phase, "error");
  assert.equal((await snapshot()).settings.adapterPort, occupiedPort);
  assert.equal((await diskState()).settings.adapterPort, occupiedPort);
  const conflictAttempts = (await audit()).attempts.slice(beforeConflict);
  assert.equal(
    conflictAttempts.length,
    1,
    "Manual conflict must not fall back to a new listener",
  );
  assert.equal(conflictAttempts[0].requestedPort, occupiedPort);
  assert.equal(conflictAttempts[0].port, null);
  const failedExport = join(profile, "conflict.toml");
  await dialogPath(failedExport);
  assert.equal(
    await page.evaluate(async () => {
      try {
        await window.mai.exportMessageAdapterConfig();
        return false;
      } catch {
        return true;
      }
    }),
    true,
    "Failed manual binding must not export an unusable configuration",
  );
  await assert.rejects(readFile(failedExport), { code: "ENOENT" });
  await closeBlocker(occupied);
  const recovered = await exportConfig(
    "exportMessageAdapterConfig",
    "manual-recovered.toml",
  );
  assert.equal(recovered.port, occupiedPort);
  await connectAdapter(recovered, "legacy");
  report.checks.push(
    "Manual conflict preserves the requested port, reports failure without fallback/export, and recovers when the port is released",
  );

  await verifyCanceledBinding({ adapterPort: 0 }, "Port changed while opening");
  const afterPortCancel = await exportConfig(
    "exportMessageAdapterConfig",
    "after-port-cancel.toml",
  );
  await connectAdapter(afterPortCancel, "legacy");
  report.checks.push(
    "Port change before delayed real bind rejects the stale call, releases its listener, and preserves the new port choice",
  );
  await verifyCanceledBinding(
    { userId: "port-smoke-new-owner" },
    "Identity changed while opening",
  );
  assert.equal((await snapshot()).settings.adapterPort, afterPortCancel.port);
  const afterIdentityCancel = await exportConfig(
    "exportAdapterConfig",
    "after-identity-cancel.toml",
  );
  assert.equal(afterIdentityCancel.port, afterPortCancel.port);
  const newIdentityPeer = await connectAdapter(afterIdentityCancel);
  assert.equal((await snapshot()).connection.userId, "port-smoke-new-owner");
  assert.equal(newIdentityPeer.socket.readyState, WebSocket.OPEN);
  report.checks.push(
    "Same-port identity change rejects/cleans a stale bind and recovers with a real handshake using the new identity",
  );
  await verifyFailedPortSave();

  assert.deepEqual(pageErrors, []);
  await closeDesktop();
  await writeFile(
    join(base, "result.json"),
    JSON.stringify({ passed: true, ...report, pageErrors }, null, 2),
  );
  console.log(
    "PASS 自动端口：导出与握手、断开重启复用、手动冲突、并发取消、身份更新及保存失败恢复",
  );
} finally {
  for (const socket of clients)
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  await desktop?.close().catch(() => {});
  await Promise.all(
    [...blockers].map((server) => new Promise((done) => server.close(done))),
  );
  const target = resolve(profile);
  assert.ok(
    target.startsWith(base + sep),
    "Profile cleanup must stay inside the test cache",
  );
  await rm(target, { recursive: true, force: true });
}
