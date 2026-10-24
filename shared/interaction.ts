import type { Snapshot } from "./types";
import { displayBotName } from "./bot-name";

export type VoiceInputPhase =
  "idle" | "listening" | "recording" | "transcribing";
export const REPLY_WAIT_MS = 15000;

/** 只描述客户端能确认的动作，不推断内核是否正在生成或一定会回复。 */
export function interactionLabel(state: Snapshot): string | null {
  if (state.focusUntil) return "专注陪伴中";
  if (state.voiceInput === "transcribing") return "正在转写…";
  if (state.voiceInput === "recording") return "正在听你说…";
  if (state.playback.phase === "preparing") return "正在准备声音…";
  if (state.playback.phase === "playing") return "正在播放声音";
  if (state.replyStatus === "sending") return "正在发送…";
  if (state.replyStatus === "waiting")
    return `已发送，等${displayBotName(state)}回应`;
  if (state.conversationActive && state.voiceInput === "listening")
    return "正在聆听";
  return null;
}
