import { z } from "zod";
import { cloudMessageSchema } from "../shared/accounts";
import type { Attachment, Settings } from "../shared/types";

export const PROTOCOL = "mai-desktop";
export const MAX_FRAME = 16 * 1024 * 1024;
export const REQUIRED_CAPABILITIES = ["chat", "image", "audio", "proactive"];
const id = z.string().min(1).max(100);
const identitySchema = z
  .object({
    platform: id,
    accountId: id,
    userId: id,
    scope: z.string().max(100),
  })
  .strict();
const segmentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(12000) }).strict(),
  z
    .object({
      type: z.literal("image"),
      dataUrl: z
        .string()
        .max(12_000_100)
        .regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/),
    })
    .strict(),
  z
    .object({
      type: z.literal("audio"),
      dataUrl: z
        .string()
        .max(12_000_100)
        .regex(/^data:audio\/(mpeg|wav|ogg);base64,[A-Za-z0-9+/=]+$/),
    })
    .strict(),
]);

export const pluginFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      v: z.literal(1),
      type: z.literal("history"),
      messages: z.array(cloudMessageSchema).max(100),
    })
    .strict(),
  z.object({ v: z.literal(1), type: z.literal("history_clear") }).strict(),
  z
    .object({
      v: z.literal(1),
      type: z.literal("hello"),
      protocol: z.literal(PROTOCOL),
      pluginVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
      instanceId: z.string().uuid(),
      startedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      identity: identitySchema,
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      type: z.literal("ready"),
      sessionId: id,
      capabilities: z.array(z.string().max(80)).max(32),
      transport: z.enum(["gateway", "legacy"]).optional(),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      type: z.literal("result"),
      id,
      ok: z.boolean(),
      error: z
        .object({ code: z.string().max(80), message: z.string().max(500) })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      type: z.literal("reply"),
      id,
      sessionId: id,
      segments: z.array(segmentSchema).min(1).max(100),
    })
    .strict(),
]);
export type PluginFrame = z.infer<typeof pluginFrameSchema>;
export type PluginReply = Extract<PluginFrame, { type: "reply" }>;
export interface Reply {
  id: string;
  text: string;
  attachments: Attachment[];
}

export function identity(settings: Settings) {
  return {
    platform: settings.platform,
    accountId: settings.botId,
    userId: settings.userId,
    scope: settings.adapterScope,
  };
}

export function buildRequest(
  method: "chat" | "proactive",
  text: string,
  image: string | undefined,
  id: string,
  source?: string,
) {
  return {
    v: 1,
    type: "request",
    method,
    id,
    params: {
      text,
      ...(image ? { image } : {}),
      ...(source ? { source } : {}),
    },
  };
}

export function parseReply(frame: PluginReply): Reply {
  const text: string[] = [];
  const attachments: Attachment[] = [];
  for (const segment of frame.segments) {
    if (segment.type === "text") text.push(segment.text);
    else attachments.push({ type: segment.type, dataUrl: segment.dataUrl });
  }
  return { id: frame.id, text: text.join(""), attachments };
}

export function adapterConfig(settings: Settings, token: string): string {
  const quote = (value: string) => JSON.stringify(value);
  return `# Mai 桌面伙伴适配器 · 此文件包含独立连接令牌，请妥善保存。\n[plugin]\nenabled = true\nconfig_version = "1.0.0"\n\n[connection]\ndesktop_url = "ws://127.0.0.1:${settings.adapterPort}/maibot"\ntoken = ${quote(token)}\n\n[identity]\nplatform = ${quote(settings.platform)}\naccount_id = ${quote(settings.botId)}\nuser_id = ${quote(settings.userId)}\nscope = ${quote(settings.adapterScope)}\n`;
}

export function messageAdapterConfig(
  settings: Settings,
  token: string,
): string {
  const quote = (value: string) => JSON.stringify(value);
  return `# Mai 桌面伙伴独立适配器；包含桌宠连接令牌，请妥善保存。\n# MaiBot 令牌填写 [maim_message].auth_token 中的原文值，或设置 MAIBOT_TOKEN。\n[maibot]\nurl = "ws://127.0.0.1:8000/ws"\ntoken = ""\n\n[desktop]\nurl = "ws://127.0.0.1:${settings.adapterPort}/maibot"\ntoken = ${quote(token)}\n\n[identity]\nplatform = ${quote(settings.platform)}\naccount_id = ${quote(settings.botId)}\nuser_id = ${quote(settings.userId)}\nuser_name = ${quote(settings.userName)}\nscope = ${quote(settings.adapterScope)}\n`;
}
