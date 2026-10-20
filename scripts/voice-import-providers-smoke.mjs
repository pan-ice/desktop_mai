import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";

const base = resolve(".cache/voice-import-providers-smoke");
await mkdir(base, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "mai-voice-providers-"));
const wav = Buffer.alloc(1644);
wav.write("RIFF");
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(1600, 40);
const names = {
  siliconflow: "硅基流动",
  minimax: "MiniMax",
  bailian: "阿里云百炼",
  volcengine: "火山引擎",
};
const providers = Object.keys(names);
const requests = [],
  errors = [];
let volcStatus = 1,
  failQuery = false,
  failAsr = false,
  origin;
const service = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks),
      type = request.headers["content-type"] || "";
    const body = type.includes("application/json")
      ? JSON.parse(bytes.toString())
      : undefined;
    const form = type.includes("multipart/form-data")
      ? await new Response(bytes, {
          headers: { "Content-Type": type },
        }).formData()
      : undefined;
    const provider = request.url.split("/")[1];
    const record = {
      path: request.url,
      provider,
      body,
      raw: bytes.toString(),
      headers: request.headers,
      form,
    };
    requests.push(record);
    const send = (value) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(value));
    };
    if (request.url === "/result.wav?signature=private") {
      assert.equal(request.headers.authorization, undefined);
      response.end(wav);
      return;
    }
    assert.equal(
      provider === "volcengine"
        ? request.headers["x-api-key"]
        : request.headers.authorization,
      provider === "volcengine" ? "key-volcengine" : `Bearer key-${provider}`,
    );
    if (request.url.endsWith("audio/transcriptions")) {
      assert.equal(form.get("model"), "FunAudioLLM/SenseVoiceSmall");
      assert.deepEqual(Buffer.from(await form.get("file").arrayBuffer()), wav);
      send({ text: failAsr ? "" : "自动识别的参考音频原文。" });
    } else if (request.url.endsWith("uploads/audio/voice")) {
      assert.ok(
        ["自动识别的参考音频原文。", "补充的原文。"].includes(form.get("text")),
      );
      send({ uri: `speech:custom:import:${requests.length}` });
    } else if (request.url.endsWith("files/upload")) {
      assert.equal(form.get("purpose"), "voice_clone");
      response.end(
        '{"file":{"file_id":9223372036854775806},"base_resp":{"status_code":0}}',
      );
    } else if (request.url.endsWith("voice_clone")) {
      if (provider === "minimax") {
        assert.match(body.voice_id, /^Mai[a-f0-9]{32}$/);
        assert.ok(record.raw.includes('"file_id":9223372036854775806'));
        send({ base_resp: { status_code: 0 } });
      } else {
        assert.equal(body.speaker_id, "custom_speaker_id");
        assert.match(body.custom_speaker_id, /^Mai[a-f0-9]{32}$/);
        assert.equal(body.audio.data, wav.toString("base64"));
        send({ status: 1 });
      }
    } else if (request.url.endsWith("get_voice")) {
      if (failQuery) response.writeHead(503).end("temporary");
      else send({ status: volcStatus });
    } else if (request.url.endsWith("customization")) {
      assert.equal(body.model, "qwen-voice-enrollment");
      assert.equal(body.input.action, "create");
      assert.equal(body.input.target_model, "qwen3-tts-vc-2026-01-22");
      assert.equal(
        body.input.audio.data,
        `data:audio/wav;base64,${wav.toString("base64")}`,
      );
      assert.equal(body.input.url, undefined);
      send({
        output: {
          voice: "qwen-imported-bailian",
          target_model: body.input.target_model,
        },
      });
    } else if (request.url.endsWith("generation")) {
      assert.equal(body.model, "qwen3-tts-vc-2026-01-22");
      assert.equal(body.input.voice, "qwen-imported-bailian");
      send({
        output: { audio: { url: `${origin}/result.wav?signature=private` } },
      });
    } else if (request.url.endsWith("t2a_v2"))
      send({
        base_resp: { status_code: 0 },
        data: { audio: wav.toString("hex") },
      });
    else if (request.url.endsWith("unidirectional")) {
      assert.equal(request.headers["x-api-resource-id"], "seed-icl-2.0");
      response.end(
        `${JSON.stringify({ code: 0, data: wav.toString("base64") })}\n${JSON.stringify({ code: 20000000 })}\n`,
      );
    } else if (request.url.endsWith("audio/speech")) response.end(wav);
    else throw new Error(`Unexpected test request: ${request.url}`);
  } catch (error) {
    errors.push(String(error));
    response.writeHead(500).end();
  }
});
service.listen(0, "127.0.0.1");
await once(service, "listening");
origin = `http://127.0.0.1:${service.address().port}`;
const defaults = {
  siliconflow: { model: "FunAudioLLM/CosyVoice2-0.5B", voice: "system" },
  minimax: { model: "speech-2.8-hd", voice: "system" },
  bailian: { model: "qwen-audio-3.0-tts-flash", voice: "system" },
  volcengine: {
    model: "seed-tts-2.0-standard",
    voice: "system",
    resourceId: "seed-tts-2.0",
  },
};
await writeFile(
  join(profile, "state.json"),
  JSON.stringify({
    version: 2,
    settings: {
      autoConnect: false,
      speechBaseUrl: `${origin}/asr-unchanged`,
      sttModel: "unchanged-asr",
      ttsProfiles: Object.fromEntries(
        providers.map((provider) => [
          provider,
          {
            baseUrl: `${origin}/${provider}`,
            resourceId: "",
            ...defaults[provider],
          },
        ]),
      ),
    },
    history: [],
    models: [],
    encrypted: {},
  }),
);
let desktop;
async function until(predicate, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 30));
  }
  throw new Error(message);
}
async function snapshot(page) {
  return page.evaluate(() => window.mai.snapshot());
}
async function launch() {
  const env = { ...process.env, MAI_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  desktop = await electron.launch({
    executablePath: resolve("node_modules/electron/dist/electron.exe"),
    args: ["."],
    cwd: resolve("."),
    env,
  });
  await desktop.firstWindow();
  let page;
  await until(() => {
    page = desktop
      .windows()
      .find((page) => page.url().includes("view=dashboard"));
    return page;
  }, "主面板未打开");
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("button", { name: "声音与感知", exact: true }).click();
  await page.evaluate(() => {
    window.__played = 0;
    window.Audio = class {
      async play() {
        window.__played++;
        queueMicrotask(() => this.onended?.());
      }
      pause() {}
    };
  });
  return page;
}
async function upload(page, name) {
  await page
    .getByLabel("选择音色音频", { exact: true })
    .setInputFiles({ name: `${name}.wav`, mimeType: "audio/wav", buffer: wav });
}
async function listen(page) {
  const before = await page.evaluate(() => window.__played);
  await page.getByRole("button", { name: "试听声音", exact: true }).click();
  await until(
    async () => (await page.evaluate(() => window.__played)) > before,
    "试听未播放",
  );
}
try {
  let page = await launch();
  const voices = {};
  for (const provider of providers) {
    await page.getByLabel("音色服务", { exact: true }).selectOption(provider);
    const count = requests.length;
    await upload(page, `${names[provider]}的声音`);
    await page.locator(".voice-import-queued").waitFor();
    assert.equal(
      requests.length,
      count,
      "没有 Key 时应保留待导入文件，不上传其他服务",
    );
    await page
      .getByLabel(`${names[provider]} API Key`, { exact: true })
      .fill(`key-${provider}`);
    await page
      .getByRole("button", { name: "保存并导入音色", exact: true })
      .click();
    await until(
      async () =>
        (await snapshot(page)).clonedVoices.some(
          (voice) => voice.provider === provider,
        ),
      `${provider} 未导入`,
    );
    voices[provider] = (await snapshot(page)).clonedVoices.find(
      (voice) => voice.provider === provider,
    );
    if (provider === "volcengine") {
      assert.equal(voices[provider].status, "pending");
      assert.equal(voices[provider].autoUse, true);
      assert.equal(
        (await snapshot(page)).settings.ttsProvider,
        "bailian",
        "训练未完成不能覆盖原音色",
      );
      failQuery = true;
      await until(
        async () =>
          (await snapshot(page)).clonedVoices.find(
            (voice) => voice.id === voices[provider].id,
          ).statusMessage,
        "查询失败未显示重试进度",
      );
      await page.getByRole("button", { name: "此刻", exact: true }).click();
      await desktop.close();
      desktop = undefined;
      const disk = JSON.parse(
        await readFile(join(profile, "state.json"), "utf8"),
      );
      assert.equal(
        disk.clonedVoices.find((voice) => voice.id === voices[provider].id)
          .autoUse,
        true,
      );
      failQuery = false;
      volcStatus = 2;
      page = await launch();
    }
    await until(async () => {
      const state = await snapshot(page);
      return (
        state.settings.ttsProvider === provider &&
        state.settings.ttsProfiles[provider].voice === voices[provider].voiceId
      );
    }, `${provider} 未自动启用，或重启后未继续查询`);
    assert.equal((await snapshot(page)).settings.voiceEnabled, true);
    await listen(page);
    await page
      .locator(".voice-import-section")
      .screenshot({ path: join(base, `${provider}.png`) });
  }

  // 识别失败时保留当前音色，补充原文后点击重试即可完成。
  await page
    .getByLabel("音色服务", { exact: true })
    .selectOption("siliconflow");
  failAsr = true;
  await upload(page, "识别失败可补充");
  await page.locator(".voice-import-error").waitFor();
  assert.equal((await snapshot(page)).settings.ttsProvider, "volcengine");
  await page.locator(".voice-import-extras summary").click();
  await page
    .getByLabel("参考音频原文（可选）", { exact: true })
    .fill("补充的原文。");
  await page.getByRole("button", { name: "重试导入音色", exact: true }).click();
  await until(
    async () => (await snapshot(page)).settings.ttsProvider === "siliconflow",
    "补充原文后未完成导入",
  );
  const previous = (await snapshot(page)).settings;

  // 手动选择其他声音后，较晚完成的训练不得覆盖用户的新选择。
  volcStatus = 1;
  await page.getByLabel("音色服务", { exact: true }).selectOption("volcengine");
  await upload(page, "不会覆盖新选择");
  await until(
    async () =>
      (await snapshot(page)).clonedVoices.some(
        (voice) => voice.name === "不会覆盖新选择",
      ),
    "新训练未保存",
  );
  const canceled = (await snapshot(page)).clonedVoices.find(
    (voice) => voice.name === "不会覆盖新选择",
  );
  await page.evaluate(
    (settings) =>
      window.mai.updateSettings({
        ttsEngine: settings.ttsEngine,
        ttsProvider: settings.ttsProvider,
        ttsProfiles: settings.ttsProfiles,
      }),
    previous,
  );
  volcStatus = 2;
  await until(
    async () =>
      (await snapshot(page)).clonedVoices.find(
        (voice) => voice.id === canceled.id,
      ).status === "ready",
    "取消自动选用后仍应后台查询至就绪",
  );
  assert.equal((await snapshot(page)).settings.ttsProvider, "siliconflow");
  assert.equal(
    (await snapshot(page)).clonedVoices.find(
      (voice) => voice.id === canceled.id,
    ).autoUse,
    false,
  );

  // 服务商拒绝训练时保留原音色，并显示可操作的失败提示。
  await page.getByLabel("音色服务", { exact: true }).selectOption("volcengine");
  await upload(page, "训练未通过");
  await until(
    async () =>
      (await snapshot(page)).clonedVoices.some(
        (voice) => voice.name === "训练未通过",
      ),
    "失败用例未提交",
  );
  volcStatus = 3;
  await until(
    async () =>
      (await snapshot(page)).clonedVoices.find(
        (voice) => voice.name === "训练未通过",
      ).status === "failed",
    "未自动发现训练失败",
  );
  await page
    .getByText("「训练未通过」准备未通过，请换一段清晰的录音重新导入。", {
      exact: true,
    })
    .waitFor();
  const final = await snapshot(page);
  assert.equal(final.settings.ttsProvider, "siliconflow");
  assert.equal(final.settings.speechBaseUrl, `${origin}/asr-unchanged`);
  assert.equal(final.settings.sttModel, "unchanged-asr");
  await desktop.close();
  desktop = undefined;
  const disk = JSON.parse(await readFile(join(profile, "state.json"), "utf8"));
  for (const provider of providers)
    assert.ok(!JSON.stringify(disk).includes(`key-${provider}`));
  assert.ok(!JSON.stringify(disk).includes(wav.toString("base64")));
  assert.deepEqual(errors, []);
  console.log(
    "其他四家简单导入、独立 Key、自动转写与编号、百炼本地文件、后台查询与重启续查、失败保留原音色验证通过",
  );
} finally {
  await desktop?.close().catch(() => {});
  await new Promise((done) => {
    service.close(done);
    service.closeAllConnections();
  });
  await rm(profile, { recursive: true, force: true });
}
