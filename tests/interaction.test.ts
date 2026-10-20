import { expect, it } from "vitest";
import { emptySnapshot } from "../shared/defaults";
import { interactionLabel } from "../shared/interaction";
import {
  audioRms,
  mouthFromRms,
  playbackReportSchema,
} from "../shared/playback";

it("波形响度忽略正负相位，静音和无效样本保持闭嘴", () => {
  expect(audioRms([0.1, -0.1, 0.1, -0.1])).toBeCloseTo(0.1);
  expect(audioRms([])).toBe(0);
  expect(audioRms([Number.NaN, 0, Number.POSITIVE_INFINITY])).toBe(0);
  expect(mouthFromRms(0, 0)).toBe(0);
  expect(mouthFromRms(0.005, 0)).toBe(0);
});

it("有声时快速开口，停顿后平滑闭嘴，过大信号不会越界", () => {
  let mouth = mouthFromRms(0.1, 0);
  expect(mouth).toBeGreaterThan(0.4);
  const softer = mouthFromRms(0.02, mouth);
  expect(softer).toBeLessThan(mouth);
  for (let frame = 0; frame < 15; frame++) mouth = mouthFromRms(0, mouth);
  expect(mouth).toBe(0);
  expect(mouthFromRms(100, 0.8)).toBeLessThanOrEqual(1);
});

it("播放帧区分真实静音与无法采样，拒绝越界和非有限值", () => {
  const id = "34a7c6df-d619-4ed7-bc73-bf00f0cc9a40";
  for (const mouth of [0, 1, null])
    expect(
      playbackReportSchema.safeParse({ type: "playing", id, mouth }).success,
    ).toBe(true);
  for (const mouth of [-1, 1.01, Number.NaN, Number.POSITIVE_INFINITY])
    expect(
      playbackReportSchema.safeParse({ type: "playing", id, mouth }).success,
    ).toBe(false);
  expect(
    playbackReportSchema.safeParse({ type: "playing", id: "invalid", mouth: 0 })
      .success,
  ).toBe(false);
});

it("没有内核生成事件时只显示发送/等待，不把沉默当故障或思考", () => {
  const state = emptySnapshot();
  state.mood = "thinking";
  expect(interactionLabel(state)).toBeNull();
  state.replyStatus = "sending";
  expect(interactionLabel(state)).toBe("正在发送…");
  state.replyStatus = "waiting";
  expect(interactionLabel(state)).toBe("已发送，等麦麦回应");
  state.replyStatus = "idle";
  expect(interactionLabel(state)).toBeNull();
});

it("转写、录音和实际播放优先于等待回复的状态", () => {
  const state = emptySnapshot();
  state.replyStatus = "waiting";
  state.playback.phase = "preparing";
  expect(interactionLabel(state)).toBe("正在准备声音…");
  state.playback.phase = "playing";
  expect(interactionLabel(state)).toBe("正在播放声音");
  state.voiceInput = "recording";
  expect(interactionLabel(state)).toBe("正在听你说…");
  state.voiceInput = "transcribing";
  expect(interactionLabel(state)).toBe("正在转写…");
  state.voiceInput = "listening";
  state.playback.phase = "idle";
  state.replyStatus = "idle";
  state.conversationActive = true;
  expect(interactionLabel(state)).toBe("正在聆听");
  state.focusUntil = Date.now() + 1000;
  expect(interactionLabel(state)).toBe("专注陪伴中");
});
