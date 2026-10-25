import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { _electron as electron } from "playwright";

const output = resolve(".cache/model-guidance-smoke");
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "mai-model-guidance-"));
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

let desktop;
const errors = [];
try {
  const env = { ...process.env, MAI_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  desktop = await electron.launch({
    executablePath: resolve("node_modules/electron/dist/electron.exe"),
    args: ["."],
    cwd: resolve("."),
    env,
  });
  await desktop.evaluate(({ shell, session }) => {
    globalThis.__guideOpened = [];
    globalThis.__guideRequests = [];
    shell.openExternal = async (url) => {
      globalThis.__guideOpened.push(url);
    };
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*"] },
      (request, done) => {
        globalThis.__guideRequests.push(request.url);
        done({ cancel: true });
      },
    );
  });
  await desktop.firstWindow();
  const deadline = Date.now() + 10000;
  let page;
  while (!page && Date.now() < deadline) {
    page = desktop
      .windows()
      .find((window) => window.url().includes("view=dashboard"));
    if (!page) await new Promise((done) => setTimeout(done, 20));
  }
  assert.ok(page, "面板未启动");
  page.on("pageerror", (error) => errors.push(error.message));
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "声音与感知", exact: true })
    .click();
  await page.getByLabel("模型原理与费用说明", { exact: true }).waitFor();
  const opened = () => desktop.evaluate(() => globalThis.__guideOpened);

  const expected = {
    mimo: "限时免费",
    siliconflow: "UTF-8 字节",
    minimax: "一次性音色费",
    volcengine: "槽位费并固定音色",
    bailian: "创建音色与之后的朗读分别计费",
  };
  for (const [provider, wording] of Object.entries(expected)) {
    await page.getByLabel("音色服务", { exact: true }).selectOption(provider);
    const section = page.locator(".voice-import-section");
    assert.ok(
      (await section.innerText()).includes(wording),
      `${provider} 的关键计费提示须直接显示`,
    );
    const guide = section.locator(".voice-service-guidance");
    const details = guide.locator("details");
    if ((await details.getAttribute("open")) === null)
      await details.locator("summary").click();
    const link = guide.getByRole("link", {
      name: "查看官方价格与计费规则",
      exact: true,
    });
    const url = await link.getAttribute("href");
    await link.click();
    await page.waitForTimeout(50);
    assert.equal((await opened()).at(-1), url, "官方说明应交给系统浏览器");
    if (provider === "volcengine") {
      const uploadGuide = section.getByRole("link", {
        name: "打开火山上传指引",
      });
      const uploadUrl = await uploadGuide.getAttribute("href");
      await uploadGuide.click();
      await page.waitForTimeout(50);
      assert.equal(
        (await opened()).at(-1),
        uploadUrl,
        "火山上传指引应交给系统浏览器",
      );
    }
  }

  // 普通窗口仍不允许任意外链、本机程序或页面跳转。
  const offset = (await opened()).length;
  await page.evaluate(() => {
    window.open("https://example.com/unlisted");
    window.open("file:///C:/Windows/System32/cmd.exe");
  });
  await page.waitForTimeout(50);
  assert.equal((await opened()).length, offset);
  assert.ok(page.url().includes("view=dashboard"));

  await page.locator(".tts-advanced > summary").click();
  assert.ok(
    (await page.locator(".tts-advanced").innerText()).includes(
      "不消耗本页语音服务的 API 额度",
    ),
  );
  await page
    .getByRole("combobox", { name: "朗读方式", exact: true })
    .selectOption("api");
  await page
    .getByRole("combobox", { name: "语音服务商", exact: true })
    .selectOption("openai");
  const apiGuide = page.locator(".tts-advanced .voice-service-guidance");
  await apiGuide.locator("summary").click();
  await apiGuide.getByRole("link", { name: "OpenAI 默认模型价格" }).click();
  await page.getByRole("link", { name: "查看默认 Whisper 模型计费" }).click();
  await page.waitForTimeout(50);
  assert.equal((await opened()).length, offset + 2);
  assert.deepEqual(
    await desktop.evaluate(() => globalThis.__guideRequests),
    [],
    "查看说明和切换选项不应产生模型或其他网络请求",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(
      {
        passed: true,
        checks: [
          "五家关键消费提示",
          "原理与费用详情展开",
          "系统与在线方式提示",
          "官方链接交给系统浏览器",
          "拒绝其他外链和本机协议",
          "浏览说明不请求模型",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS 模型说明：原理、计费提示、官方链接、系统/在线模式及零模型请求",
  );
} finally {
  await desktop?.close();
  assert.equal(dirname(profile), resolve(tmpdir()));
  assert.ok(basename(profile).startsWith("mai-model-guidance-"));
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
