import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";

const base = resolve(".cache/tts-clone-smoke");
await mkdir(base, { recursive: true });
const profile = await mkdtemp(join(base, "profile-"));
await writeFile(
  join(profile, "state.json"),
  JSON.stringify({
    version: 2,
    settings: { autoConnect: false },
    history: [],
    models: [],
    encrypted: {},
  }),
);
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
const fixture = join(base, "reference.wav");
await writeFile(fixture, wav);
const requests = [],
  errors = [];
let origin;
const service = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks),
      type = req.headers["content-type"] || "";
    const body = type.includes("application/json")
      ? JSON.parse(bytes.toString())
      : null;
    const form = type.includes("multipart/form-data")
      ? await new Response(bytes, {
          headers: { "Content-Type": type },
        }).formData()
      : null;
    const provider = req.url.split("/")[1];
    const captured = {
      path: req.url,
      provider,
      body,
      raw: bytes.toString(),
      headers: req.headers,
    };
    requests.push(captured);
    if (req.url === "/download.wav?signature=kept") {
      assert.equal(req.headers.authorization, undefined);
      res.end(wav);
      return;
    }
    if (provider === "openai")
      assert.equal(req.headers.authorization, undefined);
    else if (provider === "mimo") {
      assert.equal(req.headers["api-key"], "test-mimo-key");
      assert.equal(req.headers.authorization, undefined);
    } else if (provider === "volcengine")
      assert.equal(req.headers["x-api-key"], "test-volcengine-key");
    else assert.equal(req.headers.authorization, `Bearer test-${provider}-key`);
    const send = (data) => res.end(JSON.stringify(data));
    if (req.url.endsWith("/chat/completions")) {
      assert.equal(body.messages.length, 1);
      assert.equal(body.messages[0].role, "assistant");
      assert.equal(body.stream, false);
      assert.equal(body.audio.format, "wav");
      assert.equal(
        body.audio.voice,
        body.model === "mimo-v2.5-tts-voiceclone"
          ? `data:audio/wav;base64,${wav.toString("base64")}`
          : "茉莉",
      );
      send({
        choices: [
          {
            finish_reason: "stop",
            message: { audio: { data: wav.toString("base64") } },
          },
        ],
      });
    } else if (req.url.endsWith("/uploads/audio/voice")) {
      assert.equal(form.get("text"), "这是参考音频对应的原文。");
      assert.deepEqual(Buffer.from(await form.get("file").arrayBuffer()), wav);
      send({ uri: "speech:custom:mai:smoke" });
    } else if (req.url.endsWith("/files/upload")) {
      assert.equal(form.get("purpose"), "voice_clone");
      res.end(
        '{"file":{"file_id":9223372036854775806},"base_resp":{"status_code":0}}',
      );
    } else if (req.url.endsWith("/voice_clone")) {
      if (provider === "minimax") {
        assert.ok(captured.raw.includes('"file_id":9223372036854775806'));
        send({ base_resp: { status_code: 0 } });
      } else {
        assert.equal(body.custom_speaker_id, "MaiSmokeVolc01");
        assert.equal(body.audio.data, wav.toString("base64"));
        send({ status: 1 });
      }
    } else if (req.url.endsWith("/customization")) {
      if (body.input.action === "create_voice") {
        assert.equal(body.input.url, "https://reference.example.com/ref.wav");
        send({ output: { voice_id: "qwen-mai-smoke" } });
      } else
        send({
          output: { status: "OK", target_model: "qwen-audio-3.0-tts-flash" },
        });
    } else if (req.url.endsWith("/get_voice")) send({ status: 2 });
    else if (req.url.endsWith("/SpeechSynthesizer"))
      send({
        output: { audio: { url: `${origin}/download.wav?signature=kept` } },
      });
    else if (req.url.endsWith("/t2a_v2"))
      send({
        base_resp: { status_code: 0 },
        data: { audio: wav.toString("hex") },
      });
    else if (req.url.endsWith("/unidirectional"))
      res.end(
        `${JSON.stringify({ code: 0, data: wav.toString("base64") })}\n${JSON.stringify({ code: 20000000 })}\n`,
      );
    else if (req.url.endsWith("/audio/speech")) res.end(wav);
    else throw new Error(`Unexpected path ${req.url}`);
  } catch (error) {
    errors.push(String(error));
    res.writeHead(500).end();
  }
});
service.listen(0, "127.0.0.1");
await once(service, "listening");
origin = `http://127.0.0.1:${service.address().port}`;
async function until(predicate, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(message);
}
let desktop;
async function launch() {
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
  let page;
  await until(() => {
    page = desktop
      .windows()
      .find((window) => window.url().includes("view=dashboard"));
    return page;
  }, "桌面面板未启动");
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("button", { name: "声音与感知", exact: true }).click();
  return page;
}
const providers = ["siliconflow", "bailian", "minimax", "mimo", "volcengine"];
try {
  const page = await launch();
  await page.evaluate(async (origin) => {
    await window.mai.setCredential("speechKey", "legacy-asr-test-key");
    await window.mai.updateSettings({ speechBaseUrl: `${origin}/legacy-asr` });
  }, origin);
  await page.evaluate(() => {
    window.__played = [];
    window.__rates = [];
    window.__autoEnd = true;
    window.Audio = class {
      constructor(url) {
        this.url = url;
      }
      async play() {
        window.__played.push(this.url);
        window.__rates.push(this.playbackRate);
        if (window.__autoEnd) queueMicrotask(() => this.onended?.());
      }
      pause() {}
    };
  });
  const voices = {};
  await page.getByLabel("朗读方式").selectOption("api");
  for (const provider of providers) {
    await page.getByLabel("语音服务商").selectOption(provider);
    await page.getByLabel("合成服务地址").fill(`${origin}/${provider}`);
    await page.getByLabel("合成 API Key").fill(`test-${provider}-key`);
    if (provider === "mimo") {
      await page.getByLabel("朗读音色").selectOption("茉莉");
      const offset = await page.evaluate(() => window.__played.length);
      await page.getByRole("button", { name: "试听声音", exact: true }).click();
      await until(
        async () =>
          (await page.evaluate(() => window.__played.length)) > offset,
        "MiMo 预置音色未播放",
      );
      assert.equal(
        requests.findLast((req) => req.provider === "mimo").body.model,
        "mimo-v2.5-tts",
      );
    }
    await page.locator(".voice-clone-options summary").click();
    await page.getByLabel("音色名称").fill(`麦麦-${provider}`);
    if (provider === "bailian")
      await page
        .getByLabel("参考音频链接")
        .fill("https://reference.example.com/ref.wav");
    else await page.locator('input[type="file"]').setInputFiles(fixture);
    if (provider === "siliconflow")
      await page.getByLabel("参考音频原文").fill("这是参考音频对应的原文。");
    if (provider === "volcengine")
      await page.getByLabel("复刻音色 ID").fill("MaiSmokeVolc01");
    const requestsBeforeClone = requests.length;
    await page
      .getByRole("button", {
        name: provider === "mimo" ? "保存参考音色" : "提交音色复刻",
        exact: true,
      })
      .click();
    await until(
      async () =>
        (await page.evaluate(() => window.mai.snapshot())).clonedVoices.some(
          (voice) => voice.provider === provider,
        ),
      `${provider} 音色未保存`,
    );
    const created = await page.evaluate(() => window.mai.snapshot());
    if (provider === "mimo") {
      assert.equal(
        requests.length,
        requestsBeforeClone,
        "保存 MiMo 样本不应请求云端",
      );
      assert.ok(
        !JSON.stringify(created).includes(wav.toString("base64")),
        "样本内容不能广播进快照",
      );
    }
    assert.notEqual(
      created.settings.ttsProfiles[provider].voice,
      created.clonedVoices.find((voice) => voice.provider === provider).voiceId,
    );
    if (["bailian", "volcengine"].includes(provider)) {
      await page.getByRole("button", { name: "查询状态", exact: true }).click();
    }
    await page.getByRole("button", { name: "使用音色", exact: true }).click();
    await until(async () => {
      const snapshot = await page.evaluate(() => window.mai.snapshot());
      const voice = snapshot.clonedVoices.find(
        (item) => item.provider === provider,
      );
      return (
        voice.status === "ready" &&
        snapshot.settings.ttsProfiles[provider].voice === voice.voiceId
      );
    }, `${provider} 音色未启用`);
    const snapshot = await page.evaluate(() => window.mai.snapshot());
    voices[provider] = snapshot.clonedVoices.find(
      (item) => item.provider === provider,
    );
    if (provider === "mimo") {
      await page.evaluate(() => window.mai.updateSettings({ speechRate: 1.3 }));
      await page.getByLabel("语速 · 1.3×").waitFor();
    }
    const played = await page.evaluate(() => window.__played.length);
    await page.getByRole("button", { name: "试听声音", exact: true }).click();
    await until(
      async () => (await page.evaluate(() => window.__played.length)) > played,
      `${provider} 未播放合成音频`,
    );
    const synth = requests.findLast(
      (req) =>
        req.provider === provider &&
        [
          "/audio/speech",
          "/t2a_v2",
          "/SpeechSynthesizer",
          "/unidirectional",
          "/chat/completions",
        ].some((suffix) => req.path.endsWith(suffix)),
    );
    const id =
      provider === "minimax"
        ? synth.body.voice_setting.voice_id
        : provider === "bailian"
          ? synth.body.input.voice
          : provider === "volcengine"
            ? synth.body.req_params.speaker
            : synth.body.voice;
    if (provider === "mimo") {
      assert.equal(
        synth.body.audio.voice,
        `data:audio/wav;base64,${wav.toString("base64")}`,
      );
      assert.equal(synth.body.model, "mimo-v2.5-tts-voiceclone");
      assert.equal(await page.evaluate(() => window.__rates.at(-1)), 1.3);
      await page.screenshot({ path: join(base, "mimo.png"), fullPage: true });
    } else assert.equal(id, voices[provider].voiceId);
    if (provider === "volcengine")
      assert.equal(synth.headers["x-api-resource-id"], "seed-icl-2.0");
  }
  // 同一火山音色重新训练时更新原记录，不能被旧 pending 状态挡住。
  await page.getByRole("button", { name: "提交音色复刻", exact: true }).click();
  await until(
    async () =>
      (await page.evaluate(() => window.mai.snapshot())).clonedVoices.find(
        (voice) => voice.provider === "volcengine",
      ).status === "pending",
    "复刻重训状态未更新",
  );
  assert.equal(
    (await page.evaluate(() => window.mai.snapshot())).clonedVoices.length,
    providers.length,
  );
  await page.getByRole("button", { name: "查询状态", exact: true }).click();
  await page.getByRole("button", { name: "使用音色", exact: true }).click();
  await page.screenshot({
    path: join(base, "voice-clone.png"),
    fullPage: true,
  });
  await page.getByLabel("语音服务商").selectOption("minimax");
  const longText = "第一段。" + "长回复🙂".repeat(700) + "最后一个字。";
  await page
    .getByLabel("试听文字")
    .evaluate((element) => (element.maxLength = 12000));
  await page.getByLabel("试听文字").fill(longText);
  let before = requests.length;
  await page.getByRole("button", { name: "试听声音", exact: true }).click();
  await until(
    () =>
      requests
        .slice(before)
        .filter((req) => req.path.endsWith("/t2a_v2"))
        .map((req) => req.body.text)
        .join("") === longText,
    "长回复分段丢失文字",
  );
  const segments = requests
    .slice(before)
    .filter((req) => req.path.endsWith("/t2a_v2"));
  assert.ok(segments.length > 1);
  await page.getByRole("button", { name: "停止试听", exact: true }).click();
  await page.evaluate(() => {
    window.__autoEnd = false;
  });
  before = requests.length;
  await page.getByRole("button", { name: "试听声音", exact: true }).click();
  await until(
    () => requests.slice(before).some((req) => req.path.endsWith("/t2a_v2")),
    "停止测试未开始合成",
  );
  await page.getByRole("button", { name: "停止试听", exact: true }).click();
  await new Promise((done) => setTimeout(done, 150));
  assert.equal(
    requests.slice(before).filter((req) => req.path.endsWith("/t2a_v2")).length,
    1,
  );
  // 旧 ASR Key 不应随兼容合成地址的更换而被发送。
  await page.evaluate(async (origin) => {
    const { settings } = await window.mai.snapshot();
    await window.mai.updateSettings({
      ttsProvider: "openai",
      ttsProfiles: {
        ...settings.ttsProfiles,
        openai: {
          baseUrl: `${origin}/openai`,
          model: "tts-1",
          voice: "alloy",
          resourceId: "",
        },
      },
    });
    await window.mai.synthesize("独立合成地址。");
  }, origin);
  await desktop.close();
  desktop = undefined;

  const persisted = JSON.parse(
    await readFile(join(profile, "state.json"), "utf8"),
  );
  assert.equal(persisted.clonedVoices.length, providers.length);
  for (const provider of providers) {
    const key = `tts${{ siliconflow: "Siliconflow", bailian: "Bailian", minimax: "Minimax", volcengine: "Volcengine", mimo: "Mimo" }[provider]}Key`;
    assert.ok(persisted.encrypted[key]);
    assert.notEqual(persisted.encrypted[key], `test-${provider}-key`);
  }
  assert.deepEqual(
    await readFile(join(profile, "voice-references", `${voices.mimo.id}.wav`)),
    wav,
  );
  assert.ok(!JSON.stringify(persisted).includes(wav.toString("base64")));
  const reloaded = await launch();
  const restored = await reloaded.evaluate(() => window.mai.snapshot());
  assert.equal(restored.clonedVoices.length, providers.length);
  for (const provider of providers) {
    await reloaded.evaluate(
      (provider) => window.mai.updateSettings({ ttsProvider: provider }),
      provider,
    );
    const data = await reloaded.evaluate(() =>
      window.mai.synthesize("重启后音色试听。"),
    );
    assert.ok(data.startsWith("data:audio/wav;base64,"));
  }
  assert.deepEqual(errors, []);
  await writeFile(
    join(base, "result.json"),
    JSON.stringify(
      {
        providers,
        clonedVoices: providers.length,
        longTextSegments: segments.length,
        restart: true,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "五家在线合成、音色复刻、MiMo 预置 / 参考音色与本机语速、长文分段、停止及持久化重启验证通过",
  );
} finally {
  if (desktop) await desktop.close().catch(() => {});
  await new Promise((done) => {
    service.close(done);
    service.closeAllConnections();
  });
}
