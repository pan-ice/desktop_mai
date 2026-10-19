# 模型朗读与在线音色复刻

在「声音与感知」选择「模型语音 · 在线服务」，可使用硅基流动、阿里云百炼、MiniMax、火山引擎或小米 MiMo 合成文字，并创建和保存复刻音色。也保留系统朗读和兼容 OpenAI 的合成接口。复刻接口按服务商分别实现，不能只更换通用接口的模型名。

## 使用

1. 选择服务商，填写该服务商的合成 API Key。服务地址、模型和音色有默认值，可按账号的地域、权限和模型版本调整。点击「保存声音设置」。
2. 展开「音色复刻」，填写名称及参考材料，点击「提交音色复刻」。提交会向所选服务商发送参考材料，按其规则计费。MiMo 点击「保存参考音色」，此时只在本机保存样本，首次云端请求发生在试听或朗读时。
3. 若显示「审核 / 训练中」，点击「查询状态」。就绪后点击「使用音色」，再用上方「试听声音」确认。创建音色不会自动切换当前朗读音色。
4. 开启「自动朗读回复」。只含文字的 MaiBot 回复交给当前合成模型；包含语音的回复优先播放原音频，全部音频片段按顺序播放。长文字分段合成，保留完整尾部；停止、关闭朗读或进入专注模式会取消待播内容。

每家服务商分别保存服务地址、模型、音色和 Key，切换服务商可恢复上次保存的配置。本地保存音色名称、ID、目标模型和状态，重启后可继续使用。MiMo 额外在应用数据目录的 `voice-references/` 保存原始参考音频，状态和窗口快照不包含音频正文；其他四家上传后只保留音色元信息。此列表仅包含在此客户端创建的音色，已有云端音色可直接填写音色 ID；MiMo 使用本机参考音色。

## 服务要求

| 服务商 | 默认模型 / 接口 | 复刻材料与处理 |
| --- | --- | --- |
| 硅基流动 | `FunAudioLLM/CosyVoice2-0.5B`，`/v1/audio/speech` | 上传 MP3 / WAV 并填写参考原文，建议 8–10 秒且少于 30 秒；上传返回的 `speech:` URI 用作合成音色 |
| 阿里云百炼 | `qwen-audio-3.0-tts-flash`，`/api/v1/services/audio/tts/SpeechSynthesizer` | 填写服务商能直接读取的公网参考音频链接，创建后查询审核状态；复刻时的目标模型须与合成模型一致 |
| MiniMax | `speech-2.8-hd`，`/v1/t2a_v2` | 上传 10 秒至 5 分钟 MP3 / WAV / M4A，不超过 20 MB；ID 留空可自动生成，复刻后 7 天内需正式合成一次以保留音色 |
| 火山引擎 | `seed-tts-2.0-standard`，`/api/v3/tts/unidirectional` | 新版控制台 API Key，参考文件不超过 10 MB，填写已购 `S_` 槽位或自定义 ID；状态为 Success / Active 时才可使用 |
| 小米 MiMo | `mimo-v2.5-tts` / `mimo-v2.5-tts-voiceclone`，`/v1/chat/completions` | 预置音色可直接选择；复刻样本为 MP3 / WAV，Base64 编码后不超过 10 MB，客户端将原文件限制为约 7.5 MB。每次合成携带样本，无需云端训练与审核 |

百炼使用 Qwen-Audio-TTS 的 HTTP 合成与 `voice-enrollment` 接口，未把旧版 Qwen-TTS 的另一套路径混入此协议。可将默认域名改为业务空间专属地址 `https://你的空间.cn-beijing.maas.aliyuncs.com/api/v1`，其他地域也应使用对应空间地址和 Key。参考链接需在服务端完成读取前持续有效。

火山使用新版 `X-Api-Key` 鉴权。系统音色通常使用资源 `seed-tts-2.0`，通过此页面复刻的音色保存为 `seed-icl-2.0`。自定义后付费音色的首次正式合成会收取槽位费并固定音色，桌宠的「试听声音」调用正式合成接口，因此应先在服务商控制台确认复刻试听效果，再在桌宠应用和合成。旧版 AppID / Access Token 鉴权未在此页面实现。

参考文件的格式和大小由客户端检查，音频时长、清晰度及服务权限仍由服务商判断。模型与账号权限以服务商控制台为准，修改模型后可能需要重新复刻；不能把某家返回的音色 ID 用于另一家服务。

MiMo 默认地址 `https://api.xiaomimimo.com/v1`，使用独立 Key 和官方 `api-key` 鉴权。预置音色可选冰糖、茉莉、苏打、白桦以及英文音色；选择本机参考音色后自动切换为 `mimo-v2.5-tts-voiceclone`。参考样本在每次试听、自动朗读及长回复的每段请求中发送给所配置的 MiMo 服务，不返回可迁移的云端音色 ID；迁移客户端时需同时保留应用数据目录里的参考文件。语速由本机播放器调整。当前接入预置合成和音频复刻，未提供文本设计音色模式。

## 录音转写与兼容

「录音与转写」独立配置兼容 OpenAI 的 ASR 地址、Key 和模型，修改合成服务不会改动转写配置。MiMo 此次接入限于合成与复刻，不会将其模型填入 ASR 接口。旧版合成配置继续映射到「兼容语音 API」；尚未保存独立合成 Key 且合成地址与旧语音地址完全一致时，继续沿用原 `speechKey`。更换地址或选择其他服务商不会带上该旧 Key。

所有 Key 在主进程通过系统加密保存，渲染器只得到是否已保存的标志。百炼返回的临时音频链接由主进程下载，下载请求不附加 API Key；错误提示不回显服务端响应正文、凭证或临时签名链接。

## 验证范围

`npm test` 包含本机 HTTP 契约测试，检查各服务请求路径、鉴权、multipart 上传、MiniMax int64 文件 ID、状态查询、音频解析及错误响应。`npm run test:tts-clone` 使用实际 Electron、preload、系统密钥存储及本机模拟服务验证创建、查询、应用、试听、长文分段、停止及重启恢复；声音输出替换为确定的结束事件。

这些测试不请求云端付费接口，也没有验证真实账号权限、云端训练结果或复刻音质。实际云端效果需使用有权限的 Key 和符合服务要求的参考音频确认。

## 官方协议来源

核对日期：2026-10-19。

- 硅基流动：[上传音色](https://docs.siliconflow.cn/docs/api/uploads-audio-voice-post)、[语音合成](https://docs.siliconflow.cn/docs/api/audio-speech-post)。
- 百炼：[声音复刻 HTTP](https://help.aliyun.com/zh/model-studio/voice-clone-design-http-api)、[Qwen-Audio-TTS HTTP](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-http-api)。
- MiniMax：[声音复刻](https://platform.minimax.cn/docs/api-reference/voice-cloning-clone)、[文件上传](https://platform.minimax.cn/docs/api-reference/file-management-upload)、[HTTP 合成](https://platform.minimax.io/docs/api-reference/speech-t2a-http)。
- 火山：[声音训练](https://docs.volcengine.com/docs/DoubaoVoice/tone-training-http?lang=zh)、[状态查询](https://docs.volcengine.com/docs/DoubaoVoice/tone-query-http?lang=zh)、[HTTP 合成](https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh)、[流式完成状态](https://docs.volcengine.com/docs/DoubaoVoice/HTTPChunkedSSEUnidirectionalStreaming-V3?lang=zh)。
- MiMo：[预置音色与参考音频复刻](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5)、[API 鉴权](https://mimo.mi.com/docs/zh-CN/quick-start/faq/api-integration)。
