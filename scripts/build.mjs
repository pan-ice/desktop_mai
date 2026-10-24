import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  launchEnvironment,
  runProcess,
  toolEntry,
  projectRoot,
} from "./process-tools.mjs";
import { sourceDigest, recordProductionBuild } from "./build-state.mjs";

export async function buildApplication() {
  const before = await sourceDigest(projectRoot);
  const env = launchEnvironment("production");
  await runProcess(
    process.execPath,
    [toolEntry("typescript", "tsc"), "--noEmit"],
    env,
  );
  await runProcess(
    process.execPath,
    [toolEntry("electron-vite", "electron-vite"), "build"],
    env,
  );
  await recordProductionBuild(projectRoot, before);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await buildApplication().catch((error) => {
    console.error(`构建失败：${error.message}`);
    process.exitCode = 1;
  });
