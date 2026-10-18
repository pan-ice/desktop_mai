import { z } from "zod";

export function isLocalServerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "ws:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      url.pathname === "/desktop" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export const serverUrlSchema = z
  .string()
  .url()
  .max(2000)
  .refine((value) => {
    const url = new URL(value);
    return (
      ["ws:", "wss:"].includes(url.protocol) &&
      url.pathname === "/desktop" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }, "请输入 ws://或 wss://服务器地址/desktop");

export const serverConnectionSchema = z
  .object({
    format: z.literal("mai-desktop-server"),
    version: z.literal(1),
    serverUrl: serverUrlSchema,
    token: z.string().regex(/^[A-Za-z0-9_\-]{32,256}$/),
  })
  .strict();

const serviceUrl = (protocols: string[]) =>
  z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        protocols.includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.hash
      );
    }, "请输入有效的服务地址，认证令牌请单独填写");

export const settingsPatchSchema = z
  .object({
    nickname: z.string().trim().min(1).max(40),
    userName: z.string().trim().min(1).max(40),
    userId: z.string().trim().min(1).max(100),
    connectionMode: z.enum(["local", "server"]),
    serverUrl: z.union([z.literal(""), serverUrlSchema]),
    serverAccountId: z.union([
      z.literal(""),
      z.string().regex(/^pet_[a-f0-9]{32}$/),
    ]),
    adapterPort: z.number().int().min(1024).max(65535),
    adapterScope: z.string().trim().max(100),
    platform: z.string().regex(/^[a-z][a-z0-9_\-]{1,63}$/),
    botId: z.string().trim().min(1).max(100),
    dashboardUrl: serviceUrl(["http:", "https:"]),
    alwaysOnTop: z.boolean(),
    clickThrough: z.boolean(),
    petVisible: z.boolean(),
    petPositionLocked: z.boolean(),
    petScale: z.number().min(0.5).max(1.6),
    reducedMotion: z.boolean(),
    autoConnect: z.boolean(),
    launchAtLogin: z.boolean(),
    voiceEnabled: z.boolean(),
    ttsEngine: z.enum(["system", "api"]),
    systemVoice: z.string().max(300),
    speechBaseUrl: serviceUrl(["http:", "https:"]),
    sttModel: z.string().trim().min(1).max(100),
    ttsModel: z.string().trim().min(1).max(100),
    ttsVoice: z.string().trim().min(1).max(100),
    speechRate: z.number().min(0.5).max(2),
    speechVolume: z.number().min(0).max(1),
    vadSensitivity: z.number().min(0.005).max(0.15),
    vadSilenceMs: z.number().int().min(500).max(3000),
    screenEnabled: z.boolean(),
    screenSourceId: z.string().max(200),
    screenObservationEnabled: z.boolean(),
    screenObservationSeconds: z.number().int().min(30).max(3600),
    screenObservationPrompt: z.string().trim().min(1).max(2000),
    proactiveEnabled: z.boolean(),
    proactiveMinutes: z.number().int().min(5).max(240),
    proactivePrompt: z.string().trim().min(1).max(2000),
    quietStart: z.number().int().min(0).max(23),
    quietEnd: z.number().int().min(0).max(23),
    activeModelId: z.string().max(100).nullable(),
    corePath: z.string().max(1000),
  })
  .partial()
  .strict();

export const sendSchema = z
  .object({
    text: z.string().trim().max(12000),
    source: z.enum(["text", "voice", "screen", "proactive", "core"]).optional(),
    image: z
      .string()
      .max(12_000_000)
      .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/)
      .optional(),
  })
  .strict()
  .refine((input) => input.text.length > 0 || input.image, "消息不能为空");
