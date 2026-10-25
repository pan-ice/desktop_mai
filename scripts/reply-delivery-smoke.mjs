import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { _electron as electron, chromium } from "playwright";
import { createServer as createViteServer } from "vite";
import WebSocket from "ws";
import { inspectPackaged } from "./packaging-inspector.mjs";

// Exercise the shipped main's live-delivery eligibility around a real delayed
// persistence operation. No network voice service or user profile is used.
const base = resolve(".cache/reply-delivery-smoke");
await mkdir(base, { recursive: true });
const option = (name) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const mode = option("mode") || "build";
assert.ok(["build", "dev", "packaged"].includes(mode));
const phase =
  process.argv.find((value) => value.startsWith("--phase="))?.slice(8) ||
  (mode === "build" ? "after" : mode);
assert.match(phase, /^[a-z0-9-]+$/);
const selected = process.argv
  .find((value) => value.startsWith("--case="))
  ?.slice(7);
const caseNames = [
  "same-scope",
  "save-before-ready",
  "scope-change",
  "clear-history",
  "disconnect",
  "pending-scope-change",
  "pending-clear-history",
  "pending-disconnect",
];
const cases = selected ? [selected] : caseNames;
assert.ok(cases.every((name) => caseNames.includes(name)));
const report = { passed: true, phase, mode, cases: [] };
const metadata = JSON.parse(await readFile(resolve("package.json"), "utf8"));
let viteServer;

async function until(check, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(message);
}

async function runCase(name) {
  const profile = await mkdtemp(join(base, `${name}-`));
  const entry = join(profile, "bootstrap.mjs");
  const sockets = [];
  const result = { name, passed: false, errors: [] };
  let desktop;
  try {
    await writeFile(
      join(profile, "package.json"),
      JSON.stringify({
        name: metadata.name,
        version: metadata.version,
        type: "module",
        main: "bootstrap.mjs",
      }),
    );
    await writeFile(
      join(profile, "state.json"),
      JSON.stringify({
        version: 2,
        settings: {
          autoConnect: false,
          launchAtLogin: false,
          voiceEnabled: true,
          ttsEngine: "system",
        },
        history: [],
        models: [],
        encrypted: {},
      }),
    );
    await writeFile(
      entry,
      `
import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.showInactive = function () {};
globalShortcut.register = () => true;
globalShortcut.unregisterAll = () => {};
app.setLoginItemSettings = () => {};
globalThis.__replyDeliveryCommands = [];
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, (event, command, ...args) => {
  if (channel === "mai:command") globalThis.__replyDeliveryCommands.push(command);
  return listener(event, command, ...args);
});
await import(${JSON.stringify(pathToFileURL(resolve("out/main/index.js")).href)});
`,
    );
    const env = { ...process.env, MAI_USER_DATA: profile };
    for (const key of [
      "ELECTRON_RUN_AS_NODE",
      "ELECTRON_RENDERER_URL",
      "ELECTRON_ENTRY",
      "ELECTRON_CLI_ARGS",
      "ELECTRON_EXEC_PATH",
    ])
      delete env[key];
    if (mode === "dev") env.ELECTRON_RENDERER_URL = report.rendererUrl;
    if (mode !== "packaged") {
      desktop = await electron.launch({
        executablePath: resolve("node_modules/electron/dist/electron.exe"),
        args: [profile, "--disable-renderer-backgrounding"],
        cwd: resolve("."),
        env,
      });
      await desktop.firstWindow();
    } else {
      const executable = resolve(
        option("exe") ||
          process.env.MAI_TEST_EXE ||
          "release/win-unpacked/Mai 桌面伙伴.exe",
      );
      let output = "";
      let inspector, browser;
      const child = spawn(
        executable,
        [
          "--inspect-brk=127.0.0.1:0",
          "--remote-debugging-port=0",
          "--disable-renderer-backgrounding",
        ],
        {
          cwd: dirname(executable),
          env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.on("error", (error) => result.errors.push(error.message));
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (chunk) => {
          output = (output + chunk).slice(-12000);
        });
      desktop = {
        windows: () =>
          browser?.contexts().flatMap((context) => context.pages()) || [],
        evaluate: (callback, value) =>
          inspector.evaluate(
            `(${callback.toString()})(globalThis.__packagedElectron, ${JSON.stringify(value) ?? "undefined"})`,
          ),
        close: async () => {
          await inspector
            ?.evaluate(
              "setImmediate(() => globalThis.__packagedElectron.app.quit()); true",
            )
            .catch(() => {});
          await inspector?.close().catch(() => {});
          await browser?.close().catch(() => {});
          if (child.exitCode === null)
            await Promise.race([
              once(child, "exit"),
              new Promise((done) => setTimeout(done, 5000)),
            ]);
          if (child.exitCode === null) {
            child.kill();
            await once(child, "exit");
            throw new Error(
              "The isolated packaged test process required termination",
            );
          }
          assert.equal(child.exitCode, 0);
        },
      };
      let endpoint;
      await until(() => {
        if (result.errors.length) throw new Error(result.errors.join("\n"));
        if (child.exitCode !== null)
          throw new Error(
            `Packaged entry exited before the inspector: ${child.exitCode}`,
          );
        endpoint = output.match(
          /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/,
        )?.[1];
        return endpoint;
      }, "The actual packaged main must start its inspector");
      inspector = await inspectPackaged(
        endpoint,
        String.raw`
const fixtureRequire = process.getBuiltinModule("module").createRequire(process.resourcesPath + "/app.asar/package.json");
const { ipcMain: fixtureIpc, dialog: fixtureDialog } = fixtureRequire("electron");
globalThis.__packagedElectron.dialog = fixtureDialog;
globalThis.__replyDeliveryCommands = [];
const fixtureHandle = fixtureIpc.handle.bind(fixtureIpc);
fixtureIpc.handle = (channel, listener) => fixtureHandle(channel, (event, command, ...args) => {
  if (channel === "mai:command") globalThis.__replyDeliveryCommands.push(command);
  return listener(event, command, ...args);
});
`,
      );
      result.identity = inspector.identity;
      assert.equal(
        resolve(inspector.identity.executable).toLowerCase(),
        executable.toLowerCase(),
      );
      let browserEndpoint;
      await until(() => {
        browserEndpoint = output.match(
          /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/,
        )?.[1];
        return browserEndpoint;
      }, "The actual packaged browser must open");
      browser = await chromium.connectOverCDP(browserEndpoint);
    }
    let page, pet;
    await until(() => {
      page = desktop
        .windows()
        .find((window) => window.url().includes("view=dashboard"));
      pet = desktop
        .windows()
        .find((window) => window.url().includes("view=pet"));
      return page && pet;
    }, "The actual dashboard and pet must open");
    for (const window of [page, pet])
      window.on("pageerror", (error) => result.errors.push(error.message));
    await pet.locator(".pet-character").waitFor();
    result.version = (await page.evaluate(() => window.mai.snapshot())).version;
    assert.equal(result.version, metadata.version);
    for (const window of [page, pet]) {
      if (mode === "dev")
        assert.equal(new URL(window.url()).origin, report.rendererUrl);
      else assert.equal(new URL(window.url()).protocol, "file:");
      if (mode === "packaged")
        assert.match(window.url(), /app\.asar\/out\/renderer\/index\.html/);
    }
    await pet.evaluate(() => {
      window.__deliverySpoken = [];
      window.__deliveryLiveSnapshots = [];
      window.mai.subscribe((state) =>
        window.__deliveryLiveSnapshots.push({
          phase: state.connection.phase,
          live: state.liveReplies.map((reply) => reply.id),
        }),
      );
      speechSynthesis.cancel = () => {};
      speechSynthesis.speak = (utterance) => {
        window.__deliverySpoken.push(utterance.text);
        utterance.onstart?.({});
        queueMicrotask(() => utterance.onend?.({}));
      };
    });
    const configPath = join(profile, "adapter.toml");
    await desktop.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, configPath);
    await page.evaluate(async () => {
      await window.mai.exportAdapterConfig();
      await window.mai.connect();
    });
    const config = await readFile(configPath, "utf8");
    const token = JSON.parse(config.match(/^token = (.+)$/m)[1]);
    const state = () => page.evaluate(() => window.mai.snapshot());
    const open = async () => {
      const { settings } = await state();
      const socket = new WebSocket(
        `ws://127.0.0.1:${settings.adapterPort}/maibot`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      sockets.push(socket);
      socket.acks = [];
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === "reply_ack") socket.acks.push(frame.id);
      });
      await once(socket, "open");
      const welcome = once(socket, "message");
      socket.send(
        JSON.stringify({
          v: 1,
          type: "hello",
          protocol: "mai-desktop",
          pluginVersion: "0.4.6",
          instanceId: randomUUID(),
          startedAt: Date.now(),
          identity: {
            platform: settings.platform,
            accountId: settings.botId,
            userId: settings.userId,
            scope: settings.adapterScope,
          },
        }),
      );
      await welcome;
      socket.send(
        JSON.stringify({
          v: 1,
          type: "ready",
          sessionId: "delivery-test-session",
          capabilities: ["chat", "image", "audio", "proactive"],
        }),
      );
      await until(
        async () => (await state()).connection.phase === "connected",
        "The real bridge must become ready",
      );
      return socket;
    };
    const send = (socket, id) =>
      socket.send(
        JSON.stringify({
          v: 1,
          type: "reply",
          id,
          sessionId: "delivery-test-session",
          segments: [{ type: "text", text: id }],
        }),
      );
    const first = await open();
    send(first, "1");
    await until(() => first.acks.includes("1"), "Reply 1 must be persisted");
    await until(
      async () =>
        (await pet.evaluate(() => window.__deliverySpoken)).includes("1"),
      "Reply 1 must be read",
    );
    await desktop.evaluate(() => {
      const filesystem = process.getBuiltinModule("node:fs/promises");
      const { syncBuiltinESMExports } = process.getBuiltinModule("node:module");
      const original = filesystem.writeFile;
      const gate = (globalThis.__replyDeliverySave = {
        entered: false,
        release: null,
        restore: null,
      });
      gate.restore = () => {
        filesystem.writeFile = original;
        syncBuiltinESMExports();
        gate.release?.();
      };
      filesystem.writeFile = async (path, content, ...args) => {
        if (
          String(path).endsWith("state.json.tmp") &&
          !gate.entered &&
          JSON.parse(String(content)).history.at(-1)?.id === "2"
        ) {
          gate.entered = true;
          await new Promise((done) => {
            gate.release = done;
          });
        }
        return original.call(filesystem, path, content, ...args);
      };
      syncBuiltinESMExports();
    });
    send(first, "2");
    await until(
      () => desktop.evaluate(() => globalThis.__replyDeliverySave.entered),
      "Reply 2 must reach the actual persistence gate",
    );

    const pending = name.startsWith("pending-");
    const action = name.replace(/^pending-/, "");
    const positive = action === "same-scope" || action === "save-before-ready";
    let second = first;
    let operation;
    let released = false;
    if (positive || pending) {
      first.terminate();
      await until(
        async () => (await state()).connection.phase === "reconnecting",
        "The actual peer must disconnect",
      );
      if (action === "same-scope") second = await open();
      else {
        await desktop.evaluate(() => globalThis.__replyDeliverySave.restore());
        released = true;
        await until(
          async () =>
            JSON.parse(
              await readFile(join(profile, "state.json"), "utf8"),
            ).history.at(-1)?.id === "2",
          "Reply 2 must actually be persisted before ready",
        );
        await state();
        if (action === "save-before-ready") second = await open();
      }
    }
    if (action === "scope-change") {
      operation = page.evaluate(() =>
        window.mai.updateSettings({ adapterScope: "different-conversation" }),
      );
      await until(
        async () =>
          (await state()).settings.adapterScope === "different-conversation",
        "The connection identity must actually change before save completes",
      );
    } else if (action === "clear-history") {
      operation = page.evaluate(() => window.mai.clearHistory());
      await until(
        () =>
          desktop.evaluate(() =>
            globalThis.__replyDeliveryCommands.includes("clearHistory"),
          ),
        "The actual clear-history command must be pending",
      );
    } else if (action === "disconnect") {
      await page.evaluate(() => window.mai.disconnect());
      await until(
        async () => (await state()).connection.phase === "disconnected",
        "The explicit disconnect must complete",
      );
    }
    if (!released)
      await desktop.evaluate(() => globalThis.__replyDeliverySave.restore());
    await operation;
    if (action === "scope-change" || action === "disconnect") {
      await page.evaluate(() => window.mai.connect());
      second = await open();
    } else if (pending) second = await open();
    send(second, "3");
    await until(() => second.acks.includes("3"), "Reply 3 must be persisted");
    await until(
      async () =>
        (await pet.evaluate(() => window.__deliverySpoken)).includes("3"),
      "Reply 3 must be read",
    );
    const final = await state();
    result.history = final.history.map((message) => message.id);
    result.live = final.liveReplies.map((message) => message.id);
    result.spoken = await pet.evaluate(() => window.__deliverySpoken);
    const eligibility = await pet.evaluate(
      () => window.__deliveryLiveSnapshots,
    );
    result.liveTwoWasPublished = eligibility.some((value) =>
      value.live.includes("2"),
    );
    assert.equal(
      eligibility.some(
        (value) => value.phase !== "connected" && value.live.includes("2"),
      ),
      false,
      "A persisted reply must wait for ready before receiving live eligibility",
    );
    if (positive) {
      assert.deepEqual(result.history, ["1", "2", "3"]);
      assert.deepEqual(result.live, ["2", "3"]);
      assert.deepEqual(
        result.spoken,
        ["1", "2", "3"],
        "Same-scope reconnect must preserve reply 2 and its position before 3",
      );
    } else {
      assert.equal(
        result.liveTwoWasPublished,
        false,
        "Clearing, switching identity or explicit disconnect must reject the old pending reply",
      );
      assert.deepEqual(result.spoken, ["1", "3"]);
      assert.deepEqual(
        result.history,
        action === "clear-history" ? ["3"] : ["1", "2", "3"],
      );
    }
    assert.deepEqual(result.errors, []);
    result.passed = true;
  } catch (error) {
    result.failure = error.message;
  } finally {
    for (const socket of sockets) socket.terminate();
    await desktop
      ?.evaluate(() => globalThis.__replyDeliverySave?.restore())
      .catch(() => {});
    try {
      await desktop?.close();
    } catch (error) {
      result.errors.push(`cleanup: ${error.message}`);
      result.passed = false;
    }
    assert.ok(profile.startsWith(base + sep));
    await rm(profile, { recursive: true, force: true });
  }
  return result;
}

try {
  if (mode === "dev") {
    viteServer = await createViteServer({
      configFile: resolve("vite.config.ts"),
      logLevel: "silent",
      clearScreen: false,
    });
    await viteServer.listen();
    const address = viteServer.httpServer.address();
    assert.ok(address && typeof address === "object" && address.port > 0);
    report.rendererUrl = `http://127.0.0.1:${address.port}`;
  }
  for (const name of cases) {
    const result = await runCase(name);
    report.cases.push(result);
    if (!result.passed) report.passed = false;
  }
} finally {
  await viteServer?.close();
}
await writeFile(
  join(base, `${phase}.json`),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
