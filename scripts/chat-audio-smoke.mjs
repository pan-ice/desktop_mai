import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";

const base = resolve(".cache/chat-audio-smoke");
await mkdir(base, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "mai-chat-audio-"));
const samples = 8000 * 90;
const wav = Buffer.alloc(44 + samples * 2);
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
wav.writeUInt32LE(samples * 2, 40);
const mp3 = process.argv.includes("--mp3");
const media = mp3 ? await readFile(join(base, "no-xing.mp3")) : wav;
const filename = `c430a156-9322-4a0f-a628-ffb614be2667.${mp3 ? "mp3" : "wav"}`;
const url = `mai-media://attachment/${filename}`;
await mkdir(join(profile, "media"));
await writeFile(join(profile, "media", filename), media);
await writeFile(
  join(profile, "state.json"),
  JSON.stringify({
    version: 2,
    settings: { autoConnect: false, voiceEnabled: false },
    history: [
      {
        id: "seekable-audio",
        role: "assistant",
        text: "一段九十秒的测试音频",
        timestamp: 1,
        source: "core",
        attachments: [{ type: "audio", dataUrl: url }],
      },
    ],
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
    args: [".", "--autoplay-policy=no-user-gesture-required"],
    cwd: resolve("."),
    env,
  });
  await desktop.firstWindow();
  let page;
  for (let tries = 0; tries < 100; tries++) {
    page = desktop
      .windows()
      .find((page) => page.url().includes("view=dashboard"));
    if (page) break;
    await new Promise((done) => setTimeout(done, 30));
  }
  assert.ok(page, "dashboard window exists");
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("button", { name: "和麦麦聊聊", exact: true }).click();
  const audio = page.locator("audio[data-chat-player]");
  await audio.waitFor({ state: "attached" });
  await audio.evaluate((audio) => {
    audio.muted = true;
  });
  await page.getByRole("button", { name: "播放这段音频", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("audio[data-chat-player]")?.readyState >= 1,
  );
  const mode =
    process.argv.find((value) =>
      ["--range", "--seek", "--navigation"].includes(value),
    ) || "all";
  if (mode === "all" || mode === "--range") {
    const response = await page.evaluate(async (url) => {
      const response = await fetch(url, { headers: { Range: "bytes=44-59" } });
      return {
        status: response.status,
        range: response.headers.get("Content-Range"),
        length: (await response.arrayBuffer()).byteLength,
      };
    }, url);
    console.log("media range:", JSON.stringify(response));
    assert.equal(
      response.status,
      206,
      "快进所需的 Range 请求应返回局部音频，不能返回整个文件",
    );
    assert.equal(response.length, 16);
    assert.equal(response.range, `bytes 44-59/${media.length}`);
    console.log("PASS audio byte ranges");
  }
  if (mode === "all" || mode === "--seek") {
    const slider = page.getByRole("slider", {
      name: "音频播放进度",
      exact: true,
    });
    const bounds = await slider.boundingBox();
    assert.ok(bounds);
    await page.mouse.click(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    await page.waitForFunction(
      () => document.querySelector("audio[data-chat-player]").currentTime > 40,
    );
    const result = await audio.evaluate(async (audio) => {
      return {
        duration: audio.duration,
        current: audio.currentTime,
        seekable: audio.seekable.length,
        paused: audio.paused,
      };
    });
    console.log(
      "audio seek:",
      JSON.stringify({ ...result, duration: String(result.duration) }),
    );
    assert.ok(
      Number.isFinite(result.duration) && Math.abs(result.duration - 90) < 1,
      "播放器必须拿到有限时长，Infinity 会禁用拖动快进",
    );
    assert.ok(
      result.current >= 44 && result.current < 48,
      "拖动进度应跳至指定位置并继续播放",
    );
    assert.ok(result.seekable > 0);
    await slider.press("Home");
    await page.waitForFunction(
      () => document.querySelector("audio[data-chat-player]").currentTime < 2,
    );
    await slider.press("ArrowRight");
    assert.ok(Number(await slider.inputValue()) > 0);
    console.log("PASS seeking to 45 seconds");
  }
  if (mode === "all" || mode === "--navigation") {
    await audio.evaluate(async (audio) => {
      audio.muted = true;
      window.__chatAudio = audio;
      await audio.play();
    });
    await page.waitForFunction(() => window.__chatAudio.currentTime > 0.05);
    const before = await page.evaluate(() => window.__chatAudio.currentTime);
    await page.getByRole("button", { name: "声音与感知", exact: true }).click();
    await page
      .getByRole("heading", { name: "声音与感知", exact: true })
      .waitFor();
    await new Promise((done) => setTimeout(done, 200));
    const away = await page.evaluate(() => ({
      attached: window.__chatAudio.isConnected,
      paused: window.__chatAudio.paused,
      current: window.__chatAudio.currentTime,
    }));
    console.log("audio after navigation:", JSON.stringify(away));
    assert.ok(
      away.attached && !away.paused && away.current > before,
      "切换到其他页面后音频必须持续播放",
    );
    const dock = page.getByRole("region", { name: "正在播放的聊天音频" });
    await dock.waitFor();
    await page
      .getByRole("button", { name: "暂停当前音频", exact: true })
      .click();
    assert.equal(await audio.evaluate((audio) => audio.paused), true);
    await page.getByRole("button", { name: "快进十秒", exact: true }).click();
    const afterForward = await audio.evaluate((audio) => audio.currentTime);
    assert.ok(afterForward >= away.current + 9.5);
    await page.getByRole("button", { name: "快退十秒", exact: true }).click();
    assert.ok(
      Math.abs(
        (await audio.evaluate((audio) => audio.currentTime)) - away.current,
      ) < 0.5,
    );
    const progress = page.getByRole("slider", {
      name: "当前音频播放进度",
      exact: true,
    });
    await progress.press("End");
    assert.ok((await audio.evaluate((audio) => audio.currentTime)) > 89);
    await progress.press("Home");
    await page
      .getByRole("button", { name: "继续播放当前音频", exact: true })
      .click();
    await page.waitForFunction(() => window.__chatAudio.currentTime > 0.05);
    await dock.screenshot({ path: join(base, "background-player.png") });
    await page.getByRole("button", { name: "和麦麦聊聊", exact: true }).click();
    assert.equal(
      await audio.evaluate((audio) => audio === window.__chatAudio),
      true,
      "返回聊天应保留同一音频和播放位置",
    );
    await page
      .getByRole("button", { name: "暂停这段音频", exact: true })
      .waitFor();
    assert.equal(await dock.count(), 0);
    await page
      .getByRole("button", { name: "暂停这段音频", exact: true })
      .click();
    assert.equal(await audio.evaluate((audio) => audio.paused), true);
    await page
      .getByRole("button", { name: "播放这段音频", exact: true })
      .click();
    await page
      .locator(".message-audio")
      .screenshot({ path: join(base, "message-player.png") });
    await page.getByRole("button", { name: "偏好设置", exact: true }).click();
    await page
      .getByRole("button", { name: "停止当前音频", exact: true })
      .click();
    assert.equal(
      await audio.evaluate(
        (audio) => audio.paused && !audio.hasAttribute("src"),
      ),
      true,
    );
    assert.equal(await dock.count(), 0);
    // 删除聊天后不能留下已经失去归属的后台声音。
    await page.getByRole("button", { name: "和麦麦聊聊", exact: true }).click();
    await page
      .getByRole("button", { name: "播放这段音频", exact: true })
      .click();
    await page
      .getByRole("button", { name: "清空聊天记录", exact: true })
      .click();
    await page
      .getByRole("button", { name: "确认清空聊天记录", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        !document.querySelector("audio[data-chat-player]").hasAttribute("src"),
    );
    console.log("PASS uninterrupted navigation");
  }
  assert.deepEqual(errors, []);
} finally {
  await desktop?.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
