import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { CoreProcess } from "../electron/core-process";

const files = vi.hoisted(() => ({ access: vi.fn(), readFile: vi.fn() }));
vi.mock("node:fs/promises", () => files);
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

let core: CoreProcess;
const children: ChildProcess[] = [];
beforeEach(() => {
  core = new CoreProcess("core_host.py");
  files.access.mockReset().mockResolvedValue(undefined);
  files.readFile
    .mockReset()
    .mockImplementation(async (file: string) =>
      file.endsWith(".confirmed")
        ? createHash("md5").update("contract").digest("hex")
        : "contract",
    );
  vi.mocked(spawn)
    .mockReset()
    .mockImplementation(() => {
      // 使用真实 ChildProcess 事件和管道接口，不创建操作系统进程。
      const child = new ChildProcess();
      child.stdin = new PassThrough();
      let exitCode: number | null = null;
      Object.defineProperty(child, "exitCode", { get: () => exitCode });
      children.push(child);
      child.stdin.on("data", () => {
        queueMicrotask(() => {
          exitCode = 0;
          child.emit("exit", 0, null);
        });
      });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
});
afterEach(async () => {
  await core.stop();
  for (const child of children.splice(0)) child.stdin?.destroy();
});

it("启动检查尚未结束时拒绝并发启动，只管理一个内核", async () => {
  let release!: () => void;
  files.access.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const first = core.start("fixture");
  const second = core.start("fixture").then(
    () => "started",
    () => "rejected",
  );
  release();
  await first;
  expect(await second).toBe("rejected");
  expect(spawn).toHaveBeenCalledTimes(1);
  await core.stop();
  expect(children.every((child) => child.exitCode === 0)).toBe(true);
});

it("启动检查期间停止，等待启动结束后回收内核", async () => {
  let release!: () => void;
  files.access.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const starting = core.start("fixture");
  const stopping = core.stop();
  release();
  await Promise.all([starting, stopping]);
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(children[0].exitCode).toBe(0);
});

it("启动失败会释放启动状态，停止和重新启动均可完成", async () => {
  files.access.mockRejectedValueOnce(new Error("missing"));
  await expect(core.start("fixture")).rejects.toThrow("缺少 bot.py");
  await core.stop();
  await core.start("fixture");
  expect(spawn).toHaveBeenCalledTimes(1);
});
