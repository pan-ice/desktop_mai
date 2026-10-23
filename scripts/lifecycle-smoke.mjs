import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { _electron as electron } from "playwright";
import { WebSocketServer } from "ws";

// 隔离配置和窗口；摄像头使用 canvas 的真实 MediaStream，注册表调用由夹具接收。
const base = resolve(".cache/lifecycle-smoke");
await mkdir(base, { recursive: true });
const profile = await mkdtemp(join(base, "run-"));
const launcher = join(profile, "Mai-portable.exe");
const entry = join(profile, "bootstrap.mjs");
await writeFile(
  join(profile, "state.json"),
  JSON.stringify({
    version: 2,
    settings: { autoConnect: false, launchAtLogin: true },
    history: [],
    models: [],
    encrypted: {},
  }),
);
await writeFile(
  entry,
  `
import { app, BrowserWindow } from "electron";
Object.defineProperty(app, "isPackaged", { get: () => true });
globalThis.__loginSettings = [];
app.setLoginItemSettings = (value) => globalThis.__loginSettings.push(value);
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.showInactive = function () {};
const hide = BrowserWindow.prototype.hide;
BrowserWindow.prototype.hide = function () {
  const visible = this.isVisible();
  hide.call(this);
  if (!visible) this.emit("hide");
};
await import(${JSON.stringify(pathToFileURL(resolve("out/main/index.js")).href)});
`,
);

const server = new WebSocketServer({ host: "127.0.0.2", port: 0 });
await once(server, "listening");
const address = `ws://127.0.0.2:${server.address().port}/desktop`;
const accountId = `pet_${"a".repeat(32)}`;
let chat;
let historyReply;
let historyCalls = 0;
const replyAcks = [];
const frame = (socket, value) => socket.send(JSON.stringify(value));
server.on("headers", (headers) => headers.push("X-Mai-Account-Reuse: 1"));
server.on("connection", (socket, request) => {
  if (request.url === "/account") {
    socket.on("message", (raw) => {
      const call = JSON.parse(raw.toString());
      assert.equal(call.method, "history.list");
      historyCalls++;
      historyReply = (messages) =>
        frame(socket, {
          v: 1,
          id: call.id,
          ok: true,
          value: { messages, before: 1, hasMore: true },
        });
    });
  } else {
    chat = socket;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "reply_ack") replyAcks.push(message);
      if (message.type === "welcome")
        frame(socket, {
          v: 1,
          type: "ready",
          sessionId: "lifecycle-test",
          capabilities: ["chat", "image", "audio", "proactive"],
        });
    });
    frame(socket, {
      v: 1,
      type: "hello",
      protocol: "mai-desktop",
      pluginVersion: "0.4.5",
      instanceId: randomUUID(),
      startedAt: Date.now(),
      identity: {
        platform: "desktop_pet",
        accountId: "mai_desktop_pet",
        userId: accountId,
        scope: "",
      },
    });
  }
});

async function until(predicate, message) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(message);
}

async function deliverReply(id, text) {
  const count = replyAcks.length;
  frame(chat, {
    v: 1,
    type: "reply",
    sessionId: "lifecycle-test",
    id,
    segments: [{ type: "text", text }],
  });
  await until(() => replyAcks.length > count, "实时回复应在保存后确认");
  assert.deepEqual(replyAcks.at(-1), { v: 1, type: "reply_ack", id, ok: true });
}

let desktop;
try {
  const env = {
    ...process.env,
    MAI_USER_DATA: profile,
    PORTABLE_EXECUTABLE_FILE: launcher,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  desktop = await electron.launch({
    executablePath: resolve("node_modules/electron/dist/electron.exe"),
    args: [entry, "--disable-renderer-backgrounding"],
    env,
    timeout: 20000,
  });
  let page, pet;
  await until(() => {
    page = desktop
      .windows()
      .find((value) => value.url().includes("view=dashboard"));
    pet = desktop.windows().find((value) => value.url().includes("view=pet"));
    return page && pet;
  }, "两个隐藏窗口应完成加载");
  await pet.locator(".pet-character").waitFor();
  const login = await desktop.evaluate(() => globalThis.__loginSettings);
  assert.deepEqual(login, [{ openAtLogin: true, path: launcher, args: [] }]);
  await page.evaluate(() =>
    window.mai.updateSettings({ launchAtLogin: false }),
  );
  assert.deepEqual(
    await desktop.evaluate(() => globalThis.__loginSettings.at(-1)),
    {
      openAtLogin: false,
      path: launcher,
      args: [],
    },
  );

  const captureSpeech = () => {
    window.__spoken = [];
    speechSynthesis.cancel = () => {};
    speechSynthesis.speak = (utterance) => {
      window.__spoken.push(utterance.text);
      utterance.onstart?.({});
      queueMicrotask(() => utterance.onend?.({}));
    };
  };
  await pet.addInitScript(captureSpeech);
  await pet.evaluate(captureSpeech);
  await page.evaluate(
    async ({ address, accountId }) => {
      await window.mai.updateSettings({
        connectionMode: "server",
        serverUrl: address,
        voiceEnabled: true,
      });
      await window.mai.updateSettings({ serverAccountId: accountId });
      await window.mai.setCredential(
        "serverToken",
        "test-device-token-" + "x".repeat(32),
      );
      await window.mai.connect();
    },
    { address, accountId },
  );
  await until(() => historyReply, "应请求服务器历史");
  assert.equal(
    (await page.evaluate(() => window.mai.snapshot())).historySync.loading,
    true,
  );
  await deliverReply("live-reply", "即时回复");
  await until(
    async () => (await pet.evaluate(() => window.__spoken)).length === 1,
    "补载期间即时回复仍应朗读",
  );
  historyReply([
    {
      id: "live-reply",
      role: "assistant",
      text: "即时回复",
      timestamp: Date.now() - 30000,
      source: "core",
    },
    ...[-30000, 30000].map((offset) => ({
      id: `overlap-${offset}`,
      role: "assistant",
      text: `同步先到的即时回复 ${offset}`,
      timestamp: Date.now() + offset,
      source: "core",
    })),
    {
      id: "restored-reply",
      role: "assistant",
      text: "补载历史不应朗读",
      timestamp: Date.now(),
      source: "core",
    },
  ]);
  await until(
    async () =>
      !(await page.evaluate(() => window.mai.snapshot())).historySync.loading,
    "历史同步应结束",
  );
  await new Promise((done) => setTimeout(done, 100));
  assert.deepEqual(await pet.evaluate(() => window.__spoken), ["即时回复"]);
  const expectedSpeech = ["即时回复"];
  for (const offset of [-30000, 30000]) {
    const text = `同步先到的即时回复 ${offset}`;
    await deliverReply(`overlap-${offset}`, text);
    expectedSpeech.push(text);
    await until(
      async () =>
        (await pet.evaluate(() => window.__spoken)).length ===
        expectedSpeech.length,
      "同步先到的同一条实时回复应朗读，不受服务器时钟偏差影响",
    );
    await deliverReply(`overlap-${offset}`, text);
  }
  const earlier = page.evaluate(() => window.mai.loadEarlierHistory());
  await until(() => historyCalls === 2, "应请求下一页历史");
  historyReply([
    {
      id: "earlier-reply",
      role: "assistant",
      text: "分页历史不应朗读",
      timestamp: Date.now(),
      source: "core",
    },
  ]);
  await earlier;
  await new Promise((done) => setTimeout(done, 200));
  assert.deepEqual(await pet.evaluate(() => window.__spoken), expectedSpeech);
  assert.deepEqual(
    (await page.evaluate(() => window.mai.snapshot())).liveReplies.map(
      (reply) => reply.id,
    ),
    ["live-reply", "overlap--30000", "overlap-30000"],
  );
  const stored = JSON.parse(
    await readFile(join(profile, "state.json"), "utf8"),
  );
  assert.equal("liveReplies" in stored, false, "重启不能恢复即时朗读资格");
  assert.equal("liveReplyIds" in stored, false, "旧版标记同样不应持久化");

  // 渲染器重载不重播已经接收过的实时回复；其后的新回复仍可播放。
  await pet.reload();
  await pet.locator(".pet-character").waitFor();
  await new Promise((done) => setTimeout(done, 200));
  assert.deepEqual(await pet.evaluate(() => window.__spoken), []);
  await deliverReply("after-reload", "窗口重载后的新回复");
  await until(
    async () => (await pet.evaluate(() => window.__spoken)).length === 1,
    "重载后仍应播放新收到的回复",
  );

  // 重连后初次同步会替换缓存对象，仍必须记得连接前已有的消息 ID。
  await page.evaluate(() => window.mai.connect());
  await until(() => historyCalls === 3, "重连应重新同步历史");
  historyReply([
    {
      id: "restored-reply",
      role: "assistant",
      text: "补载历史不应朗读",
      timestamp: Date.now() + 30000,
      source: "core",
    },
  ]);
  await until(
    async () =>
      !(await page.evaluate(() => window.mai.snapshot())).historySync.loading,
    "重连同步应完成",
  );
  await deliverReply("restored-reply", "补载历史不应朗读");
  await new Promise((done) => setTimeout(done, 200));
  assert.deepEqual(await pet.evaluate(() => window.__spoken), [
    "窗口重载后的新回复",
  ]);
  assert.deepEqual(
    (await page.evaluate(() => window.mai.snapshot())).liveReplies,
    [],
  );

  // 通过真实状态 IPC 重放长会话快照，避免为去重阈值执行两千次磁盘写入。
  const longSession = await page.evaluate(() => window.mai.snapshot());
  const pendingReply = {
    id: "synced-before-trim",
    role: "assistant",
    text: "清理去重缓存后到达的即时回复",
    timestamp: Date.now() - 30000,
    source: "core",
  };
  longSession.settings.voiceEnabled = false;
  longSession.history = Array.from({ length: 2001 }, (_, index) => ({
    id: `consumed-${index}`,
    role: "assistant",
    text: "",
    timestamp: Date.now(),
    source: "core",
  }));
  longSession.liveReplies = longSession.history.map(({ id }) => ({
    id,
    receivedAt: Date.now(),
  }));
  longSession.history.push(pendingReply);
  const pushPetSnapshot = (state) =>
    desktop.evaluate(({ BrowserWindow }, snapshot) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().includes("view=pet"))
        .webContents.send("mai:state", snapshot);
    }, state);
  await pushPetSnapshot(longSession);
  await pet.getByRole("button", { name: "开启朗读", exact: true }).waitFor();
  await new Promise((done) => setTimeout(done, 100));
  longSession.settings.voiceEnabled = true;
  longSession.history = [pendingReply];
  longSession.liveReplies = [{ id: pendingReply.id, receivedAt: Date.now() }];
  await pushPetSnapshot(longSession);
  await until(
    async () =>
      (await pet.evaluate(() => window.__spoken)).includes(pendingReply.text),
    "清理已消费ID不能误标记尚未实时投递的历史消息",
  );

  await page.evaluate(() => {
    window.__cameraStreams = [];
    navigator.mediaDevices.enumerateDevices = async () => [];
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 240;
      canvas.getContext("2d").fillRect(0, 0, 320, 240);
      const stream = canvas.captureStream(1);
      window.__cameraCanvas = canvas;
      window.__cameraStreams.push(stream);
      if (window.__delayCamera)
        await new Promise((resolve) => {
          window.__releaseCamera = resolve;
        });
      return stream;
    };
  });
  await page.evaluate(() => window.mai.showDashboard("chat"));
  const camera = page.getByRole("button", { name: "摄像头分享" });
  await camera.click();
  await until(
    async () => page.evaluate(() => window.__cameraStreams.length === 1),
    "应开启测试视频轨道",
  );
  assert.equal(
    await page.evaluate(
      () => window.__cameraStreams[0].getVideoTracks()[0].readyState,
    ),
    "live",
  );
  await desktop.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((value) => value.webContents.getURL().includes("view=dashboard"))
      .close();
  });
  await until(
    async () =>
      page.evaluate(() =>
        window.__cameraStreams[0]
          .getTracks()
          .every((track) => track.readyState === "ended"),
      ),
    "主窗口关闭至托盘必须释放摄像头",
  );
  await page.getByRole("dialog").waitFor({ state: "detached" });

  await page.evaluate(() => {
    window.__delayCamera = true;
  });
  await camera.click();
  await until(
    async () => page.evaluate(() => Boolean(window.__releaseCamera)),
    "应挂起设备授权请求",
  );
  await page.evaluate(() => window.mai.hideWindow());
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.evaluate(() => window.__releaseCamera());
  await until(
    async () =>
      page.evaluate(() =>
        window.__cameraStreams[1]
          .getTracks()
          .every((track) => track.readyState === "ended"),
      ),
    "窗口隐藏后才返回的轨道也必须立即释放",
  );

  const modelRoot = join(profile, "model-input");
  await mkdir(modelRoot);
  const modelFile = join(modelRoot, "test.model3.json");
  const maliciousCore = join(modelRoot, "live2dcubismcore.min.js");
  await writeFile(
    modelFile,
    JSON.stringify({ FileReferences: { Moc: "test.moc3" } }),
  );
  await writeFile(join(modelRoot, "test.moc3"), "fixture");
  await writeFile(
    maliciousCore,
    "/* Live2DCubismCore csmGetVersion */ globalThis.__untrustedCoreRan = true;",
  );
  // 只替换固定官方下载的响应；模型中的脚本必须被忽略，手动导入也必须拒绝。
  await desktop.evaluate(({ dialog, net }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
    const fetch = net.fetch.bind(net);
    globalThis.__coreRequests = [];
    net.fetch = async (url, options) => {
      if (
        url !==
        "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js"
      )
        return fetch(url, options);
      globalThis.__coreRequests.push(url);
      return new Response(
        "var Live2DCubismCore = { Version: { csmGetVersion() { return 1; } } }; globalThis.__officialCoreRan = true;",
      );
    };
  }, modelFile);
  await page.evaluate(() => window.mai.importModel());
  await until(
    async () => pet.evaluate(() => Boolean(window.__officialCoreRan)),
    "已验证运行库应能通过 CSP 加载",
  );
  assert.equal(
    await pet.evaluate(() => Boolean(window.__untrustedCoreRan)),
    false,
  );
  assert.equal(
    (await desktop.evaluate(() => globalThis.__coreRequests)).length,
    1,
  );
  await desktop.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, maliciousCore);
  await assert.rejects(
    page.evaluate(() => window.mai.importLive2DCore()),
    /校验/,
  );
  const model = (await page.evaluate(() => window.mai.snapshot())).models[0];
  assert.equal(new URL(model.coreUrl).hostname, "runtime");
  assert.equal(
    await page.evaluate(
      (id) =>
        new Promise((resolve) => {
          const script = document.createElement("script");
          script.src = `mai-asset://model/${id}/live2dcubismcore.min.js`;
          script.onload = () => {
            script.remove();
            resolve("executed");
          };
          script.onerror = () => {
            script.remove();
            resolve("blocked");
          };
          document.head.append(script);
        }),
      model.id,
    ),
    "blocked",
    "模型资源域不能执行脚本",
  );
  console.log(
    "PASS portable startup; live/history ordering, clock skew, replay/reload dedup and long sessions; camera cleanup; verified Core and blocked model scripts",
  );
} finally {
  await desktop?.close();
  for (const socket of server.clients) socket.terminate();
  await new Promise((done) => server.close(done));
  if (!profile.startsWith(base + sep))
    throw new Error("Unexpected test profile path");
  await rm(profile, { recursive: true, force: true });
}
