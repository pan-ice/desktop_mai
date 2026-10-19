import { z } from "zod";
import { attachmentSchema } from "./media-limits";
import { messagePartSchema } from "./message-content";

export const petAccountSchema = z
  .object({
    id: z.string().regex(/^pet_[a-f0-9]{32}$/),
    name: z.string().min(1).max(40),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type PetAccount = z.infer<typeof petAccountSchema>;
export const deviceSchema = z
  .object({
    id: z.string().min(16).max(100),
    name: z.string().min(1).max(40),
    createdAt: z.number().int().nonnegative(),
    current: z.boolean(),
  })
  .strict();
export type AuthorizedDevice = z.infer<typeof deviceSchema>;
export const cloudMessageSchema = z
  .object({
    id: z.string().min(1).max(100),
    role: z.enum(["user", "assistant"]),
    text: z.string().max(1_200_000),
    timestamp: z.number().int().nonnegative(),
    source: z.enum(["text", "voice", "screen", "proactive", "core"]),
    delivery: z.enum(["sent", "failed", "unknown"]).optional(),
    attachments: z.array(attachmentSchema).max(100).optional(),
    parts: z.array(messagePartSchema).min(1).max(100).optional(),
  })
  .strict()
  .superRefine((message, ctx) => {
    if (!message.parts) return;
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    const indices = message.parts
      .filter((part) => part.type === "attachment")
      .map((part) => part.index);
    if (
      text !== message.text ||
      indices.length !== (message.attachments?.length || 0) ||
      indices.some((index, position) => index !== position)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parts"],
        message: "消息段与文字、附件不一致",
      });
    }
  });
export const historyPageSchema = z
  .object({
    messages: z.array(cloudMessageSchema).max(100),
    before: z.number().int().positive().nullable(),
    hasMore: z.boolean(),
  })
  .strict();
export interface QQLoginChallenge {
  code: string;
  expiresAt: number;
}
