import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";

const base = resolve(".cache/voice-import-smoke");
await mkdir(base, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "mai-voice-import-"));
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
const secondWav = Buffer.from(wav);
secondWav.writeInt16LE(100, 44);
const requests = [],
  errors = [];
const service = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  requests.push({
    path: request.url,
    key: request.headers["api-key"],
    body: JSON.parse(Buffer.concat(chunks).toString()),
  });
  response.setHeader("Content-Type", "application/json");
  response.end(
    JSON.stringify({
      choices: [
        {
          finish_reason: "stop",
          message: { audio: { data: wav.toString("base64") } },
        },
      ],
    }),
  );
});
service.listen(0, "127.0.0.1");
await once(service, "listening");
const origin = `http://127.0.0.1:${service.address().port}`;
const minimax = {
  baseUrl: `${origin}/minimax`,
  model: "speech-2.8-hd",
  voice: "saved-voice",
  resourceId: "",
};
await writeFile(
  join(profile, "state.json"),
  JSON.stringify({
    version: 2,
    settings: {
      autoConnect: false,
      speechBaseUrl: `${origin}/asr`,
      ttsProfiles: {
        mimo: {
          baseUrl: `${origin}/mimo`,
          model: "mimo-v2.5-tts",
          voice: "mimo_default",
          resourceId: "",
        },
        minimax,
      },
    },
    history: [],
    models: [],
    encrypted: {},
  }),
);

let desktop;
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
  const first = await desktop.firstWindow();
  const page =
    desktop.windows().find((page) => page.url().includes("view=dashboard")) ||
    first;
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
async function state(page) {
  return page.evaluate(() => window.mai.snapshot());
}
async function until(predicate, message) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(message);
}
try {
  const page = await launch();
  await page
    .getByRole("button", { name: "导入音色音频", exact: true })
    .waitFor({ timeout: 4000 });
  assert.equal((await state(page)).settings.ttsEngine, "system");
  assert.equal(await page.locator(".tts-advanced").getAttribute("open"), null);
  const upload = page.getByLabel("选择音色音频", { exact: true });
  await upload.setInputFiles({
    name: "天依的声音.wav",
    mimeType: "audio/wav",
    buffer: wav,
  });
  await until(
    async () => (await state(page)).clonedVoices.length === 1,
    "仅导入文件未能保存音色",
  );
  let saved = await state(page);
  const firstVoice = saved.clonedVoices[0];
  assert.equal(firstVoice.name, "天依的声音");
  assert.equal(saved.settings.ttsProvider, "mimo");
  assert.equal(saved.settings.ttsEngine, "api");
  assert.equal(saved.settings.ttsProfiles.mimo.voice, firstVoice.voiceId);
  assert.equal(
    saved.settings.voiceEnabled,
    false,
    "缺少 Key 时应提示连接，避免自动朗读反复失败",
  );
  assert.deepEqual(saved.settings.ttsProfiles.minimax, minimax);
  assert.equal(saved.settings.speechBaseUrl, `${origin}/asr`);
  assert.equal(requests.length, 0, "导入时不能调用云端或合成");
  const referenceCheck = page.locator(".voice-reference-advice");
  await referenceCheck.waitFor();
  assert.ok(
    (await referenceCheck.innerText()).includes("录音偏短"),
    "本机应识别过短的参考录音",
  );
  assert.ok(
    (await referenceCheck.innerText()).includes("静音"),
    "静音样本应出现质量提示",
  );
  await page.locator(".voice-service-setup").waitFor();

  // 文件损坏不能切换或清空已选音色。
  await upload.setInputFiles({
    name: "损坏.wav",
    mimeType: "audio/wav",
    buffer: Buffer.from("broken"),
  });
  await page.locator(".voice-import-error").waitFor();
  saved = await state(page);
  assert.equal(saved.clonedVoices.length, 1);
  assert.equal(saved.settings.ttsProfiles.mimo.voice, firstVoice.voiceId);

  await page
    .getByLabel("MiMo API Key", { exact: true })
    .fill("test-import-key");
  await page
    .getByRole("button", { name: "保存并启用音色", exact: true })
    .click();
  await until(
    async () => (await state(page)).settings.voiceEnabled,
    "首次保存 Key 后未启用音色",
  );
  await page.getByRole("button", { name: "试听声音", exact: true }).click();
  await until(
    async () => (await page.evaluate(() => window.__played)) > 0,
    "导入音色未能实际合成播放",
  );
  assert.equal(requests.at(-1).path, "/mimo/chat/completions");
  assert.equal(requests.at(-1).key, "test-import-key");
  assert.equal(requests.at(-1).body.model, "mimo-v2.5-tts-voiceclone");
  assert.deepEqual(requests.at(-1).body.messages, [
    {
      role: "assistant",
      content: await page.getByLabel("试听文字").inputValue(),
    },
  ]);
  assert.equal(
    requests.at(-1).body.audio.voice,
    `data:audio/wav;base64,${wav.toString("base64")}`,
  );

  const transfer = await page.evaluateHandle((bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([Uint8Array.from(bytes)], "第二个声音.wav", {
        type: "audio/wav",
      }),
    );
    return transfer;
  }, Array.from(secondWav));
  await page
    .locator(".voice-import")
    .dispatchEvent("drop", { dataTransfer: transfer });
  await transfer.dispose();
  await until(
    async () => (await state(page)).clonedVoices.length === 2,
    "再次导入未自动切换音色",
  );
  saved = await state(page);
  const secondVoice = saved.clonedVoices[1];
  assert.equal(saved.settings.ttsProfiles.mimo.voice, secondVoice.voiceId);
  assert.equal(saved.settings.voiceEnabled, true);
  await page.getByRole("button", { name: "试听声音", exact: true }).click();
  await until(() => requests.length === 2, "第二个音色未合成");
  assert.equal(
    requests.at(-1).body.audio.voice,
    `data:audio/wav;base64,${secondWav.toString("base64")}`,
  );
  await page
    .getByLabel("已导入的音色", { exact: true })
    .selectOption(firstVoice.id);
  await until(
    async () =>
      (await state(page)).settings.ttsProfiles.mimo.voice ===
      firstVoice.voiceId,
    "切换已导入音色失败",
  );
  await page
    .locator(".voice-import-section")
    .screenshot({ path: join(base, "imported.png") });
  await desktop.close();
  desktop = undefined;
  const persisted = JSON.parse(
    await readFile(join(profile, "state.json"), "utf8"),
  );
  assert.ok(persisted.encrypted.ttsMimoKey);
  assert.ok(!JSON.stringify(persisted).includes("test-import-key"));
  assert.ok(!JSON.stringify(persisted).includes(wav.toString("base64")));

  const restoredPage = await launch();
  const restored = await state(restoredPage);
  assert.equal(restored.clonedVoices.length, 2);
  assert.equal(restored.settings.ttsProfiles.mimo.voice, firstVoice.voiceId);
  assert.equal(restored.settings.ttsNativeOutput, true);
  assert.equal(restored.settings.ttsNaturalSpeech, false);
  assert.equal(restored.settings.ttsPreloadNext, true);
  assert.equal(restored.settings.ttsCloneFidelity, false);
  assert.equal(
    await restoredPage.getByLabel("已导入的音色", { exact: true }).inputValue(),
    firstVoice.id,
  );
  await restoredPage
    .getByRole("button", { name: "试听声音", exact: true })
    .click();
  await until(() => requests.length === 3, "重启后已导入音色不能合成");
  assert.deepEqual(errors, []);
  console.log(
    "导入自动命名与选用、首次 Key 设置、损坏文件保留原音色、真实合成播放、音色切换及重启恢复验证通过",
  );
} finally {
  await desktop?.close().catch(() => {});
  await new Promise((done) => {
    service.close(done);
    service.closeAllConnections();
  });
  await rm(profile, { recursive: true, force: true });
}
