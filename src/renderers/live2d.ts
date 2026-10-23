import * as PIXI from "pixi.js";
import type {
  Cubism4InternalModel,
  Cubism2InternalModel,
} from "pixi-live2d-display/cubism4";
import type { ImportedModel, Mood } from "../../shared/types";
import { createHairDynamics } from "./live2d-hair";
import { configureClipping, type ClippingRenderer } from "./live2d-clipping";
import { modernFace } from "./live2d-parameters";
import {
  LIVE2D_RUNTIME_FILES,
  live2dRuntimeForEntry,
  type Live2DRuntime,
} from "../../shared/live2d";

declare global {
  interface Window {
    PIXI: typeof PIXI;
    Live2DCubismCore?: unknown;
    Live2D?: unknown;
    Live2DModelWebGL?: { loadModel: unknown };
  }
}
const cores: Partial<
  Record<
    Live2DRuntime,
    { url: string; promise: Promise<void>; script: HTMLScriptElement }
  >
> = {};

async function waitForCore(runtime: Live2DRuntime) {
  const started = performance.now();
  while (performance.now() - started < 5000) {
    try {
      if (
        runtime === "legacy" &&
        window.Live2D &&
        typeof window.Live2DModelWebGL?.loadModel === "function"
      )
        return;
      const core = window.Live2DCubismCore as
        | {
            Version?: { csmGetVersion(): number };
          }
        | undefined;
      if (
        runtime === "modern" &&
        core?.Version &&
        core.Version.csmGetVersion() > 0
      )
        return;
    } catch {
      // JavaScript 已加载时，Core 内的 WebAssembly 可能仍在初始化。
    }
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  throw new Error("Cubism Core 未能初始化，请在角色衣橱中更换官方运行库");
}

async function ensureCore(url: string, runtime: Live2DRuntime) {
  const source = new URL(url);
  if (
    source.protocol !== "mai-asset:" ||
    source.hostname !== "runtime" ||
    source.pathname !== `/${LIVE2D_RUNTIME_FILES[runtime]}` ||
    !/^[a-f0-9]{64}$/.test(source.searchParams.get("v") || "")
  )
    throw new Error("请在角色衣橱中下载或设置通过官方校验的 Live2D 运行库");
  const previous = cores[runtime];
  if (previous?.url === url) return previous.promise;
  if (previous) await previous.promise.catch(() => {});
  previous?.script.remove();
  if (runtime === "modern") window.Live2DCubismCore = undefined;
  const script = document.createElement("script");
  const promise = new Promise<void>((resolve, reject) => {
    script.src = url;
    script.onload = () => {
      void waitForCore(runtime).then(resolve, reject);
    };
    script.onerror = () =>
      reject(
        new Error("无法加载本地 Cubism Core，请在角色衣橱中重新设置运行库"),
      );
    document.head.append(script);
  }).catch((error) => {
    if (cores[runtime]?.script === script) delete cores[runtime];
    script.remove();
    throw error;
  });
  cores[runtime] = { url, script, promise };
  return promise;
}

export async function mount(
  host: HTMLElement,
  model: ImportedModel,
  mood: () => Mood,
  reduced: boolean,
  mouth: () => number,
): Promise<() => void> {
  if (!model.coreUrl) throw new Error("请在角色衣橱中设置一次 Live2D 运行库");
  const runtime = live2dRuntimeForEntry(model.entry);
  await ensureCore(model.coreUrl, runtime);
  window.PIXI = PIXI;
  const { Live2DModel } =
    runtime === "legacy"
      ? await import("pixi-live2d-display/cubism2")
      : await import("pixi-live2d-display/cubism4");
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
      autoHitTest: true,
      autoFocus: true,
      autoUpdate: true,
    });
  } catch (error) {
    app.destroy(true);
    throw new Error(
      `Live2D 加载失败，请确认模型资源完整，并在角色衣橱中设置支持该模型版本的运行库：${error instanceof Error ? error.message : String(error)}`,
    );
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
  // The upstream 0.5 declarations omit EventEmitter's methods on InternalModel.
  const internal = avatar.internalModel as typeof avatar.internalModel & {
    on(event: string, listener: () => void): void;
    off(event: string, listener: () => void): void;
  };
  let updateHair: ReturnType<typeof createHairDynamics>;
  let updateFace: (mouth: number, sleeping: boolean) => void;
  if (runtime === "legacy") {
    const legacy = internal as unknown as Cubism2InternalModel;
    updateFace = (mouth, sleeping) => {
      legacy.coreModel.setParamFloat("PARAM_MOUTH_OPEN_Y", mouth);
      if (sleeping) {
        legacy.coreModel.setParamFloat("PARAM_EYE_L_OPEN", 0);
        legacy.coreModel.setParamFloat("PARAM_EYE_R_OPEN", 0);
      }
    };
  } else {
    const modern = internal as unknown as Cubism4InternalModel;
    configureClipping(modern.renderer as unknown as ClippingRenderer);
    if (!reduced)
      updateHair = createHairDynamics(
        modern.coreModel,
        Boolean(modern.physics),
      );
    updateFace = modernFace(
      modern.coreModel,
      modern.motionManager.lipSyncIds,
      modern.motionManager.eyeBlinkIds,
    );
  }
  const updateMood = () => {
    updateHair?.(avatar.deltaTime / 1000);
    updateFace(mouth(), mood() === "sleeping");
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
