import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { _electron as electron } from "playwright";

assert.equal(process.platform, "win32", "此验收使用 Windows 原生鼠标输入");
const base = resolve(".cache/click-through-ui-smoke");
await mkdir(base, { recursive: true });
const userData = await mkdtemp(join(base, "userdata-"));
const mouseScript = join(userData, "mouse.ps1");
await writeFile(
  mouseScript,
  `param([int]$X, [int]$Y, [int]$Click)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MaiClickThroughMouse {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
'@
$null = [MaiClickThroughMouse]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
if (-not [MaiClickThroughMouse]::SetCursorPos($X, $Y)) { throw "Cannot move the mouse" }
Start-Sleep -Milliseconds 150
if ($Click) {
  [MaiClickThroughMouse]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  [MaiClickThroughMouse]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
}
`,
);

let desktop, originalCursor;
const errors = [];
let launchLog = "";
async function mouse(point, click = true) {
  const physical = await desktop.evaluate(
    ({ screen }, value) => screen.dipToScreenPoint(value),
    point,
  );
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      mouseScript,
      "-X",
      String(physical.x),
      "-Y",
      String(physical.y),
      "-Click",
      click ? "1" : "0",
    ],
    { windowsHide: true, timeout: 10000, stdio: "pipe" },
  );
}

try {
  await writeFile(
    join(userData, "state.json"),
    JSON.stringify({
      version: 2,
      settings: { autoConnect: false, reducedMotion: true },
      history: [],
      models: [],
      encrypted: {},
    }),
  );
  const env = { ...process.env, MAI_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  desktop = await electron.launch({
    executablePath:
      process.env.MAI_TEST_EXE ||
      resolve("node_modules/electron/dist/electron.exe"),
    args: [
      ...(process.env.MAI_TEST_EXE ? [] : ["."]),
      "--disable-renderer-backgrounding",
    ],
    cwd: resolve("."),
    env,
    timeout: 15000,
  });
  desktop.process().stderr.on("data", (chunk) => {
    launchLog = (launchLog + chunk.toString()).slice(-4000);
  });
  await desktop.firstWindow({ timeout: 10000 });
  const pet =
    desktop.windows().find((page) => page.url().includes("view=pet")) ||
    (await desktop.waitForEvent("window", {
      predicate: (page) => page.url().includes("view=pet"),
      timeout: 5000,
    }));
  assert.ok(pet, "桌宠窗口存在");
  const dashboard = desktop
    .windows()
    .find((page) => page.url().includes("view=dashboard"));
  assert.ok(dashboard, "控制面板存在");
  dashboard.on("pageerror", (error) => errors.push(error.message));
  pet.on("pageerror", (error) => errors.push(error.message));
  await dashboard
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "偏好设置", exact: true })
    .click();
  const toggle = dashboard.getByRole("switch", {
    name: "鼠标穿透",
    exact: true,
  });
  await toggle.waitFor();
  const setThrough = async (value) => {
    assert.equal(await toggle.getAttribute("aria-checked"), String(!value));
    await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes("view=dashboard"),
      );
      window.show();
      window.focus();
    });
    await toggle.click();
    await dashboard.waitForFunction((expected) => {
      const button = document.querySelector(
        'button[role="switch"][aria-label="鼠标穿透"]',
      );
      return (
        button?.getAttribute("aria-checked") === String(expected) &&
        !button.disabled
      );
    }, value);
    assert.equal(
      (await dashboard.evaluate(() => window.mai.snapshot())).settings
        .clickThrough,
      value,
    );
    assert.equal(
      JSON.parse(await readFile(join(userData, "state.json"), "utf8")).settings
        .clickThrough,
      value,
    );
    await desktop.evaluate(({ BrowserWindow }) => {
      globalThis.__maiClickThroughTarget?.show();
      globalThis.__maiClickThroughTarget?.focus();
      for (const window of BrowserWindow.getAllWindows()) {
        const url = window.webContents.getURL();
        if (url.includes("view=dashboard")) window.hide();
        if (url.includes("view=pet")) {
          window.showInactive();
          window.moveTop();
        }
      }
    });
  };
  await pet.locator(".pet-character").waitFor();
  originalCursor = await desktop.evaluate(({ screen }) =>
    screen.getCursorScreenPoint(),
  );
  const bounds = await desktop.evaluate(async ({ BrowserWindow, screen }) => {
    const petWindow = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().includes("view=pet"),
    );
    globalThis.__maiMouseIgnoreCalls = [];
    const setIgnoreMouseEvents = petWindow.setIgnoreMouseEvents;
    petWindow.setIgnoreMouseEvents = function (ignore, options) {
      globalThis.__maiMouseIgnoreCalls.push(ignore);
      return setIgnoreMouseEvents.call(this, ignore, options);
    };
    for (const window of BrowserWindow.getAllWindows())
      if (window !== petWindow) window.hide();
    const area = screen.getPrimaryDisplay().workArea;
    petWindow.setPosition(
      Math.round(area.x + area.width / 2 - 170),
      Math.round(area.y + area.height / 2 - 200),
    );
    const rect = petWindow.getContentBounds();
    const target = new BrowserWindow({
      ...rect,
      frame: false,
      backgroundColor: "#ffffff",
      show: false,
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    globalThis.__maiClickThroughTarget = target;
    await target.loadURL(
      "data:text/html," +
        encodeURIComponent(
          '<html><body style="margin:0;height:100vh;background:#eee">' +
            '<button style="width:100%;height:100%;border:0">鼠标穿透验收</button>' +
            "<script>window.clickCount=0;document.addEventListener('click',()=>window.clickCount++)</script>" +
            "</body></html>",
        ),
    );
    target.show();
    petWindow.showInactive();
    petWindow.moveTop();
    return rect;
  });
  const character = await pet.locator(".pet-character").boundingBox();
  const characterPoint = {
    x: Math.round(bounds.x + character.x + character.width / 2),
    y: Math.round(bounds.y + character.y + character.height / 2),
  };
  const clickCount = () =>
    desktop.evaluate(() =>
      globalThis.__maiClickThroughTarget.webContents.executeJavaScript(
        "window.clickCount",
      ),
    );

  await pet.screenshot();
  await pet.locator(".pet-character").click();
  assert.equal(await clickCount(), 0, "关闭穿透时角色应接收点击");
  await pet.waitForFunction(
    async () => (await window.mai.snapshot()).mood === "happy",
    undefined,
    { timeout: 5000 },
  );
  await setThrough(true);
  await pet.mouse.move(5, 5);
  await pet.mouse.move(
    character.x + character.width / 2,
    character.y + character.height / 2,
  );
  await pet.evaluate(() => window.mai.snapshot());
  assert.equal(
    await desktop.evaluate(() => globalThis.__maiMouseIgnoreCalls.at(-1)),
    true,
    "开启鼠标穿透后，鼠标经过角色不能撤销系统窗口的穿透状态",
  );
  await mouse({ x: bounds.x + 5, y: bounds.y + 5 }, false);
  await mouse(characterPoint);
  assert.equal(
    await clickCount(),
    1,
    "开启鼠标穿透后，经过角色的原生点击必须落到下面的窗口",
  );
  const controls = await pet.locator(".pet-controls").boundingBox();
  await mouse({
    x: Math.round(bounds.x + controls.x + controls.width / 2),
    y: Math.round(bounds.y + controls.y + controls.height / 2),
  });
  assert.equal(await clickCount(), 2, "穿透开启时，角色按钮也不能拦截点击");
  await setThrough(false);
  await pet.evaluate(() => window.mai.setMood("idle"));
  await mouse(characterPoint);
  assert.equal(await clickCount(), 2, "关闭穿透后恢复角色点击");
  await pet.waitForFunction(
    async () => (await window.mai.snapshot()).mood === "happy",
    undefined,
    { timeout: 5000 },
  );
  assert.deepEqual(errors, []);
  await writeFile(
    join(base, "result.json"),
    JSON.stringify(
      {
        passed: true,
        executable: process.env.MAI_TEST_EXE || "development Electron",
        checks: [
          "Settings-page actual switch click changes DOM/state/disk",
          "Native pet character/control clicks reach the fixture underneath while enabled",
          "Disabling through the settings page restores native pet interaction",
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS：设置页实际开关切换DOM、IPC及落盘；开启后角色/按钮原生点击穿透，关闭后恢复互动",
  );
} catch (error) {
  if (launchLog) console.error(launchLog);
  throw error;
} finally {
  try {
    try {
      if (originalCursor && desktop) await mouse(originalCursor, false);
    } finally {
      await desktop?.close();
    }
  } finally {
    assert.ok(userData.startsWith(base + sep));
    await rm(userData, { recursive: true, force: true });
  }
}
