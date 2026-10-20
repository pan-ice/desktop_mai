import { describe, expect, it } from "vitest";
import { parseReply } from "../electron/protocol";
import { replySpeechText } from "../shared/speech-text";

function message(...texts: string[]) {
  return parseReply({
    v: 1,
    type: "reply",
    id: "speech-test",
    sessionId: "speech-test",
    segments: texts.map((text) => ({ type: "text", text })),
  });
}

describe("回复朗读跳过引用", () => {
  it("经典引用只读回复，聊天原文和分段保持完整", () => {
    const reply = message("[引用消息]\n", "这是回复。\n这是第二段。");
    const before = structuredClone(reply);
    expect(replySpeechText(reply)).toBe("这是回复。\n这是第二段。");
    expect(reply).toEqual(before);
    expect(reply.text).toBe("[引用消息]\n这是回复。\n这是第二段。");
  });

  it("SDK 的发送者和多行原文全部跳过，保留引用前后的新文字", () => {
    const reply = message(
      "@小明 ",
      "[引用消息] 朋友：第一行原文\n第二行原文\n",
      "这是新回复。",
      "[引用消息] 另一人：另一条原文\n",
      "还有补充。",
    );
    expect(replySpeechText(reply)).toBe("@小明 这是新回复。还有补充。");
  });

  it("只有引用时没有可朗读内容，附件也不会混入文字", () => {
    const reply = message("[引用消息] 朋友：只有引用\n");
    reply.parts.push({ type: "attachment", index: 0 });
    expect(replySpeechText(reply)).toBe("");
    expect(
      replySpeechText({ text: "", parts: [{ type: "attachment", index: 0 }] }),
    ).toBe("");
  });

  it("没有分段的旧历史按行跳过引用，保留后面的回复", () => {
    expect(
      replySpeechText({
        text: "[引用消息] 朋友：原文\r\n这是旧历史中的回复。",
      }),
    ).toBe("这是旧历史中的回复。");
    expect(
      replySpeechText({
        text: "第一段。\n[引用消息]\n第二段。\n[引用消息] 朋友：另一条\n第三段。",
      }),
    ).toBe("第一段。\n第二段。\n第三段。");
    expect(replySpeechText({ text: "[引用消息] 朋友：没有回复" })).toBe("");
  });

  it("同一文字段中的单行引用仍保留随后的回复", () => {
    expect(replySpeechText(message("[引用消息] 朋友：原文\n这是回复。"))).toBe(
      "这是回复。",
    );
  });

  it("普通文字、换行和正文中提到的引用标记不受影响", () => {
    const text = "普通回复🙂\n正文里提到 [引用消息] 这个标记。\n继续回复。";
    expect(replySpeechText(message(text))).toBe(text);
    expect(replySpeechText({ text })).toBe(text);
  });
});
