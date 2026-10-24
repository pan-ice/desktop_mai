import { join, resolve } from "node:path";

export const pluginDirectory = resolve(
  process.env.MAI_DESKTOP_ADAPTER_ROOT || "MaiBot/plugins/desktop_pet_adapter",
);
export const pluginPython =
  process.env.MAI_PYTHON ||
  join(
    pluginDirectory,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
