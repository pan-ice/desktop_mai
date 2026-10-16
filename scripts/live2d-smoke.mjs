import { _electron as electron } from "playwright";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { dirname, join, resolve, sep } from "node:path";
import assert from "node:assert/strict";

if (!process.argv[2])
  throw new Error(
    "用法：npm run test:live2d -- <model3.json> [live2dcubismcore.min.js]。请提供有权使用的模型和官方 Core。",
  );
const modelPath = resolve(process.argv[2]);
const corePath = resolve(
  process.argv[3] || join(dirname(modelPath), "live2dcubismcore.min.js"),
);
await Promise.all([access(modelPath), access(corePath)]);
const base = resolve(".cache/live2d-smoke");
await mkdir(base, { recursive: true });
const userData = await mkdtemp(join(base, "userdata-"));
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const adapterPort = probe.address().port;
await new Promise((done) => probe.close(done));
await writeFile(
  join(userData, "state.json"),
  JSON.stringify({
    version: 2,
    settings: { autoConnect: false, adapterPort },
    history: [],
    models: [],
    encrypted: {},
  }),
);

// 从绘制入口采样，避免把随后的 loadParameters() 恢复值当成屏幕表现。
function observePixi() {
  let pixi;
  const registered = new Set();
  window.__live2dTestApps = [];
  Object.defineProperty(window, "PIXI", {
    configurable: true,
    get: () => pixi,
    set(value) {
      pixi = value;
      if (registered.has(value.Application)) return;
      registered.add(value.Application);
      value.extensions.add({
        extension: value.ExtensionType.Application,
        init() {
          window.__live2dTestApps.push(this);
        },
        destroy() {},
      });
    },
  });
}

function startSampling() {
  const app = window.__live2dTestApps.findLast(
    (value) => value.stage?.children.length,
  );
  const internal = app.stage.children[0].internalModel;
  app.__frames = [];
  internal.on("beforeModelUpdate", () => {
    const ids = [
      "ParamBreath",
      "ParamAngleY",
      "ParamAngleZ",
      "ParamEyeLOpen",
      "ParamEyeROpen",
      "ParamMouthOpenY",
    ];
    app.__frames.push(
      Object.fromEntries(
        ids.map((id) => [id, internal.coreModel.getParameterValueById(id)]),
      ),
    );
    if (app.__frames.length > 600) app.__frames.shift();
  });
}

function takeFrames() {
  const app = window.__live2dTestApps.findLast(
    (value) => value.stage?.children.length,
  );
  return app.__frames.splice(0);
}

function modelStats() {
  const app = window.__live2dTestApps.findLast(
    (value) => value.stage?.children.length,
  );
  if (!app) return { ready: false };
  const avatar = app.stage.children[0];
  const pixels = app.renderer.extract.pixels(avatar);
  let visiblePixels = 0;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) visiblePixels++;
  return {
    ready: true,
    coreVersion: window.Live2DCubismCore.Version.csmGetVersion(),
    latestMocVersion: window.Live2DCubismCore.Version.csmGetLatestMocVersion(),
    visiblePixels,
    motionGroups: Object.keys(avatar.internalModel.motionManager.definitions),
    parameterIds: avatar.internalModel.coreModel.getModel().parameters.ids,
  };
}

function sampleHairDynamics() {
  const app = window.__live2dTestApps.findLast(
    (value) => value.stage?.children.length,
  );
  const avatar = app.stage.children[0];
  const internal = avatar.internalModel;
  const core = internal.coreModel;
  const ids = [
    "ParamHairSideL",
    "ParamHairSideLMid",
    "ParamHairSideLTip",
    "ParamHairSideR",
    "ParamHairSideRMid",
    "ParamHairSideRTip",
  ];
  const parameters = core.getModel().parameters;
  const metadata = ids.map((id) => {
    const index = parameters.ids.indexOf(id);
    return {
      id,
      index,
      min: parameters.minimumValues[index],
      max: parameters.maximumValues[index],
    };
  });
  if (metadata.some((value) => value.index < 0))
    return { supported: false, metadata };
  const autoUpdate = avatar.autoUpdate;
  const autoInteract = avatar.autoInteract;
  const natural = internal.updateNaturalMovements;
  const focus = internal.updateFocus;
  const motions = internal.motionManager.update;
  const running = app.ticker.started;
  const savedValues = parameters.values.slice();
  const frames = [];
  let head = 0;
  let phase = "rest";
  const drive = () => {
    core.setParameterValueById("ParamAngleX", head);
    core.setParameterValueById("ParamAngleY", 0);
    core.setParameterValueById("ParamAngleZ", 0);
  };
  const capture = () =>
    frames.push({
      phase,
      head,
      ...Object.fromEntries(
        ids.map((id) => [id, core.getParameterValueById(id)]),
      ),
    });
  try {
    app.stop();
    avatar.autoUpdate = false;
    avatar.autoInteract = false;
    internal.updateNaturalMovements = () => {};
    internal.updateFocus = () => {};
    internal.motionManager.update = () => false;
    internal.on("afterMotionUpdate", drive);
    internal.on("beforeModelUpdate", capture);
    for (const [name, angle, count] of [
      ["rest", 0, 90],
      ["turn", 25, 120],
      ["release", 0, 240],
    ]) {
      phase = name;
      head = angle;
      for (let i = 0; i < count; i++) {
        avatar.update(1000 / 60);
        app.renderer.render(app.stage);
      }
    }
    const drawable = core.getDrawableIndex("ArtMeshBackHair");
    const influence = [];
    const inputs = ["ParamAngleX", "ParamAngleZ"].map((id) => ({
      id,
      max: parameters.maximumValues[parameters.ids.indexOf(id)],
    }));
    for (const param of [...metadata, ...inputs]) {
      parameters.values.set(parameters.defaultValues);
      core.update();
      const before = core.getDrawableVertices(drawable).slice();
      core.setParameterValueById(param.id, param.max);
      core.update();
      const after = core.getDrawableVertices(drawable);
      let movement = 0;
      let xMovement = 0;
      let affected = 0;
      for (let i = 0; i < before.length; i++)
        movement = Math.max(movement, Math.abs(after[i] - before[i]));
      for (let i = 0; i < before.length; i += 2) {
        if (Math.abs(after[i] - before[i]) > 0.00001) {
          xMovement += after[i] - before[i];
          affected++;
        }
      }
      influence.push({
        id: param.id,
        movement,
        meanX: xMovement / Math.max(1, affected),
      });
    }
    return {
      supported: true,
      nativePhysics: !!internal.physics,
      metadata,
      influence,
      frames,
    };
  } finally {
    internal.off("afterMotionUpdate", drive);
    internal.off("beforeModelUpdate", capture);
    internal.updateNaturalMovements = natural;
    internal.updateFocus = focus;
    internal.motionManager.update = motions;
    parameters.values.set(savedValues);
    core.saveParameters();
    core.update();
    avatar.autoUpdate = autoUpdate;
    avatar.autoInteract = autoInteract;
    if (running) app.start();
  }
}

function assertHairDynamics(sample) {
  assert.ok(sample.supported, "测试模型具有三段辫子参数");
  for (const param of sample.metadata) {
    const peak = Math.max(
      ...sample.frames.map((frame) => Math.abs(frame[param.id])),
    );
    assert.ok(
      peak > (param.max - param.min) * 0.02,
      `转头后 ${param.id} 应产生独立惯性摆动，实际峰值 ${peak}`,
    );
  }
  assert.ok(
    sample.influence.every((value) => value.movement > 0.00001),
    "六个辫子参数实际影响发片网格",
  );
  const turn = sample.frames.filter((frame) => frame.phase === "turn");
  const release = sample.frames.filter((frame) => frame.phase === "release");
  for (const side of ["L", "R"]) {
    const peakAt = (suffix) => {
      const id = `ParamHairSide${side}${suffix}`;
      return turn.reduce(
        (best, frame, index) =>
          Math.abs(frame[id]) > Math.abs(turn[best][id]) ? index : best,
        0,
      );
    };
    assert.ok(peakAt("Mid") > peakAt(""), `${side} 辫子中段应晚于发根响应`);
    assert.ok(peakAt("Tip") > peakAt("Mid"), `${side} 发梢应晚于中段响应`);
    const root = sample.influence.find(
      (value) => value.id === `ParamHairSide${side}`,
    );
    const head = sample.influence.find((value) => value.id === "ParamAngleX");
    assert.ok(
      turn[0][root.id] * root.meanX * head.meanX < 0,
      `${side} 辫子初始惯性方向应与头部位移相反`,
    );
  }
  for (const param of sample.metadata) {
    assert.ok(
      sample.frames.every(
        (frame) =>
          frame[param.id] >= param.min - 0.00001 &&
          frame[param.id] <= param.max + 0.00001,
      ),
      `${param.id} 不越过模型参数范围`,
    );
    assert.ok(
      Math.abs(release.at(-1)[param.id]) < 0.002,
      `${param.id} 停头后应衰减回静止`,
    );
  }
}

async function recordHairDemo() {
  const app = window.__live2dTestApps.findLast(
    (value) => value.stage?.children.length,
  );
  const avatar = app.stage.children[0];
  const automatic = avatar.autoInteract;
  const stream = app.view.captureStream(30);
  const chunks = [];
  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
    ? "video/webm;codecs=vp9"
    : "video/webm";
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 2000000,
  });
  const finished = new Promise((done, reject) => {
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onstop = done;
    recorder.onerror = reject;
  });
  try {
    avatar.autoInteract = false;
    recorder.start();
    for (const [x, duration] of [
      [0, 600],
      [0.85, 1000],
      [-0.85, 1200],
      [0, 1500],
    ]) {
      avatar.internalModel.focusController.focus(x, 0);
      await new Promise((done) => setTimeout(done, duration));
    }
    recorder.stop();
    await finished;
    return Array.from(
      new Uint8Array(await new Blob(chunks, { type: mimeType }).arrayBuffer()),
    );
  } finally {
    if (recorder.state !== "inactive") recorder.stop();
    for (const track of stream.getTracks()) track.stop();
    avatar.autoInteract = automatic;
    avatar.internalModel.focusController.focus(0, 0);
  }
}

let desktop;
const errors = [];
const consoleErrors = [];
const report = { modelPath, corePath, passed: false };
try {
  const env = { ...process.env, MAI_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  desktop = await electron.launch({
    executablePath: resolve("node_modules/electron/dist/electron.exe"),
    args: [
      ".",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-features=CalculateNativeWinOcclusion",
    ],
    cwd: resolve("."),
    env,
    timeout: 30000,
  });
  await desktop.firstWindow();
  const context = desktop.context();
  const page = context
    .pages()
    .find((value) => value.url().includes("view=dashboard"));
  const pet = context.pages().find((value) => value.url().includes("view=pet"));
  assert.ok(page && pet, "控制面板和桌宠均已启动");
  await desktop.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.setBackgroundThrottling(false);
  });
  const targets = [
    ["dashboard", page],
    ["pet", pet],
  ];
  for (const [name, target] of targets) {
    target.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
    target.on("console", (message) => {
      if (message.type() === "error")
        consoleErrors.push(`${name}: ${message.text()}`);
    });
    target.on("requestfailed", (request) =>
      errors.push(`${name}: ${request.url()} ${request.failure()?.errorText}`),
    );
    await target.evaluate(observePixi);
  }
  await page.waitForFunction(() => !!window.mai);
  await desktop.evaluate(
    ({ dialog }, paths) => {
      let next = 0;
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [paths[next++]],
      });
    },
    [modelPath, corePath],
  );
  await page.evaluate(() => window.mai.importModel());
  const state = await page.evaluate(() => window.mai.snapshot());
  assert.equal(state.models.length, 1, "模型已导入隔离数据目录");
  assert.equal(state.models[0].kind, "live2d");
  assert.equal(state.settings.activeModelId, state.models[0].id);
  report.model = state.models[0].entry;
  for (const [name, target] of targets) {
    await target.waitForFunction(
      () => document.querySelector(".model-canvas canvas, .avatar-error"),
      undefined,
      { timeout: 20000 },
    );
    assert.equal(
      await target.locator(".avatar-error").count(),
      0,
      `${name}: ${await target.locator(".avatar-error").allTextContents()}`,
    );
    report[name] = await target.evaluate(modelStats);
    assert.ok(report[name].visiblePixels > 100, `${name} 的模型不是空白画布`);
    for (const id of ["ParamEyeLOpen", "ParamEyeROpen", "ParamMouthOpenY"])
      assert.ok(report[name].parameterIds.includes(id), `测试模型需要 ${id}`);
    await target.evaluate(startSampling);
  }
  if (process.argv.includes("--hair-only")) {
    report.hair = await pet.evaluate(sampleHairDynamics);
    console.log(
      `辫子参数：${JSON.stringify(report.hair.metadata)}；原生物理：${report.hair.nativePhysics}`,
    );
    console.log(`发片网格响应：${JSON.stringify(report.hair.influence)}`);
    assertHairDynamics(report.hair);
    if (process.argv.includes("--record-hair")) {
      await writeFile(
        join(base, "hair-dynamics.webm"),
        Buffer.from(await pet.evaluate(recordHairDemo)),
      );
      console.log(`辫子效果预览：${join(base, "hair-dynamics.webm")}`);
    }
    await pet.evaluate(() => {
      window.__previousHairApp = window.__live2dTestApps.findLast(
        (value) => value.stage?.children.length,
      );
    });
    await page.evaluate(() =>
      window.mai.updateSettings({ reducedMotion: true }),
    );
    await pet.waitForFunction(() => {
      const app = window.__live2dTestApps.findLast(
        (value) => value.stage?.children.length,
      );
      return app && app !== window.__previousHairApp;
    });
    report.reducedHair = await pet.evaluate(sampleHairDynamics);
    assert.ok(
      report.reducedHair.frames.every((frame) =>
        report.reducedHair.metadata.every(
          (param) => Math.abs(frame[param.id]) < 0.00001,
        ),
      ),
      "减少动画时不叠加辫子惯性",
    );
    report.passed = true;
    console.log("PASS Live2D：三段辫子惯性与实际发片网格响应");
  } else {
    if (
      !process.argv.includes("--resolution-only") &&
      report.pet.parameterIds.includes("ParamHairSideLTip")
    ) {
      report.hair = await pet.evaluate(sampleHairDynamics);
      assertHairDynamics(report.hair);
    }
    report.resolutions = [];
    for (const petScale of [1, 1.6, 0.75, 1]) {
      await page.evaluate(
        (value) => window.mai.updateSettings({ petScale: value }),
        petScale,
      );
      await page.waitForTimeout(250);
      const resolution = await pet.evaluate(() => {
        const canvas = document.querySelector(".model-canvas canvas");
        const bounds = canvas.getBoundingClientRect();
        return {
          devicePixelRatio,
          width: canvas.width,
          height: canvas.height,
          cssWidth: canvas.clientWidth,
          cssHeight: canvas.clientHeight,
          displayWidth: bounds.width,
          displayHeight: bounds.height,
        };
      });
      report.resolutions.push({ petScale, ...resolution });
      await pet.screenshot({
        path: join(base, `pet-scale-${petScale}.png`),
        omitBackground: true,
      });
    }
    // 保持 CSS 大小不变，模拟窗口移到不同像素密度的屏幕。
    await page.evaluate(() => window.mai.updateSettings({ petScale: 1.6 }));
    await page.waitForTimeout(250);
    const cdp = await context.newCDPSession(pet);
    try {
      for (const deviceScaleFactor of [2, 3]) {
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width: 544,
          height: 640,
          deviceScaleFactor,
          mobile: false,
        });
        await pet.waitForFunction(
          (value) => Math.abs(devicePixelRatio - value) < 0.01,
          deviceScaleFactor,
        );
        for (const petScale of [1.6, 0.75, 1]) {
          await page.evaluate(
            (value) => window.mai.updateSettings({ petScale: value }),
            petScale,
          );
          await page.waitForTimeout(250);
          report.resolutions.push({
            petScale,
            ...(await pet.evaluate(() => {
              const canvas = document.querySelector(".model-canvas canvas");
              const bounds = canvas.getBoundingClientRect();
              return {
                devicePixelRatio,
                width: canvas.width,
                height: canvas.height,
                cssWidth: canvas.clientWidth,
                cssHeight: canvas.clientHeight,
                displayWidth: bounds.width,
                displayHeight: bounds.height,
              };
            })),
          });
        }
      }
    } finally {
      await cdp.send("Emulation.clearDeviceMetricsOverride");
      await cdp.detach();
    }
    await page.evaluate(() => window.mai.updateSettings({ petScale: 1 }));
    await page.bringToFront();
    await page.waitForTimeout(250);
    console.log(`Live2D 画布密度：${JSON.stringify(report.resolutions)}`);
    for (const sample of report.resolutions) {
      assert.ok(
        sample.width + 1 >= sample.displayWidth * sample.devicePixelRatio &&
          sample.height + 1 >= sample.displayHeight * sample.devicePixelRatio,
        `角色缩放 ${sample.petScale ?? "高 DPI"}：画布 ${sample.width}×${sample.height} 不足以覆盖 ${sample.displayWidth}×${sample.displayHeight} 显示像素在 ${sample.devicePixelRatio} 倍屏幕上的显示`,
      );
    }
    if (process.argv.includes("--resolution-only")) {
      report.passed = true;
      console.log("PASS Live2D：高 DPI 与动态角色缩放保持原生画布密度");
      process.exitCode = 0;
    } else {
      report.samples = {};
      for (const mood of ["idle", "speaking", "sleeping", "idle"]) {
        await page.evaluate((value) => window.mai.setMood(value), mood);
        for (const [, target] of targets) {
          await target.waitForFunction(
            async (value) => (await window.mai.snapshot()).mood === value,
            mood,
          );
        }
        await page.waitForTimeout(120);
        for (const [, target] of targets) {
          await target.evaluate(takeFrames);
        }
        await page.waitForTimeout(1400);
        for (const [name, target] of targets) {
          const frames = await target.evaluate(takeFrames);
          report.samples[
            `${mood}-${name}-${Object.keys(report.samples).length}`
          ] = frames;
          assert.ok(frames.length >= 5, `${name} 持续绘制 ${mood} 状态`);
          if (mood === "speaking") {
            const values = frames.map((frame) => frame.ParamMouthOpenY);
            assert.ok(Math.max(...values) > 0.2, `${name} 说话时张嘴`);
            assert.ok(
              Math.max(...values) - Math.min(...values) > 0.1,
              `${name} 口型持续变化`,
            );
          } else {
            assert.ok(
              frames.every((frame) => frame.ParamMouthOpenY < 0.001),
              `${name} 停止说话后闭嘴`,
            );
          }
          if (mood === "sleeping")
            assert.ok(
              frames.every(
                (frame) =>
                  frame.ParamEyeLOpen < 0.001 && frame.ParamEyeROpen < 0.001,
              ),
              `${name} 睡眠时应持续闭眼，实际：${JSON.stringify(frames[0])}`,
            );
          if (mood === "idle")
            assert.ok(
              frames.some((frame) => frame.ParamEyeLOpen > 0.5),
              `${name} 清醒时能睁眼`,
            );
        }
        if (mood === "sleeping")
          await pet.screenshot({
            path: join(base, "sleeping.png"),
            omitBackground: true,
          });
      }
      report.motions = {};
      for (const group of report.pet.motionGroups) {
        if (/^idle$/i.test(group)) continue;
        report.motions[group] = await pet.evaluate(async (name) => {
          const app = window.__live2dTestApps.findLast(
            (value) => value.stage?.children.length,
          );
          return app.stage.children[0].motion(name, 0, 3);
        }, group);
        assert.ok(report.motions[group], `${group} 动作加载并播放`);
        await page.waitForTimeout(900);
      }
      await page.screenshot({
        path: join(base, "dashboard.png"),
        fullPage: true,
      });
      await pet.screenshot({
        path: join(base, "pet.png"),
        omitBackground: true,
      });
      assert.deepEqual(errors, []);
      assert.deepEqual(consoleErrors, []);
      report.passed = true;
      console.log(
        "PASS Live2D：实际模型导入、双窗口非空渲染、动态缩放与高 DPI 画布密度、口型、睡眠闭眼、醒来与动作播放",
      );
      console.log(`截图与报告：${base}`);
    }
  }
} finally {
  try {
    await writeFile(
      join(base, "result.json"),
      JSON.stringify({ ...report, errors, consoleErrors }, null, 2),
    );
  } finally {
    await desktop?.close();
    assert.ok(userData.startsWith(base + sep));
    await rm(userData, { recursive: true, force: true });
  }
}
