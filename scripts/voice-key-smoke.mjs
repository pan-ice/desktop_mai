import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { _electron as electron } from "playwright";
import { launchEnvironment } from "./process-tools.mjs";

const providers = [
  {
    id: "mimo",
    label: "MiMo API Key",
    key: "ttsMimoKey",
    model: "mimo-v2.5-tts",
    header: "api-key",
  },
  {
    id: "siliconflow",
    label: "硅基流动 API Key",
    key: "ttsSiliconflowKey",
    model: "FunAudioLLM/CosyVoice2-0.5B",
  },
  {
    id: "minimax",
    label: "MiniMax API Key",
    key: "ttsMinimaxKey",
    model: "speech-2.8-hd",
  },
  {
    id: "volcengine",
    label: "火山引擎 API Key",
    key: "ttsVolcengineKey",
    model: "seed-tts-2.0-standard",
    header: "x-api-key",
  },
  {
    id: "bailian",
    label: "阿里云百炼 API Key",
    key: "ttsBailianKey",
    model: "qwen-audio-3.0-tts-flash",
  },
  { id: "openai", label: "合成 API Key", key: "ttsOpenaiKey", model: "tts-1" },
];
const savedKeys = new Map();
const checks = [];
let requestCount = 0;
const base = resolve(".cache/voice-key-smoke");
await mkdir(base, { recursive: true });
const profile = await mkdtemp(join(base, "run-"));
const entry = join(profile, "bootstrap.mjs");
const errors = [];
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
let lastKey, origin;
const service = createServer(async (request, response) => {
  for await (const chunk of request) void chunk;
  const provider = request.url.split("/")[1];
  if (provider === "result.wav") {
    response.end(wav);
    return;
  }
  requestCount++;
  lastKey =
    request.headers[
      providers.find(({ id }) => id === provider)?.header || "authorization"
    ];
  const json = (value) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(value));
  };
  if (provider === "transcription") json({ text: "转写验证" });
  else if (provider === "mimo")
    json({
      choices: [
        {
          finish_reason: "stop",
          message: { audio: { data: wav.toString("base64") } },
        },
      ],
    });
  else if (provider === "minimax")
    json({
      base_resp: { status_code: 0 },
      data: { audio: wav.toString("hex") },
    });
  else if (provider === "bailian")
    json({ output: { audio: { url: `${origin}/result.wav` } } });
  else if (provider === "volcengine")
    response.end(
      `${JSON.stringify({ code: 0, data: wav.toString("base64") })}\n${JSON.stringify({ code: 20000000 })}\n`,
    );
  else response.end(wav);
});
service.listen(0, "127.0.0.1");
await once(service, "listening");
origin = `http://127.0.0.1:${service.address().port}`;
await writeFile(
  join(profile, "state.json"),
  JSON.stringify({
    version: 2,
    settings: {
      autoConnect: false,
      adapterPort: 0,
      launchAtLogin: false,
      voiceEnabled: false,
      ttsEngine: "api",
      ttsProvider: "volcengine",
      speechBaseUrl: `${origin}/transcription`,
      ttsProfiles: Object.fromEntries(
        providers.map(({ id, model }) => [
          id,
          {
            baseUrl: `${origin}/${id}`,
            model,
            voice: "fixture-voice",
            resourceId: id === "volcengine" ? "seed-tts-2.0" : "",
          },
        ]),
      ),
    },
    encrypted: {},
    history: [],
    models: [],
  }),
);
await writeFile(
  entry,
  `import { app, BrowserWindow, globalShortcut } from "electron";
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.showInactive = function () {};
app.setLoginItemSettings = () => {};
globalShortcut.register = () => true;
globalShortcut.unregisterAll = () => {};
await import(${JSON.stringify(pathToFileURL(resolve("out/main/index.js")).href)});
`,
);
let desktop;
async function launch() {
  desktop = await electron.launch({
    executablePath: resolve("node_modules/electron/dist/electron.exe"),
    args: [
      entry,
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-features=CalculateNativeWinOcclusion",
    ],
    cwd: resolve("."),
    env: { ...launchEnvironment("production"), MAI_USER_DATA: profile },
  });
  await desktop.firstWindow();
  const deadline = Date.now() + 10000;
  let page;
  while (
    !(page = desktop.windows().find((p) => p.url().includes("view=dashboard")))
  ) {
    assert.ok(Date.now() < deadline, "主面板未打开");
    await new Promise((done) => setTimeout(done, 30));
  }
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.getByRole("button", { name: "声音与感知", exact: true }).click();
  await page.getByLabel("音色服务", { exact: true }).selectOption("volcengine");
  return page;
}
async function synthesize(page, expectedKey, provider = "volcengine") {
  await page.evaluate(
    (ttsProvider) =>
      window.mai.updateSettings({ ttsEngine: "api", ttsProvider }),
    provider,
  );
  await page.evaluate(() => window.mai.synthesize("密钥保存验证"));
  const expected = providers.find(({ id }) => id === provider).header
    ? expectedKey
    : `Bearer ${expectedKey}`;
  assert.equal(
    lastKey === expected,
    true,
    `${provider} 请求没有使用当前保存的 API Key`,
  );
}
async function checkCredentials(page) {
  const state = await page.evaluate(() => window.mai.snapshot());
  for (const { key } of providers)
    assert.equal(
      state.credentials[key],
      savedKeys.has(key),
      `${key} 状态混入其他服务商`,
    );
  assert.equal(state.credentials.speechKey, savedKeys.has("speechKey"));
  assert.equal(state.settings.voiceEnabled, false, "保存 Key 不应开启自动朗读");
  const stored = await readFile(join(profile, "state.json"), "utf8");
  for (const value of savedKeys.values())
    assert.equal(stored.includes(value), false, "不能明文保存密钥");
}
async function waitForEmpty(input) {
  const deadline = Date.now() + 10000;
  while ((await input.inputValue()) !== "" || (await input.isDisabled())) {
    assert.ok(Date.now() < deadline, "密钥保存未完成");
    await new Promise((done) => setTimeout(done, 30));
  }
}
async function transcribe(page) {
  const text = await page.evaluate(
    (bytes) =>
      window.mai.transcribe(Uint8Array.from(bytes).buffer, "audio/wav"),
    [...wav],
  );
  assert.equal(text, "转写验证");
  assert.equal(
    lastKey === `Bearer ${savedKeys.get("speechKey")}`,
    true,
    "转写没有使用独立保存的 Key",
  );
}
try {
  let page = await launch();
  let input = page.getByLabel("火山引擎 API Key", { exact: true });
  await input.fill("fixture-initial-key");
  await page.getByRole("button", { name: "保存 Key", exact: true }).click();
  await page
    .getByText("API Key 已保存，请填写已在火山准备好的音色 ID", { exact: true })
    .waitFor();
  assert.equal(
    await input.isVisible(),
    true,
    "保存火山 API Key 后输入框消失，无法直接更换密钥",
  );
  assert.equal(await input.inputValue(), "", "保存后不应回显密钥");
  await synthesize(page, "fixture-initial-key");

  await input.fill("fixture-replacement-key");
  await page.getByRole("button", { name: "更新 Key", exact: true }).click();
  await page.getByText("火山引擎 API Key 已更新", { exact: true }).waitFor();
  await synthesize(page, "fixture-replacement-key");
  const snapshot = await page.evaluate(() => window.mai.snapshot());
  assert.equal(
    snapshot.settings.voiceEnabled,
    false,
    "更换 Key 不应开启自动朗读",
  );
  assert.equal(
    snapshot.credentials.ttsMimoKey,
    false,
    "不能修改其他服务商密钥",
  );
  assert.equal(snapshot.credentials.speechKey, false, "不能修改转写密钥");
  const stored = await readFile(join(profile, "state.json"), "utf8");
  assert.equal(
    stored.includes("fixture-replacement-key"),
    false,
    "不能明文保存密钥",
  );
  savedKeys.set("ttsVolcengineKey", "fixture-replacement-key");
  checks.push("volcengine: 首次保存、替换与独立鉴权");
  await page.getByLabel("音色服务", { exact: true }).selectOption("mimo");
  await page
    .getByLabel("MiMo API Key", { exact: true })
    .fill("fixture-unsaved-mimo");
  await page.getByLabel("音色服务", { exact: true }).selectOption("minimax");
  assert.equal(
    await page.getByLabel("MiniMax API Key", { exact: true }).inputValue(),
    "",
    "不能混入另一服务商未保存的 Key",
  );
  await page.getByLabel("音色服务", { exact: true }).selectOption("mimo");
  assert.equal(
    await page.getByLabel("MiMo API Key", { exact: true }).inputValue(),
    "fixture-unsaved-mimo",
  );
  await page.getByLabel("MiMo API Key", { exact: true }).fill("");
  for (const spec of providers.filter(
    ({ id }) => !["volcengine", "openai"].includes(id),
  )) {
    await page.getByLabel("音色服务", { exact: true }).selectOption(spec.id);
    input = page.getByLabel(spec.label, { exact: true });
    assert.equal(await input.isVisible(), true);
    await input.fill("   ");
    assert.equal(
      await page
        .getByRole("button", { name: "保存 Key", exact: true })
        .isDisabled(),
      true,
    );
    for (const phase of ["initial", "replacement"]) {
      const value = `fixture-${phase}-${spec.id}`;
      await input.fill(`  ${value}  `);
      const before = requestCount;
      await page
        .getByRole("button", {
          name: phase === "initial" ? "保存 Key" : "更新 Key",
          exact: true,
        })
        .click();
      await waitForEmpty(input);
      savedKeys.set(spec.key, value);
      assert.equal(await input.isVisible(), true, `${spec.id} 保存后入口消失`);
      assert.equal(requestCount, before, "仅保存 Key 不应请求模型");
      await checkCredentials(page);
      await synthesize(page, value, spec.id);
    }
    checks.push(`${spec.id}: 首次保存、替换与独立鉴权`);
  }
  await page.locator(".tts-advanced > summary").click();
  for (const spec of providers) {
    await page.getByLabel("语音服务商").selectOption(spec.id);
    input = page.getByLabel("合成 API Key");
    const value = `fixture-advanced-${spec.id}`;
    await input.fill(`  ${value}  `);
    const before = requestCount;
    await page
      .getByRole("button", { name: "保存声音设置", exact: true })
      .click();
    await waitForEmpty(input);
    savedKeys.set(spec.key, value);
    assert.equal(requestCount, before);
    await checkCredentials(page);
    await synthesize(page, value, spec.id);
    await input.fill("   ");
    await page
      .getByRole("button", { name: "保存声音设置", exact: true })
      .click();
    await waitForEmpty(input);
    await synthesize(page, value, spec.id);
    checks.push(`${spec.id}: 高级入口保存、空格处理与鉴权`);
  }
  input = page.getByLabel("转写 API Key");
  for (const phase of ["initial", "replacement"]) {
    const value = `fixture-${phase}-transcription`;
    await input.fill(`  ${value}  `);
    const before = requestCount;
    await page
      .getByRole("button", { name: "保存转写设置", exact: true })
      .click();
    await waitForEmpty(input);
    savedKeys.set("speechKey", value);
    assert.equal(requestCount, before);
    await checkCredentials(page);
    await transcribe(page);
  }
  checks.push("transcription: 独立保存、替换与鉴权");
  await input.fill("   ");
  await page.getByRole("button", { name: "保存转写设置", exact: true }).click();
  await waitForEmpty(input);
  await transcribe(page);
  await desktop.close();
  desktop = undefined;

  page = await launch();
  input = page.getByLabel("火山引擎 API Key", { exact: true });
  assert.equal(await input.isVisible(), true, "重新打开应用后仍应提供密钥入口");
  assert.equal(await input.inputValue(), "");
  await checkCredentials(page);
  for (const spec of providers) {
    await synthesize(page, savedKeys.get(spec.key), spec.id);
    if (spec.id !== "openai") {
      input = page.getByLabel(spec.label, { exact: true });
      assert.equal(await input.isVisible(), true);
      assert.equal(await input.inputValue(), "");
    }
  }
  await transcribe(page);
  checks.push("所有服务重启保留、不回显已保存密钥");
  for (const [width, height] of [
    [1280, 860],
    [960, 680],
  ]) {
    await desktop.evaluate(
      ({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows()
          .find((window) =>
            window.webContents.getURL().includes("view=dashboard"),
          )
          .setContentSize(...size);
      },
      [width, height],
    );
    await page.waitForFunction(
      ([width, height]) => innerWidth === width && innerHeight === height,
      [width, height],
    );
    for (const spec of providers.filter(({ id }) => id !== "openai")) {
      await page.getByLabel("音色服务", { exact: true }).selectOption(spec.id);
      input = page.getByLabel(spec.label, { exact: true });
      await page
        .locator(".voice-import-section")
        .evaluate((section) =>
          section.scrollIntoView({ block: "start", behavior: "instant" }),
        );
      const keyBox = await input.boundingBox();
      const importBox = await page
        .locator(
          spec.id === "volcengine" ? ".voice-existing-setup" : ".voice-import",
        )
        .boundingBox();
      assert.ok(
        keyBox && importBox && keyBox.y < importBox.y,
        "密钥入口应位于音频导入区上方",
      );
      assert.ok(
        keyBox.y >= 0 && keyBox.y + keyBox.height <= height,
        "滚动到音色设置后，密钥输入框应与服务商选择同屏显示",
      );
      const screenshot = await desktop.evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find((candidate) =>
          candidate.webContents.getURL().includes("view=dashboard"),
        );
        window.webContents.invalidate();
        const capture = await window.webContents.capturePage(undefined, {
          stayHidden: true,
          stayAwake: true,
        });
        if (window.isVisible() || capture.isEmpty())
          throw new Error("无法获取隐藏测试窗口的截图");
        return capture.toPNG().toString("base64");
      });
      await writeFile(
        join(base, `${spec.id}-${width}.png`),
        Buffer.from(screenshot, "base64"),
      );
    }
  }
  assert.deepEqual(errors, []);
  checks.push("五家克隆服务在两种窗口尺寸下入口均可见");
  await writeFile(
    join(base, "result.json"),
    JSON.stringify({ passed: true, checks, requestCount, errors }, null, 2),
  );
  console.log(
    `PASS 五家克隆服务、兼容语音接口与录音转写：${checks.length} 组密钥检查，${requestCount} 次本机鉴权验证`,
  );
} catch (error) {
  await writeFile(
    join(base, "result.json"),
    JSON.stringify(
      { passed: false, checks, failure: error.message, errors },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await desktop?.close().catch(() => {});
  service.closeAllConnections();
  await new Promise((done) => service.close(done));
  assert.ok(resolve(profile).startsWith(`${base}${sep}`));
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
}
