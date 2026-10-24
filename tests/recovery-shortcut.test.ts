import { describe, expect, it, vi } from "vitest";
import { registerRecoveryShortcut } from "../electron/recovery-shortcut";

describe("恢复鼠标交互的全局快捷键", () => {
  it("注册可用的主快捷键，只有收到它时才恢复交互", () => {
    const callbacks = new Map<string, () => void>();
    const restore = vi.fn();
    const register = vi.fn((accelerator: string, callback: () => void) => {
      callbacks.set(accelerator, callback);
      return true;
    });

    expect(registerRecoveryShortcut(register, restore)).toBe(
      "Ctrl + Shift + M",
    );
    expect(register).toHaveBeenCalledTimes(1);
    expect(restore).not.toHaveBeenCalled();
    callbacks.get("CommandOrControl+Shift+M")!();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(callbacks.size).toBe(1);
  });

  it("主快捷键由其他程序持有时，公布并绑定实际可用的备用键", () => {
    const externallyHeld = new Set(["CommandOrControl+Shift+M"]);
    const callbacks = new Map<string, () => void>();
    const restore = vi.fn();
    const register = vi.fn((accelerator: string, callback: () => void) => {
      if (externallyHeld.has(accelerator)) return false;
      callbacks.set(accelerator, callback);
      return true;
    });

    expect(registerRecoveryShortcut(register, restore)).toBe(
      "Ctrl + Alt + Shift + M",
    );
    expect(callbacks.has("CommandOrControl+Shift+M")).toBe(false);
    expect(externallyHeld.has("CommandOrControl+Shift+M")).toBe(true);
    expect(restore).not.toHaveBeenCalled();
    callbacks.get("CommandOrControl+Alt+Shift+M")!();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(2);
  });

  it("原生注册抛错与冲突混合发生时，后续备用键仍可恢复交互", () => {
    let active: (() => void) | undefined;
    const restore = vi.fn();
    const register = vi.fn((accelerator: string, callback: () => void) => {
      if (accelerator === "CommandOrControl+Shift+M")
        throw new Error("Native registration unavailable");
      if (accelerator === "CommandOrControl+Alt+Shift+M") return false;
      active = callback;
      return true;
    });

    expect(registerRecoveryShortcut(register, restore)).toBe(
      "Ctrl + Shift + F12",
    );
    expect(register).toHaveBeenCalledTimes(3);
    expect(restore).not.toHaveBeenCalled();
    expect(active).toBe(restore);
    active!();
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("全部候选不可用时返回明确的无快捷键状态，不假装已注册", () => {
    const restore = vi.fn();
    const register = vi
      .fn<(accelerator: string, callback: () => void) => boolean>()
      .mockReturnValueOnce(false)
      .mockImplementationOnce(() => {
        throw new Error("Native registration failure");
      })
      .mockReturnValueOnce(false);

    expect(registerRecoveryShortcut(register, restore)).toBeNull();
    expect(register).toHaveBeenCalledTimes(3);
    expect(restore).not.toHaveBeenCalled();
  });
});
