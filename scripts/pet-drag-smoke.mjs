import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const base = resolve(".cache/pet-drag-smoke");
await mkdir(base, { recursive: true });
const userData = await mkdtemp(join(base, "userdata-"));
let desktop;
const errors = [];

async function sendDrag(pet, action, point) {
  if (point)
    await desktop.evaluate((_, value) => {
      globalThis.__maiDragCursor = value;
    }, point);
  await pet.evaluate(async (value) => {
    window.mai.petDrag(value);
    // 同一渲染器的 IPC 按序处理，等 snapshot 返回后再读取主进程位置。
    await window.mai.snapshot();
  }, action);
}

async function metrics(pet) {
  const character = await pet.locator(".pet-character").boundingBox();
  const bounds = await desktop.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((item) =>
      item.webContents.getURL().includes("view=pet"),
    );
    return window.getContentBounds();
  });
  return {
    bounds,
    character,
    left: bounds.x + character.x,
    top: bounds.y + character.y,
    right: bounds.x + character.x + character.width,
    bottom: bounds.y + character.y + character.height,
  };
}

async function openPet(env) {
  desktop = await electron.launch({
    executablePath: resolve("node_modules/electron/dist/electron.exe"),
    args: [".", "--disable-renderer-backgrounding"],
    cwd: resolve("."),
    env,
    timeout: 15000,
  });
  await desktop.firstWindow();
  let pet;
  for (let attempt = 0; attempt < 100; attempt++) {
    pet = desktop.windows().find((page) => page.url().includes("view=pet"));
    if (pet) break;
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.ok(pet, "桌宠窗口存在");
  pet.on("pageerror", (error) => errors.push(error.message));
  await pet.locator(".pet-character").waitFor();
  const area = await desktop.evaluate(({ screen, Tray }) => {
    globalThis.__maiDragCursor = { x: 0, y: 0 };
    // 仅替换系统光标输入，窗口、布局、preload 和拖动 IPC 均使用实际实现。
    screen.getCursorScreenPoint = () => globalThis.__maiDragCursor;
    const setContextMenu = Tray.prototype.setContextMenu;
    Tray.prototype.setContextMenu = function (menu) {
      globalThis.__maiPetTrayMenu = menu;
      return setContextMenu.call(this, menu);
    };
    return screen.getPrimaryDisplay().workArea;
  });
  return { pet, area };
}

async function assertLocked(pet) {
  await pet
    .getByRole("button", { name: "解锁桌宠位置", exact: true })
    .waitFor();
  const before = await metrics(pet);
  const cursor = {
    x: before.left + before.character.width / 2,
    y: before.top + before.character.height / 2,
  };
  await sendDrag(pet, "start", cursor);
  await sendDrag(pet, "move", { x: cursor.x - 80, y: cursor.y - 60 });
  await sendDrag(pet, "end");
  assert.deepEqual(
    (await metrics(pet)).bounds,
    before.bounds,
    "锁定位置时，直接发送拖动 IPC 也不能移动窗口",
  );
  await pet.locator(".pet-character").click();
  await pet.waitForFunction(
    async () => (await window.mai.snapshot()).mood === "happy",
  );
  await pet.getByRole("button", { name: "打开迷你聊天", exact: true }).click();
  await pet.getByRole("textbox", { name: "和麦麦说话", exact: true }).waitFor();
  await pet.getByRole("button", { name: "打开迷你聊天", exact: true }).click();
  assert.deepEqual((await metrics(pet)).bounds, before.bounds);
}

async function assertTrayChecked(expected) {
  assert.equal(
    await desktop.evaluate(
      () =>
        globalThis.__maiPetTrayMenu.items.find(
          (item) => item.label === "锁定桌宠位置",
        ).checked,
    ),
    expected,
    "托盘菜单与角色、偏好设置的锁定状态同步",
  );
}

try {
  await writeFile(
    join(userData, "state.json"),
    JSON.stringify({
      version: 2,
      settings: { autoConnect: false, petScale: 1.6, reducedMotion: true },
      history: [],
      models: [],
      encrypted: {},
    }),
  );
  const env = { ...process.env, MAI_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  let { pet, area } = await openPet(env);

  assert.equal(
    await pet.evaluate(
      async () => (await window.mai.snapshot()).settings.petPositionLocked,
    ),
    true,
  );
  await assertLocked(pet);
  await pet.getByRole("button", { name: "解锁桌宠位置", exact: true }).click();
  await pet.waitForFunction(
    async () => !(await window.mai.snapshot()).settings.petPositionLocked,
  );
  await assertTrayChecked(false);

  for (const scale of [1.6, 1, 0.5]) {
    await pet.evaluate(
      (value) => window.mai.updateSettings({ petScale: value }),
      scale,
    );
    await pet.waitForFunction(
      (value) =>
        Math.abs(
          document.querySelector(".pet-character").getBoundingClientRect()
            .width -
            230 * value,
        ) < 1,
      scale,
      { timeout: 5000 },
    );
    for (const [horizontal, vertical] of [
      ["left", "top"],
      ["right", "bottom"],
      ["left", "bottom"],
      ["right", "top"],
    ]) {
      const before = await metrics(pet);
      const cursor = {
        x: before.left + before.character.width / 2,
        y: before.top + before.character.height / 2,
      };
      const target = {
        x:
          area.x +
          (horizontal === "right" ? area.width - before.character.width : 0),
        y:
          area.y +
          (vertical === "bottom" ? area.height - before.character.height : 0),
      };
      await sendDrag(pet, "start", cursor);
      await sendDrag(pet, "move", {
        x: cursor.x + target.x - before.left,
        y: cursor.y + target.y - before.top,
      });
      await sendDrag(pet, "end");
      const after = await metrics(pet);
      assert.ok(
        Math.abs(after.left - target.x) <= 2 &&
          Math.abs(after.top - target.y) <= 2,
        `${scale * 100}% 角色应能拖到屏幕 ${horizontal}/${vertical} 边缘：` +
          `期望 (${target.x}, ${target.y})，实际 (${after.left}, ${after.top})；` +
          `窗口 ${after.bounds.width}×${after.bounds.height}，角色 ${after.character.width}×${after.character.height}`,
      );
      assert.ok(after.left >= area.x - 2 && after.top >= area.y - 2);
      assert.ok(after.right <= area.x + area.width + 2);
      assert.ok(after.bottom <= area.y + area.height + 2);
    }
    const before = await metrics(pet);
    const cursor = {
      x: before.left + before.character.width / 2,
      y: before.top + before.character.height / 2,
    };
    await sendDrag(pet, "start", cursor);
    for (let step = 0; step < 40; step++)
      await sendDrag(pet, "move", {
        x: cursor.x - (step % 2 ? 20 : 40),
        y: cursor.y + (step % 2 ? 30 : 50),
      });
    await sendDrag(pet, "end");
    const after = await metrics(pet);
    assert.ok(
      Math.abs(after.bounds.width - Math.round(340 * scale)) <= 1 &&
        Math.abs(after.bounds.height - Math.round(400 * scale)) <= 1,
      `${scale * 100}% 连续拖动不能使窗口变大：` +
        `期望 ${Math.round(340 * scale)}×${Math.round(400 * scale)}，` +
        `实际 ${after.bounds.width}×${after.bounds.height}`,
    );
  }

  // 将桌宠移回屏幕中部，验证锁按钮与设置开关的实际点击和双向同步。
  await pet.evaluate(() => window.mai.updateSettings({ petScale: 1 }));
  const current = await metrics(pet);
  const cursor = {
    x: current.left + current.character.width / 2,
    y: current.top + current.character.height / 2,
  };
  await sendDrag(pet, "start", cursor);
  await sendDrag(pet, "move", {
    x:
      cursor.x +
      area.x +
      area.width / 2 -
      current.left -
      current.character.width / 2,
    y:
      cursor.y +
      area.y +
      area.height / 2 -
      current.top -
      current.character.height / 2,
  });
  await sendDrag(pet, "end");

  // 拖动途中锁定也必须取消主进程已经记录的起始坐标。
  await sendDrag(pet, "start", { x: 200, y: 200 });
  await pet.getByRole("button", { name: "锁定桌宠位置", exact: true }).click();
  await pet.waitForFunction(
    async () => (await window.mai.snapshot()).settings.petPositionLocked,
  );
  await assertTrayChecked(true);
  const fixed = await metrics(pet);
  await sendDrag(pet, "move", { x: 600, y: 500 });
  assert.deepEqual((await metrics(pet)).bounds, fixed.bounds);
  await assertLocked(pet);
  const page = desktop
    .windows()
    .find((item) => item.url().includes("view=dashboard"));
  await page.getByRole("button", { name: "偏好设置", exact: true }).click();
  const toggle = page.getByRole("switch", {
    name: "锁定桌宠位置",
    exact: true,
  });
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  await toggle.click();
  await pet
    .getByRole("button", { name: "锁定桌宠位置", exact: true })
    .waitFor();
  await assertTrayChecked(false);
  await sendDrag(pet, "move", { x: 700, y: 600 });
  assert.deepEqual(
    (await metrics(pet)).bounds,
    fixed.bounds,
    "解锁不会恢复过期拖动",
  );
  await toggle.click();
  await pet
    .getByRole("button", { name: "解锁桌宠位置", exact: true })
    .waitFor();
  await assertTrayChecked(true);
  await desktop.close();
  desktop = undefined;
  let saved = JSON.parse(await readFile(join(userData, "state.json"), "utf8"));
  assert.equal(saved.settings.petPositionLocked, true);
  assert.ok(Math.abs(saved.petPosition.x - fixed.bounds.x) <= 1);
  assert.ok(Math.abs(saved.petPosition.y - fixed.bounds.y) <= 1);
  ({ pet } = await openPet(env));
  await assertLocked(pet);
  const restored = await metrics(pet);
  assert.ok(
    Math.abs(restored.bounds.x - fixed.bounds.x) <= 1 &&
      Math.abs(restored.bounds.y - fixed.bounds.y) <= 1,
    `重启保留锁定位置：期望 (${fixed.bounds.x}, ${fixed.bounds.y})，实际 (${restored.bounds.x}, ${restored.bounds.y})`,
  );
  await pet.getByRole("button", { name: "解锁桌宠位置", exact: true }).click();
  await pet.waitForFunction(
    async () => !(await window.mai.snapshot()).settings.petPositionLocked,
  );
  await desktop.close();
  desktop = undefined;
  saved = JSON.parse(await readFile(join(userData, "state.json"), "utf8"));
  assert.equal(saved.settings.petPositionLocked, false);
  ({ pet } = await openPet(env));
  await pet
    .getByRole("button", { name: "锁定桌宠位置", exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS：默认锁定、点击互动、角色/设置/托盘同步、拖动途中锁定及重启恢复；解锁后 50%、100%、160% 角色可拖至四角，连续拖动尺寸不增长",
  );
} finally {
  try {
    await desktop?.close();
  } finally {
    assert.ok(userData.startsWith(base + sep));
    await rm(userData, { recursive: true, force: true });
  }
}
