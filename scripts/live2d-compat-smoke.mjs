import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { _electron as electron } from "playwright";

// Public sample models stay in the ignored cache, never in the application.
// Shizuku/Haru: Live2D Free Material License (upstream README).
const base = resolve(".cache/live2d-compat");
await mkdir(base, { recursive: true });
const upstream =
  "https://raw.githubusercontent.com/guansss/pixi-live2d-display/31317b37d5e22955a44d5b11f37f421e94a11269/test/assets/";
const neko =
  "https://raw.githubusercontent.com/Project-N-E-K-O/N.E.K.O/c65adc2bb467c812c5fd948c8031aa96d48c0e14/static/";
const fixtures = [
  {
    name: "Shizuku",
    base: upstream + "shizuku/",
    entry: "shizuku.model.json",
    legacy: true,
    mouth: "PARAM_MOUTH_OPEN_Y",
  },
  {
    name: "Haru",
    base: upstream + "haru/",
    entry: "haru_greeter_t03.model3.json",
    mouth: "ParamMouthOpenY",
  },
  {
    name: "Mao",
    base: neko + "mao_pro/",
    entry: "mao_pro.model3.json",
    mouth: "ParamA",
  },
];

async function download(url, file) {
  try {
    await access(file);
    return;
  } catch {}
  let failure;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(30000),
        redirect: "error",
      });
      if (!response.ok) {
        if (response.status === 404 && url.endsWith(".cdi3.json")) return;
        throw new Error(`${response.status} ${url}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, bytes);
      return;
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

for (const fixture of fixtures) {
  fixture.directory = join(base, fixture.name);
  fixture.file = join(fixture.directory, fixture.entry);
  await download(fixture.base + fixture.entry, fixture.file);
  const config = JSON.parse(await readFile(fixture.file, "utf8"));
  const refs = config.FileReferences || config;
  fixture.physics = Boolean(refs.Physics || refs.physics);
  fixture.pose = Boolean(refs.Pose || refs.pose);
  // Upstream Haru's test package reuses Shizuku sounds outside its directory.
  // Make the fixture self-contained, preserving the application's path boundary.
  for (const motions of Object.values(refs.Motions || {}))
    for (const motion of motions) {
      if (motion.Sound?.startsWith("../")) {
        const local = "sounds/" + basename(motion.Sound);
        await download(
          new URL(motion.Sound, fixture.base).href,
          join(fixture.directory, local),
        );
        motion.Sound = local;
      }
    }
  await writeFile(fixture.file, JSON.stringify(config, null, 2));
  const files = new Set();
  const collect = (value, key = "") => {
    if (
      typeof value === "string" &&
      /^(Moc|model|File|file|Sound|sound|Physics|physics|Pose|pose|UserData|DisplayInfo|Textures|textures)$/.test(
        key,
      )
    )
      files.add(value);
    else if (Array.isArray(value)) value.forEach((item) => collect(item, key));
    else if (value && typeof value === "object")
      Object.entries(value).forEach(([name, item]) => collect(item, name));
  };
  collect(refs);
  const pending = [...files];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (pending.length) {
        const file = pending.shift();
        await download(
          new URL(file, fixture.base).href,
          join(fixture.directory, file),
        );
      }
    }),
  );
  console.log(`Fixture ready: ${fixture.name} (${files.size} resources)`);
}
await download(neko + "libs/live2d.min.js", join(base, "live2d.min.js"));
const modernCore = join(base, "live2dcubismcore.min.js");
try {
  await access(modernCore);
} catch {
  try {
    await copyFile(
      resolve(".cache/live2d/live2dcubismcore.min.js"),
      modernCore,
    );
  } catch {
    await download(
      "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js",
      modernCore,
    );
  }
}
if (process.argv[2]) {
  const file = resolve(process.argv[2]);
  const config = JSON.parse(await readFile(file, "utf8"));
  fixtures.push({
    name: "Local-Cubism5",
    file,
    directory: dirname(file),
    entry: basename(file),
    mouth: "ParamMouthOpenY",
    physics: Boolean(config.FileReferences.Physics),
    pose: Boolean(config.FileReferences.Pose),
  });
}

const profile = await mkdtemp(join(base, "profile-"));
const bootstrap = join(profile, "bootstrap.mjs");
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
await writeFile(
  bootstrap,
  `import { BrowserWindow } from 'electron';
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.showInactive = function () {};
await import(${JSON.stringify(pathToFileURL(resolve("out/main/index.js")).href)});`,
);

async function until(predicate, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 40));
  }
  throw new Error(message);
}

function observe() {
  // Hidden test windows still exercise the real WebGL renderer and screenshots.
  Object.defineProperty(document, "hidden", { get: () => false });
  window.__apps = [];
  const registered = new Set();
  let pixi;
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
          window.__apps.push(this);
        },
        destroy() {},
      });
    },
  });
}

function stats() {
  const app = window.__apps.findLast((value) => value.stage?.children.length);
  if (!app) return null;
  const avatar = app.stage.children[0];
  const internal = avatar.internalModel;
  // Read the displayed viewport. Extracting the unscaled model can allocate a
  // render target larger than the GPU limit for large Cubism canvases.
  app.render();
  const pixels = app.renderer.extract.pixels();
  let visible = 0;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) visible++;
  const clipping = internal.renderer?._clippingManager;
  return {
    visible,
    entry: internal.settings.url,
    physics: Boolean(internal.physics),
    pose: Boolean(internal.pose),
    size: {
      width: avatar.width,
      height: avatar.height,
      scale: avatar.scale.x,
      alpha: avatar.alpha,
    },
    motions: Object.keys(internal.motionManager.definitions),
    masks: clipping?._clippingContextListForMask.length ?? 0,
    maskTextures: clipping?._renderTextureCount ?? 0,
    parameterIds: internal.coreModel.getModel?.().parameters.ids,
    mocVersion: internal.__moc?._mocVersion,
  };
}

let desktop;
const report = [];
const errors = [];
const consoleErrors = [];
try {
  const env = { ...process.env, MAI_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  desktop = await electron.launch({
    executablePath: resolve("node_modules/electron/dist/electron.exe"),
    args: [bootstrap, "--disable-renderer-backgrounding"],
    env,
  });
  let page, pet;
  await until(() => {
    page = desktop
      .windows()
      .find((value) => value.url().includes("view=dashboard"));
    pet = desktop.windows().find((value) => value.url().includes("view=pet"));
    return page && pet;
  }, "Electron windows did not load");
  for (const window of [page, pet]) {
    window.on("pageerror", (error) => errors.push(error.message));
    window.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning")
        consoleErrors.push(message.text());
    });
    await window.addInitScript(observe);
    await window.reload();
  }
  await pet.locator(".pet-character").waitFor();
  // Supply pinned runtime responses without reaching real services from Electron.
  await desktop.evaluate(
    ({ net }, cores) => {
      const original = net.fetch.bind(net);
      net.fetch = (url, options) => {
        const source = cores[String(url)];
        return source
          ? Promise.resolve(new Response(source))
          : original(url, options);
      };
    },
    {
      [neko + "libs/live2d.min.js"]: await readFile(
        join(base, "live2d.min.js"),
        "utf8",
      ),
      "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js":
        await readFile(modernCore, "utf8"),
    },
  );
  const imported = [];
  for (const fixture of fixtures) {
    await desktop.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [directory],
      });
    }, fixture.directory);
    await page.evaluate(() => window.mai.importModel("folder"));
    const state = await page.evaluate(() => window.mai.snapshot());
    const model = state.models.at(-1);
    imported.push(model);
    for (const window of [page, pet]) {
      await until(async () => {
        const failure = await window.locator(".avatar-error").allTextContents();
        if (failure.length)
          throw new Error(`${fixture.name}: ${failure.join(" ")}`);
        const info = await window.evaluate(stats);
        return info?.entry.includes(model.id) && info.visible > 100;
      }, `${fixture.name} did not render`).catch(async (error) => {
        console.error(
          JSON.stringify(
            {
              fixture: fixture.name,
              stats: await window.evaluate(stats),
              errors,
              consoleErrors: [...new Set(consoleErrors)].slice(-20),
            },
            null,
            2,
          ),
        );
        await window.screenshot({ path: join(base, "failure.png") });
        throw error;
      });
      const info = await window.evaluate(stats);
      assert.equal(info.physics, fixture.physics, `${fixture.name} physics`);
      assert.equal(info.pose, fixture.pose, `${fixture.name} pose`);
      assert.ok(info.motions.length > 0);
      report.push({
        fixture: fixture.name,
        window: window === pet ? "pet" : "dashboard",
        ...info,
      });
    }
    await pet.screenshot({ path: join(base, `${fixture.name}.png`) });
    const motion = await pet.evaluate(async () => {
      const app = window.__apps.findLast(
        (value) => value.stage?.children.length,
      );
      const avatar = app.stage.children[0];
      const manager = avatar.internalModel.motionManager;
      const candidates = Object.entries(manager.definitions).flatMap(
        ([group, definitions]) =>
          definitions.map((value, index) => ({ group, index, value })),
      );
      const target = candidates.find(
        ({ group, index, value }) =>
          !value.sound && !value.Sound && !manager.state.isActive(group, index),
      );
      if (!target) return false;
      return avatar.motion(target.group, target.index, 3);
    });
    assert.equal(motion, true, `${fixture.name} motion should start`);
    const expressions = JSON.parse(await readFile(fixture.file, "utf8"));
    if (
      (expressions.FileReferences?.Expressions || expressions.expressions)
        ?.length
    )
      assert.equal(
        await pet.evaluate(async () =>
          window.__apps
            .findLast((value) => value.stage?.children.length)
            .stage.children[0].expression(0),
        ),
        true,
        `${fixture.name} expression should apply`,
      );
    // Sample after the app's face hook, at the actual model update boundary.
    await pet.evaluate(({ mouth, legacy }) => {
      const app = window.__apps.findLast(
        (value) => value.stage?.children.length,
      );
      const internal = app.stage.children[0].internalModel;
      window.__mouthFrames = [];
      internal.on("beforeModelUpdate", () => {
        window.__mouthFrames.push(
          legacy
            ? internal.coreModel.getParamFloat(mouth)
            : internal.coreModel.getParameterValueById(mouth),
        );
        if (window.__mouthFrames.length > 200) window.__mouthFrames.shift();
      });
    }, fixture);
    const playbackId = randomUUID();
    await page.evaluate((id) => {
      window.mai.reportPlayback({ type: "start", id });
      window.mai.reportPlayback({ type: "playing", id, mouth: 0.8 });
    }, playbackId);
    await until(
      async () =>
        pet.evaluate(() => window.__mouthFrames.some((value) => value > 0.5)),
      `${fixture.name} custom mouth did not move`,
    );
    await page.evaluate(
      (id) => window.mai.reportPlayback({ type: "end", id }),
      playbackId,
    );
    console.log(
      `PASS ${fixture.name}: two windows, physics, motions, expression, mouth`,
    );
  }
  for (const model of [imported[0], imported[2], imported[1], imported[0]]) {
    await page.evaluate(
      (id) => window.mai.updateSettings({ activeModelId: id }),
      model.id,
    );
    await until(async () => {
      const info = await pet.evaluate(stats);
      return info?.entry.includes(model.id) && info.visible > 100;
    }, "Legacy/modern switching failed");
  }
  const stored = JSON.parse(
    await readFile(join(profile, "state.json"), "utf8"),
  );
  assert.equal(stored.models.length, fixtures.length);
  await desktop.close();
  desktop = undefined;
  desktop = await electron.launch({
    executablePath: resolve("node_modules/electron/dist/electron.exe"),
    args: [bootstrap, "--disable-renderer-backgrounding"],
    env,
  });
  await until(() => {
    page = desktop
      .windows()
      .find((value) => value.url().includes("view=dashboard"));
    pet = desktop.windows().find((value) => value.url().includes("view=pet"));
    return page && pet;
  }, "Restarted windows did not load");
  await desktop.evaluate(({ net }) => {
    const original = net.fetch.bind(net);
    globalThis.__externalRequests = [];
    net.fetch = (url, options) => {
      if (/^https?:/.test(String(url))) {
        globalThis.__externalRequests.push(String(url));
        return Promise.reject(new Error("Offline compatibility test"));
      }
      return original(url, options);
    };
  });
  for (const window of [page, pet]) {
    window.on("pageerror", (error) => errors.push(error.message));
    await window.addInitScript(observe);
    await window.reload();
  }
  const restored = await page.evaluate(() => window.mai.snapshot());
  assert.ok(
    restored.live2dCoreReady && restored.live2dLegacyReady,
    "Both verified runtimes must survive restart",
  );
  for (const model of [imported[0], imported[2]]) {
    await page.evaluate(
      (id) => window.mai.updateSettings({ activeModelId: id }),
      model.id,
    );
    for (const window of [page, pet])
      await until(async () => {
        const info = await window.evaluate(stats);
        return info?.entry.includes(model.id) && info.visible > 100;
      }, "Offline legacy/modern rendering failed");
  }
  assert.deepEqual(
    await desktop.evaluate(() => globalThis.__externalRequests),
    [],
  );
  await page.getByText("角色衣橱", { exact: true }).click();
  await page.getByRole("button", { name: "导入模型文件夹" }).waitFor();
  await page.screenshot({ path: join(base, "wardrobe.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await writeFile(
    join(base, "result.json"),
    JSON.stringify(
      {
        passed: true,
        offlineRestart: true,
        renderer: "pixi-live2d-display-lipsyncpatch@0.5.0-ls-8",
        report,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS Live2D compatibility: Cubism 2 + moc3, N.E.K.O Mao, runtime coexistence, repeated switching and offline restart",
  );
} finally {
  await desktop?.close();
  if (!profile.startsWith(base + sep))
    throw new Error("Unexpected test profile path");
  await rm(profile, { recursive: true, force: true });
}
