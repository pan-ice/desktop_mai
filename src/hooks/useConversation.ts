import { useEffect, useRef } from "react";
import { api, showToast } from "../api";
import type { Snapshot } from "../../shared/types";

// 连续语音仍经过 MaiBot 的消息管线：VAD 分句 → ASR → 内核回复 → TTS。
export function useConversation(state: Snapshot) {
  const current = useRef(state);
  current.current = state;
  useEffect(() => {
    if (!state.conversationActive) return;
    let disposed = false;
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    let recorder: MediaRecorder | undefined;
    let tick: ReturnType<typeof setInterval> | undefined;
    let processing = false;
    let startedAt = 0;
    let lastVoice = 0;
    let chunks: BlobPart[] = [];
    const cleanup = () => {
      clearInterval(tick);
      if (recorder?.state === "recording") {
        recorder.onstop = null;
        recorder.stop();
      }
      stream?.getTracks().forEach((track) => track.stop());
      if (context && context.state !== "closed") void context.close();
    };
    const begin = async () => {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      if (disposed) {
        cleanup();
        return;
      }
      context = new AudioContext();
      await context.resume();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      const buffer = new Float32Array(analyser.fftSize);
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(
        (value) => MediaRecorder.isTypeSupported(value),
      );
      if (!mime) throw new Error("系统不支持语音录制");
      const start = () => {
        if (!stream) return;
        startedAt = lastVoice = Date.now();
        chunks = [];
        const recording = new MediaRecorder(stream, { mimeType: mime });
        recorder = recording;
        recording.ondataavailable = (event) => {
          if (event.data.size) chunks.push(event.data);
        };
        recording.onstop = () => {
          const duration = Date.now() - startedAt;
          if (disposed || processing || duration < 350) return;
          processing = true;
          void (async () => {
            try {
              const blob = new Blob(chunks, { type: mime });
              if (blob.size < 1500) return;
              const text = await api.transcribe(await blob.arrayBuffer(), mime);
              if (!disposed) await api.send({ text, source: "voice" });
            } catch (error) {
              if (!disposed) {
                showToast(
                  `连续语音已暂停：${error instanceof Error ? error.message : String(error)}`,
                  true,
                );
                await api.voiceConversation(false);
              }
            } finally {
              processing = false;
            }
          })();
        };
        recording.start();
      };
      tick = setInterval(() => {
        if (disposed) return;
        const snapshot = current.current;
        const blocked =
          processing ||
          snapshot.mood === "speaking" ||
          snapshot.mood === "thinking";
        analyser.getFloatTimeDomainData(buffer);
        const rms = Math.sqrt(
          buffer.reduce((sum, value) => sum + value * value, 0) / buffer.length,
        );
        const now = Date.now();
        if (blocked) {
          if (recorder?.state === "recording") {
            recorder.onstop = null;
            recorder.stop();
            chunks = [];
          }
          return;
        }
        if (rms > snapshot.settings.vadSensitivity) {
          lastVoice = now;
          if (!recorder || recorder.state === "inactive") start();
        }
        if (
          recorder?.state === "recording" &&
          (now - lastVoice >= snapshot.settings.vadSilenceMs ||
            now - startedAt >= 45000)
        )
          recorder.stop();
      }, 50);
    };
    void begin().catch((error) => {
      cleanup();
      if (!disposed) {
        showToast(
          `无法开启连续语音：${error instanceof Error ? error.message : String(error)}`,
          true,
        );
        void api.voiceConversation(false);
      }
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, [state.conversationActive]);
}
