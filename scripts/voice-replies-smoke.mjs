import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import WebSocket from "ws";

const base = resolve(".cache/voice-replies-smoke");
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

function audio(sample) {
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
  return {
    type: "audio",
    dataUrl: `data:audio/wav;base64,${bytes.toString("base64")}`,
  };
}

async function until(predicate, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(message);
}

let desktop;
let socket;
let ttsService;
let releaseSynthesis;
const errors = [];
const acknowledgements = new Map();
try {
  const env = { ...process.env, MAI_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({
    executablePath: resolve("node_modules/electron/dist/electron.exe"),
    args: ["."],
    cwd: resolve("."),
    env,
    timeout: 30000,
  });
  await desktop.firstWindow();
  let page, pet;
  await until(() => {
    page = desktop
      .windows()
      .find((window) => window.url().includes("view=dashboard"));
    pet = desktop.windows().find((window) => window.url().includes("view=pet"));
    return page && pet;
  }, "桌宠窗口未启动");
  for (const window of [page, pet])
    window.on("pageerror", (error) => errors.push(error.message));
  await pet.locator(".pet-character").waitFor();
  await pet.evaluate(() => {
    window.__voiceTest = {
      played: [],
      paused: [],
      instances: [],
      spoken: [],
      events: [],
    };
    window.Audio = class {
      constructor(url) {
        this.url = url;
        window.__voiceTest.instances.push(this);
      }
      async play() {
        window.__voiceTest.played.push(this.url);
        window.__voiceTest.events.push({ event: "play", url: this.url });
      }
      pause() {
        window.__voiceTest.paused.push(this.url);
      }
    };
    speechSynthesis.cancel = () => {};
    speechSynthesis.speak = (utterance) => {
      window.__voiceTest.spoken.push(utterance.text);
      utterance.onstart?.({});
      queueMicrotask(() => utterance.onend?.({}));
    };
  });
  const configPath = join(profile, "config.toml");
  await desktop.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, configPath);
  await page.evaluate(async () => {
    await window.mai.exportAdapterConfig();
    await window.mai.connect();
  });
  const config = await readFile(configPath, "utf8");
  const token = JSON.parse(config.match(/^token = (.+)$/m)[1]);
  socket = new WebSocket(`ws://127.0.0.1:${port}/maibot`, {
    headers: { Authorization: `Bearer ${token}` },
  });
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
      sessionId: "voice-test",
      capabilities: ["chat", "image", "audio", "proactive"],
    }),
  );
  await until(
    async () =>
      (await page.evaluate(() => window.mai.snapshot())).connection.phase ===
      "connected",
    "消息通道未就绪",
  );
  await page.evaluate(() => window.mai.updateSettings({ voiceEnabled: true }));
  await pet.getByRole("button", { name: "关闭朗读", exact: true }).waitFor();

  async function reply(id, segments) {
    socket.send(
      JSON.stringify({
        v: 1,
        type: "reply",
        id,
        sessionId: "voice-test",
        segments,
      }),
    );
    await until(() => acknowledgements.has(id), "消息未收到保存回执");
    assert.equal(acknowledgements.get(id), true);
    const saved = await page.evaluate(
      async (id) =>
        (await window.mai.snapshot()).history.find((item) => item.id === id),
      id,
    );
    return (
      saved.attachments
        ?.filter((item) => item.type === "audio")
        .map((item) => item.dataUrl) || []
    );
  }
  const played = () => pet.evaluate(() => window.__voiceTest.played);
  const finish = () =>
    pet.evaluate(() => {
      const instance = window.__voiceTest.instances.at(-1);
      window.__voiceTest.events.push({ event: "end", url: instance.url });
      instance.onended?.();
    });

  const first = await reply("three-audio", [
    { type: "text", text: "已有原音频，不应再合成这段文字" },
    audio(1),
    audio(2),
    audio(3),
  ]);
  const second = await reply("next-message", [audio(4)]);
  await until(async () => (await played()).length === 1, "首段音频未播放");
  assert.deepEqual(await played(), first.slice(0, 1));
  await finish();
  await until(async () => (await played()).length >= 2, "第二段音频未播放");
  assert.deepEqual(
    await played(),
    first.slice(0, 2),
    "第二段应来自同一条消息，不能跳到下一条回复",
  );
  await finish();
  await until(async () => (await played()).length >= 3, "第三段音频未播放");
  assert.deepEqual(await played(), first);
  await finish();
  await until(async () => (await played()).length >= 4, "下一条回复未继续播放");
  assert.deepEqual(await played(), [...first, ...second]);
  await finish();
  assert.deepEqual(await pet.evaluate(() => window.__voiceTest.spoken), []);

  // 开关、专注或手动打断必须连同同条剩余片段和后续消息一起取消。
  for (const interruption of ["switch", "focus", "manual"]) {
    const offset = (await played()).length;
    const clips = await reply(`cancel-${interruption}`, [audio(5), audio(6)]);
    await reply(`cancel-next-${interruption}`, [audio(7)]);
    await until(
      async () => (await played()).length === offset + 1,
      "待打断的首段未开始",
    );
    if (interruption === "switch") {
      await page.evaluate(() =>
        window.mai.updateSettings({ voiceEnabled: false }),
      );
      await pet
        .getByRole("button", { name: "开启朗读", exact: true })
        .waitFor();
    } else if (interruption === "focus") {
      await page.evaluate(() => window.mai.focus(25));
    } else {
      await pet
        .getByRole("button", { name: "打开迷你聊天", exact: true })
        .click();
      await pet
        .getByRole("textbox", { name: "和麦麦说话", exact: true })
        .fill("打断当前语音");
      await pet
        .getByRole("button", { name: "发送迷你消息", exact: true })
        .click();
    }
    await until(
      async () =>
        pet.evaluate(
          (url) => window.__voiceTest.paused.includes(url),
          clips[0],
        ),
      "打断后当前音频未暂停",
    );
    // 已取消的音频即使稍后发出 ended，也不能恢复排队内容。
    await finish();
    await page.evaluate(async () => {
      await window.mai.focus(0);
      await window.mai.updateSettings({ voiceEnabled: true });
    });
    const fresh = await reply(`fresh-${interruption}`, [audio(8)]);
    await until(
      async () => (await played()).length >= offset + 2,
      "打断后新语音无法播放",
    );
    assert.deepEqual(
      (await played()).slice(offset),
      [clips[0], ...fresh],
      `${interruption} 打断后不能复播剩余音频`,
    );
    await finish();
  }

  // 无音频的回复仍使用 TTS；旧历史补载不会突然出声。
  await reply("text-only", [{ type: "text", text: "纯文字仍可朗读" }]);
  await until(
    async () =>
      pet.evaluate(() => window.__voiceTest.spoken.includes("纯文字仍可朗读")),
    "纯文字朗读未恢复",
  );
  const spokenBeforeQuote = await pet.evaluate(
    () => window.__voiceTest.spoken.length,
  );
  await reply("quoted-text", [
    { type: "text", text: "[引用消息] 朋友：被引用的第一行\n被引用的第二行\n" },
    { type: "text", text: "这是本次回复。" },
  ]);
  await until(
    async () =>
      (await pet.evaluate(() => window.__voiceTest.spoken.length)) >
      spokenBeforeQuote,
    "引用后的回复未朗读",
  );
  assert.deepEqual(
    await pet.evaluate(
      (offset) => window.__voiceTest.spoken.slice(offset),
      spokenBeforeQuote,
    ),
    ["这是本次回复。"],
    "朗读应只包含本次回复，跳过引用标记、发送者和多行原文",
  );
  await reply("quote-only", [
    { type: "text", text: "[引用消息] 朋友：仅供引用的原文\n" },
  ]);
  await reply("legacy-quote", [
    { type: "text", text: "[引用消息]\n" },
    { type: "text", text: "只有消息编号也能只读回复。" },
  ]);
  await until(
    async () =>
      pet.evaluate(() =>
        window.__voiceTest.spoken.includes("只有消息编号也能只读回复。"),
      ),
    "仅有引用的消息不应阻塞后续回复",
  );
  assert.deepEqual(
    await pet.evaluate(
      (offset) => window.__voiceTest.spoken.slice(offset),
      spokenBeforeQuote,
    ),
    ["这是本次回复。", "只有消息编号也能只读回复。"],
    "只含引用的消息应保持安静",
  );

  // 手动朗读与自动朗读共用提取规则，引用仍完整显示。
  await page.evaluate(() => {
    window.__manualSpeech = [];
    speechSynthesis.cancel = () => {};
    speechSynthesis.speak = (utterance) => {
      window.__manualSpeech.push(utterance.text);
      utterance.onstart?.({});
      queueMicrotask(() => utterance.onend?.({}));
    };
    window.Audio = class {
      async play() {
        queueMicrotask(() => this.onended?.());
      }
      pause() {}
    };
  });
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: /和麦麦聊聊/ })
    .click();
  const quotedRow = page
    .locator(".message-row.assistant")
    .filter({ hasText: "这是本次回复。" });
  assert.ok((await quotedRow.innerText()).includes("被引用的第二行"));
  const storedQuote = await page.evaluate(async () =>
    (await window.mai.snapshot()).history.find(
      (item) => item.id === "quoted-text",
    ),
  );
  assert.equal(
    storedQuote.text,
    "[引用消息] 朋友：被引用的第一行\n被引用的第二行\n这是本次回复。",
  );
  await quotedRow.getByRole("button", { name: "朗读这条消息" }).click();
  await until(
    async () => (await page.evaluate(() => window.__manualSpeech.length)) === 1,
    "手动朗读未开始",
  );
  assert.deepEqual(await page.evaluate(() => window.__manualSpeech), [
    "这是本次回复。",
  ]);
  assert.equal(
    await page
      .locator(".message-row.assistant")
      .filter({ hasText: "仅供引用的原文" })
      .getByRole("button", { name: "朗读这条消息" })
      .count(),
    0,
  );
  // 合成尚未响应时也要立即释放播放队列，新回复不应等旧请求超时。
  const requestedTexts = [];
  ttsService = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { input } = JSON.parse(Buffer.concat(chunks).toString());
    requestedTexts.push(input);
    const send = () =>
      response.end(Buffer.from(audio(10).dataUrl.split(",")[1], "base64"));
    if (input === "等待合成的旧回复") releaseSynthesis = send;
    else send();
  });
  ttsService.listen(0, "127.0.0.1");
  await once(ttsService, "listening");
  await page.evaluate(
    (port) =>
      window.mai.updateSettings({
        ttsEngine: "api",
        ttsProvider: "openai",
        ttsProfiles: {
          openai: {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "test-model",
            voice: "test-voice",
            resourceId: "",
          },
        },
      }),
    ttsService.address().port,
  );
  const offset = (await played()).length;
  await reply("pending-tts", [{ type: "text", text: "等待合成的旧回复" }]);
  await until(
    () => requestedTexts.includes("等待合成的旧回复"),
    "合成请求未发出",
  );
  await page.evaluate(() => window.mai.updateSettings({ voiceEnabled: false }));
  await pet.getByRole("button", { name: "开启朗读", exact: true }).waitFor();
  await page.evaluate(() => window.mai.updateSettings({ voiceEnabled: true }));
  await pet.getByRole("button", { name: "关闭朗读", exact: true }).waitFor();
  await reply("fresh-tts", [{ type: "text", text: "取消后立即朗读新回复" }]);
  await until(
    async () => (await played()).length === offset + 1,
    "旧合成请求阻塞了新回复",
  );
  assert.ok(requestedTexts.includes("取消后立即朗读新回复"));
  releaseSynthesis();
  releaseSynthesis = undefined;
  await finish();
  const quotedApiOffset = (await played()).length;
  const requestOffset = requestedTexts.length;
  await reply("quote-only-api", [
    { type: "text", text: "[引用消息] 朋友：不应发送到语音接口\n" },
  ]);
  await reply("quoted-api", [
    {
      type: "text",
      text: "[引用消息] 朋友：接口也要跳过原文\n以及第二行原文\n",
    },
    { type: "text", text: "接口只合成回复。" },
  ]);
  await until(
    async () => (await played()).length > quotedApiOffset,
    "引用后的 API 语音未播放",
  );
  assert.deepEqual(requestedTexts.slice(requestOffset), ["接口只合成回复。"]);
  await finish();
  await quotedRow.getByRole("button", { name: "朗读这条消息" }).click();
  await until(
    () => requestedTexts.length > requestOffset + 1,
    "手动朗读的 API 请求未发出",
  );
  assert.deepEqual(requestedTexts.slice(requestOffset), [
    "接口只合成回复。",
    "这是本次回复。",
  ]);
  // 下一段须在当前段播放期间准备，避免每段之间重新等待模型响应。
  const longOffset = (await played()).length;
  const longRequestOffset = requestedTexts.length;
  const longReply = "这是一句完整的话。".repeat(130);
  await reply("continuous-long-tts", [{ type: "text", text: longReply }]);
  await until(
    async () => (await played()).length > longOffset,
    "长回复首段未播放",
  );
  await until(
    () => requestedTexts.length > longRequestOffset + 1,
    "当前段播放期间没有准备下一段，段间会再次等待合成",
    1500,
  );
  await finish();
  await until(
    async () => (await played()).length > longOffset + 1,
    "预备的下一段未接续播放",
  );
  await finish();
  assert.equal(requestedTexts.slice(longRequestOffset).join(""), longReply);
  await page.evaluate(() =>
    window.mai.updateSettings({ ttsPreloadNext: false }),
  );
  const serialOffset = (await played()).length;
  const serialRequestOffset = requestedTexts.length;
  const serialReply = "关闭预合成后按原有顺序播放。".repeat(90);
  await reply("serial-long-tts", [{ type: "text", text: serialReply }]);
  await until(
    async () => (await played()).length > serialOffset,
    "串行朗读首段未播放",
  );
  await pet.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
  assert.equal(
    requestedTexts.length,
    serialRequestOffset + 1,
    "关闭连续播放后不应预先提交下一段",
  );
  await finish();
  await until(
    async () => (await played()).length > serialOffset + 1,
    "关闭预合成后下一段未继续",
  );
  await finish();
  assert.equal(requestedTexts.slice(serialRequestOffset).join(""), serialReply);
  await page.evaluate(() => window.mai.updateSettings({ ttsEngine: "system" }));
  // init script 在重载前安装，确保早于 React 初始化。
  await pet.addInitScript(() => {
    window.__historyAudioPlays = 0;
    window.Audio = class {
      async play() {
        window.__historyAudioPlays++;
      }
      pause() {}
    };
  });
  await pet.reload();
  await pet.getByRole("button", { name: "关闭朗读", exact: true }).waitFor();
  assert.equal(
    await pet.evaluate(() => window.__historyAudioPlays),
    0,
    "历史补载不应自动播放",
  );

  assert.deepEqual(errors, []);
  await writeFile(
    join(base, "result.json"),
    JSON.stringify(
      {
        passed: true,
        checks: [
          "多音频按顺序播放",
          "跨消息依次排队",
          "已有音频不重复合成文字",
          "关闭朗读中断全部待播音频",
          "专注中断全部待播音频",
          "手动打断与后续新消息恢复",
          "纯文字 TTS",
          "自动与手动朗读仅包含回复，跳过多行引用和发送者",
          "只有引用时不朗读，也不阻塞后续消息",
          "原文完整展示和保存",
          "语音接口不发送引用原文",
          "取消等待中的模型合成后新回复立即恢复",
          "长回复当前段播放期间只预合成下一段",
          "关闭连续播放后不预先提交后文",
          "历史补载不自动播放",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS 语音回复：多段队列、打断与恢复、自动/手动朗读跳过引用、系统语音与 API 请求正文",
  );
} finally {
  releaseSynthesis?.();
  if (socket) socket.terminate();
  await desktop?.close();
  if (ttsService)
    await new Promise((done) => {
      ttsService.close(done);
      ttsService.closeAllConnections();
    });
}
