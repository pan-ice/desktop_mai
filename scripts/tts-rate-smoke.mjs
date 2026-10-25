import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { _electron as electron, chromium } from "playwright";
import { createServer as createViteServer } from "vite";
import WebSocket from "ws";
import { inspectPackaged } from "./packaging-inspector.mjs";

const option = (name) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const mode = option("mode") || "build";
assert.ok(["build", "dev", "packaged"].includes(mode));
const phase = option("phase") || (mode === "build" ? "after" : mode);
assert.match(phase, /^[a-z0-9-]+$/);
const base = resolve(".cache/tts-rate-smoke");
await mkdir(base, { recursive: true });
const profile = await mkdtemp(join(base, "run-"));
const entry = join(profile, "bootstrap.mjs");
const report = {
  passed: false,
  phase,
  mode,
  controlledAudio: true,
  checks: [],
  requests: [],
  completion: [],
  errors: [],
  identities: [],
};
const minGapMs = 100;
const serviceDelayMs = 250;
let active = 0;
const forcedAttempts = new Map();
const originals = new Map();
const expectedErrorToasts = [];
let lastAcceptedAt = 0;
report.rateLimits = 0;
report.maxConcurrentAttempts = 0;
report.accepted = [];
const requests = [];
const gates = new Map();
let desktop, socket, ttsService, viteServer;

const pause = (ms = 80) => new Promise((done) => setTimeout(done, ms));
async function until(check, message, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await pause(20);
  }
  throw new Error(message);
}
function wav(sample) {
  const count = 1;
  const bytes = Buffer.alloc(44 + count * 2);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(count * 2, 40);
  for (let index = 0; index < count; index++)
    bytes.writeInt16LE(sample, 44 + index * 2);
  return bytes;
}
try {
  const metadata = JSON.parse(await readFile(resolve("package.json"), "utf8"));
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
      settings: { adapterPort: 0, autoConnect: false, launchAtLogin: false },
      history: [],
      models: [],
      encrypted: {},
    }),
  );
  await writeFile(
    entry,
    `import { app, BrowserWindow, globalShortcut } from "electron";
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.showInactive = function () {};
globalShortcut.register = () => true;
globalShortcut.unregisterAll = () => {};
app.setLoginItemSettings = () => {};
await import(${JSON.stringify(pathToFileURL(resolve("out/main/index.js")).href)});
`,
  );
  ttsService = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const input = body.messages?.findLast(
      (message) => message.role === "assistant",
    )?.content;
    const item = {
      index: requests.length + 1,
      text: input,
      voice: "mimo-clone",
      started: Date.now(),
      done: false,
    };
    const voice = body.audio?.voice;
    item.referenceSample =
      typeof voice === "string" && voice.startsWith("data:")
        ? Buffer.from(voice.split(",")[1], "base64").readInt16LE(44)
        : null;
    requests.push(item);
    report.maxConcurrentAttempts = Math.max(
      report.maxConcurrentAttempts,
      active + 1,
    );
    const forced = forcedAttempts.get(input) || 0;
    forcedAttempts.set(input, forced + 1);
    const limited =
      active > 0 ||
      item.started - lastAcceptedAt < minGapMs ||
      input === "rate-always" ||
      (input === "rate-once" && forced === 0);
    if (limited) {
      report.rateLimits++;
      item.status = 429;
      item.done = true;
      report.completion.push({ text: item.text, status: 429 });
      response.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": "1",
      });
      response.end(
        JSON.stringify({
          error: {
            code: "rate_limit_exceeded",
            message: "fixture concurrency limit",
          },
        }),
      );
      return;
    }
    active++;
    lastAcceptedAt = item.started;
    report.accepted.push({ text: item.text, started: item.started });
    let running = true;
    const complete = () => {
      if (!running) return;
      running = false;
      active--;
      item.done = true;
      if (response.destroyed) {
        item.aborted = true;
        return;
      }
      item.status = 200;
      report.completion.push({ text: item.text, status: 200 });
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { audio: { data: wav(item.index).toString("base64") } },
            },
          ],
        }),
      );
    };
    response.once("close", () => {
      if (running) {
        running = false;
        active--;
        item.aborted = true;
        item.done = true;
      }
    });
    item.send = complete;
    const gate = gates.get(item.text);
    if (gate) gate.pending.push(item);
    else setTimeout(complete, serviceDelayMs);
  });
  ttsService.listen(0, "127.0.0.1");
  await once(ttsService, "listening");
  const env = { ...process.env, MAI_USER_DATA: profile };
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "ELECTRON_RENDERER_URL",
    "ELECTRON_ENTRY",
    "ELECTRON_CLI_ARGS",
    "ELECTRON_EXEC_PATH",
  ])
    delete env[key];
  if (mode === "dev") {
    viteServer = await createViteServer({
      configFile: resolve("vite.config.ts"),
      logLevel: "silent",
      clearScreen: false,
    });
    await viteServer.listen();
    const address = viteServer.httpServer.address();
    assert.ok(address && typeof address === "object" && address.port > 0);
    env.ELECTRON_RENDERER_URL = `http://127.0.0.1:${address.port}`;
    report.rendererUrl = env.ELECTRON_RENDERER_URL;
  }
  const launch = async () => {
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
      child.on("error", (error) => report.errors.push(error.message));
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (chunk) => {
          output = (output + chunk).slice(-12000);
        });
      let inspector, browser;
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
            await Promise.race([once(child, "exit"), pause(5000)]);
          if (child.exitCode === null) {
            child.kill();
            await once(child, "exit");
            throw new Error("测试EXE未正常退出，已仅清理本次子进程");
          }
          assert.equal(child.exitCode, 0, "正式EXE应正常退出");
        },
      };
      const endpoint = await until(
        () => {
          if (report.errors.length) throw new Error(report.errors.join("\n"));
          if (child.exitCode !== null)
            throw new Error(`正式EXE在启动前退出：${child.exitCode}`);
          return output.match(
            /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/,
          )?.[1];
        },
        "正式EXE未启动主进程调试端点",
        15000,
      );
      report.stage = "packaged-inspector";
      inspector = await inspectPackaged(
        endpoint,
        String.raw`
const fixtureRequire = process.getBuiltinModule("module").createRequire(process.resourcesPath + "/app.asar/package.json");
globalThis.__packagedElectron.dialog = fixtureRequire("electron").dialog;
`,
      );
      assert.equal(
        resolve(inspector.identity.executable).toLowerCase(),
        executable.toLowerCase(),
      );
      report.identities.push(inspector.identity);
      report.stage = "packaged-browser";
      const browserEndpoint = await until(
        () =>
          output.match(
            /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/,
          )?.[1],
        "正式EXE未启动Chromium端点",
        15000,
      );
      browser = await chromium.connectOverCDP(browserEndpoint);
    }
    const windows = await until(() => {
      const page = desktop
        .windows()
        .find((value) => value.url().includes("view=dashboard"));
      const pet = desktop
        .windows()
        .find((value) => value.url().includes("view=pet"));
      return page && pet && { page, pet };
    }, "真实桌宠双窗口未启动");
    for (const window of Object.values(windows))
      window.on("pageerror", (error) => report.errors.push(error.message));
    if (mode === "packaged")
      for (const window of Object.values(windows)) {
        assert.equal(new URL(window.url()).protocol, "file:");
        assert.match(window.url(), /app\.asar\/out\/renderer\/index\.html/);
      }
    if (mode === "dev")
      for (const window of Object.values(windows)) {
        assert.equal(new URL(window.url()).origin, env.ELECTRON_RENDERER_URL);
        assert.equal(new URL(window.url()).protocol, "http:");
      }
    await windows.pet.locator(".pet-character").waitFor();
    if (mode === "packaged") {
      assert.equal(
        await windows.pet.evaluate(
          async () => (await window.mai.snapshot()).version,
        ),
        metadata.version,
      );
      delete report.stage;
    }
    // Hold playback independently of network timing; native decoding has its
    // own order smoke, while this loop measures provider request admission.
    await windows.pet.evaluate(() => {
      window.__ttsBuffer = {
        played: [],
        paused: [],
        instances: [],
        spoken: [],
      };
      window.Audio = class {
        constructor(url) {
          this.url = url;
          window.__ttsBuffer.instances.push(this);
        }
        async play() {
          window.__ttsBuffer.played.push(this.url);
        }
        pause() {
          window.__ttsBuffer.paused.push(this.url);
        }
      };
      speechSynthesis.cancel = () => {};
      speechSynthesis.speak = (utterance) => {
        window.__ttsBuffer.spoken.push(utterance.text);
        utterance.onstart?.({});
        queueMicrotask(() => utterance.onend?.({}));
      };
    });
    return windows;
  };
  let { page, pet } = await launch();
  await pet.evaluate(() => {
    window.__ttsRateToasts = [];
    window.addEventListener("mai:toast", (event) =>
      window.__ttsRateToasts.push(event.detail),
    );
  });
  const state = () => page.evaluate(() => window.mai.snapshot());
  report.version = (await state()).version;
  const played = () => pet.evaluate(() => window.__ttsBuffer.played);
  const finish = () =>
    pet.evaluate(() => window.__ttsBuffer.instances.at(-1)?.onended?.());
  const playLabels = async () =>
    (await played()).map((url) => {
      if (originals.has(url)) return originals.get(url);
      const sample = Buffer.from(url.split(",")[1], "base64").readInt16LE(44);
      const item = requests.find((value) => value.index === sample);
      assert.ok(item, "已播放的TTS必须对应一个真实HTTP合成结果");
      return `${item.text}@${item.voice}`;
    });
  const configure = (patch) =>
    page.evaluate((value) => window.mai.updateSettings(value), patch);
  const configPath = join(profile, "config.toml");
  await desktop.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, configPath);
  await page.evaluate(async () => {
    await window.mai.exportAdapterConfig();
    await window.mai.connect();
  });
  const configuration = await readFile(configPath, "utf8");
  const token = JSON.parse(configuration.match(/^token = (.+)$/m)[1]);
  socket = new WebSocket(
    `ws://127.0.0.1:${(await state()).settings.adapterPort}/maibot`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  const acknowledgements = new Map();
  socket.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === "reply_ack") acknowledgements.set(frame.id, frame.ok);
    if (frame.type === "request")
      socket.send(
        JSON.stringify({ v: 1, type: "result", id: frame.id, ok: true }),
      );
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
        platform: "desktop_pet",
        accountId: "mai_desktop_pet",
        userId: "desktop_owner",
        scope: "",
      },
    }),
  );
  await welcome;
  socket.send(
    JSON.stringify({
      v: 1,
      type: "ready",
      sessionId: "buffer-test",
      capabilities: ["chat", "image", "audio", "proactive"],
    }),
  );
  await until(
    async () => (await state()).connection.phase === "connected",
    "本机MaiBot协议夹具未就绪",
  );
  await page.evaluate(() =>
    window.mai.setCredential("ttsMimoKey", "local-order-fixture"),
  );
  const ttsProfiles = {
    mimo: {
      baseUrl: `http://127.0.0.1:${ttsService.address().port}/v1`,
      model: "mimo-v2.5-tts",
      voice: "mimo_default",
      resourceId: "",
    },
  };
  await configure({
    voiceEnabled: true,
    ttsEngine: "api",
    ttsProvider: "mimo",
    ttsProfiles,
    ttsPreloadNext: false,
  });
  const reference = Array.from(wav(100));
  const cloned = await page.evaluate(
    (audio) =>
      window.mai.cloneVoice({
        name: "order-fixture",
        audio: { name: "reference.wav", data: new Uint8Array(audio).buffer },
      }),
    reference,
  );
  await configure({ ttsProfiles: { mimo: cloned.profile } });
  report.cloneModel = cloned.profile.model;
  await pet.getByRole("button", { name: "关闭朗读", exact: true }).waitFor();
  assert.equal((await state()).settings.ttsReplyBufferSize, 2);
  await configure({ ttsReplyBufferSize: 2 });
  let serial = 0;
  const reply = async (label, segments) => {
    const id = `${label}-${++serial}`;
    socket.send(
      JSON.stringify({
        v: 1,
        type: "reply",
        id,
        sessionId: "buffer-test",
        segments,
      }),
    );
    await until(() => acknowledgements.has(id), `消息${label}没有持久化回执`);
    assert.equal(acknowledgements.get(id), true);
    return (await state()).history.find((message) => message.id === id);
  };
  const text = (value) => [{ type: "text", text: value }];
  const hold = (value, voice) => gates.set(value, { voice, pending: [] });
  const release = (value) => {
    const gate = gates.get(value);
    gates.delete(value);
    for (const item of gate?.pending || []) item.send();
  };

  await reply("number-1", text("1"));
  await reply("number-2", text("2"));
  await reply("number-3", text("3"));
  await until(
    () =>
      ["1", "2", "3"].every((value) =>
        requests.some((item) => item.text === value && item.done),
      ),
    "The burst must reach the constrained service",
  );
  report.played = await playLabels();
  assert.equal(
    report.rateLimits,
    0,
    "Current synthesis and prebuffer requests must share a limit instead of provoking repeated HTTP 429",
  );
  assert.equal(
    report.maxConcurrentAttempts,
    1,
    "Only one request may be active for this MiMo account",
  );
  await until(
    async () => (await played()).length === 1,
    "The first result must start playing",
  );
  assert.deepEqual(await playLabels(), ["1@mimo-clone"]);
  await finish();
  await until(
    async () => (await played()).length === 2,
    "The second result must play",
  );
  await finish();
  await until(
    async () => (await played()).length === 3,
    "The third result must play",
  );
  await finish();
  report.played = await playLabels();
  assert.deepEqual(report.played, [
    "1@mimo-clone",
    "2@mimo-clone",
    "3@mimo-clone",
  ]);
  assert.deepEqual(report.errors, []);
  report.checks.push(
    "A constrained MiMo service receives one paced request at a time while burst replies remain FIFO",
  );

  await configure({ voiceEnabled: false });
  const crossOffset = requests.length;
  const crossResults = await Promise.all([
    page.evaluate(() => window.mai.synthesize("dashboard-manual")),
    pet.evaluate(() => window.mai.synthesize("pet-manual")),
  ]);
  assert.ok(crossResults.every((value) => value.startsWith("data:audio/")));
  assert.equal(
    requests.slice(crossOffset).filter((value) => value.status === 429).length,
    0,
    "Both renderer windows must share the same account limit",
  );
  assert.equal(report.maxConcurrentAttempts, 1);
  report.checks.push(
    "dashboard and pet IPC requests share one provider account lane",
  );

  const rateOffset = requests.length;
  const recovered = await page.evaluate(() =>
    window.mai.synthesize("rate-once"),
  );
  assert.ok(recovered.startsWith("data:audio/"));
  const retried = requests
    .slice(rateOffset)
    .filter((value) => value.text === "rate-once");
  assert.equal(retried.length, 2, "A single explicit 429 should recover once");
  assert.deepEqual(
    retried.map((value) => value.status),
    [429, 200],
  );
  assert.ok(
    retried[1].started - retried[0].started >= 950,
    "Retry-After:1 must delay the actual HTTP retry for at least one second",
  );
  report.checks.push(
    "HTTP 429 Retry-After is respected before automatic recovery",
  );

  const exhaustedOffset = requests.length;
  const exhausted = await page.evaluate(() =>
    window.mai.synthesize("rate-always").then(
      () => ({ ok: true }),
      (error) => ({ ok: false, message: error.message }),
    ),
  );
  assert.equal(exhausted.ok, false);
  const attempts = requests
    .slice(exhaustedOffset)
    .filter((value) => value.text === "rate-always");
  assert.equal(
    attempts.length,
    3,
    "Persistent 429 must have exactly three total attempts",
  );
  assert.match(exhausted.message, /429/);
  assert.match(exhausted.message, /频繁|限流|频率|额度/);
  assert.doesNotMatch(exhausted.message, /请检查 Key、模型、额度和服务权限/);
  report.checks.push(
    "persistent 429 fails after a bounded retry budget with a rate-specific message",
  );

  await configure({
    voiceEnabled: true,
    ttsEngine: "api",
    ttsReplyBufferSize: 2,
  });
  const cachedRaw = await reply("cached-final-hold", [
    {
      type: "audio",
      dataUrl: "data:audio/wav;base64," + wav(310).toString("base64"),
    },
  ]);
  const cachedRawUrl = cachedRaw.attachments[0].dataUrl;
  originals.set(cachedRawUrl, "cached-final-hold");
  await until(
    async () => (await played()).includes(cachedRawUrl),
    "Original audio must play even while the API is cooling down",
  );
  const cachedFinalOffset = requests.length;
  const priorErrors = await pet.evaluate(
    () => window.__ttsRateToasts.filter((value) => value.error).length,
  );
  assert.equal(priorErrors, 0);
  await reply("cached-final", text("rate-always"));
  await until(
    () =>
      requests
        .slice(cachedFinalOffset)
        .filter((value) => value.text === "rate-always" && value.done)
        .length === 3,
    "The cached failed item must exhaust one backend budget",
    15000,
  );
  await pause(100);
  assert.equal(
    await pet.evaluate(
      () => window.__ttsRateToasts.filter((value) => value.error).length,
    ),
    0,
    "A background final failure must not toast until its playback position",
  );
  await finish();
  await until(
    async () =>
      (
        await pet.evaluate(() =>
          window.__ttsRateToasts.filter((value) => value.error),
        )
      ).length > 0,
    "The final foreground failure must be visible",
    15000,
  );
  const finalToasts = await pet.evaluate(() =>
    window.__ttsRateToasts.filter((value) => value.error),
  );
  assert.equal(
    finalToasts.length,
    1,
    "One cached final failure must produce one visible error",
  );
  assert.match(finalToasts[0].text, /429/);
  await page.evaluate(() => window.mai.synthesize("cached-final-fresh"));
  assert.equal(
    requests
      .slice(cachedFinalOffset)
      .filter((value) => value.text === "rate-always").length,
    3,
    "Final-error metadata must cross the real contextBridge; promotion must not start a second three-request budget",
  );
  expectedErrorToasts.push(finalToasts[0]);
  await pet.getByRole("button", { name: "关闭提示", exact: true }).click();
  await configure({ voiceEnabled: false });
  report.checks.push(
    "a cached final 429 crosses the contextBridge without multiplying the retry budget or duplicating the error toast",
  );

  await configure({ voiceEnabled: true, ttsReplyBufferSize: 2 });
  hold("cancel-head");
  await reply("cancel-head", text("cancel-head"));
  await until(
    () => requests.some((value) => value.text === "cancel-head"),
    "Cancellation head did not reach the service",
  );
  await reply("cancel-tail", text("cancel-tail"));
  await configure({ voiceEnabled: false });
  await pet.getByRole("button", { name: "开启朗读", exact: true }).waitFor();
  release("cancel-head");
  await page.evaluate(() => window.mai.synthesize("cancel-fresh"));
  assert.equal(
    requests.filter((value) => value.text === "cancel-tail").length,
    0,
    "Stopping speech must remove queued prefetch before it reaches the provider",
  );
  report.checks.push(
    "stopping removes queued background requests rather than sending them after current work",
  );

  const secondVoice = await page.evaluate(
    (data) =>
      window.mai.cloneVoice({
        name: "second-rate-voice",
        audio: { name: "reference.wav", data: new Uint8Array(data).buffer },
      }),
    Array.from(wav(200)),
  );
  await configure({
    voiceEnabled: true,
    ttsProfiles: { mimo: cloned.profile },
  });
  hold("voice-head");
  await reply("voice-head", text("voice-head"));
  await until(
    () => requests.some((value) => value.text === "voice-head"),
    "Voice-change head did not reach service",
  );
  await reply("voice-tail", text("voice-tail"));
  await configure({ ttsProfiles: { mimo: secondVoice.profile } });
  release("voice-head");
  await until(
    () =>
      requests.some(
        (value) => value.text === "voice-tail" && value.status === 200,
      ),
    "The updated voice was never prepared",
    12000,
  );
  assert.ok(
    requests
      .filter((value) => value.text === "voice-tail")
      .every((value) => value.referenceSample === 200),
    "A queued request must not use the old voice after settings change",
  );
  await configure({ voiceEnabled: false });
  await pet.getByRole("button", { name: "开启朗读", exact: true }).waitFor();
  report.checks.push(
    "voice changes cancel stale queued work before preparing the new voice",
  );

  const longText = "长".repeat(1100);
  const longOffset = requests.length;
  const longPlayedOffset = (await played()).length;
  await configure({
    voiceEnabled: true,
    ttsPreloadNext: true,
    ttsProfiles: { mimo: cloned.profile },
  });
  await reply("long-message", text(longText));
  await until(
    async () => (await played()).length === longPlayedOffset + 1,
    "Long-message first segment did not play",
    12000,
  );
  await reply("after-long", text("after-long"));
  await until(
    () =>
      requests.slice(longOffset).filter((value) => value.status === 200)
        .length === 3,
    "Long-segment and cross-message prefetch must both complete",
    12000,
  );
  assert.equal(
    requests.slice(longOffset).filter((value) => value.status === 429).length,
    0,
    "Intra-message and cross-message prefetch must share the same rate limit",
  );
  await finish();
  await until(
    async () => (await played()).length === longPlayedOffset + 2,
    "Long-message second segment did not play",
  );
  await finish();
  await until(
    async () => (await played()).length === longPlayedOffset + 3,
    "Following short message did not play",
  );
  await finish();
  const longPlayed = (await playLabels())
    .slice(longPlayedOffset)
    .map((value) => value.replace(/@mimo-clone$/, ""));
  assert.equal(longPlayed.slice(0, 2).join(""), longText);
  assert.equal(longPlayed[2], "after-long");
  report.checks.push(
    "long-message and later-message prefetch share the limit without reordering or duplicate text",
  );

  await configure({ ttsEngine: "system" });
  const noApiOffset = requests.length;
  const systemOffset = await pet.evaluate(
    () => window.__ttsBuffer.spoken.length,
  );
  await reply("system-one", text("系统1"));
  const raw = await reply("original-audio", [
    {
      type: "audio",
      dataUrl: "data:audio/wav;base64," + wav(300).toString("base64"),
    },
  ]);
  originals.set(raw.attachments[0].dataUrl, "original-audio");
  await until(
    async () => (await played()).some((url) => originals.has(url)),
    "Original audio must play without synthesis",
  );
  await reply("system-two", text("系统2"));
  assert.deepEqual(
    (await pet.evaluate(() => window.__ttsBuffer.spoken)).slice(systemOffset),
    ["系统1"],
  );
  await finish();
  await until(
    async () =>
      (await pet.evaluate(() => window.__ttsBuffer.spoken)).length ===
      systemOffset + 2,
    "System speech did not follow the original clip",
  );
  assert.deepEqual(
    (await pet.evaluate(() => window.__ttsBuffer.spoken)).slice(systemOffset),
    ["系统1", "系统2"],
  );
  assert.equal(
    requests.length,
    noApiOffset,
    "System and original audio must not use the TTS network queue",
  );
  report.checks.push(
    "system speech and original audio retain FIFO without API requests",
  );
  assert.deepEqual(report.errors, []);
  report.errorToasts = await pet.evaluate(() =>
    window.__ttsRateToasts.filter((value) => value.error),
  );
  report.minimumObservedGapMs = Math.min(
    ...requests
      .slice(1)
      .map((request, index) => request.started - requests[index].started),
  );
  assert.ok(
    report.minimumObservedGapMs >= 650,
    "The actual MiMo HTTP starts must retain the 700ms client spacing (with timestamp tolerance)",
  );
  assert.deepEqual(
    report.errorToasts,
    expectedErrorToasts,
    "Only the deliberately exhausted cached request may show an error; successful recovery and cancellation must stay quiet",
  );
  report.passed = true;
} catch (error) {
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  for (const gate of gates.values())
    for (const item of gate.pending) item.send();
  gates.clear();
  socket?.terminate();
  await desktop?.close().catch((error) => {
    report.passed = false;
    report.failure = report.failure || error.message;
    process.exitCode = 1;
  });
  await viteServer?.close();
  if (ttsService)
    await new Promise((done) => {
      ttsService.close(done);
      ttsService.closeAllConnections();
    });
  report.requests = requests.map(
    ({ text, voice, done, started, status, referenceSample, aborted }) => ({
      text,
      voice,
      done,
      started,
      status,
      referenceSample,
      aborted,
    }),
  );
  assert.ok(profile.startsWith(base + sep));
  await rm(profile, { recursive: true, force: true });
  await writeFile(
    join(base, `${phase}.json`),
    JSON.stringify(report, null, 2) + "\n",
  );
  const { requests: recordedRequests, ...summary } = report;
  console.log(
    JSON.stringify(
      { ...summary, requestCount: recordedRequests.length },
      null,
      2,
    ),
  );
}
