import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { messageAdapterPython } from "./message-adapter-python.mjs";

const child = spawn(
  messageAdapterPython(),
  [resolve("adapter/tools/package.py"), resolve("release")],
  {
    windowsHide: true,
    stdio: "inherit",
    env: { ...process.env, PYTHONUTF8: "1" },
  },
);
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
