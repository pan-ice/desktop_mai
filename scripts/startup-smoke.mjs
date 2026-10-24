import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createConnection, createServer } from "node:net";
import { chromium } from "playwright";
import WebSocket from "ws";

// Start real Electron entry points with fresh data. Native windows stay hidden;
// only the error-dialog display is replaced so a failed startup cannot block CI.
const root = resolve(".");
const base = join(root, ".cache/startup-smoke");
const phase = process.argv.find((arg) => arg.startsWith("--phase="))?.slice(8);
const phases = [
  "missing-renderer",
  "cli",
  "cli-polluted",
  "cli-rebuild",
  "cli-dev",
];
assert.ok(!phase || phases.includes(phase), "Unknown startup smoke phase");
const skipCli = process.argv.includes("--skip-cli");
assert.ok(!skipCli || !phase || phase === "missing-renderer");
await mkdir(base, { recursive: true });
const run = await mkdtemp(join(base, "run-"));
const results = [];
const children = new Set();

function cleanEnvironment(profile) {
  const env = { ...process.env, MAI_USER_DATA: profile };
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "ELECTRON_RENDERER_URL",
    "ELECTRON_ENTRY",
    "ELECTRON_EXEC_PATH",
    "ELECTRON_CLI_ARGS",
    "V8_INSPECTOR_PORT",
    "V8_INSPECTOR_BRK_PORT",
    "REMOTE_DEBUGGING_PORT",
    "NODE_OPTIONS",
    "PORTABLE_EXECUTABLE_FILE",
  ])
    delete env[key];
  return env;
}

const nativeFixtures = String.raw`
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.showInactive = function () {};
globalShortcut.register = () => false;
app.setLoginItemSettings = () => { throw new Error("Startup smoke must not alter login settings"); };
dialog.showErrorBox = (title, message) => {
  console.error("[startup-error] " + JSON.stringify({ title, message }));
};
app.on("browser-window-created", (_event, window) => {
  window.webContents.on("did-fail-load", (_event, code, message, url, mainFrame) => {
    if (mainFrame) console.error("[startup-load-failed] " + JSON.stringify({ code, message, url }));
  });
});
const networkRules = () => {
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    (request, done) => {
      const host = new URL(request.url).hostname;
      const local = host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
      if (!local) console.error("[startup-blocked-network] " + host);
      done({ cancel: !local });
    },
  );
};
if (app.isReady()) networkRules();
else app.once("ready", networkRules);
`;

async function fixture(name, sources = false) {
  const directory = join(run, name);
  const app = join(directory, "app");
  const profile = join(directory, "profile");
  await mkdir(app, { recursive: true });
  await mkdir(profile, { recursive: true });
  for (const path of sources
    ? ["out", "resources"]
    : ["out/main", "out/preload", "resources"])
    await cp(join(root, path), join(app, path), {
      recursive: true,
      preserveTimestamps: true,
    });
  if (sources) {
    for (const path of [
      "electron",
      "shared",
      "src",
      "scripts",
      "tests",
      "package-lock.json",
      "tsconfig.json",
      "electron.vite.config.ts",
      "dev-csp.ts",
      "index.html",
      "vite.config.ts",
      "vitest.config.ts",
    ])
      await cp(join(root, path), join(app, path), {
        recursive: true,
        preserveTimestamps: true,
      });
    // Include shared top-level Vite helpers without copying private files.
    for (const entry of await readdir(root, { withFileTypes: true }))
      if (entry.isFile() && /\.(?:ts|mjs)$/.test(entry.name))
        await cp(join(root, entry.name), join(app, entry.name), {
          preserveTimestamps: true,
        });
  }
  const info = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (sources) await cp(join(root, "package.json"), join(app, "package.json"));
  else
    // Only the deliberately broken app needs a shim to capture its error box.
    await writeFile(
      join(app, "package.json"),
      JSON.stringify({ ...info, main: "startup-entry.mjs" }, null, 2),
    );
  await writeFile(
    join(profile, "state.json"),
    JSON.stringify({
      version: 2,
      settings: {
        autoConnect: false,
        launchAtLogin: false,
        reducedMotion: true,
      },
      history: [],
      models: [],
      encrypted: {},
    }),
  );
  if (!sources)
    await writeFile(
      join(app, "startup-entry.mjs"),
      `
import { app, BrowserWindow, dialog, globalShortcut, session } from "electron";
${nativeFixtures}
await import(${JSON.stringify(pathToFileURL(join(app, "out/main/index.js")).href)});
`,
    );
  return { app, profile, version: info.version };
}

async function devFixture(name) {
  const value = await fixture(name, true);
  const trace = join(dirname(value.profile), "http-listen.jsonl");
  // The real repository is outside .cache. Keep the same child-cache exclusion
  // in this nested copy so its source can receive real HMR updates.
  for (const entry of await readdir(value.app, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:ts|mjs)$/.test(entry.name)) continue;
    const file = join(value.app, entry.name);
    const source = await readFile(file, "utf8");
    if (source.includes("**/.cache/**"))
      await writeFile(
        file,
        source.replaceAll(
          "**/.cache/**",
          join(value.app, ".cache/**").replaceAll("\\", "/"),
        ),
      );
  }
  // Observe the actual Node HTTP boundary; no port argument is changed.
  await writeFile(
    join(value.app, "startup-listen-observer.mjs"),
    `import { Server } from "node:http";
import { appendFileSync } from "node:fs";
const marker = Symbol.for("mai.startup.http-listen-observer");
if (!Server.prototype[marker]) {
  Server.prototype[marker] = true;
  const native = Server.prototype.listen;
  Server.prototype.listen = function (...args) {
    const requested = typeof args[0] === "object" ? args[0].port : args[0];
    this.once("listening", () => {
      const address = this.address();
      appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ requested, actual: typeof address === "object" ? address?.port : address }) + "\\n");
    });
    return Reflect.apply(native, this, args);
  };
}
`,
  );
  const config = join(value.app, "electron.vite.config.ts");
  await writeFile(
    config,
    'import "./startup-listen-observer.mjs";\n' +
      (await readFile(config, "utf8")),
  );
  return { ...value, listenTrace: trace };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function launch(command, args, options) {
  const child = spawn(command, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  children.add(child);
  const output = { stdout: "", stderr: "" };
  for (const stream of ["stdout", "stderr"])
    child[stream].on("data", (data) => {
      output[stream] = (output[stream] + data.toString()).slice(-32000);
    });
  const ended = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  return { child, output, ended };
}

async function waitForExit(process, timeout) {
  let timer;
  try {
    return await Promise.race([
      process.ended,
      new Promise((done) => {
        timer = setTimeout(() => done(null), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid)
    return;
  if (process.platform === "win32") {
    const killer = spawn(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      {
        windowsHide: true,
        stdio: "ignore",
      },
    );
    await once(killer, "exit");
  } else child.kill("SIGKILL");
}

async function removeFixture(path) {
  const target = resolve(path);
  assert.ok(target.startsWith(`${resolve(run)}${sep}`));
  await rm(target, {
    recursive: true,
    force: true,
    maxRetries: 6,
    retryDelay: 150,
  });
}

async function until(predicate, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(message);
}

async function missingRenderer() {
  const { app, profile } = await fixture("missing-renderer");
  const process = launch(
    join(root, "node_modules/electron/dist/electron.exe"),
    [app, "--disable-renderer-backgrounding"],
    { cwd: app, env: cleanEnvironment(profile) },
  );
  const exited = await waitForExit(process, 12000);
  results.push({
    phase: "missing-renderer",
    exited,
    stderr: process.output.stderr,
  });
  assert.ok(
    exited,
    "Missing renderer must report a startup failure and exit, not keep blank windows alive",
  );
  assert.match(
    process.output.stderr,
    /\[startup-error\].*Mai 启动失败/,
    "The startup failure must reach the user-facing error handler",
  );
  assert.doesNotMatch(process.output.stderr, /\[startup-blocked-network\]/);
  console.log("PASS missing renderer: clear startup error and process exit");
}

async function listening(port) {
  const server = createServer();
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return server;
}

async function debugPorts() {
  const browser = await listening(0);
  const inspector = await listening(0);
  const ports = {
    browser: browser.address().port,
    inspector: inspector.address().port,
  };
  await Promise.all(
    [browser, inspector].map(
      (server) => new Promise((done) => server.close(done)),
    ),
  );
  return ports;
}

async function portOpen(port) {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      done(false);
    });
  });
}

async function resumeHidden(endpoint, appDirectory) {
  const socket = new WebSocket(endpoint);
  await once(socket, "open");
  let sequence = 0;
  let paused;
  const calls = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.method === "Debugger.paused") paused = message.params;
    const pending = calls.get(message.id);
    if (pending) {
      calls.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolveCall, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        calls.delete(id);
        reject(new Error(`Inspector timed out: ${method}`));
      }, 10000);
      calls.set(id, { resolve: resolveCall, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  try {
    await send("Runtime.enable");
    await send("Debugger.enable");
    await send("Runtime.runIfWaitingForDebugger");
    await until(
      () => paused,
      "The real Electron entry must pause before opening windows",
    );
    const installed = await send("Debugger.evaluateOnCallFrame", {
      callFrameId: paused.callFrames[0].callFrameId,
      expression: `(() => {
        const { app, BrowserWindow, dialog, globalShortcut, session } = process.getBuiltinModule("module").createRequire(${JSON.stringify(join(appDirectory, "package.json"))})("electron");
        ${nativeFixtures}
        return true;
      })()`,
      returnByValue: true,
    });
    assert.equal(
      installed.exceptionDetails,
      undefined,
      "Native test fixtures must install before resuming the real main",
    );
    assert.equal(installed.result?.value, true);
    await send("Debugger.resume");
  } finally {
    for (const pending of calls.values()) clearTimeout(pending.timer);
    socket.close();
    await once(socket, "close");
  }
}

async function cliStartup(
  value,
  name,
  polluted = false,
  development = false,
  concurrent,
) {
  const profile = join(dirname(value.profile), name);
  await mkdir(profile, { recursive: true });
  await cp(join(value.profile, "state.json"), join(profile, "state.json"));
  const env = cleanEnvironment(profile);
  if (polluted) {
    env.ELECTRON_RUN_AS_NODE = "1";
    env.ELECTRON_RENDERER_URL = "http://127.0.0.1:1";
    env.ELECTRON_EXEC_PATH = "E:\\nonexistent-electron.exe";
    env.ELECTRON_ENTRY = "nonexistent-entry.mjs";
    env.ELECTRON_CLI_ARGS = "invalid inherited JSON";
  }
  const npm =
    process.env.npm_execpath ||
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  await access(npm);
  assert.equal(
    JSON.parse(await readFile(join(value.app, "package.json"), "utf8")).main,
    "out/main/index.js",
    "CLI smoke must use the real package main, without an entry shim",
  );
  const ports = await debugPorts();
  const args = development
    ? [
        npm,
        "run",
        "dev",
        "--",
        "--remoteDebuggingPort",
        String(ports.browser),
        "--",
        `--inspect-brk=${ports.inspector}`,
        "--disable-renderer-backgrounding",
      ]
    : [
        npm,
        "start",
        "--",
        `--remote-debugging-port=${ports.browser}`,
        `--inspect-brk=${ports.inspector}`,
        "--disable-renderer-backgrounding",
      ];
  const running = launch(process.execPath, args, { cwd: value.app, env });
  const result = { phase: name, passed: false };
  results.push(result);
  let browser;
  try {
    const inspector = await until(
      () => {
        if (running.child.exitCode !== null)
          throw new Error(
            `npm exited before starting Electron: ${running.child.exitCode}`,
          );
        return running.output.stderr.match(
          /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/,
        )?.[1];
      },
      "The actual npm command must launch Electron's local inspector",
      120000,
    );
    await resumeHidden(inspector, value.app);
    const endpoint = await until(
      () => {
        if (running.child.exitCode !== null)
          throw new Error(
            `npm start exited before opening the desktop: ${running.child.exitCode}`,
          );
        return running.output.stderr.match(
          /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/,
        )?.[1];
      },
      "npm start must open a local Chromium debugging endpoint",
      120000,
    );
    assert.ok(Number(new URL(endpoint).port) > 0);
    browser = await chromium.connectOverCDP(endpoint);
    const pages = () =>
      browser.contexts().flatMap((context) => context.pages());
    const dashboard = await until(
      () => pages().find((page) => page.url().includes("view=dashboard")),
      "The actual npm start entry must load the dashboard",
    );
    const pet = await until(
      () => pages().find((page) => page.url().includes("view=pet")),
      "The actual npm start entry must load the pet",
    );
    for (const page of [dashboard, pet]) {
      assert.equal(
        new URL(page.url()).protocol,
        development ? "http:" : "file:",
      );
      await page.waitForFunction(() => Boolean(window.mai));
    }
    if (development) {
      assert.equal(new URL(dashboard.url()).origin, new URL(pet.url()).origin);
      assert.equal(new URL(dashboard.url()).hostname, "127.0.0.1");
      assert.notEqual(new URL(dashboard.url()).port, "5173");
      result.rendererPort = Number(new URL(dashboard.url()).port);
      assert.notEqual(result.rendererPort, 5174);
      result.httpListens = (await readFile(value.listenTrace, "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
      assert.ok(
        result.httpListens.some(
          (call) => call.actual === result.rendererPort && call.requested === 0,
        ),
        "The renderer must actually bind Node HTTP port 0, not choose a fixed fallback port",
      );
      result.csp = await dashboard
        .locator('meta[http-equiv="Content-Security-Policy"]')
        .getAttribute("content");
      assert.ok(
        result.csp.includes(`ws://127.0.0.1:${result.rendererPort}`),
        "Development CSP must authorize the actual renderer HMR WebSocket",
      );
      assert.doesNotMatch(result.csp, /ws:\/\/127\.0\.0\.1:517[34](?:\s|;|$)/);
    }
    await dashboard.getByRole("navigation", { name: "主导航" }).waitFor();
    await pet.locator(".pet-character").waitFor();
    for (const [title, page] of [
      ["此刻", "home"],
      ["和麦麦聊聊", "chat"],
      ["角色衣橱", "models"],
      ["声音与感知", "senses"],
      ["连接与账号", "core"],
      ["偏好设置", "settings"],
    ]) {
      await dashboard
        .getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name: title, exact: true })
        .click();
      await dashboard.locator(`.page-${page}`).waitFor();
    }
    const snapshot = await dashboard.evaluate(() => window.mai.snapshot());
    assert.equal(snapshot.desktop, true);
    assert.equal(snapshot.version, value.version);
    assert.equal(snapshot.connection.phase, "disconnected");
    assert.equal(snapshot.settings.autoConnect, false);
    if (development) {
      const marker = `startup-hmr-${name}`;
      await dashboard.evaluate((value) => {
        window.__maiStartupHmrSentinel = value;
      }, marker);
      const stylesheet = join(value.app, "src/styles.css");
      await writeFile(
        stylesheet,
        (await readFile(stylesheet, "utf8")) +
          `\n:root { --mai-startup-hmr-probe: ${marker}; }\n`,
      );
      await dashboard.waitForFunction(
        (expected) =>
          getComputedStyle(document.documentElement)
            .getPropertyValue("--mai-startup-hmr-probe")
            .trim() === expected,
        marker,
        { timeout: 20000, polling: 100 },
      );
      assert.equal(
        await dashboard.evaluate(() => window.__maiStartupHmrSentinel),
        marker,
        "A CSS hot update must not reload the application",
      );
      result.hmr = {
        actualPort: result.rendererPort,
        cssUpdated: true,
        documentPreserved: true,
      };
    }
    assert.doesNotMatch(
      running.output.stderr,
      /\[startup-error\]|\[startup-load-failed\]|\[startup-blocked-network\]/,
    );
    result.urls = [dashboard.url(), pet.url()];
    result.version = snapshot.version;
    if (concurrent) {
      concurrent.ready.resolve(result);
      await concurrent.hold;
    }
    await dashboard.evaluate(() => window.mai.quit()).catch(() => {});
    const exited = await waitForExit(running, 12000);
    assert.ok(
      exited,
      "Quitting the desktop must also terminate its npm launcher",
    );
    assert.equal(exited.code, 0);
    for (const port of [
      ports.browser,
      ports.inspector,
      result.rendererPort,
    ].filter(Boolean))
      await until(
        async () => !(await portOpen(port)),
        `Test process must release port ${port}`,
      );
    result.exited = exited;
    result.passed = true;
    console.log(
      `PASS ${name}: real npm entry, both windows, preload/IPC and clean exit`,
    );
  } catch (error) {
    concurrent?.ready.reject(error);
    throw error;
  } finally {
    result.stdout = running.output.stdout;
    result.stderr = running.output.stderr;
    await browser?.close().catch(() => {});
    await stop(running.child);
  }
}

try {
  if (!phase || phase === "missing-renderer") await missingRenderer();
  if (!skipCli && phase !== "missing-renderer") {
    const app = await fixture("cli", true);
    if (!phase || phase === "cli") await cliStartup(app, "cli");
    if (!phase || phase === "cli-polluted")
      await cliStartup(app, "cli-polluted", true);
    if (!phase || phase === "cli-rebuild") {
      await removeFixture(join(app.app, "out/renderer"));
      await assert.rejects(access(join(app.app, "out/renderer/index.html")));
      await cliStartup(app, "cli-rebuild");
      await access(join(app.app, "out/renderer/index.html"));
    }
    if (!phase || phase === "cli-dev") {
      const occupied = [];
      const release = deferred();
      const firstReady = deferred();
      const secondReady = deferred();
      const checks = [];
      try {
        // Keep existing user services intact. Own only free fixture ports.
        for (const port of [5173, 5174]) {
          try {
            occupied.push(await listening(port));
          } catch (error) {
            if (error.code !== "EADDRINUSE") throw error;
          }
        }
        const first = await devFixture("cli-dev-first");
        const second = await devFixture("cli-dev-second");
        checks.push(
          cliStartup(first, "cli-dev-first", true, true, {
            ready: firstReady,
            hold: release.promise,
          }),
        );
        // Attach a rejection handler immediately; final reporting remains below.
        checks[0].catch((error) => firstReady.reject(error));
        const firstResult = await firstReady.promise;
        checks.push(
          cliStartup(second, "cli-dev-second", true, true, {
            ready: secondReady,
            hold: release.promise,
          }),
        );
        checks[1].catch((error) => secondReady.reject(error));
        const secondResult = await secondReady.promise;
        assert.notEqual(
          firstResult.rendererPort,
          secondResult.rendererPort,
          "Two simultaneously running dev clients must own different OS-assigned renderer ports",
        );
        assert.equal(await portOpen(firstResult.rendererPort), true);
        assert.equal(await portOpen(secondResult.rendererPort), true);
        firstResult.simultaneousPeerPort = secondResult.rendererPort;
        secondResult.simultaneousPeerPort = firstResult.rendererPort;
        release.resolve();
        await Promise.all(checks);
      } finally {
        release.resolve();
        await Promise.allSettled(checks);
        for (const server of occupied)
          if (server.listening) await new Promise((done) => server.close(done));
      }
    }
  }
} finally {
  for (const child of children) await stop(child);
  await writeFile(join(base, "result.json"), JSON.stringify(results, null, 2));
  await writeFile(
    join(base, `result-${phase || (skipCli ? "minimal" : "all")}.json`),
    JSON.stringify(results, null, 2),
  );
  const target = resolve(run);
  assert.ok(target.startsWith(`${resolve(base)}${sep}`));
  await rm(target, {
    recursive: true,
    force: true,
    maxRetries: 6,
    retryDelay: 150,
  });
}
