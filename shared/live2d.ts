export type Live2DRuntime = "modern" | "legacy";

export const LIVE2D_RUNTIME_FILES: Record<Live2DRuntime, string> = {
  modern: "live2dcubismcore.min.js",
  legacy: "live2d.min.js",
};

export function live2dRuntimeForEntry(entry: string): Live2DRuntime {
  return entry.toLowerCase().endsWith(".model.json") ? "legacy" : "modern";
}
