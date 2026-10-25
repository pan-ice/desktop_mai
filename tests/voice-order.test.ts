import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emptySnapshot } from "../shared/defaults";
import type { PlaybackReport } from "../shared/playback";
import { speechSegments } from "../shared/speech-text";

const runtime = vi.hoisted(() => ({
  api: {} as Record<string, unknown>,
  toast: vi.fn(),
}));
vi.mock("../src/api", () => ({ api: runtime.api, showToast: runtime.toast }));

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
  for (let tick = 0; tick < 30; tick++) await Promise.resolve();
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  runtime.toast.mockReset();
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("speechSynthesis", {
    cancel: vi.fn(),
    getVoices: () => [],
  });
  vi.stubGlobal("HTMLMediaElement", class {});
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function fixture(texts = ["1", "2", "3"], structured = false) {
  const state = emptySnapshot();
  state.settings.voiceEnabled = true;
  state.settings.ttsEngine = "api";
  state.settings.ttsProvider = "mimo";
  state.settings.ttsProfiles.mimo = {
    baseUrl: "https://example.invalid/v1",
    model: "mimo-v2.5-tts-voiceclone",
    voice: "mimo-local:fake-reference.wav",
    resourceId: "",
  };
  state.settings.ttsReplyBufferSize = 2;
  const requests: {
    text: string;
    response: ReturnType<typeof deferred<string>>;
  }[] = [];
  const audios: FakeAudio[] = [];
  const played: string[] = [];
  const paused: string[] = [];
  const reports: PlaybackReport[] = [];
  class FakeAudio {
    onended?: () => void;
    onerror?: () => void;
    crossOrigin = "";
    volume = 1;
    constructor(readonly url: string) {
      audios.push(this);
    }
    async play() {
      played.push(this.url);
    }
    pause() {
      paused.push(this.url);
    }
  }
  vi.stubGlobal("Audio", FakeAudio);
  Object.assign(runtime.api, {
    synthesizeResult: undefined,
    snapshot: async () => structuredClone(state),
    onPlayback: () => () => {},
    onStopPlayback: () => () => {},
    reportPlayback: (report: PlaybackReport) => reports.push(report),
    stopPlayback: () => {},
    synthesize: (text: string) => {
      const response = deferred<string>();
      requests.push({ text, response });
      return response.promise;
    },
  });
  const { speak, stopSpeech } = await import("../src/hooks/useVoice");
  const { requestSynthesis } = await import("../src/audio/synthesis");
  const { ReplySpeechQueue } = await import("../src/audio/reply-speech-queue");
  if (structured) {
    runtime.api.synthesizeResult = async (text: string) => {
      try {
        const value = await (
          runtime.api.synthesize as (text: string) => Promise<string>
        )(text);
        return structuredClone({ ok: true, value });
      } catch (error) {
        // This is the plain safe main->preload->renderer result. No custom
        // Error properties are expected to survive the bridge.
        return JSON.parse(
          JSON.stringify({
            ok: false,
            error: (error as Error).message,
            errorKind: "tts_final",
          }),
        );
      }
    };
  }
  const queue = new ReplySpeechQueue({
    startedAt: 0,
    synthesize: structured
      ? (text, signal) => requestSynthesis(text, "prefetch", signal)
      : (runtime.api.synthesize as (text: string) => Promise<string>),
    play: (text, settings, dataUrl, prepared) =>
      speak(text, settings, dataUrl, true, prepared),
    stop: () => stopSpeech(false),
    onError: runtime.toast,
  });
  for (const [index, text] of texts.entries()) {
    const id = String(index + 1);
    state.history.push({
      id,
      text,
      role: "assistant",
      source: "core",
      timestamp: index + 1,
    });
    state.liveReplies.push({ id, receivedAt: index + 1 });
  }
  queue.accept(structuredClone(state));
  await settle();
  return { queue, state, requests, audios, played, paused, reports };
}

it("真实speak与队列保持1/2/3，第三条先合成也不能抢播", async () => {
  const f = await fixture();
  expect(f.requests.map((item) => item.text)).toEqual(["1", "2"]);
  f.requests[0].response.resolve("audio:1");
  await settle();
  expect(f.played).toEqual(["audio:1"]);
  f.audios[0].onended?.();
  await settle();
  expect(f.requests.map((item) => item.text)).toEqual(["1", "2", "3"]);
  f.requests[2].response.resolve("audio:3");
  await settle();
  expect(f.played).toEqual(["audio:1"]);
  f.requests[1].response.resolve("audio:2");
  await settle();
  expect(f.played).toEqual(["audio:1", "audio:2"]);
  f.audios[1].onended?.();
  await settle();
  expect(f.played).toEqual(["audio:1", "audio:2", "audio:3"]);
  f.queue.dispose();
});

it("第二条预合成临时失败时，到播放位置应重试而不是只读1和3", async () => {
  const f = await fixture();
  f.requests[1].response.reject(
    new Error("temporary synthesis concurrency limit"),
  );
  await settle();
  f.requests[0].response.resolve("audio:1");
  await settle();
  const third = f.requests.find((item) => item.text === "3");
  third?.response.resolve("audio:3");
  await settle();
  f.audios[0].onended?.();
  await settle();
  expect(f.played, "第二条预合成失败不能直接跳过到第三条").toEqual(["audio:1"]);
  expect(f.requests.filter((item) => item.text === "2")).toHaveLength(2);
  const retry = f.requests.filter((item) => item.text === "2")[1];
  retry.response.resolve("audio:2");
  await settle();
  expect(f.played).toEqual(["audio:1", "audio:2"]);
  f.audios[1].onended?.();
  await settle();
  expect(f.played).toEqual(["audio:1", "audio:2", "audio:3"]);
  f.queue.dispose();
});

it("取消后迟到的预合成失败或成功都不能重试、继续播放或重新入队", async () => {
  for (const outcome of ["failure", "success"]) {
    const f = await fixture();
    expect(f.requests.map((item) => item.text)).toEqual(["1", "2"]);
    f.requests[0].response.resolve("audio:1");
    await settle();
    f.audios[0].onended?.();
    await settle();
    expect(f.requests.map((item) => item.text)).toEqual(["1", "2", "3"]);
    f.queue.clear();
    if (outcome === "failure")
      f.requests[1].response.reject(
        new Error("cancelled prefetch failed late"),
      );
    else f.requests[1].response.resolve("audio:late-2");
    f.requests[2].response.resolve("audio:late-3");
    await settle();
    f.queue.accept(structuredClone(f.state));
    await settle();
    expect(f.played).toEqual(["audio:1"]);
    expect(f.requests.map((item) => item.text)).toEqual(["1", "2", "3"]);
    expect(runtime.toast).not.toHaveBeenCalled();
    f.queue.dispose();
  }
});

it("前台补合成仍失败时只请求两次、显示错误，且下一条和后续新回复可继续", async () => {
  const f = await fixture();
  f.requests[1].response.reject(new Error("prefetch failed"));
  await settle();
  f.requests[0].response.resolve("audio:1");
  f.requests.find((item) => item.text === "3")!.response.resolve("audio:3");
  await settle();
  f.audios[0].onended?.();
  await settle();
  expect(f.played).toEqual(["audio:1"]);
  const secondRequests = f.requests.filter((item) => item.text === "2");
  expect(secondRequests).toHaveLength(2);
  secondRequests[1].response.reject(new Error("foreground retry failed"));
  await settle();
  expect(f.requests.filter((item) => item.text === "2")).toHaveLength(2);
  expect(runtime.toast).toHaveBeenCalledWith("foreground retry failed", true);
  expect(f.played).toEqual(["audio:1", "audio:3"]);
  f.state.history.push({
    id: "4",
    text: "4",
    role: "assistant",
    source: "core",
    timestamp: 4,
  });
  f.state.liveReplies.push({ id: "4", receivedAt: 4 });
  f.queue.accept(structuredClone(f.state));
  await settle();
  f.requests.find((item) => item.text === "4")!.response.resolve("audio:4");
  await settle();
  f.audios[1].onended?.();
  await settle();
  expect(f.played).toEqual(["audio:1", "audio:3", "audio:4"]);
  expect(f.requests.filter((item) => item.text === "2")).toHaveLength(2);
  f.queue.dispose();
});

it("长回复内部第二段预合成失败时在该段位置重试，完整播放后续第三段", async () => {
  const longReply =
    "一".repeat(900) + "。" + "二".repeat(900) + "。" + "三".repeat(900) + "。";
  const segments = speechSegments(longReply, "mimo");
  expect(segments).toHaveLength(3);
  const f = await fixture([longReply]);
  expect(f.requests.map((item) => item.text)).toEqual([segments[0]]);
  f.requests[0].response.resolve("audio:segment-1");
  await settle();
  expect(f.requests.map((item) => item.text)).toEqual(segments.slice(0, 2));
  f.requests[1].response.reject(new Error("second segment prefetch failed"));
  await settle();
  f.audios[0].onended?.();
  await settle();
  expect(f.played).toEqual(["audio:segment-1"]);
  expect(f.requests.map((item) => item.text)).toEqual([
    segments[0],
    segments[1],
    segments[1],
  ]);
  f.requests[2].response.resolve("audio:segment-2");
  await settle();
  expect(f.played).toEqual(["audio:segment-1", "audio:segment-2"]);
  expect(f.requests[3].text).toBe(segments[2]);
  f.requests[3].response.resolve("audio:segment-3");
  await settle();
  f.audios[1].onended?.();
  await settle();
  expect(f.played).toEqual([
    "audio:segment-1",
    "audio:segment-2",
    "audio:segment-3",
  ]);
  expect(runtime.toast).not.toHaveBeenCalled();
  f.queue.dispose();
});

it.each([429, 401, 402, 403])(
  "主进程HTTP %i最终结果不会在预合成失败后倍增重试",
  async (status) => {
    const f = await fixture(undefined, true);
    const error = new Error(`handled HTTP ${status}`);
    f.requests[1].response.reject(error);
    await settle();
    f.requests[0].response.resolve("audio:1");
    f.requests.find((item) => item.text === "3")!.response.resolve("audio:3");
    await settle();
    f.audios[0].onended?.();
    await settle();
    expect(f.requests.filter((item) => item.text === "2")).toHaveLength(1);
    expect(runtime.toast).toHaveBeenCalledExactlyOnceWith(error.message, true);
    expect(f.played).toEqual(["audio:1", "audio:3"]);
    f.queue.dispose();
  },
);
