import type { TtsProvider } from "./tts";
import type { ChatMessage } from "./types";

function withoutReferenceLines(text: string): string {
  return text.replace(/^[\t ]*\[引用消息\][^\r\n]*(?:\r?\n|$)/gmu, "");
}

/** 保留展示原文，朗读时跳过适配器的引用段；旧历史按引用标记行兼容。 */
export function replySpeechText(
  message: Pick<ChatMessage, "text" | "parts">,
): string {
  if (!message.parts?.length) return withoutReferenceLines(message.text);
  return message.parts
    .map((part) => {
      if (part.type !== "text") return "";
      // 引用原文可包含换行，使用原始分段边界跳过整段。
      if (
        part.text.trimStart().startsWith("[引用消息]") &&
        part.text.endsWith("\n")
      )
        return "";
      return withoutReferenceLines(part.text);
    })
    .join("");
}

// 保留每个字符，优先在标点处分段，避免超长回复被服务端拒绝或截断。
export function speechSegments(text: string, provider: TtsProvider): string[] {
  const maxBytes = provider === "volcengine" ? 1000 : 3000;
  const maxCharacters = provider === "bailian" ? 600 : 1000;
  const encoder = new TextEncoder();
  const result: string[] = [];
  let current = "",
    size = 0,
    boundary = 0;
  for (const character of text) {
    const bytes = encoder.encode(character).length;
    while (
      size + bytes > maxBytes ||
      current.length + character.length > maxCharacters
    ) {
      const split = boundary || current.length;
      result.push(current.slice(0, split));
      current = current.slice(split);
      size = encoder.encode(current).length;
      boundary = 0;
    }
    current += character;
    size += bytes;
    if (/[。！？；.!?;\n]/u.test(character)) boundary = current.length;
  }
  if (current) result.push(current);
  return result;
}
