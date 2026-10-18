import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function messageAdapterPython() {
  if (process.env.MAI_MESSAGE_ADAPTER_PYTHON)
    return process.env.MAI_MESSAGE_ADAPTER_PYTHON;
  const executable =
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python";
  for (const directory of ["adapter/.venv", ".cache/message-adapter-venv"])
    if (existsSync(resolve(directory, executable)))
      return resolve(directory, executable);
  return process.platform === "win32" ? "python" : "python3";
}
