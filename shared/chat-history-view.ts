import type { ChatMessage } from "./types";

export const chatMessageKey = (message: Pick<ChatMessage, "role" | "id">) =>
  `${message.role}:${message.id}`;

/** 以消息身份识别补载和新增，历史达到本机上限后新增消息也不会漏判。 */
export function historyViewChange(
  previous: readonly string[],
  current: readonly string[],
) {
  const first = previous[0];
  const last = previous.at(-1);
  const firstIndex = first === undefined ? -1 : current.indexOf(first);
  const lastIndex = last === undefined ? -1 : current.indexOf(last);
  const oldKeys = new Set(previous);
  return {
    reset: !current.some((key) => oldKeys.has(key)),
    prepended: firstIndex > 0,
    appended: lastIndex < 0 ? 0 : current.length - lastIndex - 1,
  };
}
