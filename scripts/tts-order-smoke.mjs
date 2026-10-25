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
const nativeAudio = process.argv.includes("--native-audio");
assert.ok(["build", "dev", "packaged"].includes(mode));
const phase = option("phase") || (mode === "build" ? "after" : mode);
assert.match(phase, /^[a-z0-9-]+$/);
const base = resolve(".cache/tts-order-smoke");
await mkdir(base, { recursive: true });
const profile = await mkdtemp(join(base, "run-"));
const entry = join(profile, "bootstrap.mjs");
const report = {
  passed: false,
  phase,
  mode,
  nativeAudio,
  checks: [],
  requests: [],
  completion: [],
  errors: [],
  identities: [],
};
const transientStatus = Number(option("status") || 429);
assert.ok([429, 503].includes(transientStatus));
report.transientStatus = transientStatus;
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
  const count = nativeAudio ? 1600 : 1;
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
    const item = {
      index: requests.length + 1,
      text: body.messages?.findLast((message) => message.role === "assistant")
        ?.content,
      voice: "mimo-clone",
      done: false,
    };
    requests.push(item);
    item.send = () => {
      if (item.done || response.destroyed) return;
      item.done = true;
      if (item.text === "2" && item.index === 2) {
        item.status = transientStatus;
        report.completion.push({ text: item.text, status: item.status });
        response.statusCode = transientStatus;
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            error: {
              code:
                transientStatus === 429
                  ? "rate_limit_exceeded"
                  : "service_unavailable",
              message: "fixture transient synthesis failure",
            },
          }),
        );
        return;
      }
      item.status = 200;
      report.completion.push({ text: item.text, status: item.status });
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
    const gate = gates.get(item.text);
    if (gate && (!gate.voice || gate.voice === item.voice))
      gate.pending.push(item);
    else item.send();
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
    await windows.pet.evaluate((native) => {
      window.__ttsBuffer = {
        played: [],
        paused: [],
        instances: [],
        spoken: [],
      };
      if (native) {
        const NativeAudio = window.Audio;
        window.Audio = function (url) {
          const audio = new NativeAudio(url);
          audio.muted = true;
          // Hold the first real clip until the burst has entered the queue.
          audio.loop = window.__ttsBuffer.instances.length === 0;
          window.__ttsBuffer.instances.push(audio);
          const play = audio.play.bind(audio);
          const pause = audio.pause.bind(audio);
          audio.play = async () => {
            await play();
            window.__ttsBuffer.played.push(url);
          };
          audio.pause = () => {
            window.__ttsBuffer.paused.push(url);
            pause();
          };
          return audio;
        };
      } else {
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
      }
      speechSynthesis.cancel = () => {};
      speechSynthesis.speak = (utterance) => {
        window.__ttsBuffer.spoken.push(utterance.text);
        utterance.onstart?.({});
        queueMicrotask(() => utterance.onend?.({}));
      };
    }, nativeAudio);
    return windows;
  };
  let { page, pet } = await launch();
  const state = () => page.evaluate(() => window.mai.snapshot());
  report.version = (await state()).version;
  const played = () => pet.evaluate(() => window.__ttsBuffer.played);
  const finish = async () => {
    if (!nativeAudio)
      return pet.evaluate(() =>
        window.__ttsBuffer.instances.at(-1)?.onended?.(),
      );
    const index = await pet.evaluate(
      () => window.__ttsBuffer.instances.length - 1,
    );
    await pet.evaluate((value) => {
      window.__ttsBuffer.instances[value].loop = false;
    }, index);
    await until(
      () =>
        pet.evaluate(
          (value) => window.__ttsBuffer.instances[value]?.ended,
          index,
        ),
      "The native audio must finish naturally",
    );
  };
  const playLabels = async () =>
    (await played()).map((url) => {
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
  const requestCount = (value, voice) =>
    requests.filter(
      (item) => item.text === value && (!voice || item.voice === voice),
    ).length;
  const hold = (value, voice) => gates.set(value, { voice, pending: [] });
  const release = (value) => {
    const gate = gates.get(value);
    gates.delete(value);
    for (const item of gate?.pending || []) item.send();
  };

  hold("2");
  await reply("number-1", text("1"));
  await until(async () => (await played()).length === 1, "1 did not play");
  await reply("number-2", text("2"));
  await reply("number-3", text("3"));
  await until(() => requestCount("2") === 1, "2 was not submitted");
  await finish();
  await until(
    () => requestCount("3") === 1,
    "3 was not submitted while 2 was pending",
  );
  await until(
    () => requests.find((x) => x.text === "3")?.done,
    "3 did not finish before 2",
  );
  assert.deepEqual(
    await playLabels(),
    ["1@mimo-clone"],
    "3 must not overtake unresolved 2",
  );
  release("2");
  await until(
    async () => (await played()).length >= 2,
    "no playback after transient 2 response",
  );
  await pause(100);
  report.played = await playLabels();
  report.providerReplies = requests.map(({ text, index, status }) => ({
    text,
    index,
    status,
  }));
  assert.deepEqual(
    report.completion.slice(0, 3).map((item) => item.text),
    ["1", "3", "2"],
    "The fixture must exercise out-of-order synthesis completion",
  );
  assert.deepEqual(
    report.played.slice(0, 2),
    ["1@mimo-clone", "2@mimo-clone"],
    `a transient ${transientStatus} must not silently skip reply 2 and play 3`,
  );
  await finish();
  await until(
    async () => (await played()).length === 3,
    "3 never follows recovered 2",
  );
  await finish();
  report.played = await playLabels();
  assert.deepEqual(report.played, [
    "1@mimo-clone",
    "2@mimo-clone",
    "3@mimo-clone",
  ]);
  assert.equal(
    requestCount("2"),
    2,
    "reply 2 must recover with one foreground retry",
  );
  assert.equal(requestCount("1"), 1);
  assert.equal(requestCount("3"), 1);
  report.checks.push(
    "MiMo synthesis finishes 1,3,2 with a transient failure of 2; foreground recovery preserves complete playback 1,2,3",
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
  report.requests = requests.map(({ text, voice, done }) => ({
    text,
    voice,
    done,
  }));
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
