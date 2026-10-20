import { useEffect, useRef } from "react";
import { api, showToast } from "../api";
import { interruptPlayback, playbackActivity } from "../audio/playback";
import { audioRms } from "../../shared/playback";
import type { Snapshot } from "../../shared/types";

// 只停止本机播报。每句话仍走 ASR → MaiBot，等待内核回复时也继续聆听。
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
    let startedAt = 0,
      lastVoice = 0,
      voiceSince = 0;
    let accepted = false;
    let playbackId: string | null = null;
    let playbackStarted = 0;
    const phase = (value: Snapshot["voiceInput"]) => {
      if (!disposed) void api.setVoiceInput(value);
    };
    const cleanup = () => {
      clearInterval(tick);
      if (recorder?.state === "recording") {
        recorder.onstop = null;
        recorder.stop();
      }
      stream?.getTracks().forEach((track) => track.stop());
      if (context && context.state !== "closed") void context.close();
      void api.setVoiceInput("idle");
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
      if (disposed) {
        cleanup();
        return;
      }
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      const buffer = new Float32Array(analyser.fftSize);
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(
        (value) => MediaRecorder.isTypeSupported(value),
      );
      if (!mime) throw new Error("系统不支持语音录制");
      phase("listening");
      const start = () => {
        if (!stream) return;
        startedAt = lastVoice = voiceSince = Date.now();
        accepted = false;
        const chunks: BlobPart[] = [];
        const recording = new MediaRecorder(stream, { mimeType: mime });
        recorder = recording;
        recording.ondataavailable = (event) => {
          if (event.data.size) chunks.push(event.data);
        };
        recording.onerror = () => {
          if (!disposed) {
            showToast("录音失败，请检查麦克风权限", true);
            void api.voiceConversation(false);
          }
        };
        recording.onstop = () => {
          if (recorder !== recording) return;
          const valid = accepted && Date.now() - startedAt >= 350;
          if (disposed || !valid) {
            processing = false;
            return;
          }
          processing = true;
          phase("transcribing");
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
              phase("listening");
            }
          })();
        };
        recording.start();
      };
      tick = setInterval(() => {
        if (disposed || processing) return;
        const snapshot = current.current;
        if (
          !snapshot.conversationActive ||
          snapshot.focusUntil ||
          snapshot.connection.phase !== "connected" ||
          !snapshot.settings.petVisible
        )
          return;
        const playback = playbackActivity();
        const playing = playback.phase === "playing";
        const now = Date.now();
        if (playing && playbackId !== playback.id) {
          playbackId = playback.id;
          playbackStarted = now;
        }
        analyser.getFloatTimeDomainData(buffer);
        const threshold =
          playing && !accepted
            ? Math.max(0.045, snapshot.settings.vadSensitivity * 1.8)
            : snapshot.settings.vadSensitivity;
        const voiced = audioRms(buffer) > threshold;
        if (!recorder || recorder.state === "inactive") {
          // 播报起始的瞬态回声与短促噪声不能触发插话。
          if (!voiced || (playing && now - playbackStarted < 250)) return;
          start();
        }
        if (voiced) {
          lastVoice = now;
          if (!voiceSince) voiceSince = now;
          if (!accepted && now - voiceSince >= (playing ? 220 : 120)) {
            accepted = true;
            interruptPlayback();
            phase("recording");
          }
        } else if (!accepted) voiceSince = 0;
        if (
          recorder?.state === "recording" &&
          (now - lastVoice >= snapshot.settings.vadSilenceMs ||
            now - startedAt >= 45000)
        ) {
          processing = accepted;
          recorder.stop();
        }
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
