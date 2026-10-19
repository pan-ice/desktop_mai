import type { TtsProvider } from "./tts";

// 保留每个字符，优先在标点处分段，避免超长回复被服务端拒绝或截断。
export function speechSegments(text: string, provider: TtsProvider): string[] {
  const maxBytes = provider === "volcengine" ? 1000 : 3000;
  const encoder = new TextEncoder();
  const result: string[] = [];
  let current = "",
    size = 0,
    boundary = 0;
  for (const character of text) {
    const bytes = encoder.encode(character).length;
    while (
      size + bytes > maxBytes ||
      current.length + character.length > 1000
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
