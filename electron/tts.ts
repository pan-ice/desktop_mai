import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  clonedVoiceSchema,
  BAILIAN_IMPORT_MODEL,
  MIMO_REFERENCE_MAX_BYTES,
  ttsProfile,
  ttsProfileSchema,
  ttsProviders,
  voiceCloneInputSchema,
  voiceImportAudioRules,
  voiceImportInputSchema,
  type ClonedVoice,
  type TtsProfile,
  type TtsProvider,
  type VoiceCloneInput,
  type VoiceImportInput,
} from "../shared/tts";
import type { Settings } from "../shared/types";
import { NATURAL_SPEECH_INSTRUCTION } from "../shared/speech-delivery";

const MAX_AUDIO = 25 * 1024 * 1024;
const MAX_JSON = 2 * MAX_AUDIO + 65536;

function endpoint(base: string, path: string) {
  const url = new URL(ttsProfileSchema.shape.baseUrl.parse(base));
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${path}`;
  return url.toString();
}

async function request(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal, redirect: "error" });
  } catch {
    throw new Error(
      signal.aborted
        ? "语音服务请求超时，请稍后重试"
        : "无法连接语音服务，请检查地址与网络",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `语音服务请求失败（HTTP ${response.status}），请检查 Key、模型、额度和服务权限`,
    );
  }
  return response;
}

async function bodyBytes(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("语音服务返回内容过大");
  }
  if (!response.body) throw new Error("语音服务没有返回内容");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("语音服务返回内容过大");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function jsonResponse(
  response: Response,
  limit = MAX_JSON,
): Promise<Record<string, any>> {
  try {
    const value = JSON.parse(
      (await bodyBytes(response, limit)).toString("utf8"),
      (key, value, context?: { source: string }) =>
        key === "file_id" &&
        typeof value === "number" &&
        !Number.isSafeInteger(value)
          ? (context?.source ?? value)
          : value,
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw new Error("语音服务返回了无效的数据");
  }
}

function base64(value: unknown): Buffer {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 4 * Math.ceil(MAX_AUDIO / 3) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new Error("语音服务返回的音频编码无效或过大");
  return Buffer.from(value, "base64");
}

export function ttsAudioUrl(bytes: Buffer): string {
  if (!bytes.length || bytes.length > MAX_AUDIO)
    throw new Error("合成音频为空或超过 25 MB");
  const mime =
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WAVE"
      ? "wav"
      : bytes.subarray(0, 4).toString() === "OggS"
        ? "ogg"
        : bytes.subarray(0, 3).toString() === "ID3" ||
            (bytes.length >= 4 &&
              bytes[0] === 255 &&
              (bytes[1] & 224) === 224 &&
              (bytes[1] & 6) !== 0)
          ? "mpeg"
          : null;
  if (!mime) throw new Error("语音服务未返回可播放的 MP3、WAV 或 Ogg 音频");
  return `data:audio/${mime};base64,${bytes.toString("base64")}`;
}

function headers(provider: TtsProvider, key: string): Record<string, string> {
  if (provider !== "openai" && !key.trim())
    throw new Error(`请先保存${ttsProviders[provider].name}的 API Key`);
  return provider === "volcengine"
    ? { "X-Api-Key": key, "X-Api-Request-Id": randomUUID() }
    : provider === "mimo"
      ? { "api-key": key }
      : key
        ? { Authorization: `Bearer ${key}` }
        : {};
}

function jsonBody(value: unknown, auth: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  };
}

function minimaxSuccess(data: Record<string, any>) {
  if (!data.base_resp || data.base_resp.status_code !== 0)
    throw new Error(
      `MiniMax 请求失败（状态 ${typeof data.base_resp?.status_code === "number" ? data.base_resp.status_code : "未知"}），请检查额度、权限及音频要求`,
    );
  if (data.input_sensitive)
    throw new Error("MiniMax 未接受参考音频，音色未创建");
}

async function downloadBailianAudio(
  value: unknown,
  profile: TtsProfile,
  signal: AbortSignal,
) {
  if (typeof value !== "string") throw new Error("百炼未返回合成音频");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("百炼返回的音频地址无效");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    (url.origin !== new URL(profile.baseUrl).origin &&
      !url.hostname.endsWith(".aliyuncs.com"))
  )
    throw new Error("百炼返回了非预期的音频下载地址");
  // 下载音频时不向对象存储附加 API Key，也不把签名地址交给渲染器。
  return bodyBytes(await request(url.toString(), {}, signal), MAX_AUDIO);
}

async function volcAudio(response: Response): Promise<Buffer> {
  const text = (await bodyBytes(response, MAX_JSON)).toString("utf8");
  const chunks: Buffer[] = [];
  let completed = false,
    size = 0;
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith("event:") || value.startsWith(":")) continue;
    let data: Record<string, any>;
    try {
      data = JSON.parse(
        value.startsWith("data:") ? value.slice(5).trim() : value,
      );
    } catch {
      throw new Error("火山语音响应格式无效");
    }
    if (![0, 20000000].includes(data.code))
      throw new Error(
        `火山语音合成失败（状态 ${typeof data.code === "number" ? data.code : "未知"}）`,
      );
    if (data.data) {
      if (completed) throw new Error("火山语音完成后仍返回音频");
      const bytes = base64(data.data);
      size += bytes.length;
      if (size > MAX_AUDIO) throw new Error("合成音频超过 25 MB");
      chunks.push(bytes);
    }
    if (data.code === 20000000) completed = true;
  }
  if (!completed) throw new Error("火山语音传输未完成，请重试");
  return Buffer.concat(chunks);
}

export async function synthesizeTts(
  settings: Settings,
  key: string,
  text: string,
  dataDirectory?: string,
): Promise<string> {
  if (!text.trim() || text.length > 12000)
    throw new Error("朗读内容不能为空且不超过 12000 字符");
  const provider = settings.ttsProvider;
  const profile = ttsProfileSchema.parse(ttsProfile(settings));
  if (!profile.voice) throw new Error("请先选择或填写音色 ID");
  const auth = headers(provider, key);
  const signal = AbortSignal.timeout(120000);
  const native = settings.ttsNativeOutput !== false;
  const natural = !native && settings.ttsNaturalSpeech;
  let bytes: Buffer;
  if (provider === "openai" || provider === "siliconflow") {
    const response = await request(
      endpoint(profile.baseUrl, "audio/speech"),
      jsonBody(
        {
          model: profile.model,
          input:
            natural &&
            provider === "siliconflow" &&
            profile.model.startsWith("FunAudioLLM/CosyVoice2")
              ? `${NATURAL_SPEECH_INSTRUCTION}<|endofprompt|>${text}`
              : text,
          voice: profile.voice,
          response_format: "mp3",
          ...(!native ? { speed: settings.speechRate } : {}),
        },
        auth,
      ),
      signal,
    );
    bytes = await bodyBytes(response, MAX_AUDIO);
  } else if (provider === "mimo") {
    if (!["mimo-v2.5-tts", "mimo-v2.5-tts-voiceclone"].includes(profile.model))
      throw new Error(
        "MiMo 请选择 mimo-v2.5-tts 或 mimo-v2.5-tts-voiceclone 模型",
      );
    const voice =
      profile.model === "mimo-v2.5-tts-voiceclone"
        ? await readMimoReference(profile.voice, dataDirectory)
        : profile.voice;
    if (profile.model === "mimo-v2.5-tts" && voice.startsWith("mimo-local:"))
      throw new Error("参考音色需要使用 mimo-v2.5-tts-voiceclone 模型");
    const data = await jsonResponse(
      await request(
        endpoint(profile.baseUrl, "chat/completions"),
        jsonBody(
          {
            model: profile.model,
            messages: [
              ...(natural
                ? [{ role: "user", content: NATURAL_SPEECH_INSTRUCTION }]
                : []),
              { role: "assistant", content: text },
            ],
            audio: { format: "wav", voice },
            stream: false,
          },
          auth,
        ),
        signal,
      ),
    );
    const choice = data.choices?.[0];
    if (
      data.error ||
      !choice ||
      (choice.finish_reason && choice.finish_reason !== "stop")
    )
      throw new Error(
        "MiMo 语音合成未完整完成，请检查模型、权限或缩短内容重试",
      );
    bytes = base64(choice.message?.audio?.data);
  } else if (provider === "minimax") {
    const data = await jsonResponse(
      await request(
        endpoint(profile.baseUrl, "t2a_v2"),
        jsonBody(
          {
            model: profile.model,
            text,
            stream: false,
            output_format: "hex",
            ...(!native ? { language_boost: "auto" } : {}),
            ...(natural && /^speech-2\.[68]-(hd|turbo)$/.test(profile.model)
              ? { text_normalization_mode: "quality" }
              : {}),
            voice_setting: {
              voice_id: profile.voice,
              ...(!native
                ? { speed: settings.speechRate, vol: 1, pitch: 0 }
                : {}),
            },
            audio_setting: {
              format: "mp3",
              ...(!native ? { sample_rate: 32000, channel: 1 } : {}),
            },
          },
          auth,
        ),
        signal,
      ),
    );
    minimaxSuccess(data);
    const encoded = data.data?.audio;
    if (
      typeof encoded !== "string" ||
      !encoded ||
      encoded.length > MAX_AUDIO * 2 ||
      !/^(?:[a-f0-9]{2})+$/i.test(encoded)
    )
      throw new Error("MiniMax 返回的音频编码无效");
    bytes = Buffer.from(encoded, "hex");
  } else if (provider === "bailian") {
    const qwen = profile.model.startsWith("qwen3-tts-");
    const data = await jsonResponse(
      await request(
        endpoint(
          profile.baseUrl,
          qwen
            ? "services/aigc/multimodal-generation/generation"
            : "services/audio/tts/SpeechSynthesizer",
        ),
        jsonBody(
          {
            model: profile.model,
            input: {
              text,
              voice: profile.voice,
              ...(qwen
                ? !native
                  ? { language_type: "Auto" }
                  : {}
                : {
                    format: "wav",
                    ...(!native
                      ? { sample_rate: 24000, rate: settings.speechRate }
                      : {}),
                  }),
            },
          },
          auth,
        ),
        signal,
      ),
    );
    if (data.code)
      throw new Error("百炼语音合成未成功，请检查模型、音色及空间权限");
    bytes = await downloadBailianAudio(
      data.output?.audio?.url,
      profile,
      signal,
    );
  } else {
    if (!profile.resourceId) throw new Error("请填写火山语音资源 ID");
    const preset = profile.resourceId === "seed-tts-2.0";
    const additions = {
      ...(natural && preset
        ? { context_texts: [NATURAL_SPEECH_INSTRUCTION] }
        : {}),
      ...(!native &&
      settings.ttsCloneFidelity &&
      profile.resourceId === "seed-icl-2.0"
        ? { tone_fidelity: true }
        : {}),
    };
    bytes = await volcAudio(
      await request(
        endpoint(profile.baseUrl, "unidirectional"),
        jsonBody(
          {
            ...(!native ? { user: { uid: "mai-desktop" } } : {}),
            req_params: {
              text,
              speaker: profile.voice,
              ...(!preset ? { model: profile.model } : {}),
              ...(Object.keys(additions).length
                ? { additions: JSON.stringify(additions) }
                : {}),
              audio_params: {
                format: "mp3",
                ...(!native
                  ? {
                      sample_rate: 24000,
                      speech_rate: Math.round((settings.speechRate - 1) * 100),
                    }
                  : {}),
              },
            },
          },
          { ...auth, "X-Api-Resource-Id": profile.resourceId },
        ),
        signal,
      ),
    );
  }
  return ttsAudioUrl(bytes);
}

function cloneAudio(
  input: VoiceCloneInput,
  provider: TtsProvider,
): { bytes: Buffer; format: string; mime: string } {
  if (!input.audio) throw new Error("请先选择参考音频");
  const bytes = Buffer.from(input.audio.data);
  const format = input.audio.name.toLowerCase().split(".").at(-1) || "";
  const allowed =
    provider === "siliconflow" || provider === "mimo"
      ? ["mp3", "wav"]
      : provider === "minimax"
        ? ["mp3", "wav", "m4a"]
        : ["mp3", "wav", "m4a", "ogg", "aac"];
  if (!allowed.includes(format))
    throw new Error("当前服务不支持此参考音频格式");
  const limit =
    provider === "mimo"
      ? MIMO_REFERENCE_MAX_BYTES
      : provider === "volcengine"
        ? 10_000_000
        : 20_000_000;
  if (!bytes.length || bytes.length > limit)
    throw new Error(`参考音频为空或超过 ${limit / 1_000_000} MB`);
  return {
    bytes,
    format,
    mime:
      format === "mp3"
        ? "audio/mpeg"
        : format === "m4a"
          ? "audio/mp4"
          : `audio/${format}`,
  };
}

async function readMimoReference(
  voiceId: string,
  directory?: string,
): Promise<string> {
  const match =
    /^mimo-local:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.(mp3|wav)$/.exec(
      voiceId,
    );
  if (!directory || !match) throw new Error("请先保存并选择 MiMo 参考音色");
  const file = join(directory, "voice-references", `${match[1]}.${match[2]}`);
  let bytes: Buffer;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MIMO_REFERENCE_MAX_BYTES)
      throw new Error();
    bytes = await readFile(file);
  } catch {
    throw new Error("MiMo 参考音频缺失或过大，请重新保存参考音色");
  }
  return mimoReferenceUrl(bytes, match[2]);
}

function mimoReferenceUrl(bytes: Buffer, format: string): string {
  if (!bytes.length || bytes.length > MIMO_REFERENCE_MAX_BYTES)
    throw new Error("MiMo 参考音频过大或为空，原文件需小于约 7.5 MB");
  const url = ttsAudioUrl(bytes);
  if (!url.startsWith(`data:audio/${format === "mp3" ? "mpeg" : "wav"};`))
    throw new Error("MiMo 参考音频格式与文件扩展名不符，请使用 MP3 或 WAV");
  return url;
}

function volcVoice(voiceId: string) {
  if (!/^[A-Za-z][A-Za-z0-9_-]{6,254}[A-Za-z0-9]$/.test(voiceId))
    throw new Error("火山音色 ID 需为 8–256 位字母、数字、横线或下划线");
  return voiceId.startsWith("S_")
    ? { speaker_id: voiceId }
    : { speaker_id: "custom_speaker_id", custom_speaker_id: voiceId };
}

function volcStatus(data: Record<string, any>): ClonedVoice["status"] {
  if (data.code && data.code !== 20000000)
    throw new Error("火山声音复刻请求失败，请检查音色权限与参考音频");
  if ([2, 4].includes(data.status)) return "ready";
  if (data.status === 1) return "pending";
  if ([0, 3].includes(data.status)) return "failed";
  throw new Error("火山未返回有效的训练状态");
}

export async function createClonedVoice(
  settings: Settings,
  key: string,
  input: VoiceCloneInput,
  dataDirectory?: string,
): Promise<ClonedVoice> {
  input = voiceCloneInputSchema.parse(input);
  const provider = settings.ttsProvider;
  if (provider === "openai")
    throw new Error("通用语音 API 没有统一的音色复刻接口，请选择具体服务商");
  const profile = ttsProfileSchema.parse(ttsProfile(settings));
  if (provider === "mimo") {
    if (!dataDirectory) throw new Error("MiMo 参考音色需要本机存储目录");
    const { bytes, format } = cloneAudio(input, provider);
    mimoReferenceUrl(bytes, format);
    const id = randomUUID();
    const voiceId = `mimo-local:${id}.${format}`;
    const voice = clonedVoiceSchema.parse({
      id,
      provider,
      name: input.name,
      voiceId,
      profile: {
        ...profile,
        model: "mimo-v2.5-tts-voiceclone",
        voice: voiceId,
      },
      status: "ready",
      createdAt: Date.now(),
    });
    await mkdir(join(dataDirectory, "voice-references"), { recursive: true });
    await writeFile(
      join(dataDirectory, "voice-references", `${id}.${format}`),
      bytes,
      { flag: "wx" },
    );
    return voice;
  }
  const auth = headers(provider, key);
  const signal = AbortSignal.timeout(120000);
  let voiceId = "",
    status: ClonedVoice["status"] = "ready";
  if (provider === "bailian" && profile.model.startsWith("qwen3-tts-vc-")) {
    let reference: string;
    if (input.audio) {
      const { bytes, format } = cloneAudio(input, "bailian");
      if (
        bytes.length > MIMO_REFERENCE_MAX_BYTES ||
        !["mp3", "wav"].includes(format)
      )
        throw new Error("百炼本地复刻请选择小于约 7.5 MB 的 MP3 或 WAV");
      reference = ttsAudioUrl(bytes);
    } else {
      try {
        const url = new URL(input.referenceUrl || "");
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.hash
        )
          throw new Error();
        reference = url.toString();
      } catch {
        throw new Error("请导入音色音频或填写有效的参考链接");
      }
    }
    const data = await jsonResponse(
      await request(
        endpoint(profile.baseUrl, "services/audio/tts/customization"),
        jsonBody(
          {
            model: "qwen-voice-enrollment",
            input: {
              action: "create",
              target_model: profile.model,
              preferred_name: `mai_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
              audio: { data: reference },
              ...(input.referenceText ? { text: input.referenceText } : {}),
            },
          },
          auth,
        ),
        signal,
      ),
      65536,
    );
    if (
      data.code ||
      (data.output?.target_model && data.output.target_model !== profile.model)
    )
      throw new Error("百炼音色创建失败或目标模型不匹配");
    voiceId = data.output?.voice;
  } else if (provider === "bailian") {
    let url: URL;
    try {
      url = new URL(input.referenceUrl || "");
    } catch {
      throw new Error("百炼需要可公网访问的参考音频链接");
    }
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error("参考音频链接无效");
    const data = await jsonResponse(
      await request(
        endpoint(profile.baseUrl, "services/audio/tts/customization"),
        jsonBody(
          {
            model: "voice-enrollment",
            input: {
              action: "create_voice",
              target_model: profile.model,
              prefix: "mai",
              url: url.toString(),
              language_hints: ["zh"],
            },
          },
          auth,
        ),
        signal,
      ),
      65536,
    );
    voiceId = data.output?.voice_id;
    status = "pending";
  } else {
    const { bytes, format, mime } = cloneAudio(input, provider);
    if (provider === "siliconflow") {
      if (!input.referenceText?.trim())
        throw new Error("硅基流动复刻需要参考音频对应的原文");
      const form = new FormData();
      form.set(
        "file",
        new Blob([new Uint8Array(bytes)], { type: mime }),
        `reference.${format}`,
      );
      form.set("model", profile.model);
      form.set("customName", input.name);
      form.set("text", input.referenceText);
      const data = await jsonResponse(
        await request(
          endpoint(profile.baseUrl, "uploads/audio/voice"),
          { method: "POST", headers: auth, body: form },
          signal,
        ),
        65536,
      );
      voiceId = data.uri;
      if (typeof voiceId !== "string" || !voiceId.startsWith("speech:"))
        throw new Error("硅基流动未返回有效的音色 URI");
    } else if (provider === "minimax") {
      voiceId = input.voiceId || `Mai${randomUUID().replace(/-/g, "")}`;
      if (!/^[A-Za-z][A-Za-z0-9_-]{6,254}[A-Za-z0-9]$/.test(voiceId))
        throw new Error(
          "MiniMax 音色 ID 需为 8–256 位英文字母、数字、横线或下划线",
        );
      const form = new FormData();
      form.set("purpose", "voice_clone");
      form.set(
        "file",
        new Blob([new Uint8Array(bytes)], { type: mime }),
        `reference.${format}`,
      );
      const upload = await jsonResponse(
        await request(
          endpoint(profile.baseUrl, "files/upload"),
          { method: "POST", headers: auth, body: form },
          signal,
        ),
        65536,
      );
      minimaxSuccess(upload);
      const fileId = upload.file?.file_id;
      if (
        (typeof fileId !== "string" || !/^\d+$/.test(fileId)) &&
        (typeof fileId !== "number" ||
          !Number.isSafeInteger(fileId) ||
          fileId <= 0)
      )
        throw new Error("MiniMax 未返回有效的文件 ID");
      // int64 文件 ID 不能经 JavaScript Number 转换而丢失精度。
      const payload = JSON.stringify({ voice_id: voiceId });
      const body = payload.slice(0, -1) + `,"file_id":${fileId}}`;
      const data = await jsonResponse(
        await request(
          endpoint(profile.baseUrl, "voice_clone"),
          {
            method: "POST",
            headers: { ...auth, "Content-Type": "application/json" },
            body,
          },
          signal,
        ),
        65536,
      );
      minimaxSuccess(data);
    } else {
      voiceId = input.voiceId || "";
      const data = await jsonResponse(
        await request(
          endpoint(profile.baseUrl, "voice_clone"),
          jsonBody(
            {
              ...volcVoice(voiceId),
              audio: { data: bytes.toString("base64"), format },
              language: 0,
            },
            auth,
          ),
          signal,
        ),
        65536,
      );
      status = volcStatus(data);
      profile.resourceId = "seed-icl-2.0";
    }
  }
  if (typeof voiceId !== "string" || !voiceId.trim() || voiceId.length > 512)
    throw new Error("服务商未返回有效音色 ID，音色未保存");
  return clonedVoiceSchema.parse({
    id: randomUUID(),
    provider,
    name: input.name,
    voiceId,
    profile: { ...profile, voice: voiceId },
    status,
    createdAt: Date.now(),
  });
}

export async function queryClonedVoice(
  voice: ClonedVoice,
  key: string,
  signal = AbortSignal.timeout(30000),
): Promise<ClonedVoice> {
  if (
    voice.provider === "bailian" &&
    voice.profile.model.startsWith("qwen3-tts-vc-")
  )
    return voice;
  if (!["bailian", "volcengine"].includes(voice.provider)) return voice;
  const auth = headers(voice.provider, key);
  const data = await jsonResponse(
    await request(
      endpoint(
        voice.profile.baseUrl,
        voice.provider === "bailian"
          ? "services/audio/tts/customization"
          : "get_voice",
      ),
      jsonBody(
        voice.provider === "bailian"
          ? {
              model: "voice-enrollment",
              input: { action: "query_voice", voice_id: voice.voiceId },
            }
          : volcVoice(voice.voiceId),
        auth,
      ),
      AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    ),
    65536,
  );
  if (voice.provider === "volcengine")
    return { ...voice, status: volcStatus(data) };
  if (data.code) throw new Error("百炼音色状态查询失败");
  const status = data.output?.status;
  if (!["OK", "DEPLOYING", "UNDEPLOYED"].includes(status))
    throw new Error("百炼未返回有效的音色状态");
  if (
    data.output.target_model &&
    data.output.target_model !== voice.profile.model
  )
    throw new Error("百炼音色的目标模型不匹配");
  return {
    ...voice,
    status:
      status === "OK" ? "ready" : status === "DEPLOYING" ? "pending" : "failed",
  };
}

// 简单导入只需要服务商与音频；各家的额外步骤在这里完成，不改动录音转写设置。
export async function createImportedVoice(
  settings: Settings,
  key: string,
  input: VoiceImportInput,
  dataDirectory: string,
): Promise<ClonedVoice> {
  input = voiceImportInputSchema.parse(input);
  const { provider, audio } = input;
  const rules = voiceImportAudioRules(provider);
  const format = audio.name.toLowerCase().split(".").at(-1) || "";
  if (!rules.formats.includes(format))
    throw new Error("当前服务不支持此参考音频格式");
  if (!audio.data.byteLength || audio.data.byteLength > rules.maxBytes)
    throw new Error(`音频不能为空且需小于 ${rules.maxBytes / 1_000_000} MB`);
  const selected = structuredClone(settings);
  selected.ttsProvider = provider;
  const clone: VoiceCloneInput = {
    name:
      audio.name
        .replace(/\.[^.]+$/, "")
        .trim()
        .slice(0, 60) || "我的音色",
    audio,
    referenceText: input.referenceText,
    voiceId: input.voiceId,
  };
  if (provider === "siliconflow" && !clone.referenceText?.trim()) {
    const { bytes, mime } = cloneAudio(clone, provider);
    const form = new FormData();
    form.set(
      "file",
      new Blob([new Uint8Array(bytes)], { type: mime }),
      `reference.${format}`,
    );
    form.set("model", "FunAudioLLM/SenseVoiceSmall");
    const data = await jsonResponse(
      await request(
        endpoint(ttsProfile(selected).baseUrl, "audio/transcriptions"),
        { method: "POST", headers: headers(provider, key), body: form },
        AbortSignal.timeout(60000),
      ),
      65536,
    );
    if (
      typeof data.text !== "string" ||
      !data.text.trim() ||
      data.text.trim().length > 4000
    )
      throw new Error(
        "未能识别参考音频，请使用清晰的说话录音，或在补充选项填写原文后重试",
      );
    clone.referenceText = data.text.trim();
  }
  if (provider === "volcengine" && !clone.voiceId)
    clone.voiceId = `Mai${randomUUID().replace(/-/g, "")}`;
  if (provider === "bailian") {
    const profile = ttsProfile(selected);
    selected.ttsProfiles.bailian = {
      ...profile,
      model: /^qwen3-tts-vc-(?!realtime)/.test(profile.model)
        ? profile.model
        : BAILIAN_IMPORT_MODEL,
    };
  }
  return createClonedVoice(selected, key, clone, dataDirectory);
}
