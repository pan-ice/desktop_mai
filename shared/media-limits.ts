import { z } from "zod";

export const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
export const MAX_AUDIO_DATA_URL_LENGTH =
  4 * Math.ceil(MAX_AUDIO_BYTES / 3) + 100;
export const MAX_REPLY_FRAME = 160 * 1024 * 1024;
export const MEDIA_SAVE_TIMEOUT = 120_000;
export const HISTORY_TIMEOUT = 180_000;

export const imageAttachmentSchema = z
  .object({
    type: z.literal("image"),
    dataUrl: z
      .string()
      .max(12_000_100)
      .regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/),
  })
  .strict();

export const audioAttachmentSchema = z
  .object({
    type: z.literal("audio"),
    dataUrl: z
      .string()
      .max(MAX_AUDIO_DATA_URL_LENGTH)
      .regex(/^data:audio\/(mpeg|wav|ogg);base64,[A-Za-z0-9+/=]+$/),
  })
  .strict();

// 即时回复与云端历史共用同一附件约束，避免大音频只能在线接收。
export const attachmentSchema = z.discriminatedUnion("type", [
  imageAttachmentSchema,
  audioAttachmentSchema,
]);
