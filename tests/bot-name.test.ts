import { describe, expect, it } from "vitest";
import { displayBotName } from "../shared/bot-name";
import { emptySnapshot } from "../shared/defaults";

describe("MaiBot 显示名称", () => {
  it("开启跟随时使用当前内核提供的名字，保留手动名", () => {
    const state = emptySnapshot();
    state.settings.nickname = "手动小麦";
    state.settings.followBotName = true;
    state.botName = "内核阿团";
    expect(displayBotName(state)).toBe("内核阿团");
    expect(state.settings.nickname).toBe("手动小麦");
  });

  it("关闭跟随后始终使用手动名", () => {
    const state = emptySnapshot();
    state.settings.nickname = "我的小伙伴";
    state.settings.followBotName = false;
    state.botName = "MaiBot 名字";
    expect(displayBotName(state)).toBe("我的小伙伴");
  });

  it.each([null, ""])("尚未获得有效名字 %s 时回退手动名", (botName) => {
    const state = emptySnapshot();
    state.settings.nickname = "保留的称呼";
    state.settings.followBotName = true;
    state.botName = botName;
    expect(displayBotName(state)).toBe("保留的称呼");
  });

  it("切换连接清除名称后不会继续显示上一连接的名字", () => {
    const state = emptySnapshot();
    state.settings.nickname = "本机备用名";
    state.settings.followBotName = true;
    state.botName = "上一内核";
    expect(displayBotName(state)).toBe("上一内核");
    state.botName = null;
    expect(displayBotName(state)).toBe("本机备用名");
    state.botName = "当前内核";
    expect(displayBotName(state)).toBe("当前内核");
  });

  it("临时关闭再开启跟随能找回两种名字而不改写偏好", () => {
    const state = emptySnapshot();
    state.settings.nickname = "手动名字";
    state.settings.followBotName = true;
    state.botName = "自动名字";
    const before = structuredClone(state);
    expect(displayBotName(state)).toBe("自动名字");
    expect(state).toEqual(before);
    state.settings.followBotName = false;
    expect(displayBotName(state)).toBe("手动名字");
    state.settings.followBotName = true;
    expect(displayBotName(state)).toBe("自动名字");
  });
});
