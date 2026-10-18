import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { messageAdapterPython } from "./message-adapter-python.mjs";

const python = messageAdapterPython();
for (const [executable, args, cwd] of [
  [
    python,
    ["-m", "unittest", "discover", "-s", "tests", "-v"],
    resolve("adapter"),
  ],
  [
    process.execPath,
    [
      resolve("node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      "vitest.message-adapter.config.ts",
    ],
    process.cwd(),
  ],
]) {
  const result = spawnSync(executable, args, {
    cwd,
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONUTF8: "1",
      MAI_MESSAGE_ADAPTER_PYTHON: python,
    },
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) {
    console.error(
      "适配器测试失败；请先在 adapter/ 执行 uv sync，或设置 MAI_MESSAGE_ADAPTER_PYTHON。",
    );
    process.exit(result.status ?? 1);
  }
}
