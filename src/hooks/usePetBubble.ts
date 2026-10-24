import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, Snapshot } from "../../shared/types";
import { displayBotName } from "../../shared/bot-name";

const GREETING_MS = 5000;
const TEXT_LIMIT = 150;
interface Bubble {
  text: string | null;
  duration: number;
}

export function usePetBubble(state: Snapshot) {
  const [bubble, setBubble] = useState<Bubble | null>({
    text: null,
    duration: GREETING_MS,
  });
  const started = useRef(Date.now());
  const seen = useRef(new Set<string>());
  const present = useCallback((reply?: ChatMessage) => {
    const text = reply?.text.slice(0, TEXT_LIMIT) || null;
    setBubble({
      text,
      duration: text
        ? Math.min(15000, Math.max(8000, Array.from(text).length * 100))
        : GREETING_MS,
    });
  }, []);

  useEffect(() => {
    if (!bubble) return;
    const timer = setTimeout(() => {
      setBubble((current) => (current === bubble ? null : current));
    }, bubble.duration);
    return () => clearTimeout(timer);
  }, [bubble]);

  useEffect(() => {
    const replies = new Map(
      state.history
        .filter((message) => message.role === "assistant")
        .map((message) => [message.id, message]),
    );
    let latest: ChatMessage | undefined;
    for (const delivery of state.liveReplies) {
      if (seen.current.has(delivery.id)) continue;
      const reply = replies.get(delivery.id);
      // History and its live delivery can arrive in either order.
      if (!reply) continue;
      seen.current.add(delivery.id);
      if (delivery.receivedAt >= started.current && reply.text.trim())
        latest = reply;
    }
    if (seen.current.size > 2000) {
      const retained = new Set([
        ...replies.keys(),
        ...state.liveReplies.map((delivery) => delivery.id),
      ]);
      seen.current = new Set(
        [...seen.current].filter((id) => retained.has(id)),
      );
    }
    if (latest) present(latest);
  }, [state.history, state.liveReplies, present]);

  return {
    visible: bubble !== null,
    text: bubble?.text ?? `我是${displayBotName(state)}，很高兴在这里遇见你。`,
    show: () =>
      present(
        state.history.findLast((message) => message.role === "assistant"),
      ),
    dismiss: () => setBubble(null),
  };
}
