import type { TtsProvider } from "./tts";

export const MODEL_GUIDANCE_CHECKED = "2026-10-19";

export const modelGuideLinks = {
  openai: "https://developers.openai.com/api/docs/models/tts-1",
  transcription: "https://developers.openai.com/api/docs/models/whisper-1",
  siliconflow: "https://siliconflow.cn/pricing",
  bailian: "https://help.aliyun.com/zh/model-studio/model-pricing",
  minimax: "https://platform.minimax.cn/docs/pricing/overview",
  volcengine:
    "https://docs.volcengine.com/docs/DoubaoVoice/Billinginstructions-21?lang=zh",
  volcengineClone:
    "https://docs.volcengine.com/docs/DoubaoVoice/Soundreplicationorderingandusageguide?lang=zh",
  mimo: "https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go",
} as const;

/** 只允许界面列出的官方说明页在系统浏览器打开。 */
export function isModelGuideUrl(url: string): boolean {
  return Object.values(modelGuideLinks).some((allowed) => allowed === url);
}

export const voiceServiceGuides: Record<
  TtsProvider,
  { summary: string; principle: string; preparation: string; billing: string }
> = {
  openai: {
    summary: "在线合成按所用平台和模型收费；试听与重新朗读都会发起请求。",
    principle:
      "把回复文字发给你填写的语音服务，由指定模型生成音频，再交给本机播放。音色 ID 决定声音，模型 ID 决定使用哪项合成能力。",
    preparation: "这个通用接口使用服务商已有音色，不提供统一的音频导入协议。",
    billing:
      "计费跟随所填服务地址和模型。默认 OpenAI tts-1 按输入字符数收费；其他兼容服务可能按字符、Token 或音频时长收费，需查看对应平台价格。",
  },
  siliconflow: {
    summary:
      "导入会在线转写并创建音色；默认 CosyVoice2 朗读按 UTF-8 字节数计费。",
    principle:
      "导入时把录音发送到硅基流动，先自动识别录音原文，再创建可重复使用的云端音色；之后发送回复文字和音色 ID 来合成。",
    preparation:
      "导入包含自动转写与创建音色两步，适用额度及费用以硅基流动为准；填写准确原文可跳过自动转写。",
    billing:
      "当前默认 CosyVoice2 按输入文本的 UTF-8 字节数计费，常见汉字通常占 3 字节，不能直接把字节单价当成汉字单价。每次试听和重新朗读都会再次请求合成。",
  },
  bailian: {
    summary: "创建音色与之后的朗读分别计费；单价和免费额度随模型及地域变化。",
    principle:
      "简单导入把录音发送给百炼 Qwen-TTS 创建云端音色，之后用配对的语音模型朗读。音色与创建时指定的目标模型配套使用。",
    preparation:
      "简单导入的 Qwen-TTS 按新建音色个数计费，后续朗读另计；高级设置中的其他模型可能采用不同复刻规则。",
    billing:
      "语音费用随模型和地域变化。Qwen3-TTS 通常按输入字符数计费，部分旧模型按输入、输出 Token 计费；免费额度有适用地域、模型和有效期。",
  },
  minimax: {
    summary: "首次试听或自动朗读会触发一次性音色费，语音合成另按字符数计费。",
    principle:
      "上传录音后由 MiniMax 创建云端音色；合成时发送回复文字和音色 ID，生成新的语音，不需要每次重新上传参考录音。",
    preparation:
      "创建时不立即收取复刻音色费，首次使用该音色正式合成时收取一次性费用。复刻后 7 天内需正式合成一次以保留音色。",
    billing:
      "合成另按输入字符数计费，HD 与 Turbo 单价不同；官方规则中 1 个汉字计 2 个字符。此处的试听、手动朗读和导入后自动朗读均调用正式合成，首次使用会触发音色费。",
  },
  volcengine: {
    summary:
      "自定义音色首次试听或自动朗读会收取槽位费并固定音色，语音合成另计。",
    principle:
      "把录音发送给火山训练音色，准备完成后发送回复文字和音色 ID 来合成。可使用已购买的 S_ 槽位，或新建自定义后付费音色。",
    preparation:
      "自定义后付费音色在首次正式合成时收取槽位费并固定音色，之后不能重新训练。已有预付费槽位按其购买权益和训练次数使用。",
    billing:
      "音色槽位与语音合成分别计费，具体单价和用量单位随所选模型、资源及套餐确定。此处的试听和导入后自动朗读会正式合成，可能触发首次槽位扣费；请先在官方控制台确认复刻效果。",
  },
  mimo: {
    summary: "导入只存本机；朗读时上传参考录音。官方 TTS 当前标注限时免费。",
    principle:
      "参考录音先保存在本机，不进行云端训练。每次朗读把参考录音和回复文字一起发给 MiMo，由模型模仿音色生成新的语音；长回复的每一段也会携带样本。",
    preparation: "导入只在本机保存样本，不发起云端复刻请求。",
    billing:
      "核对时官方将 mimo-v2.5-tts 和 mimo-v2.5-tts-voiceclone 标为限时免费。活动结束时间、账号额度和后续单价以官方为准；使用其他服务地址时遵循该平台收费规则。",
  },
};
