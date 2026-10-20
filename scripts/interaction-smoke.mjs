import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve, sep } from "node:path";
import { _electron as electron } from "playwright";
import WebSocket from "ws";

// 实际 Electron / HTML 音频 / VAD，仅模型端由本机测试服务替代。
const base = resolve(".cache/interaction-smoke");
await mkdir(base, { recursive: true });
const profile = await mkdtemp(join(base, "profile-"));
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((done) => probe.close(done));
await writeFile(
  join(profile, "state.json"),
  JSON.stringify({
    version: 2,
    settings: { adapterPort: port, autoConnect: false },
    history: [],
    models: [],
    encrypted: {},
  }),
);

function waveform() {
  const rate = 16000,
    samples = rate * 8;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) {
    const time = index / rate;
    const amplitude = time >= 0.5 && time < 1.5 ? 0.16 : time >= 3 ? 0.32 : 0;
    wav.writeInt16LE(
      Math.round(Math.sin(time * 440 * 2 * Math.PI) * amplitude * 32767),
      44 + index * 2,
    );
  }
  return {
    type: "audio",
    dataUrl: `data:audio/wav;base64,${wav.toString("base64")}`,
  };
}
const clip = waveform();
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, message, timeout = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await pause(25);
  }
  throw new Error(message);
}

let desktop, socket, releaseAsr;
let holdAsr = false,
  asrCount = 0;
const service = createServer(async (request, response) => {
  for await (const chunk of request) {
    /* 读取测试录音 */
  }
  asrCount++;
  const send = () => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ text: `这是第 ${asrCount} 句语音` }));
  };
  if (holdAsr) releaseAsr = send;
  else send();
});
service.listen(0, "127.0.0.1");
await once(service, "listening");
const errors = [],
  requests = [],
  acknowledgements = new Map();
let acknowledgeRequests = true;
try {
  const env = { ...process.env, MAI_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  desktop = await electron.launch({
    executablePath: resolve("node_modules/electron/dist/electron.exe"),
    args: [
      ".",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
    cwd: resolve("."),
    env,
  });
  await desktop.firstWindow();
  let page, pet;
  await until(() => {
    page = desktop
      .windows()
      .find((window) => window.url().includes("view=dashboard"));
    pet = desktop.windows().find((window) => window.url().includes("view=pet"));
    return page && pet;
  }, "双窗口未启动");
  for (const window of [page, pet])
    window.on("pageerror", (error) => errors.push(error.message));
  // 在 WebContents 输出处静音，波形仍由真实 AudioContext 分析，不打扰运行者。
  await desktop.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.setAudioMuted(true);
  });
  await pet.locator(".pet-character").waitFor();
  const state = () => page.evaluate(() => window.mai.snapshot());
  const configPath = join(profile, "config.toml");
  await desktop.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, configPath);
  await page.evaluate(async () => {
    await window.mai.exportAdapterConfig();
    await window.mai.connect();
  });
  const token = JSON.parse(
    (await readFile(configPath, "utf8")).match(/^token = (.+)$/m)[1],
  );
  socket = new WebSocket(`ws://127.0.0.1:${port}/maibot`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  socket.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === "reply_ack") acknowledgements.set(frame.id, frame.ok);
    if (frame.type === "request") {
      requests.push(frame);
      if (acknowledgeRequests)
        socket.send(
          JSON.stringify({ v: 1, type: "result", id: frame.id, ok: true }),
        );
    }
  });
  await once(socket, "open");
  const welcome = once(socket, "message");
  socket.send(
    JSON.stringify({
      v: 1,
      type: "hello",
      protocol: "mai-desktop",
      pluginVersion: "0.4.5",
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
      sessionId: "interaction-test",
      capabilities: ["chat", "image", "audio", "proactive"],
    }),
  );
  await until(
    async () => (await state()).connection.phase === "connected",
    "连接未完成",
  );
  await page.getByRole("button", { name: "和麦麦聊聊", exact: true }).click();

  // 状态只描述投递：发送中 → 等待 → 自然回到空闲，无伪造思考/失败。
  acknowledgeRequests = false;
  await page.evaluate(() => {
    window.__send = window.mai.send({ text: "这一句可以保持沉默" });
  });
  await until(
    async () => (await state()).replyStatus === "sending",
    "未显示发送中",
  );
  assert.notEqual((await state()).mood, "thinking");
  assert.equal(
    await page.getByText("正在想怎么回复你…", { exact: true }).count(),
    0,
  );
  await until(() => requests.length > 0, "没有发给内核");
  socket.send(
    JSON.stringify({ v: 1, type: "result", id: requests.at(-1).id, ok: true }),
  );
  await page.evaluate(() => window.__send);
  await until(
    async () => (await state()).replyStatus === "waiting",
    "未显示等待回应",
  );
  await until(
    async () => (await state()).replyStatus === "idle",
    "正常沉默后未回到空闲",
    18000,
  );
  assert.notEqual((await state()).history.at(-1).delivery, "failed");
  console.log("PASS 投递状态、自然沉默与等待结束");
  acknowledgeRequests = true;

  async function reply(id, segments) {
    socket.send(
      JSON.stringify({
        v: 1,
        type: "reply",
        id,
        sessionId: "interaction-test",
        segments,
      }),
    );
    await until(() => acknowledgements.has(id), "回复未保存");
    assert.equal(acknowledgements.get(id), true);
    return (await state()).history.find((message) => message.id === id);
  }
  await reply("manual-waveform", [
    { type: "text", text: "这句话没有指定情绪" },
    clip,
  ]);
  assert.equal((await state()).mood, "idle", "不能把任意回复都判为开心");
  await page.getByRole("button", { name: "播放这段音频", exact: true }).click();
  await until(
    async () => (await state()).playback.phase === "playing",
    "手动声音未进入播放状态",
  );
  const readings = [];
  const start = Date.now();
  while (Date.now() - start < 3100) {
    const reading = await page.evaluate(async () => ({
      time: document.querySelector("audio[data-chat-player]").currentTime,
      mouth: (await window.mai.snapshot()).playback.mouth,
    }));
    readings.push(reading);
    await pause(45);
  }
  assert.ok(
    readings.some(
      (row) => row.time > 0.75 && row.time < 1.4 && row.mouth > 0.25,
    ),
    "真实声音没有驱动口型",
  );
  assert.ok(
    readings.some((row) => row.time > 2 && row.time < 2.8 && row.mouth === 0),
    "音频停顿时没有闭嘴",
  );
  await page.getByRole("button", { name: "此刻", exact: true }).click();
  await until(
    async () =>
      Number(
        await pet
          .locator(".pet-character [data-mouth-open]")
          .getAttribute("data-mouth-open"),
      ) > 0.1,
    "桌宠没有收到主窗口口型",
  );
  assert.ok(
    Number(
      await page
        .locator(".stage-avatar [data-mouth-open]")
        .getAttribute("data-mouth-open"),
    ) > 0.1,
  );
  await page.screenshot({
    path: join(base, "audio-mouth.png"),
    fullPage: true,
  });
  await page.evaluate(() => window.mai.stopPlayback());
  await until(
    async () => (await state()).playback.phase === "idle",
    "跨窗口停止后未释放口型",
  );
  await until(
    async () =>
      (await pet
        .locator(".pet-character [data-mouth-open]")
        .getAttribute("data-mouth-open")) === "0.000",
    "停止后嘴型未归零",
  );
  assert.equal(
    await page
      .locator("audio[data-chat-player]")
      .evaluate((audio) => audio.paused),
    true,
  );
  console.log("PASS 真实音频响度、静音停顿、双窗口口型与跨窗口停止");

  // 过期窗口回调不能清除新的播放状态；非法帧也不会生效。
  const oldId = randomUUID(),
    newId = randomUUID();
  await page.evaluate(
    ([oldId, newId]) => {
      window.mai.reportPlayback({ type: "start", id: oldId });
      window.mai.reportPlayback({ type: "start", id: newId });
      window.mai.reportPlayback({ type: "playing", id: newId, mouth: 0.6 });
      window.mai.reportPlayback({ type: "end", id: oldId });
      window.mai.reportPlayback({ type: "playing", id: newId, mouth: 99 });
    },
    [oldId, newId],
  );
  await until(
    async () => (await state()).playback.id === newId,
    "新播放状态丢失",
  );
  assert.equal((await state()).playback.mouth, 0.6);
  await page.evaluate(
    (id) => window.mai.reportPlayback({ type: "end", id }),
    newId,
  );

  // 仅麦克风的能量输入被控制，录音器、播放及 ASR HTTP 路径均保留真实实现。
  await pet.evaluate(() => {
    window.__micLevel = 0;
    window.__played = [];
    const originalSource = AudioContext.prototype.createMediaStreamSource;
    AudioContext.prototype.createMediaStreamSource = function (stream) {
      window.__micTracks = stream.getTracks();
      const source = originalSource.call(this, stream);
      const connect = source.connect.bind(source);
      source.connect = (destination) => {
        destination.__microphone = true;
        return connect(destination);
      };
      return source;
    };
    const read = AnalyserNode.prototype.getFloatTimeDomainData;
    AnalyserNode.prototype.getFloatTimeDomainData = function (buffer) {
      if (this.__microphone) buffer.fill(window.__micLevel);
      else read.call(this, buffer);
    };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      window.__played.push(this.src);
      return play.call(this);
    };
  });
  await page.evaluate(async (port) => {
    await window.mai.updateSettings({
      voiceEnabled: true,
      vadSilenceMs: 500,
      speechBaseUrl: `http://127.0.0.1:${port}/v1`,
      sttModel: "test-asr",
    });
    await window.mai.voiceConversation(true);
  }, service.address().port);
  await until(
    async () => (await state()).voiceInput === "listening",
    "麦克风未就绪",
  );
  const pending = await reply("interrupt-waveform", [clip, clip]);
  await until(
    async () => (await state()).playback.phase === "playing",
    "待打断语音未播放",
  );
  const playingId = (await state()).playback.id;
  await pause(400);
  await pet.evaluate(() => {
    window.__micLevel = 0.09;
  });
  await pause(85);
  await pet.evaluate(() => {
    window.__micLevel = 0;
  });
  await pause(350);
  assert.equal((await state()).playback.id, playingId, "短噪声误触发了打断");
  holdAsr = true;
  await pet.evaluate(() => {
    window.__micLevel = 0.09;
  });
  await until(
    async () => (await state()).voiceInput === "recording",
    "持续开口没有进入录音",
  );
  await until(
    async () => (await state()).playback.phase === "idle",
    "开口后未停止当前播报",
  );
  await pause(500);
  await pet.evaluate(() => {
    window.__micLevel = 0;
  });
  await until(
    async () => (await state()).voiceInput === "transcribing",
    "未显示正在转写",
  );
  await until(() => Boolean(releaseAsr), "录音没有提交本机ASR");
  await pet.getByText("正在转写…", { exact: true }).first().waitFor();
  releaseAsr();
  releaseAsr = undefined;
  holdAsr = false;
  await until(
    async () =>
      (await state()).voiceInput === "listening" &&
      (await state()).replyStatus === "waiting",
    "发送后没有继续聆听",
  );
  const voiceCount = requests.filter(
    (request) => request.params.source === "voice",
  ).length;
  assert.equal(voiceCount, 1);
  // 还没收到内核回复，也应该可以继续说第二句。
  await pet.evaluate(() => {
    window.__micLevel = 0.08;
  });
  await pause(650);
  await pet.evaluate(() => {
    window.__micLevel = 0;
  });
  await until(
    () =>
      requests.filter((request) => request.params.source === "voice").length ===
      2,
    "等待内核时第二句语音被丢弃",
  );
  const played = await pet.evaluate(() => window.__played);
  assert.equal(
    played.filter((url) =>
      pending.attachments.some((attachment) => attachment.dataUrl === url),
    ).length,
    1,
    "插话后复播了旧队列",
  );
  console.log(
    "PASS 短噪声过滤、语音插话、转写状态、旧队列取消、等待时继续说话",
  );

  await reply("fresh-waveform", [clip]);
  await until(
    async () => (await state()).playback.phase === "playing",
    "新回复未恢复播放",
  );
  await page.evaluate(() => window.mai.focus(25));
  await until(
    async () =>
      (await state()).playback.phase === "idle" &&
      (await state()).voiceInput === "idle",
    "专注未停止音频和语音输入",
  );
  await pet.waitForFunction(() =>
    window.__micTracks.every((track) => track.readyState === "ended"),
  );
  assert.equal((await state()).mood, "sleeping");
  assert.deepEqual(errors, []);
  console.log("PASS 新回复恢复、专注清理和麦克风释放；未调用在线模型");
  // 系统朗读不能读取波形，仍要在实际 start/end 之间保持基础口型并可停止。
  await page.evaluate(async () => {
    await window.mai.focus(0);
    await window.mai.updateSettings({ ttsEngine: "system" });
  });
  await pet.evaluate(() => {
    speechSynthesis.cancel = () => {};
    speechSynthesis.speak = (utterance) => {
      window.__systemUtterance = utterance;
      utterance.onstart?.({});
    };
  });
  await reply("system-fallback", [
    { type: "text", text: "系统声音保留基础口型" },
  ]);
  await until(
    async () =>
      (await state()).playback.phase === "playing" &&
      (await state()).playback.mouth === null,
    "系统语音没有进入降级口型",
  );
  const fallbackMouth = [];
  for (let frame = 0; frame < 12; frame++) {
    fallbackMouth.push(
      Number(
        await pet
          .locator(".pet-character [data-mouth-open]")
          .getAttribute("data-mouth-open"),
      ),
    );
    await pause(40);
  }
  assert.ok(
    Math.max(...fallbackMouth) - Math.min(...fallbackMouth) > 0.1,
    "系统朗读基础口型静止",
  );
  await page.evaluate(() => window.mai.stopPlayback());
  await until(
    async () => (await state()).playback.phase === "idle",
    "系统朗读未停止",
  );
  await pet.evaluate(() => window.__systemUtterance.onend?.({}));
  assert.equal((await state()).playback.phase, "idle");
  assert.deepEqual(errors, []);
  console.log("PASS 系统朗读降级口型、停止及迟到结束事件");
  await writeFile(
    join(base, "result.json"),
    JSON.stringify(
      {
        readings,
        requests: requests.map(({ params }) => params.source || "text"),
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  releaseAsr?.();
  socket?.terminate();
  await desktop?.close();
  service.closeAllConnections();
  await new Promise((done) => service.close(done));
  assert.ok(resolve(profile).startsWith(base + sep));
  await rm(profile, { recursive: true, force: true });
}
