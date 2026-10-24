import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { join, resolve, sep } from "node:path";
import { chromium } from "playwright";
import WebSocket from "ws";
import { fileHash } from "./packaging-tools.mjs";
import { inspectPackaged, pause, until } from "./packaging-inspector.mjs";

// Launch the genuine Portable EXE, without a bootstrap entry or modified ASAR.
// Inspector hooks only keep windows hidden, stub native dialogs and block remote I/O.
const base = resolve(".cache/portable-smoke");
const info = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const executable = resolve(
  `release/Mai-Desktop-Pet-${info.version}-win-x64.exe`,
);
await mkdir(base, { recursive: true });
const profile = await mkdtemp(join(base, "profile-"));
const modelId = randomUUID();
const mediaName = `${randomUUID()}.png`;
const mediaUrl = `mai-media://attachment/${mediaName}`;
await mkdir(join(profile, "models", modelId), { recursive: true });
await mkdir(join(profile, "media"), { recursive: true });
await copyFile(
  resolve("resources/icon.png"),
  join(profile, "models", modelId, "fixture.png"),
);
await copyFile(
  resolve("resources/icon.png"),
  join(profile, "media", mediaName),
);
await writeFile(
  join(profile, "state.json"),
  JSON.stringify({
    version: 2,
    settings: {
      autoConnect: false,
      launchAtLogin: false,
      reducedMotion: true,
      petVisible: false,
      voiceEnabled: false,
      adapterPort: 0,
    },
    history: [
      {
        id: randomUUID(),
        role: "assistant",
        text: "发行包本机媒体夹具",
        timestamp: Date.now(),
        source: "core",
        attachments: [{ type: "image", dataUrl: mediaUrl }],
      },
    ],
    models: [
      {
        id: modelId,
        name: "本机测试图标",
        kind: "image",
        entry: "fixture.png",
        addedAt: Date.now(),
        assetUrl: "",
      },
    ],
    encrypted: {},
  }),
);
const report = {
  passed: false,
  version: info.version,
  executable,
  checks: [],
  sessions: [],
};
const trapRequests = [];
const trap = createHttpServer((request, response) => {
  trapRequests.push(request.url);
  response.writeHead(500);
  response.end("Unexpected renderer source");
});
trap.listen(0, "127.0.0.1");
await once(trap, "listening");
const rendererUrl = `http://127.0.0.1:${trap.address().port}/`;
const clients = new Set();
let active;

async function debugPorts() {
  const servers = [createServer(), createServer()];
  for (const server of servers) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
  }
  const ports = servers.map((server) => server.address().port);
  await Promise.all(
    servers.map((server) => new Promise((done) => server.close(done))),
  );
  return { inspector: ports[0], browser: ports[1] };
}
async function launch() {
  const ports = await debugPorts();
  const env = { ...process.env, MAI_USER_DATA: profile };
  for (const key of [
    "NODE_OPTIONS",
    "PORTABLE_EXECUTABLE_FILE",
    "PORTABLE_EXECUTABLE_DIR",
    "ELECTRON_ENTRY",
    "ELECTRON_CLI_ARGS",
    "V8_INSPECTOR_PORT",
    "V8_INSPECTOR_BRK_PORT",
    "REMOTE_DEBUGGING_PORT",
  ])
    delete env[key];
  // These must be harmless even when inherited by the real production executable.
  env.ELECTRON_RUN_AS_NODE = "1";
  env.ELECTRON_RENDERER_URL = rendererUrl;
  const child = spawn(
    executable,
    [
      `--inspect-brk=127.0.0.1:${ports.inspector}`,
      `--remote-debugging-port=${ports.browser}`,
      "--disable-renderer-backgrounding",
    ],
    { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const session = {
    child,
    inspector: undefined,
    browser: undefined,
    page: undefined,
    errors: [],
    output: "",
  };
  active = session;
  child.on("error", (error) => session.errors.push(error.message));
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      session.output = (session.output + data).slice(-8000);
    });
  const targets = await until(
    async () => {
      if (session.errors.length) throw new Error(session.errors.join("\n"));
      try {
        return await (
          await fetch(`http://127.0.0.1:${ports.inspector}/json/list`, {
            signal: AbortSignal.timeout(1000),
          })
        ).json();
      } catch {
        return false;
      }
    },
    "Portable EXE did not expose the paused real main",
    60000,
  );
  session.inspector = await inspectPackaged(targets[0].webSocketDebuggerUrl);
  await until(async () => {
    try {
      return (
        await fetch(`http://127.0.0.1:${ports.browser}/json/version`, {
          signal: AbortSignal.timeout(1000),
        })
      ).ok;
    } catch {
      return false;
    }
  }, "Portable EXE did not start Chromium");
  session.browser = await chromium.connectOverCDP(
    `http://127.0.0.1:${ports.browser}`,
  );
  await until(() => {
    const pages = session.browser
      .contexts()
      .flatMap((context) => context.pages());
    session.page = pages.find((page) => page.url().includes("view=dashboard"));
    return (
      session.page && pages.find((page) => page.url().includes("view=pet"))
    );
  }, "The actual packaged dashboard and pet must both load");
  for (const page of session.browser
    .contexts()
    .flatMap((context) => context.pages())) {
    page.on("pageerror", (error) => session.errors.push(error.message));
    assert.ok(
      page.url().startsWith("file:") &&
        page.url().includes("app.asar/out/renderer/index.html"),
      `Expected bundled renderer: ${page.url()}`,
    );
    await page.waitForFunction(() => Boolean(window.mai));
    const policy = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute("content");
    assert.ok(policy, "The actual bundled page must supply its production CSP");
    assert.doesNotMatch(
      policy,
      /\bwss?:|https?:\/\/(?:localhost|\[::1\]|127(?:\.\d{1,3}){3})(?=[:/\s;]|$)/i,
      "The actual bundled page must not authorize development WebSockets",
    );
  }
  await session.page.locator(".app-shell").waitFor();
  const state = await session.page.evaluate(() => window.mai.snapshot());
  assert.equal(state.version, info.version);
  assert.equal(state.desktop, true);
  assert.equal(state.connection.phase, "disconnected");
  const identity = session.inspector.identity;
  assert.notEqual(
    resolve(identity.executable),
    resolve("node_modules/electron/dist/electron.exe"),
  );
  const packagedFingerprint = await session.inspector.evaluate(
    `process.getBuiltinModule("fs").readFileSync(process.resourcesPath + "/app.asar/out/.production-build.json", "utf8")`,
  );
  assert.equal(
    packagedFingerprint,
    await readFile(resolve("out/.production-build.json"), "utf8"),
    "Portable must contain the final unified build",
  );
  report.sessions.push({
    packaged: identity.packaged,
    executable: identity.executable,
    windows: 2,
    rendererProtocol: "file:",
    developmentWebSocketAccess: false,
  });
  return session;
}

async function closeSession() {
  if (!active) return;
  const session = active;
  let failure;
  try {
    if (session.inspector) {
      const audit = await session.inspector.evaluate(
        `({ ...globalThis.__packagedAudit, visible: globalThis.__packagedElectron.BrowserWindow.getAllWindows().some(window => window.isVisible()) })`,
      );
      assert.deepEqual(audit.errors, []);
      assert.deepEqual(audit.blocked, []);
      assert.equal(audit.visible, false);
    }
    assert.deepEqual(session.errors, []);
  } catch (error) {
    failure = error;
  }
  if (session.page) {
    await session.page
      .evaluate(() => {
        void window.mai.quit();
      })
      .catch(() => {});
  }
  await session.inspector?.close().catch(() => {});
  await session.browser?.close().catch(() => {});
  if (session.child.exitCode === null && session.child.signalCode === null) {
    await Promise.race([once(session.child, "close"), pause(5000)]);
    if (session.child.exitCode === null && session.child.pid) {
      const killer = spawn(
        "taskkill.exe",
        ["/PID", String(session.child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      await once(killer, "exit");
      failure ||= new Error("Portable did not exit cleanly after quit");
    }
  }
  active = undefined;
  if (failure) throw failure;
}

async function connectAdapter(page, config) {
  const state = await page.evaluate(() => window.mai.snapshot());
  const socket = new WebSocket(config.url, {
    headers: { Authorization: `Bearer ${config.token}` },
    handshakeTimeout: 5000,
  });
  clients.add(socket);
  const requests = [];
  const errors = [];
  const sessionId = `portable-${randomUUID()}`;
  socket.on("error", (error) => errors.push(error.message));
  socket.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === "welcome")
      socket.send(
        JSON.stringify({
          v: 1,
          type: "ready",
          sessionId,
          transport: "legacy",
          capabilities: ["chat", "image", "audio"],
        }),
      );
    if (frame.type === "request") {
      requests.push(frame);
      socket.send(
        JSON.stringify({ v: 1, type: "result", id: frame.id, ok: true }),
      );
    }
  });
  await once(socket, "open");
  socket.send(
    JSON.stringify({
      v: 1,
      type: "hello",
      protocol: "mai-desktop",
      pluginVersion: "0.4.5",
      instanceId: randomUUID(),
      startedAt: Date.now(),
      identity: {
        platform: state.settings.platform,
        accountId: state.settings.botId,
        userId: state.settings.userId,
        scope: state.settings.adapterScope,
      },
    }),
  );
  await until(
    async () =>
      (await page.evaluate(() => window.mai.snapshot())).connection
        .sessionId === sessionId,
    "Exported listener must accept a real adapter handshake",
  );
  await page.evaluate(() =>
    window.mai.send({ text: "正式发行包本机消息验收", source: "text" }),
  );
  assert.ok(
    requests.some(
      (frame) =>
        frame.params?.text === "正式发行包本机消息验收" ||
        JSON.stringify(frame).includes("正式发行包本机消息验收"),
    ),
  );
  assert.deepEqual(errors, []);
  socket.close();
  await once(socket, "close");
  clients.delete(socket);
}

try {
  const session = await launch();
  const { page, inspector } = session;
  report.checks.push(
    "real Portable entry, bundled dual windows, dirty environment ignored",
  );
  for (const name of [
    "此刻",
    "和麦麦聊聊",
    "角色衣橱",
    "声音与感知",
    "连接与账号",
    "偏好设置",
  ]) {
    const button = page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name, exact: false });
    await button.click();
    await until(
      () =>
        button.evaluate((element) => element.classList.contains("selected")),
      `Navigation did not select ${name}`,
    );
  }
  report.checks.push("all six pages navigate through the shipped renderer");
  const state = await page.evaluate(() => window.mai.snapshot());
  const assetUrl = state.models.find((model) => model.id === modelId).assetUrl;
  const protocol = await page.evaluate(
    async ({ assetUrl, mediaUrl }) => {
      const read = async (url, headers) => {
        const response = await fetch(url, { headers });
        return {
          status: response.status,
          bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
          range: response.headers.get("Content-Range"),
        };
      };
      return {
        asset: await read(assetUrl),
        media: await read(mediaUrl),
        range: await read(mediaUrl, { Range: "bytes=0-7" }),
      };
    },
    { assetUrl, mediaUrl },
  );
  const expectedBytes = [...(await readFile(resolve("resources/icon.png")))];
  assert.equal(protocol.asset.status, 200);
  assert.deepEqual(protocol.asset.bytes, expectedBytes);
  assert.equal(protocol.media.status, 200);
  assert.deepEqual(protocol.media.bytes, expectedBytes);
  assert.equal(protocol.range.status, 206);
  assert.deepEqual(protocol.range.bytes, expectedBytes.slice(0, 8));
  report.checks.push("mai-asset and mai-media bytes plus media Range protocol");
  await page.evaluate(() =>
    window.mai.updateSettings({ userName: "正式包验收", activeModelId: null }),
  );
  assert.equal(
    (await page.evaluate(() => window.mai.snapshot())).settings.adapterPort,
    0,
  );
  const exportPath = join(profile, "adapter.toml");
  await inspector.evaluate(
    `globalThis.__packagedSavePath = ${JSON.stringify(exportPath)}`,
  );
  assert.equal(
    await page.evaluate(() => window.mai.exportMessageAdapterConfig()),
    true,
  );
  const configText = await readFile(exportPath, "utf8");
  const desktop = configText.match(/\[desktop\]([\s\S]*?)(?=\n\[|$)/)[1];
  const field = (name) =>
    JSON.parse(desktop.match(new RegExp(`^${name} = (".*")$`, "m"))[1]);
  const config = { url: field("url"), token: field("token") };
  const port = Number(new URL(config.url).port);
  assert.ok(port > 0 && port <= 65535);
  const saved = JSON.parse(await readFile(join(profile, "state.json"), "utf8"));
  assert.equal(saved.settings.adapterPort, port);
  const audit = await inspector.evaluate("globalThis.__packagedAudit");
  assert.ok(
    audit.listens.some(
      (attempt) =>
        attempt.requested === 0 && attempt.port === port && !attempt.closed,
    ),
  );
  await connectAdapter(page, config);
  report.port = port;
  report.checks.push(
    "auto port bound and persisted before export, authenticated local handshake and send IPC",
  );
  const screenshot = await inspector.evaluate(
    `(async () => { const window = globalThis.__packagedElectron.BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes("view=dashboard")); return (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString("base64"); })()`,
  );
  await writeFile(
    join(base, "portable.png"),
    Buffer.from(screenshot, "base64"),
  );
  await closeSession();
  const restarted = await launch();
  const restored = await restarted.page.evaluate(() => window.mai.snapshot());
  assert.equal(restored.settings.userName, "正式包验收");
  assert.equal(restored.settings.adapterPort, port);
  assert.ok(
    restored.history.some(
      (message) => message.text === "正式发行包本机消息验收",
    ),
  );
  await closeSession();
  report.checks.push(
    "clean shutdown and second actual Portable launch preserve settings, port and chat",
  );
  assert.deepEqual(
    trapRequests,
    [],
    "The inherited renderer URL must never receive a request",
  );
  report.sha256 = await fileHash(executable);
  report.passed = true;
  console.log(
    `PASS 最终 Portable v${info.version}：真实入口、隐藏双窗/六页、脏环境、资源协议、自动端口导出与握手、消息和重启持久化`,
  );
} catch (error) {
  report.error = error.stack || String(error);
  throw error;
} finally {
  for (const client of clients) client.terminate();
  await closeSession().catch((error) => {
    report.cleanupError = error.stack;
    report.passed = false;
  });
  await new Promise((done) => trap.close(done));
  const target = resolve(profile);
  assert.ok(target.startsWith(`${base}${sep}`));
  await rm(target, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 300,
  });
  await writeFile(join(base, "result.json"), JSON.stringify(report, null, 2));
}
