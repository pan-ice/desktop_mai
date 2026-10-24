import { buildApplication } from "./build.mjs";
import { productionBuildCurrent } from "./build-state.mjs";
import {
  launchEnvironment,
  projectRequire,
  runProcess,
} from "./process-tools.mjs";

try {
  if (!(await productionBuildCurrent())) {
    console.log("正在准备完整的正式页面与启动文件…");
    await buildApplication();
  }
  await runProcess(
    projectRequire("electron"),
    [".", ...process.argv.slice(2)],
    launchEnvironment("production"),
  );
} catch (error) {
  console.error(`启动失败：${error.message}`);
  process.exitCode = 1;
}
