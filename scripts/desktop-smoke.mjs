import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { createGlb } from "./model-fixture.mjs";

const base = resolve(".cache/desktop-smoke");
await mkdir(base, { recursive: true });
const userData = await mkdtemp(join(base, "userdata-"));
await writeFile(join(base, "fixture.glb"), createGlb());
await writeFile(join(base, "broken.glb"), "invalid-glb");
await writeFile(
  join(base, "fixture.png"),
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ text: "语音转写测试成功" }));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
const portProbe = createServer();
portProbe.listen(0, "127.0.0.1");
await once(portProbe, "listening");
const adapterPort = portProbe.address().port;
await new Promise((resolveClose) => portProbe.close(resolveClose));
await writeFile(
  join(userData, "state.json"),
  JSON.stringify({
    version: 2,
    settings: { adapterPort, autoConnect: false },
    history: [],
    models: [],
    encrypted: {},
  }),
);
let adapter;
const adapterEvents = [];
const configPath = join(base, "config.toml");
let desktop;
const errors = [];
async function waitState(page, predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => window.mai.snapshot());
    if (predicate(state)) return state;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("桌宠状态未在预期时间内完成");
}
try {
  const env = { ...process.env, MAI_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({
    executablePath:
      process.env.MAI_TEST_EXE ||
      resolve("node_modules/electron/dist/electron.exe"),
    args: [
      ...(process.env.MAI_TEST_EXE ? [] : ["."]),
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
    cwd: resolve("."),
    env,
    timeout: 30000,
  });
  await desktop.firstWindow();
  const electronVersion = await desktop.evaluate(
    () => process.versions.electron,
  );
  assert.equal(electronVersion, "41.10.6");
  let page;
  for (let attempt = 0; attempt < 100; attempt++) {
    page = desktop
      .windows()
      .find((window) => window.url().includes("view=dashboard"));
    if (page) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.ok(page, "控制面板窗口存在");
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page
      .getByRole("heading", { name: /早上好|中午好|下午好|晚上好|夜深了/ })
      .waitFor();
  } catch (error) {
    console.error(
      "窗口 URL:",
      desktop.windows().map((window) => window.url()),
    );
    console.error(
      "页面内容:",
      (await page.locator("body").innerText()).slice(0, 1000),
    );
    console.error("渲染错误:", errors);
    throw error;
  }
  await page.screenshot({ path: join(base, "home.png"), fullPage: true });
  assert.equal(
    await page
      .locator("body")
      .evaluate((element) => element.scrollWidth > window.innerWidth),
    false,
  );
  const windows = await desktop.windows();
  const pet = windows.find((window) => window.url().includes("view=pet"));
  assert.ok(pet, "桌宠窗口存在");
  await pet.locator(".pet-character").waitFor();
  pet.on("pageerror", (error) => errors.push(error.message));
  assert.equal(
    await pet
      .locator("html")
      .evaluate((element) => getComputedStyle(element).backgroundColor),
    "rgba(0, 0, 0, 0)",
  );
  await pet.screenshot({ path: join(base, "pet.png"), omitBackground: true });
  await page.getByRole("button", { name: "连接与账号", exact: true }).click();
  await page.locator(".legacy-connection > summary").click();
  await page.locator(".legacy-local > summary").click();
  await page
    .getByRole("spinbutton", { name: "本机接入端口" })
    .fill(String(adapterPort));
  await page
    .getByRole("button", { name: "保存并开启接入", exact: true })
    .click();
  await waitState(page, (state) => state.connection.phase === "connecting");
  await desktop.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, configPath);
  assert.equal(
    await page.evaluate(() => window.mai.exportAdapterConfig()),
    true,
  );
  const pluginRoot = resolve("MaiBot/plugins/desktop_pet_adapter");
  adapter = spawn(
    process.env.MAI_PYTHON ||
      join(
        pluginRoot,
        ".venv",
        process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
      ),
    [join(pluginRoot, "tests/host_fixture.py"), configPath],
    {
      windowsHide: true,
      stdio: "pipe",
      env: { ...process.env, PYTHONUTF8: "1" },
    },
  );
  const lines = createInterface({ input: adapter.stdout });
  lines.on("line", (line) => adapterEvents.push(JSON.parse(line)));
  adapter.once("exit", () => lines.close());
  adapter.stderr.on("data", (chunk) => process.stderr.write(chunk));
  await page.locator(".page-heading .status.online").waitFor();
  await page.screenshot({ path: join(base, "core.png"), fullPage: true });
  await page.getByRole("button", { name: "和麦麦聊聊", exact: true }).click();
  await page
    .getByRole("textbox", { name: "消息内容" })
    .fill("桌面测试：你好麦麦");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.getByText("你好呀！今天也想陪着你。", { exact: true }).waitFor();
  assert.equal(
    adapterEvents.find((event) => event.event === "inbound").payload.message
      .account_id,
    "mai_desktop_pet",
  );
  await page.screenshot({ path: join(base, "chat.png"), fullPage: true });
  await page.getByRole("button", { name: "偏好设置", exact: true }).click();
  await page.getByRole("switch", { name: "始终置顶", exact: true }).click();
  const alwaysOnTop = await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().includes("view=pet"))
      .isAlwaysOnTop(),
  );
  assert.equal(alwaysOnTop, false);
  await page.getByRole("button", { name: "角色衣橱", exact: true }).click();
  await desktop.evaluate(
    ({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    },
    join(base, "fixture.png"),
  );
  await page.getByRole("button", { name: "导入角色", exact: true }).click();
  await page.getByRole("heading", { name: "fixture", exact: true }).waitFor();
  await page.screenshot({ path: join(base, "models.png"), fullPage: true });
  await desktop.evaluate(
    ({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    },
    join(base, "fixture.glb"),
  );
  await page.getByRole("button", { name: "导入角色", exact: true }).click();
  await page
    .getByRole("heading", { name: "fixture", exact: true })
    .nth(1)
    .waitFor();
  await page.getByRole("button", { name: "此刻", exact: true }).click();
  await page.locator(".stage-avatar canvas").waitFor({ timeout: 20000 });
  await pet.locator(".model-canvas canvas").waitFor({ timeout: 20000 });
  // 保留同一个 Avatar 挂载实例，验证失败角色直接切换有效角色可恢复。
  const validModel = (await page.evaluate(() => window.mai.snapshot())).settings
    .activeModelId;
  await desktop.evaluate(
    ({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    },
    join(base, "broken.glb"),
  );
  await page.evaluate(() => window.mai.importModel());
  await page.locator(".stage-avatar .avatar-error").waitFor();
  await pet.locator(".avatar-error").waitFor();
  await page.evaluate(
    (id) => window.mai.updateSettings({ activeModelId: id }),
    validModel,
  );
  await page.locator(".stage-avatar canvas").waitFor({ timeout: 10000 });
  await pet.locator(".model-canvas canvas").waitFor({ timeout: 10000 });
  const brokenModel = (
    await page.evaluate(() => window.mai.snapshot())
  ).models.find((model) => model.name === "broken");
  await page.evaluate((id) => window.mai.removeModel(id), brokenModel.id);
  await page.screenshot({ path: join(base, "glb.png"), fullPage: true });
  await page.getByRole("button", { name: "声音与感知", exact: true }).click();
  await page
    .getByRole("textbox", { name: "API Base URL" })
    .fill(`http://127.0.0.1:${address.port}/v1`);
  await page.getByRole("button", { name: "保存声音设置", exact: true }).click();
  const transcript = await page.evaluate(async () =>
    window.mai.transcribe(new Uint8Array(2500).buffer, "audio/webm"),
  );
  assert.equal(transcript, "语音转写测试成功");
  await page.evaluate(async () => {
    await window.mai.setCredential("speechKey", "local-test-key");
  });
  await page.getByRole("switch", { name: "屏幕感知", exact: true }).click();
  const capture = await page.evaluate(async () => {
    const sources = await window.mai.screenSources();
    return sources.length ? window.mai.captureScreen(sources[0].id) : "";
  });
  assert.ok(capture.startsWith("data:image/jpeg;base64,"));
  await page.evaluate(
    async (image) =>
      window.mai.send({ text: "截图消息测试", image, source: "screen" }),
    capture,
  );
  await waitState(page, (state) => state.history.length === 4);
  await page.getByRole("button", { name: "打开摄像头", exact: true }).click();
  await page.locator(".camera-preview video").waitFor();
  await page.waitForFunction(
    () => document.querySelector(".camera-preview video")?.videoWidth > 0,
  );
  await page.getByRole("button", { name: "拍照并预览", exact: true }).click();
  await page.getByAltText("待发送的摄像头照片").waitFor();
  await page.getByRole("button", { name: "关闭摄像头", exact: true }).click();
  await pet.evaluate(() => {
    window.__testVolume = 0;
    const getMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (options) => {
      const stream = await getMedia(options);
      window.__microphoneReady = true;
      window.__testTracks = stream.getTracks();
      return stream;
    };
    AnalyserNode.prototype.getFloatTimeDomainData = function (array) {
      array.fill(window.__testVolume);
    };
  });
  await page.evaluate(() => window.mai.updateSettings({ speechVolume: 0 }));
  await page.getByRole("switch", { name: "连续语音对话", exact: true }).click();
  await waitState(pet, (state) => state.conversationActive);
  await pet.waitForFunction(() => window.__microphoneReady);
  await pet.evaluate(() => {
    window.__testVolume = 0.07;
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 800));
  await pet.evaluate(() => {
    window.__testVolume = 0;
  });
  await waitState(page, (state) =>
    state.history.some((message) => message.source === "voice"),
  );
  await page.evaluate(() => window.mai.voiceConversation(false));
  await pet.waitForFunction(() =>
    window.__testTracks.every((track) => track.readyState === "ended"),
  );
  await pet.evaluate(() => {
    window.__spokenTexts = [];
    speechSynthesis.cancel = () => {};
    speechSynthesis.speak = (utterance) => {
      window.__spokenTexts.push(utterance.text);
      utterance.onstart?.({});
      setTimeout(() => utterance.onend?.({}), 150);
    };
  });
  await page.evaluate(async () => {
    await window.mai.updateSettings({
      voiceEnabled: true,
      ttsEngine: "system",
    });
    await window.mai.send({ text: "分段朗读测试" });
  });
  await pet.waitForFunction(() => window.__spokenTexts.includes("第二段回复"));
  assert.deepEqual(await pet.evaluate(() => window.__spokenTexts.slice(-2)), [
    "第一段回复",
    "第二段回复",
  ]);
  await page.screenshot({ path: join(base, "senses.png"), fullPage: true });
  const asset = await page.evaluate(async () => {
    const state = await window.mai.snapshot();
    return fetch(state.models[0].assetUrl).then((response) => response.status);
  });
  assert.equal(asset, 200);
  const rendererState = await page.evaluate(async () => window.mai.snapshot());
  assert.equal(rendererState.credentials.speechKey, true);
  assert.ok(rendererState.history.length >= 5);
  assert.ok(
    rendererState.history
      .find((message) => message.source === "screen")
      .attachments[0].dataUrl.startsWith("mai-media:"),
  );
  const persisted = await readFile(join(userData, "state.json"), "utf8");
  assert.ok(!persisted.includes("local-test-key"));
  const exported = await readFile(configPath, "utf8");
  const exportedToken = JSON.parse(exported.match(/^token = (.+)$/m)[1]);
  assert.ok(!persisted.includes(exportedToken));
  assert.equal(rendererState.credentials.adapterToken, true);
  assert.deepEqual(errors, []);
  console.log(
    "PASS Electron：透明双窗口、聊天、置顶、图片与 GLB 导入、3D 渲染、截图、摄像头、连续语音、设备释放、加密保存",
  );
  console.log(`界面截图：${base}`);
} finally {
  if (adapter && adapter.exitCode === null) {
    const exited = once(adapter, "exit");
    adapter.stdin.end("STOP\n");
    const timer = setTimeout(() => adapter.kill(), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
  await desktop?.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
