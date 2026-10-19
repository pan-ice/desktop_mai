import { z } from "zod";
import type { Attachment, ChatMessage } from "./types";

export const messagePartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(12000) }).strict(),
  z
    .object({
      type: z.literal("attachment"),
      index: z.number().int().min(0).max(99),
    })
    .strict(),
]);
export type MessagePart = z.infer<typeof messagePartSchema>;
export type MessageContent = { type: "text"; text: string } | Attachment;

/** 媒体只保存一次，parts 记录内核消息段的展示顺序。旧历史沿用原来的布局。 */
export function messageContent(
  message: Pick<ChatMessage, "text" | "attachments" | "parts">,
): MessageContent[] {
  const content: MessageContent[] = [];
  if (message.parts) {
    for (const part of message.parts) {
      const previous = content.at(-1);
      if (part.type === "text") {
        if (previous?.type === "text") previous.text += part.text;
        else content.push({ ...part });
      } else if (message.attachments?.[part.index]) {
        content.push(message.attachments[part.index]);
      }
    }
    return content;
  }
  return [
    ...(message.text ? [{ type: "text" as const, text: message.text }] : []),
    ...(message.attachments || []),
  ];
}
