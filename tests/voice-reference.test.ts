import { describe, expect, it } from "vitest";
import { analyzeVoiceReference } from "../shared/voice-reference";

function tone(seconds: number, rate = 24000) {
  return Float32Array.from(
    { length: seconds * rate },
    (_, index) => 0.2 * Math.sin((index * 2 * Math.PI * 220) / rate),
  );
}

describe("参考录音本机检查", () => {
  it("正常时长和幅度的单声道音频没有基础波形警告", () => {
    expect(analyzeVoiceReference([tone(12)], 24000)).toMatchObject({
      duration: 12,
      channels: 1,
      warnings: [],
    });
  });
  it("过短的录音提示补充音色信息", () => {
    expect(analyzeVoiceReference([tone(2)], 24000).warnings.join("")).toContain(
      "偏短",
    );
  });
  it("长静音和音量不足可被识别", () => {
    const report = analyzeVoiceReference([new Float32Array(24000 * 12)], 24000);
    expect(report.warnings.join("")).toContain("静音");
    expect(report.warnings.join("")).toContain("音量很低");
  });
  it("低采样率、长录音和削波分别提示", () => {
    expect(
      analyzeVoiceReference([tone(12, 8000)], 8000).warnings.join(""),
    ).toContain("采样率偏低");
    expect(
      analyzeVoiceReference([tone(31)], 24000).warnings.join(""),
    ).toContain("录音较长");
    expect(
      analyzeVoiceReference(
        [new Float32Array(24000 * 12).fill(1)],
        24000,
      ).warnings.join(""),
    ).toContain("削波");
  });
  it("立体声任一声道有连续说话时不误报长静音", () => {
    expect(
      analyzeVoiceReference([new Float32Array(24000 * 12), tone(12)], 24000)
        .warnings,
    ).toEqual([]);
  });
  it("空音频给出可读提示", () => {
    expect(analyzeVoiceReference([], 24000).warnings.join("")).toContain(
      "没有可分析",
    );
  });
});
