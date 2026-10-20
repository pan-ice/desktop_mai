import type { Settings } from "./types";
import { ttsProfile } from "./tts";

export const NATURAL_SPEECH_INSTRUCTION =
  "像面对面聊天一样自然放松，按语义连贯表达，停顿轻且合适，情绪随内容变化；保持所选或参考声音的音色、口音和说话习惯，不用播音腔或夸张表演。";

export function speechDeliveryHint(settings: Settings): string {
  if (settings.ttsEngine === "system")
    return "语气控制适用于支持此能力的在线模型，系统声音沿用系统朗读方式。";
  const profile = ttsProfile(settings);
  if (settings.ttsProvider === "mimo")
    return "向 MiMo 单独传入聊天语气指令，保留所选音色；指令本身不会被朗读。";
  if (
    settings.ttsProvider === "siliconflow" &&
    profile.model.startsWith("FunAudioLLM/CosyVoice2")
  )
    return "使用 CosyVoice2 的语气指令，连贯表达并保留音色；指令可能计入文本用量。";
  if (settings.ttsProvider === "volcengine")
    return profile.resourceId === "seed-tts-2.0"
      ? "预置 2.0 音色使用官方语气指令；复刻音色不支持这组指令，可使用下方还原模式。"
      : "火山复刻音色不支持这组语气指令，仍沿用原音色；同语种可开启下方还原模式。";
  if (
    settings.ttsProvider === "minimax" &&
    /^speech-2\.[68]-(hd|turbo)$/.test(profile.model)
  )
    return "使用高质量文本归一化改善数字、符号等读法，情绪由模型结合正文推断；不会强行设为同一种情绪。";
  return "当前模型未接入独立语气指令，仍沿用其原有表达；此开关不能给所有模型增加情绪能力。";
}
