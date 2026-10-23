import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { _electron as electron } from "playwright";

assert.equal(process.platform, "win32", "此验收检查 Windows 原生窗口层级");
const base = resolve(".cache/pet-topmost-smoke");
await mkdir(base, { recursive: true });
const userData = await mkdtemp(join(base, "userdata-"));
const nativeScript = join(userData, "z-order.ps1");
await writeFile(
  nativeScript,
  `param([long]$Pet, [long]$Other)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MaiTopmostWindows {
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr window, int index);
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  public static int Rank(IntPtr window) {
    int index = 0;
    for (IntPtr current = GetTopWindow(IntPtr.Zero); current != IntPtr.Zero; current = GetWindow(current, 2)) {
      if (current == window) return index;
      index++;
    }
    return -1;
  }
}
'@
$petHandle = [IntPtr]::new($Pet)
$otherHandle = [IntPtr]::new($Other)
[pscustomobject]@{
  petTopmost = ([MaiTopmostWindows]::GetWindowLong($petHandle, -20) -band 8) -ne 0
  otherTopmost = ([MaiTopmostWindows]::GetWindowLong($otherHandle, -20) -band 8) -ne 0
  petVisible = [MaiTopmostWindows]::IsWindowVisible($petHandle)
  otherVisible = [MaiTopmostWindows]::IsWindowVisible($otherHandle)
  petRank = [MaiTopmostWindows]::Rank($petHandle)
  otherRank = [MaiTopmostWindows]::Rank($otherHandle)
  otherFocused = [MaiTopmostWindows]::GetForegroundWindow() -eq $otherHandle
} | ConvertTo-Json -Compress
`,
);

let desktop;
const errors = [];
const results = [];
async function checkTopmost(stage, expected) {
  const handles = await desktop.evaluate(({ BrowserWindow }) => {
    const petWindow = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().includes("view=pet"),
    );
    const other = globalThis.__maiTopmostTarget;
    other.show();
    other.focus();
    other.moveTop();
    const handle = (window) => {
      const buffer = window.getNativeWindowHandle();
      return buffer.length === 8
        ? buffer.readBigUInt64LE().toString()
        : buffer.readUInt32LE().toString();
    };
    return {
      pet: handle(petWindow),
      other: handle(other),
      electronTopmost: petWindow.isAlwaysOnTop(),
    };
  });
  const state = JSON.parse(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        nativeScript,
        "-Pet",
        handles.pet,
        "-Other",
        handles.other,
      ],
      { windowsHide: true, timeout: 10000, encoding: "utf8" },
    ).trim(),
  );
  results.push({ stage, expected, ...state, ...handles });
  const detail = `${stage}: ${JSON.stringify({ ...state, ...handles })}`;
  assert.ok(state.petVisible && state.otherVisible, detail);
  assert.ok(state.petRank >= 0 && state.otherRank >= 0, detail);
  assert.equal(state.otherFocused, true, "普通对照窗口必须确实切到前台");
  assert.equal(state.otherTopmost, false, "对照窗口必须是普通窗口");
  assert.equal(handles.electronTopmost, expected, detail);
  assert.equal(state.petTopmost, expected, detail);
  assert.equal(
    state.petRank < state.otherRank,
    expected,
    `普通窗口切到前台后，桌宠实际层级必须遵循置顶开关；${detail}`,
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
    executablePath: resolve("node_modules/electron/dist/electron.exe"),
    args: [".", "--disable-renderer-backgrounding"],
    cwd: resolve("."),
    env,
    timeout: 15000,
  });
  await desktop.firstWindow({ timeout: 10000 });
  const pet =
    desktop.windows().find((page) => page.url().includes("view=pet")) ||
    (await desktop.waitForEvent("window", {
      predicate: (page) => page.url().includes("view=pet"),
      timeout: 5000,
    }));
  const dashboard = desktop
    .windows()
    .find((page) => page.url().includes("view=dashboard"));
  assert.ok(pet && dashboard, "桌宠和设置窗口存在");
  for (const page of [pet, dashboard])
    page.on("pageerror", (error) => errors.push(error.message));
  await pet.locator(".pet-character").waitFor();
  await dashboard
    .getByRole("button", { name: "偏好设置", exact: true })
    .click();
  const toggle = dashboard.getByRole("switch", {
    name: "始终置顶",
    exact: true,
  });
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  await desktop.evaluate(async ({ BrowserWindow }) => {
    const petWindow = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().includes("view=pet"),
    );
    const { x, y } = petWindow.getBounds();
    const target = new BrowserWindow({
      x,
      y,
      width: 700,
      height: 600,
      show: false,
      alwaysOnTop: false,
      backgroundColor: "#e0e0e0",
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    globalThis.__maiTopmostTarget = target;
    await target.loadURL(
      "data:text/html,<title>Mai topmost check</title>Normal window",
    );
    target.show();
    target.focus();
  });
  await checkTopmost("首次显示", true);
  await toggle.click();
  await dashboard.waitForFunction(
    async () => !(await window.mai.snapshot()).settings.alwaysOnTop,
  );
  await checkTopmost("设置关闭", false);
  await toggle.click();
  await dashboard.waitForFunction(
    async () => (await window.mai.snapshot()).settings.alwaysOnTop,
  );
  await checkTopmost("设置重新开启", true);
  for (const patch of [
    { petScale: 1.6 },
    { petVisible: false },
    { petVisible: true },
    { clickThrough: true },
    { clickThrough: false, petScale: 1 },
  ]) {
    await dashboard.evaluate(
      (value) => window.mai.updateSettings(value),
      patch,
    );
    if (patch.petVisible !== false)
      await checkTopmost(`更新设置 ${JSON.stringify(patch)}`, true);
  }
  await dashboard.evaluate(async () => {
    await window.mai.updateSettings({ petVisible: false, alwaysOnTop: false });
    await window.mai.updateSettings({ alwaysOnTop: true });
    await window.mai.updateSettings({ petVisible: true });
  });
  await checkTopmost("隐藏时重新开启置顶，显示后生效", true);
  assert.deepEqual(errors, []);
  console.log(
    "PASS：Windows 原生置顶与实际窗口层级、普通窗口前台切换、设置双向切换、缩放、隐藏恢复和鼠标穿透切换",
  );
} finally {
  try {
    await writeFile(
      join(base, "result.json"),
      JSON.stringify(results, null, 2),
    );
  } finally {
    try {
      await desktop?.close();
    } finally {
      assert.ok(userData.startsWith(base + sep));
      await rm(userData, { recursive: true, force: true });
    }
  }
}
