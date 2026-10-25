import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TtsHttpError } from "../electron/tts-errors";
import { TtsScheduler } from "../electron/tts-scheduler";

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
  for (let tick = 0; tick < 12; tick++) await Promise.resolve();
}

const schedulers: TtsScheduler[] = [];
function scheduler(random = () => 0) {
  const value = new TtsScheduler({ now: Date.now, random });
  schedulers.push(value);
  return value;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T00:00:00Z"));
});

afterEach(async () => {
  for (const value of schedulers.splice(0)) value.dispose();
  await settle();
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("所有窗口共享同一lane，并发上限1直到run真正完成", async () => {
  const value = scheduler();
  const first = deferred<string>();
  const second = deferred<string>();
  const starts: string[] = [];
  const one = value.schedule({
    lane: "mimo",
    owner: 1,
    id: "one",
    priority: "foreground",
    run: () => {
      starts.push("one");
      return first.promise;
    },
  });
  const two = value.schedule({
    lane: "mimo",
    owner: 2,
    id: "two",
    priority: "prefetch",
    run: () => {
      starts.push("two");
      return second.promise;
    },
  });
  expect(starts).toEqual(["one"]);
  first.resolve("audio-one");
  await expect(one).resolves.toBe("audio-one");
  expect(starts).toEqual(["one", "two"]);
  second.resolve("audio-two");
  await expect(two).resolves.toBe("audio-two");
});

it("前台先于等待的预取，相同优先级仍FIFO", async () => {
  const value = scheduler();
  const active = deferred<string>();
  const starts: string[] = [];
  const submit = (id: string, priority: "foreground" | "prefetch") =>
    value.schedule({
      lane: "mimo",
      owner: 1,
      id,
      priority,
      run: async () => {
        starts.push(id);
        return id === "active" ? active.promise : id;
      },
    });
  const promises = [
    submit("active", "prefetch"),
    submit("prefetch-one", "prefetch"),
    submit("foreground-one", "foreground"),
    submit("foreground-two", "foreground"),
    submit("prefetch-two", "prefetch"),
  ];
  active.resolve("active");
  await Promise.all(promises);
  expect(starts).toEqual([
    "active",
    "foreground-one",
    "foreground-two",
    "prefetch-one",
    "prefetch-two",
  ]);
});

it("起始间隔在两次请求之间保留，已有并发容量也不能抢发", async () => {
  const value = scheduler();
  const first = deferred<string>();
  const second = deferred<string>();
  const starts: number[] = [];
  const baseline = Date.now();
  const submit = (id: string, result: Promise<string>) =>
    value.schedule({
      lane: "mimo",
      owner: 1,
      id,
      priority: "foreground",
      concurrency: 2,
      minIntervalMs: 700,
      run: () => {
        starts.push(Date.now() - baseline);
        return result;
      },
    });
  const one = submit("one", first.promise);
  const two = submit("two", second.promise);
  await vi.advanceTimersByTimeAsync(699);
  expect(starts).toEqual([0]);
  await vi.advanceTimersByTimeAsync(1);
  expect(starts).toEqual([0, 700]);
  first.resolve("one");
  second.resolve("two");
  await Promise.all([one, two]);
});

it("较宽并发的后来请求不能放宽当前lane的安全上限", async () => {
  const value = scheduler();
  const first = deferred<string>();
  const starts: string[] = [];
  const one = value.schedule({
    lane: "mimo",
    owner: 1,
    id: "one",
    priority: "foreground",
    concurrency: 1,
    run: () => first.promise,
  });
  const two = value.schedule({
    lane: "mimo",
    owner: 2,
    id: "two",
    priority: "foreground",
    concurrency: 2,
    run: async () => {
      starts.push("two");
      return "two";
    },
  });
  await settle();
  expect(starts).toEqual([]);
  first.resolve("one");
  await Promise.all([one, two]);
  expect(starts).toEqual(["two"]);
});

it("不同lane可以独立前进，取消请求也按owner隔离", async () => {
  const value = scheduler();
  const first = deferred<string>();
  const second = deferred<string>();
  const signals: AbortSignal[] = [];
  const submit = (lane: string, owner: number, promise: Promise<string>) =>
    value.schedule({
      lane,
      owner,
      id: "same-id",
      priority: "foreground",
      run: (signal) => {
        signals.push(signal);
        return promise;
      },
    });
  const one = submit("mimo", 1, first.promise);
  const rejected = expect(one).rejects.toMatchObject({ name: "AbortError" });
  const two = submit("other-provider", 2, second.promise);
  expect(signals).toHaveLength(2);
  value.cancel(1, "same-id");
  await rejected;
  expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
  first.resolve("late-cancelled");
  second.resolve("two");
  await expect(two).resolves.toBe("two");
});

it("重复owner/id拒绝，不影响其他owner相同id", async () => {
  const value = scheduler();
  const active = deferred<string>();
  const first = value.schedule({
    lane: "mimo",
    owner: 1,
    id: "same",
    priority: "foreground",
    run: () => active.promise,
  });
  const run = vi.fn(async () => "duplicate");
  await expect(
    value.schedule({
      lane: "mimo",
      owner: 1,
      id: "same",
      priority: "foreground",
      run,
    }),
  ).rejects.toThrow("重复");
  expect(run).not.toHaveBeenCalled();
  active.resolve("one");
  await first;
  await expect(
    value.schedule({
      lane: "mimo",
      owner: 2,
      id: "same",
      priority: "foreground",
      run: async () => "other-owner",
    }),
  ).resolves.toBe("other-owner");
});

it("取消active立即拒绝，但真实run未settle之前绝不释放槽位或复用id", async () => {
  const value = scheduler();
  const active = deferred<string>();
  const next = vi.fn(async () => "next");
  let signal: AbortSignal | undefined;
  const first = value.schedule({
    lane: "mimo",
    owner: 1,
    id: "one",
    priority: "foreground",
    run: (input) => {
      signal = input;
      return active.promise;
    },
  });
  const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
  const second = value.schedule({
    lane: "mimo",
    owner: 2,
    id: "two",
    priority: "foreground",
    run: next,
  });
  value.cancel(1, "one");
  await rejected;
  expect(signal?.aborted).toBe(true);
  expect(next).not.toHaveBeenCalled();
  await expect(
    value.schedule({
      lane: "mimo",
      owner: 1,
      id: "one",
      priority: "foreground",
      run: async () => "duplicate",
    }),
  ).rejects.toThrow("重复");
  await vi.advanceTimersByTimeAsync(10000);
  expect(next).not.toHaveBeenCalled();
  active.resolve("late");
  await expect(second).resolves.toBe("next");
  expect(next).toHaveBeenCalledTimes(1);
});

it("取消queued或同owner所有任务后不再出网", async () => {
  const value = scheduler();
  const active = deferred<string>();
  const run = vi.fn(async () => "queued");
  const submit = (id: string, work: () => Promise<string> = run) =>
    value.schedule({
      lane: "mimo",
      owner: 1,
      id,
      priority: "prefetch",
      run: work,
    });
  const first = submit("active", () => active.promise);
  const second = submit("queued-one");
  const third = submit("queued-two");
  const rejected = [first, second, third].map((promise) =>
    expect(promise).rejects.toMatchObject({ name: "AbortError" }),
  );
  value.cancelOwner(2);
  expect(run).not.toHaveBeenCalled();
  value.cancelOwner(1);
  await Promise.all(rejected);
  active.resolve("late");
  await settle();
  expect(run).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("429按1秒和2秒退避，等待时其他窗口及预取均不能抢发", async () => {
  const value = scheduler();
  const starts: { id: string; at: number }[] = [];
  const baseline = Date.now();
  let attempt = 0;
  const one = value.schedule({
    lane: "mimo",
    owner: 1,
    id: "one",
    priority: "foreground",
    run: async () => {
      starts.push({ id: "one", at: Date.now() - baseline });
      if (++attempt < 3) throw new TtsHttpError(429);
      return "one";
    },
  });
  await settle();
  const two = value.schedule({
    lane: "mimo",
    owner: 2,
    id: "two",
    priority: "prefetch",
    run: async () => {
      starts.push({ id: "two", at: Date.now() - baseline });
      return "two";
    },
  });
  await vi.advanceTimersByTimeAsync(999);
  expect(starts).toEqual([{ id: "one", at: 0 }]);
  await vi.advanceTimersByTimeAsync(1);
  expect(starts).toEqual([
    { id: "one", at: 0 },
    { id: "one", at: 1000 },
  ]);
  await vi.advanceTimersByTimeAsync(1999);
  expect(starts).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  await Promise.all([one, two]);
  expect(starts).toEqual([
    { id: "one", at: 0 },
    { id: "one", at: 1000 },
    { id: "one", at: 3000 },
    { id: "two", at: 3000 },
  ]);
});

it("Retry-After比指数退避更长时完整等待，跨lane不受影响", async () => {
  const value = scheduler();
  const starts: number[] = [];
  const baseline = Date.now();
  let count = 0;
  const request = value.schedule({
    lane: "mimo",
    owner: 1,
    id: "one",
    priority: "foreground",
    run: async () => {
      starts.push(Date.now() - baseline);
      if (++count === 1) throw new TtsHttpError(429, 4000);
      return "ready";
    },
  });
  await settle();
  await expect(
    value.schedule({
      lane: "other",
      owner: 2,
      id: "other",
      priority: "foreground",
      run: async () => "other-ready",
    }),
  ).resolves.toBe("other-ready");
  await vi.advanceTimersByTimeAsync(3999);
  expect(starts).toEqual([0]);
  await vi.advanceTimersByTimeAsync(1);
  await expect(request).resolves.toBe("ready");
  expect(starts).toEqual([0, 4000]);
});

it("持续429最多三次尝试，最终失败仍保留lane冷却", async () => {
  const value = scheduler();
  const run = vi.fn(async () => {
    throw new TtsHttpError(429);
  });
  const request = value.schedule({
    lane: "mimo",
    owner: 1,
    id: "one",
    priority: "foreground",
    run,
  });
  const failure = expect(request).rejects.toMatchObject({ status: 429 });
  await vi.advanceTimersByTimeAsync(3000);
  await failure;
  expect(run).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
  const next = vi.fn(async () => "next");
  const later = value.schedule({
    lane: "mimo",
    owner: 2,
    id: "two",
    priority: "foreground",
    run: next,
  });
  await vi.advanceTimersByTimeAsync(3999);
  expect(next).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(later).resolves.toBe("next");
});

it.each([401, 402, 403])("HTTP %i 不自动重试或冷却其他请求", async (status) => {
  const value = scheduler();
  const run = vi.fn(async () => {
    throw new TtsHttpError(status);
  });
  await expect(
    value.schedule({
      lane: "mimo",
      owner: 1,
      id: "one",
      priority: "foreground",
      run,
    }),
  ).rejects.toMatchObject({ status });
  expect(run).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  await expect(
    value.schedule({
      lane: "mimo",
      owner: 2,
      id: "two",
      priority: "foreground",
      run: async () => "two",
    }),
  ).resolves.toBe("two");
});

it("长Retry-After不截短重试，不留空转timer；后续请求也不能绕过", async () => {
  const value = scheduler();
  const run = vi.fn(async () => {
    throw new TtsHttpError(429, 90000);
  });
  await expect(
    value.schedule({
      lane: "mimo",
      owner: 1,
      id: "one",
      priority: "foreground",
      run,
    }),
  ).rejects.toMatchObject({ status: 429, retryAfterMs: 90000 });
  expect(run).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  const next = vi.fn(async () => "next");
  await vi.advanceTimersByTimeAsync(70000);
  await expect(
    value.schedule({
      lane: "mimo",
      owner: 2,
      id: "two",
      priority: "foreground",
      run: next,
    }),
  ).rejects.toMatchObject({ retryAfterMs: 20000 });
  expect(next).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(10001);
  const accepted = value.schedule({
    lane: "mimo",
    owner: 2,
    id: "three",
    priority: "foreground",
    run: next,
  });
  await vi.advanceTimersByTimeAsync(9998);
  expect(next).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(accepted).resolves.toBe("next");
});

it("取消冷却中的重试立即拒绝，清掉timer且永不再调度", async () => {
  const value = scheduler();
  const run = vi.fn(async () => {
    throw new TtsHttpError(429, 5000);
  });
  const request = value.schedule({
    lane: "mimo",
    owner: 1,
    id: "one",
    priority: "foreground",
    run,
  });
  const aborted = expect(request).rejects.toMatchObject({ name: "AbortError" });
  await settle();
  expect(vi.getTimerCount()).toBe(1);
  value.cancel(1, "one");
  await aborted;
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(100000);
  expect(run).toHaveBeenCalledTimes(1);
});

it("取消active后迟到429也不能恢复旧job，dispose不留等待任务", async () => {
  const value = scheduler();
  const active = deferred<string>();
  const run = vi.fn(() => active.promise);
  const queuedRun = vi.fn(async () => "queued");
  const first = value.schedule({
    lane: "mimo",
    owner: 1,
    id: "one",
    priority: "foreground",
    run,
  });
  const second = value.schedule({
    lane: "mimo",
    owner: 2,
    id: "two",
    priority: "prefetch",
    run: queuedRun,
  });
  const failures = [first, second].map((promise) =>
    expect(promise).rejects.toMatchObject({ name: "AbortError" }),
  );
  value.dispose();
  await Promise.all(failures);
  active.reject(new TtsHttpError(429));
  await settle();
  await vi.advanceTimersByTimeAsync(100000);
  expect(run).toHaveBeenCalledTimes(1);
  expect(queuedRun).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  await expect(
    value.schedule({
      lane: "mimo",
      owner: 1,
      id: "three",
      priority: "foreground",
      run: async () => "late",
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
});

it("抖动注入可测，且不会短于基础退避", async () => {
  const value = scheduler(() => 0.5);
  const run = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(new TtsHttpError(429))
    .mockResolvedValue("ready");
  const request = value.schedule({
    lane: "mimo",
    owner: 1,
    id: "one",
    priority: "foreground",
    run,
  });
  await vi.advanceTimersByTimeAsync(1124);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await expect(request).resolves.toBe("ready");
  expect(run).toHaveBeenCalledTimes(2);
});
