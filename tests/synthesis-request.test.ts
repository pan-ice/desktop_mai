import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesktopApi } from "../shared/types";

const runtime = vi.hoisted(() => ({
  invoke: vi.fn(),
  preloadApi: undefined as DesktopApi | undefined,
  api: {
    synthesize: vi.fn(),
    synthesizeResult: undefined as DesktopApi["synthesizeResult"] | undefined,
    cancelSynthesis: vi.fn() as ((id: string) => void) | undefined,
  },
}));
vi.mock("../src/api", () => ({ api: runtime.api }));
vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: DesktopApi) => {
      runtime.preloadApi = api;
    },
  },
  ipcRenderer: {
    invoke: runtime.invoke,
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
  },
}));

import { finalSynthesisError, requestSynthesis } from "../src/audio/synthesis";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle() {
  for (let tick = 0; tick < 8; tick++) await Promise.resolve();
}

beforeEach(() => {
  runtime.invoke.mockReset();
  runtime.api.synthesize.mockReset();
  runtime.api.synthesizeResult = undefined;
  runtime.api.cancelSynthesis = vi.fn();
});
afterEach(() => vi.restoreAllMocks());

it("已取消的请求不发起合成或取消IPC", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    requestSynthesis("不应提交", "foreground", controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(runtime.api.synthesize).not.toHaveBeenCalled();
  expect(runtime.api.cancelSynthesis).not.toHaveBeenCalled();
});

it.each(["success", "failure"])(
  "等待中取消立即结束本地等待，迟到%s不重复动作",
  async (outcome) => {
    const response = deferred<string>();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    runtime.api.synthesize.mockReturnValue(response.promise);
    const pending = requestSynthesis("第二条", "prefetch", controller.signal);
    const settled = vi.fn();
    void pending.then(settled, settled);
    const assertion = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    const [text, options] = runtime.api.synthesize.mock.calls[0];
    expect(text).toBe("第二条");
    expect(options.priority).toBe("prefetch");
    expect(options.id).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
    controller.abort();
    await assertion;
    expect(settled).toHaveBeenCalledOnce();
    expect(runtime.api.cancelSynthesis).toHaveBeenCalledExactlyOnceWith(
      options.id,
    );
    expect(remove).toHaveBeenCalledExactlyOnceWith(
      "abort",
      expect.any(Function),
    );
    if (outcome === "success") response.resolve("audio:late");
    else response.reject(new Error("late failure"));
    await settle();
    controller.abort();
    expect(settled).toHaveBeenCalledOnce();
    expect(runtime.api.cancelSynthesis).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
  },
);

it.each(["success", "failure"])(
  "正常%s会清理监听，之后的abort不会取消已完成请求",
  async (outcome) => {
    const response = deferred<string>();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    runtime.api.synthesize.mockReturnValue(response.promise);
    const pending = requestSynthesis("首条", "foreground", controller.signal);
    const handler = add.mock.calls[0][1];
    if (outcome === "success") {
      response.resolve("audio:ready");
      await expect(pending).resolves.toBe("audio:ready");
    } else {
      const error = Object.assign(new Error("服务端已结束有限重试"), {
        name: "TtsFinalError",
      });
      response.reject(error);
      await expect(pending).rejects.toBe(error);
    }
    expect(remove).toHaveBeenCalledExactlyOnceWith("abort", handler);
    controller.abort();
    await settle();
    expect(runtime.api.cancelSynthesis).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledOnce();
  },
);

it("同步IPC失败仍保留错误并清理abort监听", async () => {
  const error = new Error("IPC unavailable");
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  runtime.api.synthesize.mockImplementation(() => {
    throw error;
  });
  await expect(
    requestSynthesis("当前段", "foreground", controller.signal),
  ).rejects.toBe(error);
  expect(remove).toHaveBeenCalledOnce();
  controller.abort();
  expect(runtime.api.cancelSynthesis).not.toHaveBeenCalled();
});

it("没有旧版可选cancel接口时仍立即取消本地等待", async () => {
  const response = deferred<string>();
  const controller = new AbortController();
  runtime.api.cancelSynthesis = undefined;
  runtime.api.synthesize.mockReturnValue(response.promise);
  const pending = requestSynthesis("兼容等待", "foreground", controller.signal);
  const assertion = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  controller.abort();
  await assertion;
  response.resolve("audio:late");
  await settle();
});

it("注册监听时取消也不会再发起合成", async () => {
  const response = deferred<string>();
  const controller = new AbortController();
  const original = controller.signal.addEventListener.bind(controller.signal);
  vi.spyOn(controller.signal, "addEventListener").mockImplementation(
    (type, handler, options) => {
      original(type, handler, options);
      controller.abort();
    },
  );
  runtime.api.synthesize.mockReturnValue(response.promise);
  await expect(
    requestSynthesis("注册交错", "foreground", controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(runtime.api.synthesize).not.toHaveBeenCalled();
  expect(runtime.api.cancelSynthesis).toHaveBeenCalledOnce();
});

it("无取消信号时仍携带独立请求ID与优先级", async () => {
  runtime.api.synthesize.mockResolvedValue("audio:plain");
  await expect(requestSynthesis("简单调用", "foreground")).resolves.toBe(
    "audio:plain",
  );
  expect(runtime.api.synthesize).toHaveBeenCalledWith("简单调用", {
    id: expect.any(String),
    priority: "foreground",
  });
  expect(runtime.api.cancelSynthesis).not.toHaveBeenCalled();
});

it.each(["AbortError", "TtsFinalError"])(
  "%s 是已处理的最终结果，普通错误和不可信对象不是",
  (name) => {
    expect(
      finalSynthesisError(Object.assign(new Error("safe"), { name })),
    ).toBe(true);
    expect(finalSynthesisError(new Error("TtsFinalError"))).toBe(false);
    expect(finalSynthesisError({ name })).toBe(false);
    expect(finalSynthesisError(null)).toBe(false);
    expect(finalSynthesisError(name)).toBe(false);
  },
);

it("真实preload返回纯数据envelope，跨桥复制后由renderer重建最终错误和取消分类", async () => {
  await import("../electron/preload");
  expect(runtime.preloadApi).toBeDefined();
  // Electron's bridge does not preserve custom Error.name. Deliberately make
  // the legacy throwing path lose it, while copying only plain wire data.
  runtime.api.synthesize.mockImplementation(async (text, options) => {
    try {
      return await runtime.preloadApi!.synthesize(text, options);
    } catch (error) {
      throw structuredClone(error);
    }
  });
  runtime.api.synthesizeResult = async (text, options) =>
    JSON.parse(
      JSON.stringify(await runtime.preloadApi!.synthesizeResult(text, options)),
    );
  const named = Object.assign(new Error("bridge-copy"), {
    name: "TtsFinalError",
  });
  expect(structuredClone(named).name).toBe("Error");
  for (const status of [429, 401, 402, 403]) {
    const message = `handled HTTP ${status}`;
    runtime.invoke.mockResolvedValueOnce({
      ok: false,
      error: message,
      errorKind: "tts_final",
    });
    const error = await requestSynthesis("第二条", "prefetch").catch(
      (value: unknown) => value,
    );
    expect(error).toMatchObject({ name: "TtsFinalError", message });
    expect(finalSynthesisError(error)).toBe(true);
  }
  runtime.invoke.mockResolvedValueOnce({
    ok: false,
    error: "已取消",
    errorKind: "cancelled",
  });
  const cancelled = await requestSynthesis("取消", "foreground").catch(
    (value: unknown) => value,
  );
  expect(cancelled).toMatchObject({ name: "AbortError" });
  expect(finalSynthesisError(cancelled)).toBe(true);
  runtime.invoke.mockResolvedValueOnce({ ok: false, error: "legacy failure" });
  const legacy = await requestSynthesis("旧错误", "foreground").catch(
    (value: unknown) => value,
  );
  expect(legacy).toMatchObject({ name: "Error", message: "legacy failure" });
  expect(finalSynthesisError(legacy)).toBe(false);
  expect(runtime.api.synthesize).not.toHaveBeenCalled();
  expect(runtime.invoke).toHaveBeenCalledWith(
    "mai:command",
    "synthesize",
    "第二条",
    { id: expect.any(String), priority: "prefetch" },
  );
});

it.each(["success", "failure"])(
  "envelope请求取消后迟到%s不恢复或重复取消",
  async (outcome) => {
    const response =
      deferred<Awaited<ReturnType<DesktopApi["synthesizeResult"]>>>();
    const result = vi.fn(async () => structuredClone(await response.promise));
    runtime.api.synthesizeResult = result;
    const controller = new AbortController();
    const pending = requestSynthesis("跨桥等待", "prefetch", controller.signal);
    const settled = vi.fn();
    void pending.then(settled, settled);
    const assertion = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await assertion;
    if (outcome === "success")
      response.resolve({ ok: true, value: "audio:late" });
    else
      response.resolve({
        ok: false,
        error: "safe final",
        errorKind: "tts_final",
      });
    await settle();
    expect(settled).toHaveBeenCalledOnce();
    expect(runtime.api.cancelSynthesis).toHaveBeenCalledOnce();
    expect(runtime.api.synthesize).not.toHaveBeenCalled();
  },
);

it("envelope成功值也在renderer还原并优先于旧抛错接口", async () => {
  runtime.api.synthesizeResult = vi.fn(async () =>
    structuredClone({ ok: true as const, value: "audio:copied" }),
  );
  await expect(requestSynthesis("已合成", "foreground")).resolves.toBe(
    "audio:copied",
  );
  expect(runtime.api.synthesize).not.toHaveBeenCalled();
});
