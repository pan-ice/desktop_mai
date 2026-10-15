import * as PIXI from "pixi.js";
import type { ImportedModel, Mood } from "../../shared/types";

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
  const app = new PIXI.Application({
    width: host.clientWidth || 260,
    height: host.clientHeight || 300,
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(devicePixelRatio, 1.5),
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
    app.renderer.resize(width, height);
    const scale =
      Math.min(width / original.width, height / original.height) * 0.94;
    avatar.scale.set(scale);
    avatar.anchor.set(0.5, 1);
    avatar.position.set(width / 2, height);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();
  let elapsed = 0;
  const tick = () => {
    elapsed += app.ticker.deltaMS / 1000;
    const core = avatar.internalModel.coreModel as {
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
  app.ticker.add(tick);
  app.ticker.maxFPS = reduced ? 20 : 30;
  const visibility = () => {
    if (document.hidden) app.stop();
    else app.start();
  };
  document.addEventListener("visibilitychange", visibility);
  return () => {
    observer.disconnect();
    document.removeEventListener("visibilitychange", visibility);
    app.ticker.remove(tick);
    avatar.destroy();
    app.destroy(true, { children: true, texture: true, baseTexture: true });
  };
}
