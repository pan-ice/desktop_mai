import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { _electron as electron } from "playwright";

assert.equal(process.platform, "win32", "此验收使用 Windows 原生鼠标输入");
const allConflicts = process.argv.includes("--all-conflicts");
const conflict = allConflicts || process.argv.includes("--conflict");
const saveDelay = process.argv.includes("--save-delay");
const saveFailure = process.argv.includes("--save-failure");
const legacyRed = process.argv.includes("--legacy-red");
const inflightSettings = process.argv.includes("--inflight-settings");
assert.ok(!(saveDelay && saveFailure), "Select one save injection");
assert.ok(
  !(allConflicts && (saveDelay || saveFailure)),
  "All-conflict case uses settings restoration",
);
const caseName = `${allConflicts ? "all-conflicts" : conflict ? "conflict" : "normal"}${saveDelay ? "-save-delay" : saveFailure ? "-save-failure" : ""}${inflightSettings ? "-inflight-settings" : ""}${legacyRed ? "-legacy-red" : ""}`;
const mode = process.env.MAI_TEST_EXE ? "packaged" : "build";
const base = resolve(".cache/pet-shortcut-smoke", mode, caseName);
await mkdir(base, { recursive: true });
const userData = await mkdtemp(join(base, "userdata-"));
const mouseScript = join(userData, "mouse.ps1");
const keyScript = join(userData, "shortcut.ps1");
await writeFile(
  keyScript,
  `param([string]$Combination="primary")
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MaiShortcutInput {
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public MOUSEINPUT mi; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION data; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  public static void Send(string combination) {
    ushort[] keys = combination=="alternate" ? new ushort[]{0x11,0x12,0x10,0x4D,0x4D,0x10,0x12,0x11} : combination=="last" ? new ushort[]{0x11,0x10,0x7B,0x7B,0x10,0x11} : new ushort[]{0x11,0x10,0x4D,0x4D,0x10,0x11};
    INPUT[] input = new INPUT[keys.Length];
    for(int i=0;i<keys.Length;i++) { input[i].type=1; input[i].data.ki.wVk=keys[i]; input[i].data.ki.dwFlags=i>=keys.Length/2 ? 2u : 0u; }
    uint sent=SendInput((uint)input.Length,input,Marshal.SizeOf(typeof(INPUT)));
    if(sent!=input.Length) throw new Exception("SendInput failed: "+Marshal.GetLastWin32Error()+", sent="+sent);
  }
}
'@
[MaiShortcutInput]::Send($Combination)
`,
);
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

let desktop, originalCursor, shortcutOwner;
let ownerOutput = "";
let registration;
let registrations;
let recoveryShortcut;
let recoveryHint;
let recoveryKeys;
let entry;
let injectedSave;
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
  if (conflict) {
    const helper = join(userData, "shortcut-owner.ps1");
    await writeFile(
      helper,
      `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MaiShortcutOwner {
 [DllImport("user32.dll",SetLastError=true)] public static extern bool RegisterHotKey(IntPtr hWnd,int id,uint modifiers,uint key);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool UnregisterHotKey(IntPtr hWnd,int id);
}
'@
$registrations=@()
$registrations+= [MaiShortcutOwner]::RegisterHotKey([IntPtr]::Zero,21341,6,0x4D)
${allConflicts ? "$registrations+= [MaiShortcutOwner]::RegisterHotKey([IntPtr]::Zero,21342,7,0x4D)\n$registrations+= [MaiShortcutOwner]::RegisterHotKey([IntPtr]::Zero,21343,6,0x7B)" : ""}
$registered= -not ($registrations -contains $false)
[Console]::WriteLine('[shortcut-owner-ready] '+$registered.ToString().ToLowerInvariant())
[Console]::Out.Flush()
try { $null=[Console]::ReadLine() } finally { for($index=0;$index -lt $registrations.Count;$index++) { if($registrations[$index]) { $null=[MaiShortcutOwner]::UnregisterHotKey([IntPtr]::Zero,(21341+$index)) } } }
`,
    );
    shortcutOwner = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        helper,
      ],
      { env, windowsHide: true, stdio: "pipe" },
    );
    shortcutOwner.stdout.on("data", (chunk) => {
      ownerOutput += chunk.toString();
    });
    shortcutOwner.stderr.on("data", (chunk) => {
      ownerOutput += chunk.toString();
    });
    const deadline = Date.now() + 10000;
    while (!ownerOutput.includes("[shortcut-owner-ready]")) {
      if (shortcutOwner.exitCode !== null || Date.now() > deadline)
        throw new Error(
          "Shortcut fixture did not become ready: " + ownerOutput,
        );
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.ok(
      ownerOutput.includes("[shortcut-owner-ready] true"),
      "Only run conflict regression when this test owns the conflicting registration",
    );
  }
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
  entry = await desktop.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    version: app.getVersion(),
    executable: process.execPath,
    userData: app.getPath("userData"),
  }));
  assert.equal(
    entry.version,
    JSON.parse(await readFile(resolve("package.json"), "utf8")).version,
  );
  assert.equal(entry.packaged, mode === "packaged");
  if (mode === "packaged") {
    assert.match(entry.appPath, /[\\/]resources[\\/]app\.asar$/);
    assert.equal(
      resolve(entry.executable).toLowerCase(),
      resolve(process.env.MAI_TEST_EXE).toLowerCase(),
    );
  }
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
  registration = await desktop.evaluate(({ globalShortcut }) =>
    globalShortcut.isRegistered("CommandOrControl+Shift+M"),
  );
  assert.equal(
    registration,
    !conflict,
    "Hotkey registration must reflect the test-owned conflict",
  );
  if (conflict)
    assert.equal(
      shortcutOwner.exitCode,
      null,
      "The conflict owner must still be alive",
    );
  recoveryShortcut = (await dashboard.evaluate(() => window.mai.snapshot()))
    .recoveryShortcut;
  if (!legacyRed) {
    assert.equal(
      recoveryShortcut,
      allConflicts
        ? null
        : conflict
          ? "Ctrl + Alt + Shift + M"
          : "Ctrl + Shift + M",
    );
    registrations = await desktop.evaluate(({ globalShortcut }) => ({
      primary: globalShortcut.isRegistered("CommandOrControl+Shift+M"),
      alternate: globalShortcut.isRegistered("CommandOrControl+Alt+Shift+M"),
      last: globalShortcut.isRegistered("CommandOrControl+Shift+F12"),
    }));
    assert.equal(
      Object.values(registrations).filter(Boolean).length,
      allConflicts ? 0 : 1,
    );
    const hint = await toggle.locator("..").innerText();
    recoveryHint = hint;
    recoveryKeys = await dashboard
      .locator(".shortcut-row kbd")
      .allTextContents();
    assert.equal(
      recoveryKeys.join(" + "),
      recoveryShortcut || "",
      "Visible keyboard hints must match the actual registered shortcut",
    );
    if (recoveryShortcut)
      assert.ok(
        hint.includes(recoveryShortcut),
        "The visible hint must name the actually registered shortcut",
      );
    else
      assert.match(
        hint,
        /托盘|无可用|未能注册|被占用/,
        "No-shortcut state must provide an honest recovery hint",
      );
  }
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
  if (inflightSettings) {
    await dashboard.evaluate(() => window.mai.connect());
    await desktop.evaluate(({ app }) => {
      const { createRequire } = process.getBuiltinModule("node:module");
      const { join } = process.getBuiltinModule("node:path");
      const { WebSocketServer } = createRequire(
        join(app.getAppPath(), "package.json"),
      )("ws");
      const original = WebSocketServer.prototype.close;
      const state = (globalThis.__shortcutInflight = {
        entered: false,
        release: null,
        restore: null,
      });
      state.restore = () => {
        WebSocketServer.prototype.close = original;
        state.release?.();
      };
      WebSocketServer.prototype.close = function (callback) {
        return original.call(this, (...args) => {
          state.entered = true;
          state.release = () => {
            state.release = null;
            callback?.(...args);
          };
        });
      };
    });
    await dashboard.evaluate(() => {
      window.__shortcutSettings = window.mai.updateSettings({
        botId: "shortcut_inflight",
      });
      window.__shortcutSettings.catch((error) => {
        window.__shortcutSettingsError = error.message;
      });
    });
    const deadline = Date.now() + 5000;
    while (
      !(await desktop.evaluate(() => globalThis.__shortcutInflight.entered))
    ) {
      if (Date.now() > deadline)
        throw new Error(
          "The real WSS disconnect did not enter the callback gate",
        );
      await new Promise((done) => setTimeout(done, 30));
    }
  }
  if (saveDelay || saveFailure) {
    await desktop.evaluate(
      (_, mode) => {
        const filesystem = process.getBuiltinModule("node:fs/promises");
        const { syncBuiltinESMExports } =
          process.getBuiltinModule("node:module");
        const original = filesystem.writeFile;
        const state = (globalThis.__shortcutSave = {
          attempts: 0,
          pending: false,
          mode,
          release: null,
          restore: null,
        });
        state.restore = () => {
          filesystem.writeFile = original;
          syncBuiltinESMExports();
          state.release?.();
        };
        filesystem.writeFile = async (path, content, ...args) => {
          if (
            String(path).endsWith("state.json.tmp") &&
            JSON.parse(String(content)).settings.clickThrough === false &&
            state.attempts === 0
          ) {
            state.attempts++;
            if (mode === "failure")
              throw Object.assign(
                new Error("Shortcut smoke injected a state write failure"),
                { code: "EACCES" },
              );
            state.pending = true;
            await new Promise((done) => {
              state.release = done;
            });
            state.pending = false;
          }
          return original.call(filesystem, path, content, ...args);
        };
        syncBuiltinESMExports();
      },
      saveDelay ? "delay" : "failure",
    );
  }
  if (allConflicts) await setThrough(false);
  else
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        keyScript,
        "-Combination",
        conflict ? "alternate" : "primary",
      ],
      { windowsHide: true, timeout: 10000, stdio: "pipe" },
    );
  const restoredDeadline =
    Date.now() + (saveDelay || saveFailure ? 1500 : 8000);
  while (true) {
    const through = (await pet.evaluate(() => window.mai.snapshot())).settings
      .clickThrough;
    const nativeThrough = await desktop.evaluate(() =>
      globalThis.__maiMouseIgnoreCalls.at(-1),
    );
    const domThrough = await toggle.getAttribute("aria-checked");
    if (!through && nativeThrough === false && domThrough === "false") break;
    if (Date.now() > restoredDeadline)
      throw new Error(
        `恢复鼠标交互未生效${saveDelay ? "（保存仍被阻塞）" : ""}：snapshot=${through}, native=${nativeThrough}, UI=${domThrough}`,
      );
    await new Promise((done) => setTimeout(done, 50));
  }
  await dashboard.waitForFunction(
    () =>
      document
        .querySelector('button[role="switch"][aria-label="鼠标穿透"]')
        ?.getAttribute("aria-checked") === "false",
    undefined,
    { timeout: 5000 },
  );
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  if (saveDelay || saveFailure) {
    injectedSave = await desktop.evaluate(() => ({
      attempts: globalThis.__shortcutSave.attempts,
      pending: globalThis.__shortcutSave.pending,
    }));
    assert.equal(
      injectedSave.attempts,
      1,
      "The real state write path must reach the injection",
    );
    if (saveDelay) {
      assert.equal(
        injectedSave.pending,
        true,
        "Interaction must restore while the real save is still blocked",
      );
      assert.equal(
        JSON.parse(await readFile(join(userData, "state.json"), "utf8"))
          .settings.clickThrough,
        true,
      );
    } else {
      assert.ok(
        (await dashboard.evaluate(() => window.mai.snapshot())).activity.some(
          (item) => /已恢复.*保存/.test(item.text),
        ),
        "A save failure must warn after restoring interaction",
      );
    }
  } else
    assert.equal(
      JSON.parse(await readFile(join(userData, "state.json"), "utf8")).settings
        .clickThrough,
      false,
    );
  await pet.evaluate(() => window.mai.setMood("idle"));
  await mouse(characterPoint);
  assert.equal(await clickCount(), 2, "关闭穿透后恢复角色点击");
  await pet.waitForFunction(
    async () => (await window.mai.snapshot()).mood === "happy",
    undefined,
    { timeout: 5000 },
  );
  if (inflightSettings) {
    await desktop.evaluate(() => globalThis.__shortcutInflight.restore());
    await dashboard.evaluate(() => window.__shortcutSettings);
    const snapshot = await dashboard.evaluate(() => window.mai.snapshot());
    assert.equal(snapshot.settings.botId, "shortcut_inflight");
    assert.equal(
      snapshot.settings.clickThrough,
      false,
      "An older in-flight settings update must not restore mouse passthrough",
    );
    assert.equal(
      await desktop.evaluate(() => globalThis.__maiMouseIgnoreCalls.at(-1)),
      false,
      "An older in-flight settings update must keep native input interactive",
    );
  }
  if (saveDelay || saveFailure) {
    await desktop.evaluate(() => globalThis.__shortcutSave.restore());
    if (saveDelay) {
      const deadline = Date.now() + 5000;
      while (
        JSON.parse(await readFile(join(userData, "state.json"), "utf8"))
          .settings.clickThrough
      ) {
        if (Date.now() > deadline)
          throw new Error("The released save did not complete");
        await new Promise((done) => setTimeout(done, 30));
      }
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(
    join(base, "result.json"),
    JSON.stringify(
      {
        passed: true,
        mode,
        entry,
        executable: process.env.MAI_TEST_EXE || "source package entry",
        registration,
        registrations,
        conflict,
        allConflicts,
        recoveryShortcut,
        recoveryHint,
        recoveryKeys,
        injectedSave,
        inflightSettings,
        ownerOutput,
        ownerExitCode: shortcutOwner?.exitCode,
        checks: [
          "Settings-page actual switch click changes DOM/state/disk",
          "Native pet character/control clicks reach the fixture underneath while enabled",
          allConflicts
            ? "All test-owned candidate conflicts expose an unavailable shortcut hint, and the settings page restores interaction"
            : "The displayed actual recovery combination restores the real pet's native input and settings",
          ...(saveDelay
            ? [
                "Native input and UI restore before releasing the blocked real state write",
              ]
            : []),
          ...(saveFailure
            ? [
                "A real state write failure warns and preserves restored native input",
              ]
            : []),
          ...(inflightSettings
            ? [
                "An older real WSS-disconnect settings update cannot re-enable mouse passthrough",
              ]
            : []),
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS ${caseName}：实际恢复入口关闭穿透、同步设置并恢复角色原生点击`,
  );
} catch (error) {
  await writeFile(
    join(base, "failure.json"),
    JSON.stringify(
      {
        passed: false,
        mode,
        entry,
        registration,
        registrations,
        conflict,
        allConflicts,
        recoveryShortcut,
        recoveryHint,
        recoveryKeys,
        saveDelay,
        saveFailure,
        inflightSettings,
        ownerOutput,
        message: error.message,
        launchLog,
      },
      null,
      2,
    ),
  );
  if (launchLog) console.error(launchLog);
  throw error;
} finally {
  try {
    try {
      if (originalCursor && desktop) await mouse(originalCursor, false);
    } finally {
      await desktop
        ?.evaluate(() => globalThis.__shortcutSave?.restore())
        .catch(() => {});
      await desktop
        ?.evaluate(() => globalThis.__shortcutInflight?.restore())
        .catch(() => {});
      await desktop?.close();
    }
  } finally {
    if (shortcutOwner && shortcutOwner.exitCode === null) {
      shortcutOwner.stdin.end();
      const deadline = Date.now() + 3000;
      while (shortcutOwner.exitCode === null && Date.now() < deadline)
        await new Promise((done) => setTimeout(done, 30));
      if (shortcutOwner.exitCode === null)
        execFileSync(
          "taskkill.exe",
          ["/PID", String(shortcutOwner.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
    }
    assert.ok(userData.startsWith(base + sep));
    await rm(userData, { recursive: true, force: true });
  }
}
