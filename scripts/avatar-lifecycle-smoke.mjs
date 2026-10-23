import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { _electron as electron } from "playwright";
import { createGlb } from "./model-fixture.mjs";

// Cache the public Haru sample once with test:live2d-compat. This test is offline.
// --three-only also runs on a fresh checkout, without a Live2D sample or runtime.
const threeOnly = process.argv.includes("--three-only");
const sample = resolve(".cache/live2d-compat/Haru");
const core = resolve(".cache/live2d-compat/live2dcubismcore.min.js");
if (!threeOnly)
  for (const file of [join(sample, "haru_greeter_t03.model3.json"), core])
    await access(file).catch(() => {
      throw new Error(
        "Run npm run test:live2d-compat once to cache Haru and its runtime",
      );
    });

const texture =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";

function texturedGlb() {
  const original = createGlb();
  const jsonLength = original.readUInt32LE(12);
  const json = JSON.parse(original.subarray(20, 20 + jsonLength).toString());
  const positions = original.subarray(28 + jsonLength);
  const uv = Buffer.from(new Float32Array([0, 0, 1, 0, 0.5, 1]).buffer);
  const binary = Buffer.concat([positions, uv]);
  json.meshes[0].primitives[0].attributes.TEXCOORD_0 = 1;
  json.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
  json.textures = [{ source: 0 }];
  json.images = [{ uri: texture }];
  json.bufferViews.push({
    buffer: 0,
    byteOffset: positions.length,
    byteLength: uv.length,
  });
  json.accessors.push({
    bufferView: 1,
    componentType: 5126,
    count: 3,
    type: "VEC2",
  });
  json.buffers[0].byteLength = binary.length;
  const source = Buffer.from(JSON.stringify(json));
  const padded = Buffer.concat([
    source,
    Buffer.alloc((4 - (source.length % 4)) % 4, 32),
  ]);
  const result = Buffer.alloc(28 + padded.length + binary.length);
  result.writeUInt32LE(0x46546c67, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(padded.length, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(result, 20);
  result.writeUInt32LE(binary.length, 20 + padded.length);
  result.writeUInt32LE(0x004e4942, 24 + padded.length);
  binary.copy(result, 28 + padded.length);
  return result;
}

function observe(texture) {
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
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    this.__url = String(url);
    return open.call(this, method, url, ...args);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (window.__holdLive2d && this.__url.includes(".model3.json")) {
      window.__holdLive2d = false;
      window.__resumeLive2d = () => send.apply(this, args);
      return;
    }
    return send.apply(this, args);
  };

  // Only the fixture's texture transport is supplied here. Real GLTF parsing,
  // image decoding, rendering and disposal run in the packaged renderer.
  const fetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (String(input) === texture) {
      const bytes = Uint8Array.from(atob(texture.split(",")[1]), (c) =>
        c.charCodeAt(0),
      );
      return Promise.resolve(
        new Response(bytes, { headers: { "Content-Type": "image/png" } }),
      );
    }
    return fetch(input, init);
  };
  const decode = window.createImageBitmap.bind(window);
  window.createImageBitmap = (...args) => {
    if (window.__holdThree) {
      window.__holdThree = false;
      return new Promise((resolve, reject) => {
        window.__resumeThree = () => decode(...args).then(resolve, reject);
      });
    }
    return decode(...args);
  };
  const getContext = HTMLCanvasElement.prototype.getContext;
  const seen = new WeakSet();
  window.__threeContexts = [];
  HTMLCanvasElement.prototype.getContext = function (...args) {
    const gl = getContext.apply(this, args);
    if (window.__captureThree && gl?.isContextLost && !seen.has(gl)) {
      seen.add(gl);
      const record = { canvas: this, gl, draws: 0 };
      window.__threeContexts.push(record);
      for (const name of ["drawArrays", "drawElements"]) {
        const draw = gl[name].bind(gl);
        gl[name] = (...args) => {
          record.draws++;
          return draw(...args);
        };
      }
    }
    return gl;
  };
}

async function until(predicate, message) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 40));
  }
  throw new Error(message);
}

const base = resolve(".cache/avatar-lifecycle-smoke");
await mkdir(base, { recursive: true });
const profile = await mkdtemp(join(base, "profile-"));
const bootstrap = join(profile, "bootstrap.mjs");
const glb = join(profile, "lifecycle.glb");
let desktop;
try {
  await writeFile(glb, texturedGlb());
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
  const errors = [];
  for (const window of [page, pet]) {
    window.on("pageerror", (error) => errors.push(error.message));
    await window.addInitScript(observe, texture);
    await window.reload();
  }
  await pet.locator(".pet-character").waitFor();
  await desktop.evaluate(
    ({ net }, source) => {
      const fetch = net.fetch.bind(net);
      net.fetch = (url, options) => {
        if (
          String(url) ===
            "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js" &&
          source
        )
          return Promise.resolve(new Response(source));
        if (/^https?:/.test(String(url)))
          return Promise.reject(
            new Error("Unexpected external request in offline lifecycle test"),
          );
        return fetch(url, options);
      };
    },
    threeOnly ? null : await readFile(core, "utf8"),
  );
  async function importModel(file, source) {
    await desktop.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
    }, file);
    await page.evaluate((source) => window.mai.importModel(source), source);
  }
  async function checkCurrentCanvas(label) {
    assert.equal(
      await pet.locator(".pet-character canvas").count(),
      1,
      `${label}: one canvas`,
    );
    assert.equal(
      await pet.evaluate(() => window.__currentCanvas.isConnected),
      true,
      `${label}: current canvas is attached`,
    );
    assert.equal(
      await pet.evaluate(
        () =>
          document.querySelector(".pet-character canvas") ===
          window.__currentCanvas,
      ),
      true,
      `${label}: keep the current renderer`,
    );
  }

  if (!threeOnly) {
    await pet.evaluate(() => {
      window.__holdLive2d = true;
    });
    await importModel(sample, "folder");
    await until(
      () => pet.evaluate(() => Boolean(window.__resumeLive2d)),
      "First Live2D load was not delayed",
    );
    await page.evaluate(() =>
      window.mai.updateSettings({ reducedMotion: true }),
    );
    await until(
      () =>
        pet.evaluate(() =>
          window.__apps.some((app) => app.stage?.children.length),
        ),
      "Replacement Live2D renderer did not mount",
    );
    await pet.evaluate(() => {
      window.__currentCanvas = document.querySelector(".pet-character canvas");
    });
    await checkCurrentCanvas("Live2D before releasing obsolete load");
    await pet.evaluate(() => window.__resumeLive2d());
    await until(
      () => pet.evaluate(() => window.__apps.some((app) => !app.stage)),
      "Obsolete Live2D renderer was not disposed",
    );
    await checkCurrentCanvas("Live2D after releasing obsolete load");
    assert.equal(
      await pet.evaluate(() => window.__apps.filter((app) => app.stage).length),
      1,
      "Only one Live2D renderer remains",
    );
    const visible = await pet.evaluate(() => {
      const app = window.__apps.find((app) => app.stage);
      app.render();
      const pixels = app.renderer.extract.pixels();
      let visible = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) visible++;
      return visible;
    });
    assert.ok(
      visible > 100,
      "Current Live2D model still renders visible pixels",
    );
    await page.evaluate(() =>
      window.mai.updateSettings({ activeModelId: null, reducedMotion: false }),
    );
    await until(
      () => pet.evaluate(() => window.__apps.every((app) => !app.stage)),
      "Unmount should release the current Live2D renderer",
    );
    console.log(
      "PASS Live2D: late load preserves current canvas; both renderers dispose on cancellation/unmount",
    );
  }

  await pet.evaluate(() => {
    window.__holdThree = true;
    window.__captureThree = true;
  });
  await importModel(glb, "file");
  await until(
    () => pet.evaluate(() => Boolean(window.__resumeThree)),
    "First Three texture decode was not delayed",
  );
  await page.evaluate(() => window.mai.updateSettings({ reducedMotion: true }));
  await until(
    () =>
      pet.evaluate(() =>
        window.__threeContexts.some(
          (record) => record.canvas.isConnected && record.draws > 0,
        ),
      ),
    "Replacement Three renderer did not render",
  );
  await pet.evaluate(() => {
    window.__currentCanvas = document.querySelector(".pet-character canvas");
  });
  await checkCurrentCanvas("Three before releasing obsolete load");
  await pet.evaluate(() => window.__resumeThree());
  await until(
    () =>
      pet.evaluate(() =>
        window.__threeContexts.some((record) => record.gl.isContextLost()),
      ),
    "Obsolete Three renderer did not release its WebGL context",
  );
  await checkCurrentCanvas("Three after releasing obsolete load");
  assert.equal(
    await pet.evaluate(
      () =>
        window.__threeContexts.filter((record) => !record.gl.isContextLost())
          .length,
    ),
    1,
    "Only one Three WebGL context remains",
  );
  const draws = await pet.evaluate(
    () =>
      window.__threeContexts.find(
        (record) => record.canvas === window.__currentCanvas,
      ).draws,
  );
  await until(
    () =>
      pet.evaluate(
        (draws) =>
          window.__threeContexts.find(
            (record) => record.canvas === window.__currentCanvas,
          ).draws > draws,
        draws,
      ),
    "Current Three renderer stopped drawing after obsolete load finished",
  );
  await page.evaluate(() => window.mai.updateSettings({ activeModelId: null }));
  await until(
    () =>
      pet.evaluate(() =>
        window.__threeContexts.every((record) => record.gl.isContextLost()),
      ),
    "Unmount should release the current Three WebGL context",
  );
  assert.equal(await pet.locator(".pet-character canvas").count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS Three: late load preserves current canvas and animation; both WebGL contexts release on cancellation/unmount",
  );
} finally {
  await desktop?.close();
  if (!profile.startsWith(base + sep))
    throw new Error("Unexpected test profile path");
  await rm(profile, { recursive: true, force: true });
}
