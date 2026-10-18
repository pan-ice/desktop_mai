import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Script } from "node:vm";

export const LIVE2D_CORE_FILE = "live2dcubismcore.min.js";
export const LIVE2D_CORE_DOWNLOAD_URL =
  "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js";
const MAX_CORE_BYTES = 10 * 1024 * 1024;

export interface Live2DCore {
  file: string;
  revision: string;
}

function coreDirectory(modelsRoot: string) {
  return join(modelsRoot, ".live2d-core");
}

function validateCore(bytes: Buffer) {
  if (bytes.length > MAX_CORE_BYTES)
    throw new Error("Cubism Core 文件超过 10 MB 限制");
  const source = bytes.toString("utf8");
  try {
    if (
      !source.includes("Live2DCubismCore") ||
      !source.includes("csmGetVersion")
    )
      throw new Error("unrecognized core");
    // 只检查语法；运行库仅在模型渲染窗口执行。
    new Script(source);
  } catch {
    throw new Error(
      "无法识别 Cubism Core，请选择官方 SDK 中的 live2dcubismcore.min.js",
    );
  }
  return {
    bytes,
    revision: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function readCore(file: string) {
  const info = await lstat(file);
  if (!info.isFile()) throw new Error("Cubism Core 必须是本地 JavaScript 文件");
  if (info.size > MAX_CORE_BYTES)
    throw new Error("Cubism Core 文件超过 10 MB 限制");
  return validateCore(await readFile(file));
}

async function saveCore(
  modelsRoot: string,
  { bytes, revision }: ReturnType<typeof validateCore>,
): Promise<Live2DCore> {
  const directory = coreDirectory(modelsRoot);
  const file = join(directory, LIVE2D_CORE_FILE);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return { file, revision };
}

export async function installLive2DCore(
  modelsRoot: string,
  source: string,
): Promise<Live2DCore> {
  return saveCore(modelsRoot, await readCore(source));
}

export async function downloadLive2DCore(
  modelsRoot: string,
  request: (url: string, options: RequestInit) => Promise<Response> = fetch,
): Promise<Live2DCore> {
  try {
    const response = await request(LIVE2D_CORE_DOWNLOAD_URL, {
      signal: AbortSignal.timeout(30000),
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    if (Number(response.headers.get("content-length")) > MAX_CORE_BYTES) {
      await response.body?.cancel();
      throw new Error("Cubism Core 文件超过 10 MB 限制");
    }
    if (!response.body) throw new Error("官方服务器返回了空文件");
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_CORE_BYTES)
          throw new Error("Cubism Core 文件超过 10 MB 限制");
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return await saveCore(modelsRoot, validateCore(Buffer.concat(chunks)));
  } catch (error) {
    throw new Error(
      `官方 Live2D 运行库下载失败：${error instanceof Error ? error.message : String(error)}。请检查网络或系统代理后重试，也可从本地导入运行库。`,
    );
  }
}

export async function findLive2DCore(
  modelsRoot: string,
): Promise<Live2DCore | undefined> {
  const file = join(coreDirectory(modelsRoot), LIVE2D_CORE_FILE);
  try {
    return { file, revision: (await readCore(file)).revision };
  } catch {
    // 缺失或损坏时仍可重新设置，也可从旧版导入的角色中恢复。
  }
  let entries;
  try {
    entries = await readdir(modelsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/i.test(entry.name)) continue;
    try {
      return await installLive2DCore(
        modelsRoot,
        join(modelsRoot, entry.name, LIVE2D_CORE_FILE),
      );
    } catch {
      // 一个旧角色缺少或带有无效的 Core 时继续检查其他角色。
    }
  }
}

export function live2dCoreUrl(core: Live2DCore) {
  return `mai-asset://runtime/${LIVE2D_CORE_FILE}?v=${core.revision}`;
}
