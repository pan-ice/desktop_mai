import { useEffect, useRef, useState } from "react";
import { api, showToast } from "../api";
import { speechSegments } from "../../shared/speech-text";
import { ttsProfile } from "../../shared/tts";
import type { Settings, Snapshot } from "../../shared/types";
import { beginPlayback, interruptPlayback } from "../audio/playback";
import {
  ReplySpeechQueue,
  type SynthesisResult,
} from "../audio/reply-speech-queue";

export function useRecorder(onText: (text: string) => Promise<void> | void) {
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);
  const busy = useRef(false);
  const callback = useRef(onText);
  callback.current = onText;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(timeout.current);
      if (recorder.current?.state === "recording") recorder.current.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
      void api.setVoiceInput("idle");
    };
  }, []);
  const toggle = async () => {
    if (recorder.current?.state === "recording") {
      recorder.current.stop();
      return;
    }
    if (busy.current) return;
    busy.current = true;
    try {
      interruptPlayback();
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      if (!alive.current) {
        media.getTracks().forEach((track) => track.stop());
        busy.current = false;
        return;
      }
      stream.current = media;
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(
        (value) => MediaRecorder.isTypeSupported(value),
      );
      if (!mime) throw new Error("当前系统不支持录音，请使用文字聊天");
      const input = new MediaRecorder(media, { mimeType: mime });
      recorder.current = input;
      const chunks: BlobPart[] = [];
      input.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      input.onerror = () => {
        showToast("录音失败，请检查麦克风权限", true);
        input.stop();
      };
      input.onstop = () => {
        clearTimeout(timeout.current);
        media.getTracks().forEach((track) => track.stop());
        stream.current = null;
        if (!alive.current) {
          busy.current = false;
          return;
        }
        setRecording(false);
        setProcessing(true);
        void api.setVoiceInput("transcribing");
        void (async () => {
          try {
            const blob = new Blob(chunks, { type: mime });
            if (blob.size < 1500) throw new Error("录音太短，请再说一遍");
            const text = await api.transcribe(await blob.arrayBuffer(), mime);
            if (alive.current) await callback.current(text);
          } catch (error) {
            if (alive.current)
              showToast(
                error instanceof Error ? error.message : String(error),
                true,
              );
          } finally {
            busy.current = false;
            if (alive.current) setProcessing(false);
            void api.setVoiceInput("idle");
          }
        })();
      };
      input.start();
      setRecording(true);
      void api.setVoiceInput("recording");
      timeout.current = setTimeout(() => {
        if (input.state === "recording") input.stop();
      }, 45000);
    } catch (error) {
      busy.current = false;
      void api.setVoiceInput("idle");
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
      showToast(error instanceof Error ? error.message : String(error), true);
    }
  };
  return { recording, processing, toggle };
}

let currentAudio: HTMLAudioElement | null = null;
let playbackGeneration = 0;
let cancelPlayback: (() => void) | null = null;
let speechPlayback: ReturnType<typeof beginPlayback> | null = null;
export function stopSpeech(clearQueue = true) {
  ++playbackGeneration;
  cancelPlayback?.();
  cancelPlayback = null;
  speechSynthesis.cancel();
  currentAudio?.pause();
  currentAudio = null;
  speechPlayback?.end();
  speechPlayback = null;
  if (clearQueue) interruptPlayback();
}

export async function speak(
  text: string,
  settings: Settings,
  dataUrl?: string,
  preserveQueue = false,
  preparedFirst?: Promise<SynthesisResult>,
) {
  stopSpeech(!preserveQueue);
  const generation = playbackGeneration;
  const segments =
    dataUrl || settings.ttsEngine === "system"
      ? [text]
      : speechSegments(text, settings.ttsProvider).filter((segment) =>
          segment.trim(),
        );
  const synthesize = (segment: string) =>
    api.synthesize(segment).then(
      (url) => ({ url, error: undefined }),
      (error: unknown) => ({ url: null, error }),
    );
  let prepared: Promise<SynthesisResult> | undefined = preparedFirst;
  for (const [index, segment] of segments.entries()) {
    if (generation !== playbackGeneration) return;
    if (!dataUrl && !segment.trim()) continue;
    let complete: () => void = () => {};
    const ended = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const playback = beginPlayback(() => {
      if (generation === playbackGeneration) stopSpeech(false);
    });
    speechPlayback = playback;
    cancelPlayback = complete;
    const finish = () => {
      complete();
      playback.end();
      if (generation === playbackGeneration) {
        cancelPlayback = null;
        speechPlayback = null;
      }
    };
    try {
      if (dataUrl || settings.ttsEngine === "api") {
        const prefetched = prepared;
        let result = dataUrl
          ? { url: dataUrl, error: undefined }
          : await Promise.race([
              prefetched || synthesize(segment),
              ended.then(() => null),
            ]);
        prepared = undefined;
        if (generation !== playbackGeneration || !result) return;
        // Prefetch is optional work: a temporary failure must not consume the
        // reply's place. Retry once when this segment reaches the foreground.
        if (!dataUrl && prefetched && (result.error || !result.url)) {
          result = await Promise.race([
            synthesize(segment),
            ended.then(() => null),
          ]);
          if (generation !== playbackGeneration || !result) return;
        }
        if (result.error) throw result.error;
        const url = result.url;
        if (!url) throw new Error("语音合成未返回有效音频");
        const audio = new Audio(url);
        audio.crossOrigin = "anonymous";
        currentAudio = audio;
        audio.volume = settings.speechVolume;
        if (
          !dataUrl &&
          settings.ttsNativeOutput === false &&
          (settings.ttsProvider === "mimo" ||
            (settings.ttsProvider === "bailian" &&
              ttsProfile(settings).model.startsWith("qwen3-tts-")))
        )
          audio.playbackRate = settings.speechRate;
        audio.onended = finish;
        audio.onerror = () => {
          finish();
          showToast("语音无法播放，请检查音频输出设备", true);
        };
        if (generation !== playbackGeneration) return;
        await audio.play();
        if (generation !== playbackGeneration) {
          audio.pause();
          return;
        }
        playback.playing(audio);
        if (
          !dataUrl &&
          settings.ttsPreloadNext &&
          generation === playbackGeneration &&
          index + 1 < segments.length
        )
          prepared = synthesize(segments[index + 1]);
      } else {
        const voices = speechSynthesis.getVoices();
        const utterance = new SpeechSynthesisUtterance(segment);
        utterance.lang = "zh-CN";
        utterance.rate = settings.speechRate;
        utterance.volume = settings.speechVolume;
        utterance.voice =
          voices.find((voice) => voice.voiceURI === settings.systemVoice) ||
          voices.find((voice) => voice.lang.startsWith("zh")) ||
          null;
        utterance.onstart = () => {
          if (generation === playbackGeneration) playback.playing();
        };
        utterance.onend = finish;
        utterance.onerror = (event) => {
          finish();
          if (event.error !== "interrupted" && event.error !== "canceled")
            showToast(`系统朗读失败：${event.error}`, true);
        };
        speechSynthesis.speak(utterance);
      }
      await ended;
    } catch (error) {
      finish();
      if (generation === playbackGeneration)
        showToast(error instanceof Error ? error.message : String(error), true);
      return;
    }
  }
}

export function useSpeechReplies(state: Snapshot) {
  const queue = useRef<ReplySpeechQueue | null>(null);
  const started = useRef(Date.now());
  useEffect(() => {
    const value = new ReplySpeechQueue({
      startedAt: started.current,
      synthesize: (text) => api.synthesize(text),
      play: (text, settings, dataUrl, preparedFirst) =>
        speak(text, settings, dataUrl, true, preparedFirst),
      stop: () => stopSpeech(false),
      onError: (error) =>
        showToast(error instanceof Error ? error.message : String(error), true),
    });
    queue.current = value;
    const clear = () => value.clear();
    window.addEventListener("mai:stop-speech", clear);
    return () => {
      window.removeEventListener("mai:stop-speech", clear);
      value.dispose();
      if (queue.current === value) queue.current = null;
      stopSpeech();
    };
  }, []);
  useEffect(() => {
    queue.current?.accept(state);
  }, [state]);
  useEffect(() => {
    if (
      (!state.settings.voiceEnabled && !state.conversationActive) ||
      state.focusUntil
    )
      stopSpeech();
  }, [state.settings.voiceEnabled, state.focusUntil, state.conversationActive]);
}
