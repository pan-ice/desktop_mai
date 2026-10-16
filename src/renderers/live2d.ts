import * as PIXI from "pixi.js";
import type { Cubism4InternalModel } from "pixi-live2d-display/cubism4";
import type { ImportedModel, Mood } from "../../shared/types";
import { createHairDynamics } from "./live2d-hair";

declare global {
  interface Window {
    PIXI: typeof PIXI;
    Live2DCubismCore?: unknown;
  }
}
let corePromise: Promise<void> | undefined;
let loadedCoreUrl = "";

async function ensureCore(url: string) {
  if (window.Live2DCubismCore) return;
  if (corePromise && loadedCoreUrl === url) return corePromise;
  loadedCoreUrl = url;
  corePromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.onload = () =>
      window.Live2DCubismCore
        ? resolve()
        : reject(new Error("Cubism Core 未能初始化，请导入官方 SDK Core"));
    script.onerror = () => {
      corePromise = undefined;
      script.remove();
      reject(new Error("无法加载本地 Cubism Core"));
    };
    document.head.append(script);
  });
  return corePromise;
}

export async function mount(
  host: HTMLElement,
  model: ImportedModel,
  mood: () => Mood,
  reduced: boolean,
): Promise<() => void> {
  if (!model.coreUrl) throw new Error("请重新导入模型并选择 Cubism Core");
  await ensureCore(model.coreUrl);
  window.PIXI = PIXI;
  const { Live2DModel } = await import("pixi-live2d-display/cubism4");
  Live2DModel.registerTicker(PIXI.Ticker);
  // 小尺寸角色用两倍采样改善边缘，高 DPI 屏幕按实际像素密度渲染。
  const renderResolution = () => {
    const bounds = host.getBoundingClientRect();
    const scale = Math.max(
      host.clientWidth ? bounds.width / host.clientWidth : 1,
      host.clientHeight ? bounds.height / host.clientHeight : 1,
    );
    return Math.max(2, (window.devicePixelRatio || 1) * scale);
  };
  const app = new PIXI.Application({
    width: host.clientWidth || 260,
    height: host.clientHeight || 300,
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: renderResolution(),
  });
  let avatar: InstanceType<typeof Live2DModel>;
  try {
    avatar = await Live2DModel.from(model.assetUrl, {
      autoInteract: true,
      autoUpdate: true,
    });
  } catch (error) {
    app.destroy(true);
    throw error;
  }
  app.stage.addChild(avatar);
  host.replaceChildren(app.view as HTMLCanvasElement);
  const original = { width: avatar.width, height: avatar.height };
  const resize = () => {
    const width = host.clientWidth || 260,
      height = host.clientHeight || 300;
    app.renderer.resolution = renderResolution();
    app.renderer.resize(width, height);
    const scale =
      Math.min(width / original.width, height / original.height) * 0.94;
    avatar.scale.set(scale);
    avatar.anchor.set(0.5, 1);
    avatar.position.set(width / 2, height);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host, { box: "device-pixel-content-box" });
  resize();
  // Electron 缩放或切换屏幕时，CSS 尺寸可能不变，仍需更新画布像素密度。
  let densityQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  const densityChanged = () => {
    densityQuery.removeEventListener("change", densityChanged);
    densityQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    densityQuery.addEventListener("change", densityChanged);
    resize();
  };
  densityQuery.addEventListener("change", densityChanged);
  window.addEventListener("resize", resize);
  let elapsed = 0;
  const internal = avatar.internalModel as Cubism4InternalModel;
  const updateHair = reduced
    ? undefined
    : createHairDynamics(internal.coreModel, Boolean(internal.physics));
  const updateMood = () => {
    updateHair?.(avatar.deltaTime / 1000);
    elapsed += app.ticker.deltaMS / 1000;
    const core = internal.coreModel as {
      setParameterValueById(id: string, value: number): void;
    };
    core.setParameterValueById(
      "ParamMouthOpenY",
      mood() === "speaking" ? 0.3 + Math.sin(elapsed * 16) * 0.25 : 0,
    );
    if (mood() === "sleeping") {
      core.setParameterValueById("ParamEyeLOpen", 0);
      core.setParameterValueById("ParamEyeROpen", 0);
    }
  };
  // 在动作、眨眼和物理计算之后写入，避免它们覆盖口型与睡眠闭眼。
  internal.on("beforeModelUpdate", updateMood);
  app.ticker.maxFPS = reduced ? 20 : 30;
  const visibility = () => {
    if (document.hidden) app.stop();
    else app.start();
  };
  document.addEventListener("visibilitychange", visibility);
  return () => {
    observer.disconnect();
    densityQuery.removeEventListener("change", densityChanged);
    window.removeEventListener("resize", resize);
    document.removeEventListener("visibilitychange", visibility);
    internal.off("beforeModelUpdate", updateMood);
    avatar.destroy();
    app.destroy(true, { children: true, texture: true, baseTexture: true });
  };
}
