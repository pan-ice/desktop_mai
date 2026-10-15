import { describe, expect, it } from "vitest";
import { inQuietHours, shouldReachOut } from "../electron/companion";
import { defaultSettings } from "../shared/defaults";
import { sendSchema, settingsPatchSchema } from "../shared/schemas";

describe("陪伴节奏", () => {
  it("支持跨午夜及同日免打扰；起止相同表示不设置免打扰", () => {
    expect(inQuietHours(1, 23, 8)).toBe(true);
    expect(inQuietHours(8, 23, 8)).toBe(false);
    expect(inQuietHours(12, 11, 14)).toBe(true);
    expect(inQuietHours(20, 8, 8)).toBe(false);
  });
  it("离线、专注、禁用或未到间隔时不会搭话", () => {
    const now = new Date(2026, 9, 15, 14).getTime();
    const settings = {
      ...defaultSettings,
      proactiveEnabled: true,
      proactiveMinutes: 30,
    };
    const last = now - 31 * 60000;
    expect(shouldReachOut(settings, now, last, true, null)).toBe(true);
    expect(shouldReachOut(settings, now, last, false, null)).toBe(false);
    expect(shouldReachOut(settings, now, last, true, now + 1000)).toBe(false);
    expect(shouldReachOut(settings, now, now - 5000, true, null)).toBe(false);
    expect(shouldReachOut(defaultSettings, now, last, true, null)).toBe(false);
  });
});
describe("IPC 输入边界", () => {
  it("拒绝执行性服务 URL、意外字段和越界设置", () => {
    for (const patch of [
      { adapterPort: 80 },
      { adapterPort: 65536 },
      { maibotUrl: "ws://127.0.0.1:8000/ws" },
      { petScale: 99 },
      { arbitraryCommand: "run" },
    ])
      expect(settingsPatchSchema.safeParse(patch).success).toBe(false);
    expect(sendSchema.safeParse({ text: "" }).success).toBe(false);
    expect(
      sendSchema.safeParse({
        text: "你好",
        image: "https://example.com/image.png",
      }).success,
    ).toBe(false);
  });
});
