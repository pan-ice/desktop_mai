import { describe, expect, it } from "vitest";
import {
  adapterConfig,
  messageAdapterConfig,
  buildRequest,
  parseReply,
  pluginFrameSchema,
} from "../electron/protocol";
import { defaultSettings } from "../shared/defaults";
import {
  serverConnectionSchema,
  serverUrlSchema,
  settingsPatchSchema,
} from "../shared/schemas";
import { cloudMessageSchema } from "../shared/accounts";

describe("桌宠协议 v1", () => {
  it("内核名字是可选元数据，保留旧 ready/reply 帧兼容", () => {
    const frames = [
      {
        v: 1,
        type: "ready",
        sessionId: "core-session",
        capabilities: ["chat", "image", "audio"],
        transport: "legacy",
      },
      {
        v: 1,
        type: "reply",
        id: "named-reply",
        sessionId: "core-session",
        segments: [{ type: "text", text: "你好" }],
      },
    ];
    for (const frame of frames) {
      expect(pluginFrameSchema.parse(frame)).not.toHaveProperty("botName");
      expect(
        pluginFrameSchema.parse({ ...frame, botName: "  花花  " }),
      ).toHaveProperty("botName", "花花");
      expect(
        pluginFrameSchema.parse({ ...frame, botName: "麦".repeat(40) }),
      ).toHaveProperty("botName", "麦".repeat(40));
      expect(
        pluginFrameSchema.safeParse({ ...frame, unsupported: true }).success,
      ).toBe(false);
    }
  });

  it("无效名字只丢弃元数据，不破坏正常握手和回复内容", () => {
    const frames = [
      {
        v: 1,
        type: "ready",
        sessionId: "core-session",
        capabilities: ["chat", "image", "audio", "proactive"],
      },
      {
        v: 1,
        type: "reply",
        id: "valid-chat",
        sessionId: "core-session",
        segments: [{ type: "text", text: "名字无效时，回复仍然可用" }],
      },
    ];
    const invalidNames: unknown[] = [
      "",
      "   ",
      "麦".repeat(41),
      null,
      false,
      123,
      [],
      { name: "不是字符串" },
      ...Array.from(
        { length: 32 },
        (_, code) => `麦${String.fromCharCode(code)}麦`,
      ),
      ...Array.from(
        { length: 33 },
        (_, code) => `麦${String.fromCharCode(0x7f + code)}麦`,
      ),
    ];
    for (const frame of frames)
      for (const botName of invalidNames) {
        const parsed = pluginFrameSchema.parse({ ...frame, botName });
        expect("botName" in parsed && parsed.botName).toBeUndefined();
        if (parsed.type === "reply")
          expect(parseReply(parsed).text).toBe("名字无效时，回复仍然可用");
      }
  });

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
      { ...defaultSettings, adapterPort: 18765, adapterScope: "工作" },
      "test-token",
    );
    expect(config).toContain('desktop_url = "ws://127.0.0.1:18765/maibot"');
    expect(config).toContain('scope = "工作"');
    expect(config).not.toContain("maim_message");
  });
  it("保留文字、图片、文字、音频的原始顺序", () => {
    const frame = pluginFrameSchema.parse({
      v: 1,
      type: "reply",
      id: "mixed",
      sessionId: "core-session",
      segments: [
        { type: "text", text: "看这张图" },
        { type: "image", dataUrl: "data:image/png;base64,aGVsbG8=" },
        { type: "text", text: "然后听这段声音" },
        { type: "audio", dataUrl: "data:audio/wav;base64,aGVsbG8=" },
      ],
    });
    if (frame.type !== "reply") throw new Error("错误测试数据");
    expect(parseReply(frame)).toMatchObject({
      parts: [
        { type: "text", text: "看这张图" },
        { type: "attachment", index: 0 },
        { type: "text", text: "然后听这段声音" },
        { type: "attachment", index: 1 },
      ],
    });
  });
  it("历史顺序必须与完整文字和全部附件对应，仍兼容旧历史", () => {
    const message = {
      id: "history",
      role: "assistant",
      text: "之前之后",
      timestamp: 1,
      source: "core",
      attachments: [
        { type: "image", dataUrl: "data:image/png;base64,aGVsbG8=" },
      ],
    };
    expect(cloudMessageSchema.safeParse(message).success).toBe(true);
    const parts = [
      { type: "text", text: "之前" },
      { type: "attachment", index: 0 },
      { type: "text", text: "之后" },
    ];
    expect(cloudMessageSchema.safeParse({ ...message, parts }).success).toBe(
      true,
    );
    for (const invalid of [
      parts.slice(0, 2),
      [parts[0], parts[2]],
      [...parts, parts[1]],
      [parts[0], { type: "attachment", index: 1 }, parts[2]],
    ]) {
      expect(
        cloudMessageSchema.safeParse({ ...message, parts: invalid }).success,
      ).toBe(false);
    }
  });
});

describe("本机接入端口", () => {
  it("设置只允许自动分配或合法手动端口", () => {
    for (const port of [0, 1024, 18765, 65535])
      expect(settingsPatchSchema.parse({ adapterPort: port }).adapterPort).toBe(
        port,
      );
    for (const port of [-1, 1, 1023, 65536, 0.5, NaN, Infinity])
      expect(settingsPatchSchema.safeParse({ adapterPort: port }).success).toBe(
        false,
      );
  });

  it.each([
    ["网关插件", adapterConfig],
    ["独立消息适配器", messageAdapterConfig],
  ] as const)("%s 配置只导出已选定的实际端口", (_name, renderConfig) => {
    for (const port of [1024, 49152, 65535]) {
      const config = renderConfig(
        { ...defaultSettings, adapterPort: port },
        "test-token",
      );
      expect(config).toContain(`ws://127.0.0.1:${port}/maibot`);
      expect(config).not.toContain("ws://127.0.0.1:0/maibot");
    }
    for (const port of [0, -1, 65536, 0.5, NaN, Infinity])
      expect(() =>
        renderConfig({ ...defaultSettings, adapterPort: port }, "test-token"),
      ).toThrow();
  });
});

describe("服务器接入凭证", () => {
  it("允许外部 ws、加密服务器和本机测试，拒绝错误协议、凭证及查询参数", () => {
    for (const url of [
      "wss://mai.example.com/desktop",
      "ws://mai.example.com/desktop",
      "ws://192.168.1.10:18766/desktop",
      "ws://127.0.0.1:18766/desktop",
    ])
      expect(serverUrlSchema.safeParse(url).success).toBe(true);
    for (const url of [
      "http://example.com/desktop",
      "ws://user:secret@example.com/desktop",
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
