import { z } from "zod";
import type { Settings } from "./types";

export const TTS_PROVIDERS = [
  "openai",
  "siliconflow",
  "bailian",
  "minimax",
  "volcengine",
  "mimo",
] as const;
export type TtsProvider = (typeof TTS_PROVIDERS)[number];
export const VOICE_IMPORT_PROVIDERS = [
  "mimo",
  "siliconflow",
  "minimax",
  "volcengine",
  "bailian",
] as const;
export type VoiceImportProvider = (typeof VOICE_IMPORT_PROVIDERS)[number];
export const BAILIAN_IMPORT_MODEL = "qwen3-tts-vc-2026-01-22";
// MiMo 限制携带 MIME 前缀的 Base64 样本不超过 10 MB。
export const MIMO_REFERENCE_MAX_BYTES = 7_499_952;
export function voiceImportAudioRules(provider: VoiceImportProvider) {
  return {
    formats:
      provider === "minimax"
        ? ["mp3", "wav", "m4a"]
        : provider === "volcengine"
          ? ["mp3", "wav", "m4a", "ogg", "aac"]
          : ["mp3", "wav"],
    maxBytes:
      provider === "mimo" || provider === "bailian"
        ? MIMO_REFERENCE_MAX_BYTES
        : provider === "volcengine"
          ? 10_000_000
          : 20_000_000,
  };
}
export const ttsProviderSchema = z.enum(TTS_PROVIDERS);
export const ttsBaseUrlSchema = z
  .string()
  .url()
  .max(1000)
  .refine((value) => {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }, "请填写不含凭证或查询参数的 HTTP(S) 服务地址");
export const ttsProfileSchema = z
  .object({
    baseUrl: ttsBaseUrlSchema,
    model: z.string().trim().min(1).max(160),
    voice: z.string().trim().max(512),
    resourceId: z.string().trim().max(160),
  })
  .strict();
export type TtsProfile = z.infer<typeof ttsProfileSchema>;

export const ttsProviders: Record<
  TtsProvider,
  {
    name: string;
    defaults: TtsProfile;
    key:
      | "ttsOpenaiKey"
      | "ttsSiliconflowKey"
      | "ttsBailianKey"
      | "ttsMinimaxKey"
      | "ttsVolcengineKey"
      | "ttsMimoKey";
    cloneHint: string;
    reference: "file" | "url" | null;
  }
> = {
  openai: {
    name: "兼容语音 API",
    key: "ttsOpenaiKey",
    reference: null,
    cloneHint: "可填写服务商已创建的音色 ID；通用接口不提供音色复刻。",
    defaults: {
      baseUrl: "https://api.openai.com/v1",
      model: "tts-1",
      voice: "alloy",
      resourceId: "",
    },
  },
  siliconflow: {
    name: "硅基流动",
    key: "ttsSiliconflowKey",
    reference: "file",
    cloneHint:
      "使用清晰的单人 MP3 / WAV，建议 8–10 秒且少于 30 秒，并填写对应原文。",
    defaults: {
      baseUrl: "https://api.siliconflow.cn/v1",
      model: "FunAudioLLM/CosyVoice2-0.5B",
      voice: "FunAudioLLM/CosyVoice2-0.5B:anna",
      resourceId: "",
    },
  },
  bailian: {
    name: "阿里云百炼",
    key: "ttsBailianKey",
    reference: "url",
    cloneHint:
      "Qwen-Audio-TTS 复刻需要可公网访问的参考音频链接，音色需经审核；目标模型必须与合成时一致。",
    defaults: {
      baseUrl: "https://dashscope.aliyuncs.com/api/v1",
      model: "qwen-audio-3.0-tts-flash",
      voice: "longanhuan_v3.6",
      resourceId: "",
    },
  },
  minimax: {
    name: "MiniMax",
    key: "ttsMinimaxKey",
    reference: "file",
    cloneHint:
      "上传 10 秒至 5 分钟的 MP3 / M4A / WAV，文件不超过 20 MB。复刻后 7 天内需正式合成一次以保留音色。",
    defaults: {
      baseUrl: "https://api.minimax.cn/v1",
      model: "speech-2.8-hd",
      voice: "female-shaonv",
      resourceId: "",
    },
  },
  volcengine: {
    name: "火山引擎",
    key: "ttsVolcengineKey",
    reference: "file",
    cloneHint:
      "使用新版控制台 API Key。上传不超过 10 MB 的音频，填写已有 S_ 音色槽位或自定义 ID；复刻完成后查询状态。",
    defaults: {
      baseUrl: "https://openspeech.bytedance.com/api/v3/tts",
      model: "seed-tts-2.0-standard",
      voice: "zh_female_vv_uranus_bigtts",
      resourceId: "seed-tts-2.0",
    },
  },
  mimo: {
    name: "小米 MiMo",
    key: "ttsMimoKey",
    reference: "file",
    cloneHint:
      "选择 MP3 / WAV 参考音频，原文件不超过约 7.5 MB。样本保存在本机，使用复刻音色时随每次合成请求发送给 MiMo，无需参考原文或训练审核。",
    defaults: {
      baseUrl: "https://api.xiaomimimo.com/v1",
      model: "mimo-v2.5-tts",
      voice: "mimo_default",
      resourceId: "",
    },
  },
};

export function ttsProfile(
  settings: Settings,
  provider = settings.ttsProvider,
): TtsProfile {
  return (
    settings.ttsProfiles[provider] ||
    (provider === "openai"
      ? {
          baseUrl: settings.speechBaseUrl,
          model: settings.ttsModel,
          voice: settings.ttsVoice,
          resourceId: "",
        }
      : ttsProviders[provider].defaults)
  );
}

export const clonedVoiceSchema = z
  .object({
    id: z.string().uuid(),
    provider: ttsProviderSchema.exclude(["openai"]),
    name: z.string().trim().min(1).max(60),
    voiceId: z.string().min(1).max(512),
    profile: ttsProfileSchema,
    status: z.enum(["pending", "ready", "failed"]),
    autoUse: z.boolean().optional(),
    statusMessage: z.string().max(160).optional(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type ClonedVoice = z.infer<typeof clonedVoiceSchema>;
export interface VoiceCloneInput {
  name: string;
  voiceId?: string;
  referenceText?: string;
  referenceUrl?: string;
  audio?: { name: string; data: ArrayBuffer };
}
export const voiceCloneInputSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    voiceId: z.string().trim().max(256).optional(),
    referenceText: z.string().trim().max(4000).optional(),
    referenceUrl: z.string().max(8192).optional(),
    audio: z
      .object({
        name: z.string().min(1).max(255),
        data: z.instanceof(ArrayBuffer),
      })
      .strict()
      .optional(),
  })
  .strict();

export const voiceImportInputSchema = z
  .object({
    provider: z.enum(VOICE_IMPORT_PROVIDERS),
    audio: voiceCloneInputSchema.shape.audio.unwrap(),
    referenceText: voiceCloneInputSchema.shape.referenceText,
    voiceId: voiceCloneInputSchema.shape.voiceId,
  })
  .strict();
export type VoiceImportInput = z.infer<typeof voiceImportInputSchema>;
