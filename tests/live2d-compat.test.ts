import { describe, expect, it, vi } from "vitest";
import {
  configureClipping,
  type ClippingRenderer,
  maskTextureCount,
} from "../src/renderers/live2d-clipping";
import { modernFace } from "../src/renderers/live2d-parameters";

function renderer(count: number) {
  const contexts = Array.from({ length: count }, () => ({
    _bufferIndex: -1,
    _layoutChannelNo: -1,
    _layoutBounds: { x: 0, y: 0, width: 0, height: 0 },
    _allClippedDrawRect: { x: 0, y: 0, width: 0, height: 0 },
    _clippedDrawableIndexList: [0],
    _isUsing: true,
  }));
  const result = {
    gl: {} as WebGLRenderingContext,
    _clippingManager: {
      _clippingContextListForMask: contexts,
      _renderTextureCount: 1,
      setupLayoutBounds: (_count: number) => {},
      calcClippedDrawTotalBounds: (_model: unknown, _context: unknown) => {},
      setGL: vi.fn(),
    },
    useHighPrecisionMask: vi.fn(),
    setClippingMaskBufferSize: vi.fn(),
  } satisfies ClippingRenderer;
  configureClipping(result);
  return result;
}

describe("Live2D 复杂遮罩兼容", () => {
  it.each([1, 36, 94, 95, 96, 97, 1024])(
    "%i 个遮罩都分配独立区域，活动数量变化不会移动区域",
    (count) => {
      const value = renderer(count);
      const manager = value._clippingManager;
      manager.setupLayoutBounds(count);
      const slots = () =>
        manager._clippingContextListForMask.map((c) =>
          [
            c._bufferIndex,
            c._layoutChannelNo,
            c._layoutBounds.x,
            c._layoutBounds.y,
          ].join(":"),
        );
      const initial = slots();
      expect(new Set(initial).size).toBe(count);
      expect(
        manager._clippingContextListForMask.every(
          (c) =>
            c._layoutBounds.width > 0 &&
            c._bufferIndex < manager._renderTextureCount,
        ),
      ).toBe(true);
      manager.setupLayoutBounds(1);
      expect(slots()).toEqual(initial);
    },
  );

  it("超过图集预算后逐个绘制高精度遮罩", () => {
    expect(maskTextureCount(1025)).toBeNull();
    const value = renderer(1025);
    expect(value.useHighPrecisionMask).toHaveBeenCalledWith(true);
    value._clippingManager.setupLayoutBounds(0);
    expect(
      value._clippingManager._clippingContextListForMask.every(
        (c) => c._layoutBounds.width === 1 && c._bufferIndex === 0,
      ),
    ).toBe(true);
  });

  it("负坐标和空网格得到正确边界", () => {
    const value = renderer(1);
    const manager = value._clippingManager;
    const context = manager._clippingContextListForMask[0];
    manager.calcClippedDrawTotalBounds(
      {
        getDrawableVertexCount: () => 2,
        getDrawableVertices: () => [-5, -8, -2, -3],
      },
      context,
    );
    expect(context._allClippedDrawRect).toEqual({
      x: -5,
      y: -8,
      width: 3,
      height: 5,
    });
    manager.calcClippedDrawTotalBounds(
      { getDrawableVertexCount: () => 0, getDrawableVertices: () => [] },
      context,
    );
    expect(context._isUsing).toBe(false);
    expect(context._allClippedDrawRect.width).toBe(0);
  });

  it("保存 GL 状态时分别保留顶点与索引缓冲区", () => {
    const array = {},
      element = {};
    const profile = {
      gl: {
        ARRAY_BUFFER_BINDING: 1,
        ELEMENT_ARRAY_BUFFER_BINDING: 2,
        getParameter: (key: number) => (key === 1 ? array : element),
      } as unknown as WebGLRenderingContext,
      _lastArrayBufferBinding: null as WebGLBuffer | null,
      _lastElementArrayBufferBinding: null as WebGLBuffer | null,
      save() {
        this._lastArrayBufferBinding = element;
      },
    };
    const value = { ...renderer(1), _rendererProfile: profile };
    configureClipping(value);
    profile.save();
    expect(profile._lastArrayBufferBinding).toBe(array);
    expect(profile._lastElementArrayBufferBinding).toBe(element);
  });

  it("遮罩尺寸变化后新管理器继续使用原 GL 和稳定布局", () => {
    const value = renderer(95);
    const replacement = renderer(95)._clippingManager;
    replacement._renderTextureCount = 1;
    replacement.setupLayoutBounds = vi.fn();
    const resized = {
      ...value,
      setClippingMaskBufferSize(_size: number) {
        this._clippingManager = replacement;
      },
    };
    configureClipping(resized);
    resized.setClippingMaskBufferSize(512);
    expect(replacement.setGL).toHaveBeenCalledWith(resized.gl);
    expect(replacement._renderTextureCount).toBe(3);
    replacement.setupLayoutBounds(95);
    expect(
      new Set(
        replacement._clippingContextListForMask.map((c) =>
          [
            c._bufferIndex,
            c._layoutChannelNo,
            c._layoutBounds.x,
            c._layoutBounds.y,
          ].join(":"),
        ),
      ).size,
    ).toBe(95);
  });
});

describe("Live2D 参数适配", () => {
  it("尊重模型声明的自定义口型、眼睛和参数范围，不写入不存在的参数", () => {
    const set = vi.fn();
    const core = {
      getModel: () => ({
        parameters: {
          ids: ["CustomMouth", "CustomEye"],
          minimumValues: [0, 0],
          maximumValues: [2, 3],
        },
      }),
      setParameterValueById: set,
    };
    const face = modernFace(core, ["missing", "CustomMouth"], ["CustomEye"]);
    face(0.75, true);
    expect(set.mock.calls).toEqual([
      ["CustomMouth", 1.5],
      ["CustomEye", 0],
    ]);
    set.mockClear();
    face(0, false);
    expect(set.mock.calls).toEqual([["CustomMouth", 0]]);
  });

  it("缺少 Groups 时兼容标准参数名称", () => {
    const set = vi.fn();
    const core = {
      getModel: () => ({
        parameters: {
          ids: ["ParamMouthOpenY", "ParamEyeLOpen", "ParamEyeROpen"],
          minimumValues: [0, 0, 0],
          maximumValues: [1, 1, 1],
        },
      }),
      setParameterValueById: set,
    };
    modernFace(core, [], [])(1, true);
    expect(set.mock.calls).toEqual([
      ["ParamMouthOpenY", 1],
      ["ParamEyeLOpen", 0],
      ["ParamEyeROpen", 0],
    ]);
  });
});
