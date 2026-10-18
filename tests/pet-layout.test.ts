import { describe, expect, it } from "vitest";
import { fitPetPosition } from "../shared/pet-layout";

describe("桌宠移动边界", () => {
  const area = { x: 0, y: 0, width: 1536, height: 824 };

  it("放大后角色可以贴近四边，透明留白不缩小活动范围", () => {
    expect(fitPetPosition({ x: -2000, y: -2000 }, area, 1.6)).toEqual({
      x: -88,
      y: -158,
    });
    expect(fitPetPosition({ x: 2000, y: 2000 }, area, 1.6)).toEqual({
      x: 1080,
      y: 282,
    });
  });

  it("保留屏幕内的位置，默认与最小大小都使用实际角色范围", () => {
    expect(fitPetPosition({ x: 100, y: 100 }, area, 1.6)).toEqual({
      x: 100,
      y: 100,
    });
    expect(fitPetPosition({ x: 2000, y: 2000 }, area, 1)).toEqual({
      x: 1251,
      y: 485,
    });
    expect(fitPetPosition({ x: -2000, y: -2000 }, area, 0.5)).toEqual({
      x: -27,
      y: -49,
    });
  });

  it("支持主屏左上方的副屏与不含任务栏的工作区", () => {
    const secondary = { x: -1280, y: -120, width: 1280, height: 984 };
    expect(fitPetPosition({ x: -3000, y: -3000 }, secondary, 1.6)).toEqual({
      x: -1368,
      y: -278,
    });
    expect(fitPetPosition({ x: 3000, y: 3000 }, secondary, 1.6)).toEqual({
      x: -456,
      y: 322,
    });
  });
});
