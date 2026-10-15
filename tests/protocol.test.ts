import { describe, expect, it } from "vitest";
import {
  adapterConfig,
  buildRequest,
  parseReply,
  pluginFrameSchema,
} from "../electron/protocol";
import { defaultSettings } from "../shared/defaults";
import { serverConnectionSchema, serverUrlSchema } from "../shared/schemas";

describe("桌宠协议 v1", () => {
  it("图文与主动任务使用不同方法，客户端不承担内核消息格式", () => {
    expect(
      buildRequest("chat", "看看", "data:image/png;base64,aGVsbG8=", "1"),
    ).toEqual({
      v: 1,
      type: "request",
      method: "chat",
      id: "1",
      params: { text: "看看", image: "data:image/png;base64,aGVsbG8=" },
    });
    expect(buildRequest("proactive", "自然聊聊", undefined, "2").method).toBe(
      "proactive",
    );
  });
  it("接收图文语音，拒绝远程媒体、旧协议与未知版本", () => {
    const valid = {
      v: 1,
      type: "reply",
      id: "1",
      sessionId: "core-session",
      segments: [
        { type: "text", text: "你好" },
        { type: "image", dataUrl: "data:image/png;base64,aGVsbG8=" },
        { type: "audio", dataUrl: "data:audio/wav;base64,aGVsbG8=" },
      ],
    };
    const frame = pluginFrameSchema.parse(valid);
    if (frame.type !== "reply") throw new Error("错误测试数据");
    expect(parseReply(frame)).toMatchObject({
      text: "你好",
      attachments: [{ type: "image" }, { type: "audio" }],
    });
    for (const input of [
      { ...valid, v: 2 },
      {
        ...valid,
        segments: [{ type: "image", dataUrl: "https://example.com/x.png" }],
      },
      { message_info: {}, message_segment: {} },
    ])
      expect(pluginFrameSchema.safeParse(input).success).toBe(false);
  });
  it("配置导出只包含独立连接令牌与固定身份", () => {
    const config = adapterConfig(
      { ...defaultSettings, adapterScope: "工作" },
      "test-token",
    );
    expect(config).toContain('desktop_url = "ws://127.0.0.1:18765/maibot"');
    expect(config).toContain('scope = "工作"');
    expect(config).not.toContain("maim_message");
  });
});

describe("服务器接入凭证", () => {
  it("允许加密服务器和本机测试，拒绝携带凭证、查询参数或明文公网地址", () => {
    for (const url of [
      "wss://mai.example.com/desktop",
      "ws://127.0.0.1:18766/desktop",
    ])
      expect(serverUrlSchema.safeParse(url).success).toBe(true);
    for (const url of [
      "ws://example.com/desktop",
      "wss://user:secret@example.com/desktop",
      "wss://example.com/desktop?token=secret",
      "wss://example.com/adapter",
    ])
      expect(serverUrlSchema.safeParse(url).success).toBe(false);
    expect(
      serverConnectionSchema.safeParse({
        format: "mai-desktop-server",
        version: 1,
        serverUrl: "wss://mai.example.com/desktop",
        token: "t".repeat(40),
        userId: "victim",
      }).success,
    ).toBe(false);
  });
});
