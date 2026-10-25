import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emptySnapshot } from "../shared/defaults";
import type { PlaybackReport } from "../shared/playback";

const runtime = vi.hoisted(() => ({
  api: {} as Record<string, unknown>,
  toast: vi.fn(),
}));
vi.mock("../src/api", () => ({ api: runtime.api, showToast: runtime.toast }));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  runtime.toast.mockReset();
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("speechSynthesis", { cancel: vi.fn(), getVoices: () => [] });
  vi.stubGlobal("HTMLMediaElement", class {});
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function fixture() {
  const state = emptySnapshot();
  state.settings.voiceEnabled = true;
  state.settings.ttsEngine = "api";
  state.settings.ttsProvider = "mimo";
  let onStop: (id: string | null) => void = () => {};
  let activeId: string | null = null;
  let resolveAudio: (url: string) => void = () => {};
  const audioReady = new Promise<string>((resolve) => {
    resolveAudio = resolve;
  });
  const played: string[] = [];
  const paused: string[] = [];
  class FakeAudio {
    onended?: () => void;
    onerror?: () => void;
    constructor(readonly url: string) {}
    async play() {
      played.push(this.url);
    }
    pause() {
      paused.push(this.url);
    }
  }
  vi.stubGlobal("Audio", FakeAudio);
  const stopPlayback = vi.fn(() => {
    const previousId = activeId;
    activeId = null;
    // IPC sends the stop acknowledgement after the next playback has begun.
    Promise.resolve().then(() => onStop(previousId));
  });
  Object.assign(runtime.api, {
    snapshot: async () => structuredClone(state),
    onPlayback: () => () => {},
    onStopPlayback: (callback: typeof onStop) => {
      onStop = callback;
      return () => {};
    },
    reportPlayback: (report: PlaybackReport) => {
      if (report.type === "start") activeId = report.id;
      else if (report.type === "end" && activeId === report.id) activeId = null;
    },
    stopPlayback,
    synthesize: vi.fn(() => audioReady),
    cancelSynthesis: vi.fn(),
  });
  const { speak, stopSpeech } = await import("../src/hooks/useVoice");
  return {
    state,
    speak,
    stopSpeech,
    resolveAudio,
    played,
    paused,
    stopPlayback,
    onStop: (id: string | null) => onStop(id),
  };
}

async function settle() {
  for (let tick = 0; tick < 30; tick++) await Promise.resolve();
}

it("首次试听不会被自己发送的旧播放停止通知取消", async () => {
  const f = await fixture();
  const preview = f.speak("试听声音", f.state.settings);
  await settle();
  f.resolveAudio("audio:preview");
  await settle();
  expect(f.played).toEqual(["audio:preview"]);
  expect(runtime.api.cancelSynthesis).not.toHaveBeenCalled();
  f.stopSpeech();
  await preview;
});

it("真正的全局停止仍能取消正在等待合成的试听", async () => {
  const f = await fixture();
  const preview = f.speak("等待合成", f.state.settings);
  await settle();
  f.onStop(null);
  f.resolveAudio("audio:cancelled");
  await preview;
  expect(f.played).toEqual([]);
  expect(runtime.api.cancelSynthesis).toHaveBeenCalledTimes(1);
});

it("停止按钮能中止已经开始的试听", async () => {
  const f = await fixture();
  const preview = f.speak("试听后停止", f.state.settings);
  await settle();
  f.resolveAudio("audio:preview");
  await settle();
  expect(f.played).toEqual(["audio:preview"]);
  f.stopSpeech();
  await preview;
  expect(f.paused).toEqual(["audio:preview"]);
  expect(f.stopPlayback).toHaveBeenCalled();
});
