import type { Settings } from "../shared/types";
import { synthesizeTts } from "./tts";

export function speechEndpoint(base: string, path: string) {
  const url = new URL(base);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("语音服务地址无效");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${path}`;
  return url.toString();
}

async function checkResponse(response: Response) {
  if (!response.ok) {
    // 仅报告 HTTP 状态，服务端响应可能带有认证字段或其他敏感信息。
    throw new Error(
      `语音服务请求失败（HTTP ${response.status}），请检查地址、模型和 API Key`,
    );
  }
}

export async function transcribeAudio(
  settings: Settings,
  key: string,
  data: ArrayBuffer,
  mime: string,
): Promise<string> {
  if (data.byteLength === 0 || data.byteLength > 25 * 1024 * 1024)
    throw new Error("录音不能为空且不能超过 25 MB");
  if (!/^audio\/(webm|ogg|wav|mp4|mpeg)(;.*)?$/.test(mime))
    throw new Error("不支持的录音格式");
  const type = mime.split(";")[0];
  const ext = type === "audio/mp4" ? "m4a" : type.split("/")[1];
  const form = new FormData();
  form.set("file", new Blob([data], { type }), `recording.${ext}`);
  form.set("model", settings.sttModel);
  const response = await fetch(
    speechEndpoint(settings.speechBaseUrl, "audio/transcriptions"),
    {
      method: "POST",
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      body: form,
      signal: AbortSignal.timeout(60000),
      redirect: "error",
    },
  );
  await checkResponse(response);
  const result: unknown = await response.json();
  if (
    !result ||
    typeof result !== "object" ||
    !("text" in result) ||
    typeof result.text !== "string"
  )
    throw new Error("语音服务返回内容缺少 text");
  if (!result.text.trim()) throw new Error("没有识别到语音，请靠近麦克风重试");
  return result.text.trim();
}

export async function synthesizeAudio(
  settings: Settings,
  key: string,
  text: string,
  dataDirectory?: string,
): Promise<string> {
  return synthesizeTts(settings, key, text, dataDirectory);
}
