import { describe, expect, it } from "vitest";
import { createHairDynamics } from "../src/renderers/live2d-hair";

const hairIds = [
  "ParamHairSideL",
  "ParamHairSideLMid",
  "ParamHairSideLTip",
  "ParamHairSideR",
  "ParamHairSideRMid",
  "ParamHairSideRTip",
];
function fixture(ids = hairIds) {
  const values = new Map<string, number>();
  const parameterIds = ["ParamAngleX", "ParamAngleZ", ...ids];
  const core = {
    getModel: () => ({
      parameters: {
        ids: parameterIds,
        minimumValues: parameterIds.map((id) =>
          id.startsWith("ParamAngle") ? -45 : -1,
        ),
        maximumValues: parameterIds.map((id) =>
          id.startsWith("ParamAngle") ? 45 : 1,
        ),
        defaultValues: parameterIds.map(() => 0),
      },
    }),
    getParameterValueById: (id: string) => values.get(id) ?? 0,
    addParameterValueById: (id: string, value: number) =>
      values.set(id, (values.get(id) ?? 0) + value),
  };
  const update = createHairDynamics(core, false)!;
  const tick = (head: number, delta = 1 / 60, authored = 0) => {
    values.set("ParamAngleX", head);
    for (const id of ids) values.set(id, authored);
    update(delta);
    return hairIds.map((id) => values.get(id) ?? 0);
  };
  return { core, tick };
}

describe("Live2D 三段侧发惯性", () => {
  it("转头时先产生反向惯性，再逐段传到发梢", () => {
    const { tick } = fixture();
    tick(0);
    const frames = Array.from({ length: 90 }, () => tick(25));
    expect(frames[0][0]).toBeGreaterThan(0.1);
    expect(Math.abs(frames[0][2])).toBeLessThan(Math.abs(frames[0][0]) * 0.1);
    const peakAt = (segment: number) =>
      frames.reduce(
        (peak, frame, index) =>
          Math.abs(frame[segment]) > Math.abs(frames[peak][segment])
            ? index
            : peak,
        0,
      );
    expect(peakAt(1)).toBeGreaterThan(peakAt(0));
    expect(peakAt(2)).toBeGreaterThan(peakAt(1));
  });

  it("停头后回摆并衰减，不会持续漂移", () => {
    const { tick } = fixture();
    tick(0);
    for (let i = 0; i < 120; i++) tick(25);
    const first = tick(0);
    expect(first[0]).toBeLessThan(-0.1);
    let settled = first;
    for (let i = 0; i < 240; i++) settled = tick(0);
    expect(Math.max(...settled.map(Math.abs))).toBeLessThan(0.001);
  });

  it("20 FPS 与 60 FPS 下产生一致的延迟和幅度", () => {
    const slow = fixture(),
      fast = fixture();
    slow.tick(0);
    fast.tick(0);
    for (let frame = 0; frame < 30; frame++) {
      const left = slow.tick(25, 1 / 20);
      let right = left;
      for (let substep = 0; substep < 3; substep++)
        right = fast.tick(25, 1 / 60);
      left.forEach((value, index) =>
        expect(value).toBeCloseTo(right[index], 5),
      );
    }
  });

  it("恢复长暂停时不甩动，叠加动作后仍保持参数范围", () => {
    const { tick } = fixture();
    tick(0);
    tick(45);
    expect(tick(-45, 10)).toEqual([0, 0, 0, 0, 0, 0]);
    for (let i = 0; i < 120; i++)
      expect(
        tick(i % 2 ? -45 : 45, 1 / 30, 0.9).every(
          (value) => Number.isFinite(value) && value >= -1 && value <= 1,
        ),
      ).toBe(true);
  });

  it("保留模型原生物理，不为缺少分段参数的模型创建虚假参数", () => {
    const { core } = fixture();
    expect(createHairDynamics(core, true)).toBeUndefined();
    expect(createHairDynamics(fixture([]).core, false)).toBeUndefined();
  });
});
