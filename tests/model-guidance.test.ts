import { describe, expect, it } from "vitest";
import { isModelGuideUrl, modelGuideLinks } from "../shared/model-guidance";

describe("官方计费说明外链", () => {
  it.each(Object.values(modelGuideLinks))("允许已列出的说明页 %s", (url) => {
    expect(isModelGuideUrl(url)).toBe(true);
  });

  it.each([
    "https://example.com/",
    "https://developers.openai.com.evil.example/api/docs/models/tts-1",
    "https://developers.openai.com@evil.example/api/docs/models/tts-1",
    "https://developers.openai.com/api/docs/models/tts-1/other",
    `${modelGuideLinks.openai}?redirect=https://example.com/`,
    "http://developers.openai.com/api/docs/models/tts-1",
    "file:///C:/Windows/System32/cmd.exe",
    "javascript:alert(1)",
    "mai-media://private-file",
    "",
  ])("拒绝其他地址或协议 %s", (url) => {
    expect(isModelGuideUrl(url)).toBe(false);
  });
});
