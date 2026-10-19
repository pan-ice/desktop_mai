import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { parseReply, pluginFrameSchema } from "../electron/protocol";
import { messageContent } from "../shared/message-content";

const execute = promisify(execFile);
const executable =
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python";

it.each(["legacy", "sdk"])(
  "MaiBot 实际序列化 → %s 适配器 → 桌宠保留媒体和顺序",
  async (mode) => {
    const python =
      mode === "legacy"
        ? process.env.MAI_MESSAGE_ADAPTER_PYTHON ||
          resolve("adapter/.venv", executable)
        : process.env.MAI_PYTHON ||
          resolve("MaiBot/plugins/desktop_pet_adapter/.venv", executable);
    const { stdout } = await execute(
      python,
      [join(resolve("scripts"), "maibot-message-fixture.py"), mode],
      {
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, PYTHONUTF8: "1" },
      },
    );
    const fixture = JSON.parse(stdout);
    expect(fixture.rejected).toEqual(["file", "forward", "dict"]);
    const replies = fixture.frames.map((value: unknown) => {
      const frame = pluginFrameSchema.parse(value);
      if (frame.type !== "reply") throw new Error("错误测试数据");
      return parseReply(frame);
    });
    const parts = messageContent(replies[0]);
    expect(parts.map((part) => part.type)).toEqual([
      "text",
      "image",
      "text",
      "audio",
      "text",
    ]);
    expect(parts[0]).toEqual({ type: "text", text: "图片之前" });
    expect(parts[2]).toEqual({ type: "text", text: "图片之后，音频之前" });
    expect(replies[0].attachments[0].dataUrl).toMatch(
      /^data:image\/png;base64,/,
    );
    expect(replies[0].attachments[1].dataUrl).toMatch(
      /^data:audio\/wav;base64,/,
    );
    expect(replies[0].text).toContain("[引用消息]");
    expect(replies[0].text).toContain("回复正文");
    expect(replies[0].text).toContain(mode === "sdk" ? "@小明" : "@对方");
    if (mode === "sdk") expect(replies[0].text).toContain("引用的原话");
    expect(replies[1].text).toBe("长😀".repeat(4001));
  },
);
