import { useEffect, useRef, useState } from "react";
import { api, showToast } from "../api";
import { speechSegments } from "../../shared/speech-text";
import type { Settings, Snapshot } from "../../shared/types";

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
          }
        })();
      };
      input.start();
      setRecording(true);
      timeout.current = setTimeout(() => {
        if (input.state === "recording") input.stop();
      }, 45000);
    } catch (error) {
      busy.current = false;
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
export function stopSpeech(clearQueue = true) {
  ++playbackGeneration;
  cancelPlayback?.();
  cancelPlayback = null;
  speechSynthesis.cancel();
  currentAudio?.pause();
  currentAudio = null;
  void api.setMood("idle");
  if (clearQueue) window.dispatchEvent(new Event("mai:stop-speech"));
}

export async function speak(
  text: string,
  settings: Settings,
  dataUrl?: string,
  preserveQueue = false,
) {
  stopSpeech(!preserveQueue);
  const generation = playbackGeneration;
  const segments =
    dataUrl || settings.ttsEngine === "system"
      ? [text]
      : speechSegments(text, settings.ttsProvider);
  for (const segment of segments) {
    if (generation !== playbackGeneration) return;
    if (!dataUrl && !segment.trim()) continue;
    let complete: () => void = () => {};
    const ended = new Promise<void>((resolve) => {
      complete = resolve;
    });
    cancelPlayback = complete;
    const finish = () => {
      complete();
      if (generation === playbackGeneration) {
        cancelPlayback = null;
        void api.setMood("idle");
      }
    };
    try {
      if (dataUrl || settings.ttsEngine === "api") {
        const url =
          dataUrl ||
          (await Promise.race([
            api.synthesize(segment),
            ended.then(() => null),
          ]));
        if (generation !== playbackGeneration || !url) return;
        const audio = new Audio(url);
        currentAudio = audio;
        audio.volume = settings.speechVolume;
        if (!dataUrl && settings.ttsProvider === "mimo")
          audio.playbackRate = settings.speechRate;
        audio.onended = finish;
        audio.onerror = () => {
          finish();
          showToast("语音无法播放，请检查音频输出设备", true);
        };
        await api.setMood("speaking");
        if (generation !== playbackGeneration) return;
        await audio.play();
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
          void api.setMood("speaking");
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
  const seen = useRef(new Set<string>());
  const queue = useRef<{ text: string; dataUrl?: string }[]>([]);
  const playing = useRef(false);
  const current = useRef(state);
  current.current = state;
  const started = useRef(Date.now());
  useEffect(() => {
    for (const reply of state.history) {
      if (reply.role !== "assistant" || seen.current.has(reply.id)) continue;
      seen.current.add(reply.id);
      if (
        (state.settings.voiceEnabled || state.conversationActive) &&
        !state.focusUntil &&
        reply.timestamp >= started.current &&
        (reply.text || reply.attachments?.some((item) => item.type === "audio"))
      ) {
        const voices =
          reply.attachments?.filter((item) => item.type === "audio") || [];
        if (voices.length) {
          queue.current.push(
            ...voices.map((voice) => ({ text: "", dataUrl: voice.dataUrl })),
          );
        } else {
          queue.current.push({ text: reply.text });
        }
      }
    }
    if (seen.current.size > 2000)
      seen.current = new Set(state.history.map((message) => message.id));
    if (playing.current || !queue.current.length) return;
    playing.current = true;
    void (async () => {
      try {
        while (queue.current.length) {
          const snapshot = current.current;
          if (
            (!snapshot.settings.voiceEnabled && !snapshot.conversationActive) ||
            snapshot.focusUntil
          ) {
            queue.current = [];
            break;
          }
          const reply = queue.current.shift()!;
          await speak(reply.text, snapshot.settings, reply.dataUrl, true);
        }
      } finally {
        playing.current = false;
      }
    })();
  }, [
    state.history,
    state.settings,
    state.focusUntil,
    state.conversationActive,
  ]);
  useEffect(() => {
    if (
      (!state.settings.voiceEnabled && !state.conversationActive) ||
      state.focusUntil
    )
      stopSpeech();
  }, [state.settings.voiceEnabled, state.focusUntil, state.conversationActive]);
  useEffect(() => () => stopSpeech(), []);
  useEffect(() => {
    const clear = () => {
      queue.current = [];
    };
    window.addEventListener("mai:stop-speech", clear);
    return () => window.removeEventListener("mai:stop-speech", clear);
  }, []);
}
