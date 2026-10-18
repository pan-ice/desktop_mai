import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

// 同源页面会共享 Electron 的页面缩放，必须覆盖实际开发服务中的双窗口。
const development = process.argv.includes("--dev");
const base = resolve(".cache/window-scale-smoke");
await mkdir(base, { recursive: true });
const userData = await mkdtemp(join(base, "userdata-"));
let desktop;
let renderer;
const errors = [];

async function settle(page) {
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
}

async function dashboardMetrics(page) {
  await settle(page);
  return page.locator("h1").evaluate((heading) => ({
    fontPixels:
      parseFloat(getComputedStyle(heading).fontSize) * devicePixelRatio,
    viewportWidth: innerWidth,
  }));
}

async function windowMetrics() {
  return desktop.evaluate(({ BrowserWindow }) =>
    Object.fromEntries(
      BrowserWindow.getAllWindows().map((window) => [
        new URL(window.webContents.getURL()).searchParams.get("view"),
        {
          zoom: window.webContents.getZoomFactor(),
          size: window.getContentSize(),
        },
      ]),
    ),
  );
}

async function openWindows(env) {
  desktop = await electron.launch({
    executablePath: resolve("node_modules/electron/dist/electron.exe"),
    args: [".", "--disable-renderer-backgrounding"],
    cwd: resolve("."),
    env,
    timeout: 30000,
  });
  await desktop.firstWindow();
  const context = desktop.context();
  async function findWindow(view) {
    const page =
      context.pages().find((item) => item.url().includes(`view=${view}`)) ||
      (await context.waitForEvent("page", (item) =>
        item.url().includes(`view=${view}`),
      ));
    page.on("pageerror", (error) => errors.push(error.message));
    return page;
  }
  const page = await findWindow("dashboard");
  const pet = await findWindow("pet");
  await page.getByRole("button", { name: "偏好设置", exact: true }).click();
  await pet.locator(".pet-character").waitFor();
  return { page, pet };
}

async function assertScale({ page, pet }, scale, baseline) {
  await pet.waitForFunction(
    async (expected) =>
      Math.abs((await window.mai.snapshot()).settings.petScale - expected) <
      0.00001,
    scale,
  );
  await pet.waitForFunction(
    (expected) =>
      Math.abs(innerWidth - Math.round(340 * expected)) <= 1 &&
      Math.abs(innerHeight - Math.round(400 * expected)) <= 1,
    scale,
    { timeout: 5000 },
  );
  const current = await dashboardMetrics(page);
  const windows = await windowMetrics();
  assert.deepEqual(
    current,
    baseline.font,
    `${scale * 100}% 角色大小不改变控制面板的实际字号和布局`,
  );
  assert.deepEqual(windows.dashboard, baseline.window);
  // 分数 DPI 下系统窗口按物理像素取整，换回逻辑像素最多相差 1px。
  for (const [index, expected] of [340 * scale, 400 * scale].entries())
    assert.ok(Math.abs(windows.pet.size[index] - Math.round(expected)) <= 1);
  await settle(pet);
  const dimensions = await pet.evaluate(() => {
    const surface = document
      .querySelector(".pet-surface")
      .getBoundingClientRect();
    const character = document
      .querySelector(".pet-character")
      .getBoundingClientRect();
    return {
      surfaceWidth: surface.width,
      surfaceHeight: surface.height,
      characterWidth: character.width,
      characterHeight: character.height,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
    };
  });
  for (const [key, expected] of Object.entries({
    surfaceWidth: 340 * scale,
    surfaceHeight: 400 * scale,
    characterWidth: 230 * scale,
    characterHeight: 240 * scale,
    viewportWidth: Math.round(340 * scale),
    viewportHeight: Math.round(400 * scale),
  })) {
    assert.ok(
      Math.abs(dimensions[key] - expected) <= 1,
      `${scale * 100}% 桌宠 ${key} 应为 ${expected}，实际 ${dimensions[key]}`,
    );
  }
  // 在缩放后的坐标实际点击控件，避免只验证了视觉尺寸。
  await pet.getByRole("button", { name: "打开迷你聊天", exact: true }).click();
  await pet.getByRole("textbox", { name: "和麦麦说话", exact: true }).waitFor();
  await pet.getByRole("button", { name: "打开迷你聊天", exact: true }).click();
}

try {
  await writeFile(
    join(userData, "state.json"),
    JSON.stringify({
      version: 2,
      settings: { autoConnect: false, petScale: 1, reducedMotion: true },
      history: [],
      models: [],
      encrypted: {},
    }),
  );
  const env = { ...process.env, MAI_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  if (development) {
    const { createServer } = await import("vite");
    renderer = await createServer({
      configFile: resolve("vite.config.ts"),
      cacheDir: join(userData, "node_modules/.vite"),
      server: {
        host: "127.0.0.1",
        port: 5174,
        strictPort: false,
        watch: { ignored: ["**/.cache/**"] },
      },
    });
    await renderer.listen();
    env.ELECTRON_RENDERER_URL = new URL(renderer.resolvedUrls.local[0]).origin;
  }
  let windows = await openWindows(env);
  const baseline = {
    font: await dashboardMetrics(windows.page),
    window: (await windowMetrics()).dashboard,
  };
  const slider = windows.page.getByRole("slider", { name: /角色大小/ });
  for (const [key, scale] of [
    ["ArrowLeft", 0.95],
    ["ArrowLeft", 0.9],
    ["Home", 0.5],
    ["End", 1.6],
  ]) {
    await slider.press(key);
    await assertScale(windows, scale, baseline);
  }
  // 覆盖鼠标松开时保存，以及隐藏桌宠后仍调整大小的场景。
  await windows.page
    .getByRole("switch", { name: "显示桌宠", exact: true })
    .click();
  const track = await slider.boundingBox();
  await slider.click({ position: { x: track.width / 2, y: track.height / 2 } });
  await windows.page.waitForFunction(
    async () => (await window.mai.snapshot()).settings.petScale === 1.05,
  );
  await windows.page
    .getByRole("switch", { name: "显示桌宠", exact: true })
    .click();
  await assertScale(windows, 1.05, baseline);
  // 重启读取已保存的非 100% 比例，检查启动阶段也不会联动。
  await desktop.close();
  desktop = undefined;
  windows = await openWindows(env);
  await assertScale(windows, 1.05, baseline);
  assert.deepEqual(errors, []);
  console.log(
    `PASS ${development ? "开发服务" : "构建页面"}：角色缩放 50%–160%、鼠标/键盘、隐藏后调整及重启恢复；控制面板字号和布局不变，桌宠尺寸和点击位置正确`,
  );
} finally {
  try {
    await desktop?.close();
  } finally {
    try {
      await renderer?.close();
    } finally {
      assert.ok(userData.startsWith(base + sep));
      await rm(userData, { recursive: true, force: true });
    }
  }
}
