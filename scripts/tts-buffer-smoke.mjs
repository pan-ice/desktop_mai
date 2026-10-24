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
const base = resolve(".cache/tts-buffer-smoke");
await mkdir(base, { recursive: true });
const profile = await mkdtemp(join(base, "run-"));
const entry = join(profile, "bootstrap.mjs");
const report = {
  passed: false,
  phase,
  mode,
  checks: [],
  requests: [],
  errors: [],
  identities: [],
};
const requests = [];
const gates = new Map();
const originals = new Map();
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
  const bytes = Buffer.alloc(46);
  bytes.write("RIFF");
  bytes.writeUInt32LE(38, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(2, 40);
  bytes.writeInt16LE(sample, 44);
  return bytes;
}
function original(sample) {
  return {
    type: "audio",
    dataUrl: `data:audio/wav;base64,${wav(sample).toString("base64")}`,
  };
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
      text: body.input,
      voice: body.voice,
      done: false,
    };
    requests.push(item);
    item.send = () => {
      if (item.done || response.destroyed) return;
      item.done = true;
      response.setHeader("Content-Type", "audio/wav");
      response.end(wav(item.index));
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
  const stop = async () => {
    await configure({ voiceEnabled: false });
    await pet.getByRole("button", { name: "开启朗读", exact: true }).waitFor();
    await configure({ voiceEnabled: true });
    await pet.getByRole("button", { name: "关闭朗读", exact: true }).waitFor();
  };
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
    window.mai.setCredential("ttsOpenaiKey", "local-buffer-fixture"),
  );
  const ttsProfiles = {
    openai: {
      baseUrl: `http://127.0.0.1:${ttsService.address().port}/v1`,
      model: "buffer-fixture",
      voice: "voice-one",
      resourceId: "",
    },
  };
  await configure({
    voiceEnabled: true,
    ttsEngine: "api",
    ttsProvider: "openai",
    ttsProfiles,
    ttsPreloadNext: false,
  });
  await pet.getByRole("button", { name: "关闭朗读", exact: true }).waitFor();
  if (phase !== "before") {
    assert.equal(
      (await state()).settings.ttsReplyBufferSize,
      2,
      "旧设置应默认启用2条跨消息缓冲",
    );
    await configure({ ttsReplyBufferSize: 2 });
  }
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
    const saved = (await state()).history.find((message) => message.id === id);
    for (const attachment of saved.attachments || [])
      if (attachment.type === "audio") originals.set(attachment.dataUrl, label);
    return saved;
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

  await reply("mixed-head", [original(-1)]);
  await until(
    async () => (await played()).length === 1,
    "首条原始语音没有播放",
  );
  const previousPlaybackId = await until(async () => {
    const playback = (await state()).playback;
    return playback.phase === "playing" && playback.id;
  }, "当前原始语音没有实际播放标识");
  await reply("mixed-text-a", text("缓冲文字甲"));
  await reply("mixed-voice-b", [original(-2)]);
  await reply("mixed-text-c", text("缓冲文字丙"));
  await until(
    () => requestCount("缓冲文字甲") === 1 && requestCount("缓冲文字丙") === 1,
    "原始语音播放期间没有提前合成后续两条文字消息，跨消息仍会逐条等待配音",
    2000,
  );
  assert.deepEqual(
    await playLabels(),
    ["mixed-head"],
    "后台合成完成不能抢占正在播放的原始语音",
  );
  for (const expected of [
    "缓冲文字甲@voice-one",
    "mixed-voice-b",
    "缓冲文字丙@voice-one",
  ]) {
    const offset = (await played()).length;
    await finish();
    await until(
      async () => (await played()).length === offset + 1,
      "缓冲后的消息没有顺序接续播放",
    );
    assert.equal((await playLabels()).at(-1), expected);
    if (expected === "缓冲文字甲@voice-one") {
      const currentUrl = (await played()).at(-1);
      const currentPlaybackId = await until(async () => {
        const playback = (await state()).playback;
        return (
          playback.phase === "playing" &&
          playback.id !== previousPlaybackId &&
          playback.id
        );
      }, "后条文字没有接管实际播放标识");
      await desktop.evaluate(({ BrowserWindow }, id) => {
        const window = BrowserWindow.getAllWindows().find((candidate) =>
          candidate.webContents.getURL().includes("view=pet"),
        );
        window.webContents.send("mai:stop-playback", id);
      }, previousPlaybackId);
      await pause(150);
      assert.equal(
        await pet.evaluate(
          (url) => window.__ttsBuffer.paused.includes(url),
          currentUrl,
        ),
        false,
        "过期的播放停止通知不能暂停正在播放的新消息",
      );
      assert.equal(
        (await state()).playback.id,
        currentPlaybackId,
        "过期停止通知不能清除当前播放会话",
      );
    }
  }
  await finish();
  assert.equal(requestCount("缓冲文字甲"), 1);
  assert.equal(requestCount("缓冲文字丙"), 1);
  report.checks.push(
    "mixed text/audio bursts are synthesized before the active audio ends and play FIFO without duplicate synthesis",
  );
  report.checks.push(
    "a stale stop-playback notification cannot stop a newer item or clear its remaining queue",
  );
  hold("预合成提升为当前消息");
  const promotedOffset = (await played()).length;
  await reply("promoted-head", [original(-4)]);
  await until(
    async () => (await played()).length === promotedOffset + 1,
    "后台提升场景的原始语音未开始",
  );
  await reply("promoted-pending", text("预合成提升为当前消息"));
  await until(
    () => requestCount("预合成提升为当前消息") === 1,
    "待提升的后台合成未提交",
  );
  await reply("promoted-following", text("当前等待时继续准备下一条"));
  await finish();
  await until(
    () => requestCount("当前等待时继续准备下一条") === 1,
    "待决的预合成提升为当前消息后仍占住后台槽，后续文字不能提前准备",
    2000,
  );
  assert.equal(
    (await played()).length,
    promotedOffset + 1,
    "当前消息未准备好时后条不能抢播",
  );
  release("预合成提升为当前消息");
  await until(
    async () => (await played()).length === promotedOffset + 2,
    "提升后的当前合成没有播放",
  );
  assert.equal((await playLabels()).at(-1), "预合成提升为当前消息@voice-one");
  await finish();
  await until(
    async () => (await played()).length === promotedOffset + 3,
    "提升后的后续缓冲未播放",
  );
  assert.equal(
    (await playLabels()).at(-1),
    "当前等待时继续准备下一条@voice-one",
  );
  await finish();
  report.checks.push(
    "promoting pending prefetch to foreground releases the background slot while keeping FIFO",
  );

  hold("等待前台合成");
  const orderOffset = (await played()).length;
  await reply("slow-head", text("等待前台合成"));
  await until(() => requestCount("等待前台合成") === 1, "前台合成未提交");
  await reply("ready-second", text("后条先合成完成"));
  await until(
    () =>
      requestCount("后条先合成完成") === 1 &&
      requests.find((value) => value.text === "后条先合成完成").done,
    "后条没有在前台等待期间预备",
  );
  assert.equal(
    (await played()).length,
    orderOffset,
    "后条先准备好不能越过尚未完成的前条",
  );
  release("等待前台合成");
  await until(
    async () => (await played()).length === orderOffset + 1,
    "前条合成结束后没有播放",
  );
  assert.equal((await playLabels()).at(-1), "等待前台合成@voice-one");
  await finish();
  await until(
    async () => (await played()).length === orderOffset + 2,
    "预备后条没有继续播放",
  );
  assert.equal((await playLabels()).at(-1), "后条先合成完成@voice-one");
  await finish();
  report.checks.push(
    "out-of-order synthesis completion preserves arrival order and reuses the prepared result",
  );

  const longText = "预备的长回复应该完整衔接而且不能重复开头。".repeat(90);
  const longOffset = (await played()).length;
  const longRequestOffset = requests.length;
  await reply("long-buffer-head", [original(-5)]);
  await until(
    async () => (await played()).length === longOffset + 1,
    "长回复缓冲场景当前语音未播放",
  );
  await reply("long-buffer-text", text(longText));
  await reply("long-buffer-following", text("长回复之后的短消息"));
  await until(
    () => requests.length >= longRequestOffset + 2,
    "长回复的首段与后续消息没有提前合成",
  );
  const firstLongSegment = requests[longRequestOffset].text;
  assert.ok(
    longText.startsWith(firstLongSegment) && firstLongSegment !== longText,
    "缓冲应采用同样的长回复分段规则",
  );
  await finish();
  await until(
    async () => (await played()).length === longOffset + 2,
    "缓冲的长回复首段未播放",
  );
  assert.equal((await playLabels()).at(-1), `${firstLongSegment}@voice-one`);
  await pause(100);
  assert.equal(
    requests.length,
    longRequestOffset + 2,
    "关闭同消息预合成时，不应因为跨消息缓冲而重复首段或提前提交剩余段",
  );
  let consumedLong = firstLongSegment;
  while (consumedLong.length < longText.length) {
    const offset = (await played()).length;
    const beforeRequests = requests.length;
    await finish();
    await until(
      async () => (await played()).length === offset + 1,
      "长回复后续段没有继续播放",
    );
    assert.equal(requests.length, beforeRequests + 1);
    const segment = requests.at(-1).text;
    assert.ok(longText.slice(consumedLong.length).startsWith(segment));
    consumedLong += segment;
  }
  assert.equal(consumedLong, longText);
  const afterLong = (await played()).length;
  await finish();
  await until(
    async () => (await played()).length === afterLong + 1,
    "长回复结束后没有继续播放已缓冲短消息",
  );
  assert.equal((await playLabels()).at(-1), "长回复之后的短消息@voice-one");
  assert.equal(
    requestCount(firstLongSegment),
    1,
    "长回复已预备的首段只能合成一次",
  );
  await finish();
  report.checks.push(
    "a buffered long reply reuses its first segment and preserves all remaining segments with intra-message preloading disabled",
  );

  for (const depth of [0, 1, 2]) {
    await configure({ ttsReplyBufferSize: depth });
    const offset = (await played()).length;
    await reply(`depth-${depth}-head`, [original(-10 - depth)]);
    await until(
      async () => (await played()).length === offset + 1,
      "深度测试当前语音未播放",
    );
    const labels = Array.from(
      { length: 3 },
      (_, index) => `深度${depth}文字${index}`,
    );
    for (const label of labels) await reply(`depth-${depth}-text`, text(label));
    if (depth)
      await until(
        () =>
          labels.slice(0, depth).every((label) => requestCount(label) === 1),
        "预缓冲条数不足配置值",
      );
    await pause(120);
    assert.deepEqual(
      labels.map((label) => requestCount(label)),
      labels.map((_, index) => Number(index < depth)),
      "后台合成不能超过配置条数，0应完全关闭跨消息预合成",
    );
    for (const label of labels) {
      const before = (await played()).length;
      await finish();
      await until(
        async () => (await played()).length === before + 1,
        "深度测试队列未继续",
      );
      assert.equal((await playLabels()).at(-1), `${label}@voice-one`);
    }
    await finish();
  }
  report.checks.push(
    "buffer sizes 0, 1 and 2 limit background work while preserving sequential playback",
  );

  await configure({ ttsReplyBufferSize: 2 });
  for (const interruption of ["switch", "focus", "manual"]) {
    const oldText = `取消预备-${interruption}`;
    const untouched = `取消后不得预备-${interruption}`;
    hold(oldText);
    const offset = (await played()).length;
    await reply(`interrupt-${interruption}-head`, [original(-20)]);
    await until(
      async () => (await played()).length === offset + 1,
      "打断场景原始语音未播放",
    );
    await reply(`interrupt-${interruption}-pending`, text(oldText));
    await reply(`interrupt-${interruption}-next`, text(untouched));
    await until(() => requestCount(oldText) === 1, "打断场景没有待决预合成");
    if (interruption === "switch") await configure({ voiceEnabled: false });
    else if (interruption === "focus")
      await page.evaluate(() => window.mai.focus(25));
    else await pet.evaluate(() => window.mai.stopPlayback());
    await pause();
    await page.evaluate(async () => {
      await window.mai.focus(0);
      await window.mai.updateSettings({ voiceEnabled: true });
    });
    const fresh = `打断后新消息-${interruption}`;
    await reply(`interrupt-${interruption}-fresh`, text(fresh));
    await until(
      async () => (await played()).length === offset + 2,
      "旧预合成请求阻塞打断后的新回复",
    );
    assert.equal((await playLabels()).at(-1), `${fresh}@voice-one`);
    release(oldText);
    await pause(150);
    assert.equal(
      requestCount(untouched),
      0,
      "停止后后台worker不能继续提交积压请求",
    );
    assert.equal(
      (await played()).length,
      offset + 2,
      "迟到的旧合成不能复活已取消队列",
    );
    await finish();
  }
  report.checks.push(
    "switch, focus and manual interruption cancel backlog; late synthesis cannot revive it or block fresh replies",
  );

  await pet.evaluate(async () => {
    window.mai.stopPlayback();
    await window.mai.setVoiceInput("recording");
  });
  const recordingText = "录音结束后再朗读";
  const recordingOffset = (await played()).length;
  await reply("while-recording", text(recordingText));
  await pause(150);
  assert.equal(
    requestCount(recordingText),
    0,
    "录音期间不得自动预合成或播放新回复",
  );
  await pet.evaluate(() => window.mai.setVoiceInput("idle"));
  await until(
    async () => (await played()).length === recordingOffset + 1,
    "录音结束后队列没有继续",
  );
  await finish();
  report.checks.push(
    "recording pauses preparation and playback, then resumes new pending replies",
  );

  hold("切音色的待播回复", "voice-one");
  const voiceOffset = (await played()).length;
  await reply("voice-switch-head", [original(-30)]);
  await until(
    async () => (await played()).length === voiceOffset + 1,
    "切音色场景当前语音未开始",
  );
  await reply("voice-switch-pending", text("切音色的待播回复"));
  await until(
    () => requestCount("切音色的待播回复", "voice-one") === 1,
    "旧音色预合成未开始",
  );
  ttsProfiles.openai.voice = "voice-two";
  await configure({ ttsProfiles });
  await until(
    () => requestCount("切音色的待播回复", "voice-two") === 1,
    "切换音色后未废弃旧缓冲并重新准备",
  );
  release("切音色的待播回复");
  await finish();
  await until(
    async () => (await played()).length === voiceOffset + 2,
    "新音色缓冲没有播放",
  );
  assert.equal(
    (await playLabels()).at(-1),
    "切音色的待播回复@voice-two",
    "不能使用旧音色的迟到缓存",
  );
  await finish();
  report.checks.push(
    "voice changes invalidate queued prepared audio without allowing stale synthesis to play",
  );

  await configure({ ttsReplyBufferSize: 2 });
  hold("关闭缓冲时已提交");
  const disableOffset = (await played()).length;
  await reply("disable-buffer-head", [original(-40)]);
  await until(
    async () => (await played()).length === disableOffset + 1,
    "关闭缓冲场景未播放",
  );
  await reply("disable-buffer-pending", text("关闭缓冲时已提交"));
  await reply("disable-buffer-next", text("关闭缓冲后不得提前提交"));
  await until(() => requestCount("关闭缓冲时已提交") === 1, "关闭前预备未开始");
  await configure({ ttsReplyBufferSize: 0 });
  release("关闭缓冲时已提交");
  await pause(150);
  assert.equal(
    requestCount("关闭缓冲后不得提前提交"),
    0,
    "设为0后已提交请求完成不能继续后台准备",
  );
  await stop();
  report.checks.push(
    "disabling buffering prevents new background submissions after existing work completes",
  );

  const systemOffset = requests.length;
  await configure({ ttsEngine: "system", ttsReplyBufferSize: 5 });
  await reply("system-one", text("系统朗读甲"));
  await reply("system-two", text("系统朗读乙"));
  await until(
    async () =>
      (await pet.evaluate(() => window.__ttsBuffer.spoken)).includes(
        "系统朗读乙",
      ),
    "系统朗读队列未继续",
  );
  assert.equal(requests.length, systemOffset, "系统朗读模式不能调用API预合成");
  assert.deepEqual(
    (await pet.evaluate(() => window.__ttsBuffer.spoken)).slice(-2),
    ["系统朗读甲", "系统朗读乙"],
  );
  report.checks.push("system speech preserves FIFO without API synthesis");

  await configure({ ttsEngine: "api", ttsReplyBufferSize: 2 });
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "声音与感知", exact: true })
    .click();
  const bufferSelect = page.getByRole("combobox", { name: /预缓冲文字条数/ });
  await bufferSelect.selectOption("3");
  await page.getByRole("button", { name: "保存声音设置", exact: true }).click();
  await until(
    async () => (await state()).settings.ttsReplyBufferSize === 3,
    "声音设置没有保存预缓冲条数",
  );
  socket.terminate();
  socket = undefined;
  await desktop.close();
  desktop = undefined;
  ({ page, pet } = await launch());
  assert.equal(
    (await state()).settings.ttsReplyBufferSize,
    3,
    "重新启动后没有保留缓冲设置",
  );
  assert.equal((await played()).length, 0, "重启不能重播旧历史或恢复旧预合成");
  report.checks.push(
    "the actual settings form saves the buffer size and a real restart retains it without replaying history",
  );
  assert.deepEqual(report.errors, []);
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
