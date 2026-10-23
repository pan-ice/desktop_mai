// Compatibility for the Cubism Web renderer used by pixi-live2d-display 0.5.
// The atlas budget follows N.E.K.O; layout is allocated across all channels so
// remainders and temporarily inactive masks retain distinct, stable slots.
interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface ClipContext {
  _bufferIndex: number;
  _layoutChannelNo: number;
  _layoutBounds: Rectangle;
  _allClippedDrawRect: Rectangle;
  _clippedDrawableIndexList: number[];
  _isUsing: boolean;
}
interface DrawableModel {
  getDrawableVertexCount(index: number): number;
  getDrawableVertices(index: number): ArrayLike<number>;
}
interface ClippingManager {
  _clippingContextListForMask: ClipContext[];
  _renderTextureCount: number;
  setupLayoutBounds(active: number): void;
  calcClippedDrawTotalBounds(model: DrawableModel, context: ClipContext): void;
  setGL(gl: WebGLRenderingContext): void;
}
interface RendererProfile {
  gl: WebGLRenderingContext;
  save(): void;
  _lastArrayBufferBinding: WebGLBuffer | null;
  _lastElementArrayBufferBinding: WebGLBuffer | null;
}
export interface ClippingRenderer {
  gl: WebGLRenderingContext;
  _clippingManager?: ClippingManager;
  _rendererProfile?: RendererProfile;
  useHighPrecisionMask(enabled: boolean): void;
  setClippingMaskBufferSize(size: number): void;
}

export function maskTextureCount(count: number): number | null {
  if (!Number.isSafeInteger(count) || count < 0)
    throw new Error("无效的 Live2D 遮罩数量");
  const textures = Math.max(3, Math.ceil(count / 32));
  return textures <= 32 ? textures : null;
}

function layout(this: ClippingManager, active: number) {
  const contexts = this._clippingContextListForMask;
  if (active === 0) {
    for (const context of contexts) {
      context._bufferIndex = context._layoutChannelNo = 0;
      Object.assign(context._layoutBounds, { x: 0, y: 0, width: 1, height: 1 });
    }
    return;
  }
  const channels = this._renderTextureCount * 4;
  const perChannel = Math.floor(contexts.length / channels);
  const remainder = contexts.length % channels;
  let offset = 0;
  for (let channel = 0; channel < channels; channel++) {
    const count = perChannel + (channel < remainder ? 1 : 0);
    const columns = count <= 1 ? 1 : count <= 4 ? 2 : 3;
    const rows = count <= 2 ? 1 : columns;
    for (let slot = 0; slot < count; slot++) {
      const context = contexts[offset++];
      context._bufferIndex = Math.floor(channel / 4);
      context._layoutChannelNo = channel % 4;
      Object.assign(context._layoutBounds, {
        x: (slot % columns) / columns,
        y: Math.floor(slot / columns) / rows,
        width: 1 / columns,
        height: 1 / rows,
      });
    }
  }
}

function bounds(model: DrawableModel, context: ClipContext) {
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const index of context._clippedDrawableIndexList) {
    const vertices = model.getDrawableVertices(index);
    for (let i = 0; i < model.getDrawableVertexCount(index) * 2; i += 2) {
      const x = vertices[i],
        y = vertices[i + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  context._isUsing = left !== Infinity;
  Object.assign(
    context._allClippedDrawRect,
    context._isUsing
      ? { x: left, y: top, width: right - left, height: bottom - top }
      : { x: 0, y: 0, width: 0, height: 0 },
  );
}

const patched = new WeakSet<object>();
export function configureClipping(renderer: ClippingRenderer) {
  const manager = renderer._clippingManager;
  if (manager) {
    const count = maskTextureCount(manager._clippingContextListForMask.length);
    manager._renderTextureCount = count ?? 1;
    renderer.useHighPrecisionMask(count === null);
    manager.setupLayoutBounds = layout;
    manager.calcClippedDrawTotalBounds = bounds;
  }
  if (patched.has(renderer)) return;
  patched.add(renderer);
  const profile = renderer._rendererProfile;
  if (profile) {
    const save = profile.save;
    profile.save = function () {
      // Upstream stores ELEMENT_ARRAY_BUFFER_BINDING in the array-buffer field.
      const array = this.gl.getParameter(this.gl.ARRAY_BUFFER_BINDING);
      const element = this.gl.getParameter(
        this.gl.ELEMENT_ARRAY_BUFFER_BINDING,
      );
      save.call(this);
      this._lastArrayBufferBinding = array;
      this._lastElementArrayBufferBinding = element;
    };
  }
  const resize = renderer.setClippingMaskBufferSize;
  renderer.setClippingMaskBufferSize = function (size) {
    resize.call(this, size);
    if (this.gl) this._clippingManager?.setGL(this.gl);
    configureClipping(this);
  };
}
