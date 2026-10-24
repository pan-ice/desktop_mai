import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";

export const pause = (milliseconds) =>
  new Promise((done) => setTimeout(done, milliseconds));

export async function until(check, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await pause(100);
  }
  throw new Error(message);
}

// Only native side effects are replaced. The shipped main, preload, renderer,
// IPC handlers, settings store, protocols and listener execute unmodified.
const fixtures = String.raw`
const require = process.getBuiltinModule("module").createRequire(process.resourcesPath + "/app.asar/package.json");
const { app, BrowserWindow, dialog, globalShortcut, session, net: electronNet, shell } = require("electron");
globalThis.__packagedAudit = { errors: [], blocked: [], listens: [] };
globalThis.__packagedSavePath = undefined;
globalThis.__packagedElectron = { app, BrowserWindow };
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.showInactive = function () {};
globalShortcut.register = () => false;
globalShortcut.unregisterAll = () => {};
app.setLoginItemSettings = () => { throw new Error("Packaged smoke must not change login settings"); };
dialog.showErrorBox = (title, message) => globalThis.__packagedAudit.errors.push({ title, message });
dialog.showSaveDialog = async () => globalThis.__packagedSavePath
  ? { canceled: false, filePath: globalThis.__packagedSavePath }
  : { canceled: true };
const loopback = (host) => !host || host === "localhost" || host === "::1" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
const rejectRemote = (host) => {
  if (!loopback(host)) {
    globalThis.__packagedAudit.blocked.push(host);
    throw new Error("Packaged smoke blocked a non-loopback destination: " + host);
  }
};
const checkUrl = (value) => {
  const url = new URL(typeof value === "string" || value instanceof URL ? value : value.url);
  if (["http:", "https:", "ws:", "wss:"].includes(url.protocol)) rejectRemote(url.hostname);
};
const { Socket, Server } = require("node:net");
const originalConnect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  rejectRemote(first && typeof first === "object" ? first.host : typeof args[1] === "string" ? args[1] : undefined);
  return originalConnect.apply(this, args);
};
const originalListen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  const attempt = { requested: typeof args[0] === "object" ? args[0].port : args[0], port: null, closed: false };
  globalThis.__packagedAudit.listens.push(attempt);
  this.once("listening", () => { attempt.port = this.address().port; });
  this.once("close", () => { attempt.closed = true; });
  return originalListen.apply(this, args);
};
for (const owner of [globalThis, electronNet]) {
  const original = owner.fetch.bind(owner);
  owner.fetch = (value, ...args) => { checkUrl(value); return original(value, ...args); };
}
shell.openExternal = async (url) => { checkUrl(url); };
shell.openPath = async () => "";
app.on("browser-window-created", (_event, window) => {
  window.webContents.on("did-fail-load", (_event, code, message, url, mainFrame) => {
    if (mainFrame) globalThis.__packagedAudit.errors.push({ code, message, url });
  });
});
const ready = () => session.defaultSession.webRequest.onBeforeRequest(
  { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
  (request, done) => {
    try { checkUrl(request.url); done({}); }
    catch { done({ cancel: true }); }
  },
);
if (app.isReady()) ready(); else app.once("ready", ready);
return { packaged: app.isPackaged, appPath: app.getAppPath(), pid: process.pid, executable: process.execPath };
`;

export async function inspectPackaged(endpoint, setup = "") {
  const socket = new WebSocket(endpoint);
  await once(socket, "open");
  let sequence = 0;
  let paused;
  const calls = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.method === "Debugger.paused") paused = message.params;
    const pending = calls.get(message.id);
    if (!pending) return;
    calls.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolveCall, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        calls.delete(id);
        reject(new Error(`Inspector timed out: ${method}`));
      }, 15000);
      calls.set(id, { resolve: resolveCall, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const close = async () => {
    for (const pending of calls.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Packaged inspector closed"));
    }
    calls.clear();
    if (socket.readyState === WebSocket.CLOSED) return;
    socket.close();
    await once(socket, "close");
  };
  try {
    await send("Runtime.enable");
    await send("Debugger.enable");
    await send("Runtime.runIfWaitingForDebugger");
    await until(
      () => paused,
      "The packaged main must pause before opening windows",
    );
    const installed = await send("Debugger.evaluateOnCallFrame", {
      callFrameId: paused.callFrames[0].callFrameId,
      expression: `(() => { ${fixtures} })()`,
      returnByValue: true,
    });
    assert.equal(
      installed.exceptionDetails,
      undefined,
      JSON.stringify(installed.exceptionDetails),
    );
    const identity = installed.result?.value;
    assert.equal(
      identity?.packaged,
      true,
      "The actual packaged entry must run",
    );
    assert.match(identity.appPath, /app\.asar$/);
    if (setup) {
      const configured = await send("Debugger.evaluateOnCallFrame", {
        callFrameId: paused.callFrames[0].callFrameId,
        expression: `(() => { ${setup} })()`,
        returnByValue: true,
      });
      assert.equal(
        configured.exceptionDetails,
        undefined,
        JSON.stringify(configured.exceptionDetails),
      );
    }
    await send("Debugger.resume");
    await send("Debugger.disable");
    return {
      identity,
      close,
      async evaluate(expression) {
        const result = await send("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        assert.equal(
          result.exceptionDetails,
          undefined,
          JSON.stringify(result.exceptionDetails),
        );
        return result.result?.value;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
