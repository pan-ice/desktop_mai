import { useSyncExternalStore } from "react";
import { api } from "../api";
import {
  audioRms,
  idlePlayback,
  mouthFromRms,
  type PlaybackState,
} from "../../shared/playback";
import type { Mood } from "../../shared/types";

let activity: PlaybackState = { ...idlePlayback };
const listeners = new Set<() => void>();
let local: { id: string; cancel: () => void } | undefined;
let context: AudioContext | undefined;
const nodes = new WeakMap<
  HTMLMediaElement,
  {
    source: MediaElementAudioSourceNode;
    analyser: AnalyserNode;
  }
>();

function accept(value: PlaybackState) {
  activity = value;
  listeners.forEach((listener) => listener());
}
let received = false;
api.onPlayback((value) => {
  received = true;
  accept(value);
});
void api
  .snapshot()
  .then((state) => {
    if (!received) accept(state.playback);
  })
  .catch(() => {});
api.onStopPlayback((id) => {
  // A delayed stop for an earlier playback must not clear a newer reply queue.
  if (id !== null && local && local.id !== id) return;
  local?.cancel();
  window.dispatchEvent(new Event("mai:stop-speech"));
});

export function usePlaybackActivity() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => activity,
  );
}

export function playbackActivity() {
  return activity;
}

export function mouthOpen(mood: Mood): number {
  if (activity.phase === "preparing") return 0;
  if (activity.phase === "playing" && activity.mouth !== null)
    return activity.mouth;
  if (activity.phase !== "playing" && mood !== "speaking") return 0;
  // 系统朗读不能取得波形，保留基础动画。
  return 0.3 + Math.sin(performance.now() / 62.5) * 0.25;
}

/** 一次播放拥有独立标识；旧 ended/合成响应不能结束新会话。 */
export function beginPlayback(onStop: () => void) {
  local?.cancel();
  const id = crypto.randomUUID();
  let ended = false;
  let stopMeter: (() => void) | undefined;
  const end = () => {
    if (ended) return;
    ended = true;
    stopMeter?.();
    if (local?.id === id) local = undefined;
    api.reportPlayback({ type: "end", id });
  };
  local = {
    id,
    cancel: () => {
      end();
      onStop();
    },
  };
  api.reportPlayback({ type: "start", id });
  return {
    end,
    playing(audio?: HTMLMediaElement) {
      if (ended) return;
      stopMeter?.();
      const fallback = () => {
        const report = () =>
          api.reportPlayback({ type: "playing", id, mouth: null });
        report();
        const timer = setInterval(report, 33);
        stopMeter = () => clearInterval(timer);
      };
      if (!audio || !(audio instanceof HTMLMediaElement)) {
        fallback();
        return;
      }
      try {
        context ??= new AudioContext();
        void context.resume().catch(() => {});
        let node = nodes.get(audio);
        if (!node) {
          const source = context.createMediaElementSource(audio);
          const analyser = context.createAnalyser();
          analyser.fftSize = 1024;
          node = { source, analyser };
          nodes.set(audio, node);
        }
        node.source.connect(node.analyser);
        node.analyser.connect(context.destination);
        const samples = new Float32Array(node.analyser.fftSize);
        let mouth = 0;
        const sample = () => {
          if (ended) return;
          const silent =
            audio.paused || audio.ended || audio.muted || audio.volume === 0;
          try {
            node.analyser.getFloatTimeDomainData(samples);
          } catch {
            // 保留已连通的音频输出，只降级口型；结束时统一释放节点。
            clearInterval(timer);
            const releaseNodes = stopMeter;
            fallback();
            const releaseFallback = stopMeter;
            stopMeter = () => {
              releaseNodes?.();
              releaseFallback?.();
            };
            return;
          }
          mouth = mouthFromRms(silent ? 0 : audioRms(samples), mouth);
          api.reportPlayback({ type: "playing", id, mouth });
        };
        const timer = setInterval(sample, 33);
        stopMeter = () => {
          clearInterval(timer);
          node.source.disconnect();
          node.analyser.disconnect();
        };
        sample();
      } catch {
        // 波形读取失败也不能阻断原有声音播放。
        fallback();
      }
    },
  };
}

export function interruptPlayback() {
  local?.cancel();
  window.dispatchEvent(new Event("mai:stop-speech"));
  api.stopPlayback();
}

window.addEventListener("beforeunload", () => {
  local?.cancel();
  void context?.close();
});
