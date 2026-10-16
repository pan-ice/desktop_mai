import { z } from "zod";

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
    attachments: z
      .array(
        z
          .object({
            type: z.enum(["image", "audio"]),
            dataUrl: z
              .string()
              .max(12_000_100)
              .regex(
                /^data:(?:image\/(?:png|jpeg|webp|gif)|audio\/(?:mpeg|wav|ogg));base64,[A-Za-z0-9+/=]+$/,
              ),
          })
          .strict(),
      )
      .max(100)
      .optional(),
  })
  .strict();
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
