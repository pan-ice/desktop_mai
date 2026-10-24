import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { _electron as electron, chromium } from "playwright";
import { inspectPackaged, until } from "./packaging-inspector.mjs";

const option = (name) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const mode = option("mode") || "build";
assert.ok(["build", "packaged"].includes(mode));
const version = JSON.parse(
  await readFile(resolve("package.json"), "utf8"),
).version;

const base = resolve(".cache/pet-bubble-smoke");
await mkdir(base, { recursive: true });
const profile = await mkdtemp(join(base, "run-"));
const entry = join(profile, "bootstrap.mjs");
const phase = option("phase") || (mode === "packaged" ? "packaged" : "after");
assert.match(phase, /^[a-z0-9-]+$/);
const report = { passed: false, phase, mode, version, checks: [], errors: [] };
let desktop;
let packagedChild, packagedInspector, packagedBrowser;
const snapshotFixture = String.raw`
const fixtureIpc = process.getBuiltinModule("module").createRequire(process.resourcesPath + "/app.asar/package.json")("electron").ipcMain;
globalThis.__packagedElectron.ipcMain = fixtureIpc;
const handle = fixtureIpc.handle.bind(fixtureIpc);
fixtureIpc.handle = (channel, listener) => handle(channel, (event, command, ...args) => {
  if (channel === "mai:command" && command === "snapshot" && globalThis.__petBubbleReloadSnapshot)
    return { ok: true, value: structuredClone(globalThis.__petBubbleReloadSnapshot) };
  return listener(event, command, ...args);
});
`;
try {
  await writeFile(
    join(profile, "state.json"),
    JSON.stringify({
      version: 2,
      settings: {
        autoConnect: false,
        reducedMotion: true,
        voiceEnabled: false,
        launchAtLogin: false,
      },
      history: [],
      models: [],
      encrypted: {},
    }),
  );
  await writeFile(
    entry,
    `
import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.showInactive = function () {};
app.setLoginItemSettings = () => {};
globalShortcut.register = () => true;
globalShortcut.unregisterAll = () => {};
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, (event, command, ...args) => {
  if (channel === "mai:command" && command === "snapshot" && globalThis.__petBubbleReloadSnapshot)
    return { ok: true, value: structuredClone(globalThis.__petBubbleReloadSnapshot) };
  return listener(event, command, ...args);
});
await import(${JSON.stringify(pathToFileURL(resolve("out/main/index.js")).href)});
`,
  );
  const env = { ...process.env, MAI_USER_DATA: profile };
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "ELECTRON_RENDERER_URL",
    "ELECTRON_ENTRY",
    "ELECTRON_CLI_ARGS",
    "ELECTRON_EXEC_PATH",
  ])
    delete env[key];
  let pet;
  if (mode === "build") {
    desktop = await electron.launch({
      executablePath: resolve("node_modules/electron/dist/electron.exe"),
      args: [entry, "--disable-renderer-backgrounding"],
      cwd: resolve("."),
      env,
    });
    await desktop.firstWindow();
    pet =
      desktop.windows().find((page) => page.url().includes("view=pet")) ||
      (await desktop.waitForEvent("window", {
        predicate: (page) => page.url().includes("view=pet"),
      }));
  } else {
    const executable = resolve(
      option("exe") ||
        process.env.MAI_TEST_EXE ||
        "release/win-unpacked/Mai 桌面伙伴.exe",
    );
    let output = "";
    packagedChild = spawn(
      executable,
      [
        "--inspect-brk=127.0.0.1:0",
        "--remote-debugging-port=0",
        "--disable-renderer-backgrounding",
      ],
      {
        cwd: dirname(executable),
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    packagedChild.on("error", (error) => report.errors.push(error.message));
    for (const stream of [packagedChild.stdout, packagedChild.stderr])
      stream.on("data", (chunk) => {
        output = (output + chunk).slice(-12000);
      });
    const endpoint = await until(() => {
      if (report.errors.length) throw new Error(report.errors.join("\n"));
      if (packagedChild.exitCode !== null)
        throw new Error(
          `Packaged EXE exited early: ${packagedChild.exitCode}\n${output}`,
        );
      return output.match(
        /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/,
      )?.[1];
    }, "The actual packaged main must pause for hidden-window fixtures");
    packagedInspector = await inspectPackaged(endpoint, snapshotFixture);
    report.identity = packagedInspector.identity;
    assert.equal(
      resolve(report.identity.executable).toLowerCase(),
      executable.toLowerCase(),
    );
    const browserEndpoint = await until(
      () =>
        output.match(
          /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/,
        )?.[1],
      "The actual packaged Chromium must start",
    );
    packagedBrowser = await chromium.connectOverCDP(browserEndpoint);
    desktop = {
      evaluate: (callback, value) =>
        packagedInspector.evaluate(
          `(${callback.toString()})(globalThis.__packagedElectron, ${JSON.stringify(value) ?? "undefined"})`,
        ),
    };
    pet = await until(
      () =>
        packagedBrowser
          .contexts()
          .flatMap((context) => context.pages())
          .find((page) => page.url().includes("view=pet")),
      "The actual packaged pet must load",
    );
    assert.equal(new URL(pet.url()).protocol, "file:");
    assert.match(pet.url(), /app\.asar\/out\/renderer\/index\.html/);
    assert.equal(
      await desktop.evaluate(({ app }) => app.getVersion()),
      version,
    );
  }
  pet.on("pageerror", (error) => report.errors.push(error.message));
  await pet.clock.install({ time: Date.now() });
  await pet.reload();
  await pet.locator(".pet-character").waitFor();
  await pet.locator(".pet-bubble").waitFor();
  assert.match(
    await pet.locator(".pet-bubble p").innerText(),
    /很高兴在这里遇见你/,
  );
  await pet.clock.fastForward(6000);
  assert.equal(
    await pet.locator(".pet-bubble").count(),
    0,
    "初始问候在没有新消息时应在5秒后自动收起",
  );
  report.checks.push("initial greeting expires without updates");

  const snapshot = await pet.evaluate(() => window.mai.snapshot());
  await desktop.evaluate(({ BrowserWindow, ipcMain }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes("view=pet"),
    );
    const send = window.webContents.send.bind(window.webContents);
    globalThis.__petBubbleSend = (value) => send("mai:state", value);
    window.webContents.send = function (channel, ...args) {
      if (channel !== "mai:state") return send(channel, ...args);
    };
    globalThis.__petBubbleStopPlayback = 0;
    ipcMain.on("mai:stop-playback", () => globalThis.__petBubbleStopPlayback++);
  });
  const visible = () => pet.locator(".pet-bubble").count();
  const settle = () => pet.waitForTimeout(35);
  const advance = async (ms) => {
    await pet.clock.fastForward(ms);
    await settle();
  };
  const emit = async () => {
    await desktop.evaluate(
      (_electron, value) => globalThis.__petBubbleSend(value),
      snapshot,
    );
    await settle();
  };
  const reply = async (id, text, live = true) => {
    snapshot.history.push({
      id,
      text,
      role: "assistant",
      source: "core",
      timestamp: Date.now() - 3600000,
    });
    if (live)
      snapshot.liveReplies.push({
        id,
        receivedAt: await pet.evaluate(() => Date.now()),
      });
    await emit();
  };
  const text = () => pet.locator(".pet-bubble p").innerText();

  await emit();
  await advance(20000);
  assert.equal(await visible(), 0, "普通快照不能重新打开已过期的问候");
  await reply("history-only", "这是一条从历史记录恢复的旧消息", false);
  assert.equal(await visible(), 0, "历史恢复不能自动弹出旧句");
  report.checks.push(
    "unchanged snapshots and history backfill do not reopen a bubble",
  );

  await reply("live-short", "这是一条新的简短回复。");
  assert.equal(await text(), "这是一条新的简短回复。");
  await advance(6000);
  snapshot.mood = "happy";
  snapshot.connection = { ...snapshot.connection, detail: "unrelated update" };
  await emit();
  await advance(3000);
  assert.equal(await visible(), 0, "无关快照不能延长短回复8秒的显示时间");
  await emit();
  assert.equal(await visible(), 0, "相同即时消息再次广播不能重新弹出");
  report.checks.push(
    "live replies expire, and repeated snapshots neither extend nor reopen them",
  );

  await reply("first-timer", "旧定时器对应的回复");
  await advance(6000);
  await reply("second-timer", "刚刚收到的新回复");
  await advance(3000);
  assert.equal(await text(), "刚刚收到的新回复", "旧回复定时器不能关闭新回复");
  await advance(5500);
  assert.equal(await visible(), 0);
  report.checks.push(
    "a new reply resets the deadline without being closed by an older timer",
  );

  await reply("manual-close", "手动关闭的回复");
  await pet.getByRole("button", { name: "关闭气泡", exact: true }).click();
  await emit();
  await advance(1000);
  assert.equal(await visible(), 0, "手动关闭后相同回复不能重弹");
  await reply("after-manual", "关闭后新到的回复");
  assert.equal(await text(), "关闭后新到的回复");
  await advance(6000);
  await pet.locator(".pet-character").click();
  await advance(3000);
  assert.equal(await text(), "关闭后新到的回复", "点击角色可重看并重新计时");
  await advance(5500);
  assert.equal(await visible(), 0);
  report.checks.push(
    "manual dismissal persists until a new reply; clicking the character reopens and retimes",
  );

  await reply("history-before-live", "历史先到，随后即时通知到达", false);
  assert.equal(await visible(), 0);
  snapshot.liveReplies.push({
    id: "history-before-live",
    receivedAt: await pet.evaluate(() => Date.now()),
  });
  await emit();
  assert.equal(await text(), "历史先到，随后即时通知到达");
  await advance(8500);
  assert.equal(await visible(), 0);
  report.checks.push(
    "a reply becomes visible when its live delivery arrives after its history record",
  );

  snapshot.liveReplies.push({
    id: "live-before-history",
    receivedAt: await pet.evaluate(() => Date.now()),
  });
  await emit();
  assert.equal(
    await visible(),
    0,
    "即时通知先到时等待匹配的内容，不能重播旧句",
  );
  snapshot.history.push({
    id: "live-before-history",
    text: "即时通知先到，随后内容到达",
    role: "assistant",
    source: "core",
    timestamp: Date.now() - 3600000,
  });
  await emit();
  assert.equal(await text(), "即时通知先到，随后内容到达");
  await advance(8500);
  assert.equal(await visible(), 0);
  report.checks.push(
    "live delivery can arrive before its history record without replaying an older reply",
  );

  const longText = "这是一段用于验证长回复阅读时间和显示截断的内容。".repeat(
    12,
  );
  await reply("long-reply", longText);
  assert.equal(await text(), longText.slice(0, 150));
  snapshot.playback = { id: "long-reply", phase: "playing", mouth: 0.7 };
  await advance(11000);
  await emit();
  await advance(2500);
  assert.equal(await visible(), 1, "长回复应保留足够的阅读时间");
  await advance(2000);
  assert.equal(
    await visible(),
    0,
    "长回复最长15秒后仍应收起，不受播放状态续时",
  );
  assert.equal(
    await desktop.evaluate(() => globalThis.__petBubbleStopPlayback),
    0,
    "气泡到期不能发送停止播放命令",
  );
  report.checks.push(
    "long replies cap at 15 seconds and disappear independently of playback state",
  );

  await desktop.evaluate((_electron, value) => {
    globalThis.__petBubbleReloadSnapshot = value;
  }, snapshot);
  await pet.reload();
  await pet.locator(".pet-character").waitFor();
  await settle();
  if (await visible()) {
    assert.match(
      await text(),
      /很高兴在这里遇见你/,
      "页面重载不能自动重播已过期的即时回复",
    );
  }
  await advance(6000);
  assert.equal(await visible(), 0);
  await emit();
  await advance(1000);
  assert.equal(
    await visible(),
    0,
    "页面重载后同一过期元数据再次刷新不能重播旧句",
  );
  report.checks.push(
    "renderer reload ignores expired live metadata and never replays its history",
  );

  const anchor = {
    id: "retained-live-history-gap",
    text: "已经读过，不应该再次弹出的旧回复",
    role: "assistant",
    source: "core",
    timestamp: Date.now(),
  };
  let anchorDelivery;
  for (let batch = 0; batch < 3; batch++) {
    const receivedAt = await pet.evaluate(() => Date.now());
    snapshot.history = Array.from({ length: 1000 }, (_, index) => ({
      id: `long-session-${batch}-${index}`,
      text: `第${batch}批的第${index}条测试回复`,
      role: "assistant",
      source: "core",
      timestamp: Date.now(),
    }));
    if (!batch) snapshot.history[0] = anchor;
    snapshot.liveReplies = snapshot.history
      .slice(0, batch ? 999 : 1000)
      .map((message) => ({ id: message.id, receivedAt }));
    if (!batch) anchorDelivery = snapshot.liveReplies[0];
    else snapshot.liveReplies.push(anchorDelivery);
    await emit();
    assert.equal(await visible(), 1);
    await advance(16000);
    assert.equal(await visible(), 0);
  }
  snapshot.history[999] = anchor;
  await emit();
  assert.equal(
    await visible(),
    0,
    "累计处理超过2000条后，仍在即时元数据中的已消费旧回复不能因历史回填重弹",
  );
  report.checks.push(
    "long-session deduplication retains consumed live IDs across temporary history truncation",
  );
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  if (mode === "build") await desktop?.close();
  else {
    if (packagedInspector) {
      await packagedInspector
        .evaluate(
          "setImmediate(() => globalThis.__packagedElectron.app.quit()); true",
        )
        .catch(() => {});
      await packagedInspector.close().catch(() => {});
    }
    await packagedBrowser?.close().catch(() => {});
    if (packagedChild?.pid && packagedChild.exitCode === null) {
      await Promise.race([
        once(packagedChild, "exit"),
        new Promise((done) => setTimeout(done, 5000)),
      ]);
      if (packagedChild.exitCode === null) {
        packagedChild.kill();
        await once(packagedChild, "exit");
      }
    }
  }
  assert.ok(profile.startsWith(base + sep));
  await rm(profile, { recursive: true, force: true });
  await writeFile(
    join(base, `${phase}.json`),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
