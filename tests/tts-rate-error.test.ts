import { afterEach, expect, it, vi } from "vitest";
import { defaultSettings } from "../shared/defaults";
import { ttsProviders } from "../shared/tts";
import { synthesizeTts } from "../electron/tts";
import { TtsHttpError, ttsResponseError } from "../electron/tts-errors";

afterEach(() => vi.unstubAllGlobals());

function settings() {
  return {
    ...structuredClone(defaultSettings),
    ttsProvider: "mimo" as const,
    ttsProfiles: { mimo: { ...ttsProviders.mimo.defaults } },
  };
}

it("保留429限流与Retry-After信息，不误提示Key或暴露服务端正文", async () => {
  const secret = "test-secret-not-to-be-displayed";
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "rate_limit_exceeded", message: secret },
          }),
          {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": "2" },
          },
        ),
    ),
  );
  const error = await synthesizeTts(settings(), "fake-test-key", "测试").catch(
    (value: unknown) => value,
  );
  expect(error).toMatchObject({
    status: 429,
    retryAfterMs: 2000,
    retryable: true,
    quota: false,
  });
  expect((error as Error).message).toContain("限流");
  expect((error as Error).message).not.toContain("检查 Key");
  expect((error as Error).message).not.toContain(secret);
});

it.each([
  [401, false, "认证失败"],
  [403, false, "拒绝访问"],
  [402, true, "余额或额度不足"],
  [503, false, "HTTP 503"],
] as const)(
  "HTTP %i 不盲重试并区分确定的认证/额度状态",
  async (status, quota, hint) => {
    const error = await ttsResponseError(
      new Response("untrusted-secret-key-and-private-url", { status }),
    );
    expect(error).toBeInstanceOf(TtsHttpError);
    expect(error).toMatchObject({ status, quota, retryable: false });
    expect(error.message).toContain(hint);
    expect(error.message).not.toContain("untrusted");
  },
);

it.each([
  ["0", 0],
  ["0.25", 250],
  ["90", 90000],
  ["86400", 86400000],
  ["-1", undefined],
  ["Infinity", undefined],
  ["1e3", undefined],
  ["nonsense", undefined],
  ["999999999999999999999999999999", undefined],
] as const)(
  "Retry-After %s 安全解析且不缩短有效长等待",
  async (header, expected) => {
    const error = await ttsResponseError(
      new Response("", { status: 429, headers: { "Retry-After": header } }),
    );
    expect(error.retryAfterMs).toBe(expected);
  },
);

it("Retry-After HTTP-date 使用接收时刻，过去日期为0", async () => {
  const now = Date.UTC(2026, 9, 25, 10, 0, 0);
  const future = await ttsResponseError(
    new Response("", {
      status: 429,
      headers: { "Retry-After": new Date(now + 120000).toUTCString() },
    }),
    now,
  );
  expect(future.retryAfterMs).toBe(120000);
  const past = await ttsResponseError(
    new Response("", {
      status: 429,
      headers: { "Retry-After": new Date(now - 1000).toUTCString() },
    }),
    now,
  );
  expect(past.retryAfterMs).toBe(0);
});

it("未知429正文不被猜测为确定额度故障，也不读取或泄露正文", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream({ cancel });
  const error = await ttsResponseError(
    new Response(body, { status: 429, headers: { "Retry-After": "1" } }),
  );
  expect(error).toMatchObject({
    quota: false,
    retryable: true,
    retryAfterMs: 1000,
  });
  expect(error.message).toContain("可能");
  expect(error.message).toContain("账户额度限制");
  expect(cancel).toHaveBeenCalledOnce();
});

it("预先取消不发送网络请求，并保留原AbortError", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  const reason = new DOMException("cancel test", "AbortError");
  controller.abort(reason);
  await expect(
    synthesizeTts(settings(), "fake-key", "取消", undefined, controller.signal),
  ).rejects.toBe(reason);
  expect(fetch).not.toHaveBeenCalled();
});

it("请求中取消保留AbortError而不是报告超时或网络故障", async () => {
  const controller = new AbortController();
  const reason = new DOMException("cancel active test", "AbortError");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener(
            "abort",
            () => reject(init.signal!.reason),
            { once: true },
          );
        }),
    ),
  );
  const pending = synthesizeTts(
    settings(),
    "fake-key",
    "请求中取消",
    undefined,
    controller.signal,
  );
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
});

it("MiMo成功响应正文读取中取消也保留AbortError", async () => {
  const controller = new AbortController();
  const reason = new DOMException("cancel body test", "AbortError");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (_url: string, init: RequestInit) =>
        new Response(
          new ReadableStream({
            start(stream) {
              init.signal!.addEventListener(
                "abort",
                () => stream.error(init.signal!.reason),
                { once: true },
              );
            },
          }),
          { status: 200 },
        ),
    ),
  );
  const pending = synthesizeTts(
    settings(),
    "fake-key",
    "读取中取消",
    undefined,
    controller.signal,
  );
  await Promise.resolve();
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
});

it("读取错误响应元数据后取消优先于HTTP失败", async () => {
  const controller = new AbortController();
  const reason = new DOMException("cancel error body test", "AbortError");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              controller.abort(reason);
            },
          }),
          { status: 429, headers: { "Retry-After": "2" } },
        ),
    ),
  );
  await expect(
    synthesizeTts(
      settings(),
      "fake-key",
      "取消错误响应",
      undefined,
      controller.signal,
    ),
  ).rejects.toBe(reason);
});
