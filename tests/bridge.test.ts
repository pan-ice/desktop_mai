import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { DeliveryUnknownError, MaiBotBridge } from "../electron/bridge";
import { identity, type Reply } from "../electron/protocol";
import { defaultSettings } from "../shared/defaults";

const token = "test-only-token-0123456789abcdefgh";
let bridge: MaiBotBridge | undefined;
const sockets: WebSocket[] = [];
const remoteServers: WebSocketServer[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await bridge?.disconnect();
  bridge = undefined;
  for (const server of remoteServers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

export async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function setup() {
  const settings = { ...defaultSettings, adapterPort: await freePort() };
  const instance = new MaiBotBridge();
  bridge = instance;
  await instance.connect(settings, token);
  return { instance, settings };
}
async function plugin(port: number, startedAt = Date.now(), overrides = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/maibot`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  sockets.push(socket);
  await once(socket, "open");
  const welcome = once(socket, "message");
  socket.send(
    JSON.stringify({
      v: 1,
      type: "hello",
      protocol: "mai-desktop",
      pluginVersion: "0.2.0",
      instanceId: randomUUID(),
      startedAt,
      identity: identity(defaultSettings),
      ...overrides,
    }),
  );
  await welcome;
  return socket;
}
async function ready(
  instance: MaiBotBridge,
  socket: WebSocket,
  overrides: Record<string, unknown> = {},
) {
  const connected = once(instance, "status");
  socket.send(
    JSON.stringify({
      v: 1,
      type: "ready",
      sessionId: "session-from-host",
      capabilities: ["chat", "image", "audio", "proactive"],
      ...overrides,
    }),
  );
  await connected;
}

describe("独立插件入口", () => {
  it("端口 0 直接绑定真实空闲端口，关闭后可按已选端口重新接入", async () => {
    const instance = new MaiBotBridge();
    bridge = instance;
    const statuses: { phase: string; detail: string }[] = [];
    instance.on("status", (status) => statuses.push(status));
    expect(instance.localPort).toBeUndefined();
    await instance.connect({ ...defaultSettings, adapterPort: 0 }, token);
    const port = instance.localPort;
    expect(port).toBeTypeOf("number");
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(port).toBeLessThanOrEqual(65535);
    expect(statuses.at(-1)?.detail).toContain(`127.0.0.1:${port}`);
    const socket = await plugin(port!);
    await ready(instance, socket);
    expect(instance.phase).toBe("connected");
    await instance.disconnect();
    expect(instance.localPort).toBeUndefined();
    await instance.connect({ ...defaultSettings, adapterPort: port! }, token);
    expect(instance.localPort).toBe(port);
    await ready(instance, await plugin(port!));
    expect(instance.phase).toBe("connected");
  });

  it("两个自动接入实例各自持有不同的可用端口", async () => {
    const first = new MaiBotBridge();
    const second = new MaiBotBridge();
    bridge = first;
    try {
      await Promise.all([
        first.connect({ ...defaultSettings, adapterPort: 0 }, token),
        second.connect({ ...defaultSettings, adapterPort: 0 }, token),
      ]);
      expect(first.localPort).toBeTypeOf("number");
      expect(second.localPort).toBeTypeOf("number");
      expect(first.localPort).not.toBe(second.localPort);
      await ready(first, await plugin(first.localPort!));
      await ready(second, await plugin(second.localPort!));
      expect(first.phase).toBe("connected");
      expect(second.phase).toBe("connected");
    } finally {
      await second.disconnect();
    }
  });

  it("已配置端口被占用时明确失败，不另选端口误导已有适配器", async () => {
    const occupied = createServer();
    occupied.listen(0, "127.0.0.1");
    await once(occupied, "listening");
    const port = (occupied.address() as { port: number }).port;
    const instance = new MaiBotBridge();
    bridge = instance;
    const statuses: { phase: string; detail: string }[] = [];
    instance.on("status", (status) => statuses.push(status));
    try {
      await expect(
        instance.connect({ ...defaultSettings, adapterPort: port }, token),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(instance.phase).toBe("error");
      expect(instance.localPort).toBeUndefined();
      expect(statuses.at(-1)?.detail).toContain(String(port));
      expect(occupied.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  it("立即取消自动接入不会留下可导出的过期监听地址", async () => {
    const instance = new MaiBotBridge();
    bridge = instance;
    const connecting = instance.connect(
      { ...defaultSettings, adapterPort: 0 },
      token,
    );
    const disconnected = instance.disconnect();
    await Promise.all([connecting, disconnected]);
    expect(instance.phase).toBe("disconnected");
    expect(instance.localPort).toBeUndefined();
  });

  it("只有正式握手完成才连接；请求等 Host 回执，回复等持久化回执", async () => {
    const { instance, settings } = await setup();
    expect(instance.phase).toBe("connecting");
    const socket = await plugin(settings.adapterPort);
    expect(instance.phase).toBe("connecting");
    await ready(instance, socket);
    const incoming = once(socket, "message");
    let completed = false;
    const sent = instance.send("你好", undefined, "msg-1").then(() => {
      completed = true;
    });
    const [raw] = await incoming;
    expect(JSON.parse(raw.toString())).toMatchObject({
      type: "request",
      method: "chat",
      id: "msg-1",
    });
    expect(completed).toBe(false);
    socket.send(
      JSON.stringify({ v: 1, type: "result", id: "msg-1", ok: true }),
    );
    await sent;
    let ack: ((error?: Error) => void) | undefined;
    const replies: Reply[] = [];
    instance.on("reply", (reply, callback) => {
      replies.push(reply);
      ack = callback;
    });
    const replyEvent = once(instance, "reply");
    const frame = {
      v: 1,
      type: "reply",
      id: "reply-1",
      sessionId: "session-from-host",
      segments: [{ type: "text", text: "麦麦来了" }],
    };
    socket.send(JSON.stringify(frame));
    await replyEvent;
    const replyAck = once(socket, "message");
    ack!();
    expect(JSON.parse((await replyAck)[0].toString())).toMatchObject({
      type: "reply_ack",
      ok: true,
    });
    const duplicateAck = once(socket, "message");
    socket.send(JSON.stringify(frame));
    await duplicateAck;
    expect(replies).toHaveLength(1);
  });

  it("认证及协议版本错误显式拒绝，不影响已连接实例", async () => {
    const { instance, settings } = await setup();
    const bad = new WebSocket(`ws://127.0.0.1:${settings.adapterPort}/maibot`, {
      headers: { Authorization: "Bearer wrong" },
    });
    sockets.push(bad);
    await new Promise<void>((resolve) =>
      bad.once("error", (error) => {
        expect(error.message).toContain("401");
        resolve();
      }),
    );
    expect(instance.phase).toBe("connecting");
    const socket = new WebSocket(
      `ws://127.0.0.1:${settings.adapterPort}/maibot`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    sockets.push(socket);
    await once(socket, "open");
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ v: 2, type: "hello" }));
    expect((await closed)[0]).toBe(1008);
    expect(instance.phase).toBe("connecting");
  });

  it("新实例就绪后替换旧实例，断线的未确认请求不自动重发", async () => {
    const { instance, settings } = await setup();
    const first = await plugin(settings.adapterPort, 100);
    await ready(instance, first);
    const inbound = once(first, "message");
    const pending = instance.send("可能已接收", undefined, "uncertain");
    const rejected =
      expect(pending).rejects.toBeInstanceOf(DeliveryUnknownError);
    await inbound;
    const next = await plugin(settings.adapterPort, 200);
    const oldClosed = once(first, "close");
    await ready(instance, next);
    await rejected;
    expect((await oldClosed)[0]).toBe(1012);
    const lost = once(instance, "status");
    next.terminate();
    await lost;
    expect(instance.phase).toBe("reconnecting");
    await instance.disconnect();
    expect(instance.phase).toBe("disconnected");
    await instance.connect(settings, token);
    expect(instance.phase).toBe("connecting");
  });

  it("Host 拒绝与保存失败均返回失败，不伪造成功", async () => {
    const { instance, settings } = await setup();
    const socket = await plugin(settings.adapterPort);
    await ready(instance, socket);
    const incoming = once(socket, "message");
    const sent = instance.proactive("聊聊今天", "task-1");
    const rejected = expect(sent).rejects.toThrow("被策略拒绝");
    expect(JSON.parse((await incoming)[0].toString()).method).toBe("proactive");
    socket.send(
      JSON.stringify({
        v: 1,
        type: "result",
        id: "task-1",
        ok: false,
        error: { code: "rejected", message: "被策略拒绝" },
      }),
    );
    await rejected;
    instance.on("reply", (_reply, ack) => ack(new Error("磁盘失败")));
    const replyAck = once(socket, "message");
    socket.send(
      JSON.stringify({
        v: 1,
        type: "reply",
        id: "reply-fail",
        sessionId: "session-from-host",
        segments: [{ type: "text", text: "你好" }],
      }),
    );
    expect(JSON.parse((await replyAck)[0].toString()).ok).toBe(false);
  });
});

describe("已认证连接的内核名字", () => {
  const replyFrame = (id: string, metadata: Record<string, unknown> = {}) => ({
    v: 1,
    type: "reply",
    id,
    sessionId: "session-from-host",
    segments: [{ type: "text", text: "正常回复" }],
    ...metadata,
  });
  const acknowledgeReplies = (instance: MaiBotBridge) => {
    const replies: Reply[] = [];
    instance.on("reply", (reply, complete) => {
      replies.push(reply);
      complete();
    });
    return replies;
  };
  const sendReply = async (
    socket: WebSocket,
    id: string,
    metadata: Record<string, unknown> = {},
  ) => {
    const response = once(socket, "message");
    socket.send(JSON.stringify(replyFrame(id, metadata)));
    expect(JSON.parse((await response)[0].toString())).toMatchObject({
      type: "reply_ack",
      id,
      ok: true,
    });
  };

  it("ready 完成前没有名字，完成后读取真实名字；旧适配器无名仍连接", async () => {
    const { instance, settings } = await setup();
    expect(instance.botName).toBeNull();
    const first = await plugin(settings.adapterPort, 100);
    expect(instance.botName).toBeNull();
    await ready(instance, first, { botName: "  连接中的麦麦  " });
    expect(instance.botName).toBe("连接中的麦麦");
    const legacy = await plugin(settings.adapterPort, 200);
    // 一个尚未 ready 的连接不能清除当前已认证连接的名字。
    expect(instance.botName).toBe("连接中的麦麦");
    await ready(instance, legacy, {
      transport: "legacy",
      capabilities: ["chat", "image", "audio"],
    });
    expect(instance.phase).toBe("connected");
    expect(instance.botName).toBeNull();
  });

  it("有效回复更新名字并通知一次，无名旧回复保留当前名字", async () => {
    const { instance, settings } = await setup();
    const socket = await plugin(settings.adapterPort);
    await ready(instance, socket, { botName: "原名字" });
    const replies = acknowledgeReplies(instance);
    const names: string[] = [];
    instance.on("bot-name", (name) => names.push(name));
    await sendReply(socket, "new-name", { botName: "  新名字  " });
    expect(instance.botName).toBe("新名字");
    expect(names).toEqual(["新名字"]);
    await sendReply(socket, "same-name", { botName: "新名字" });
    await sendReply(socket, "old-format");
    expect(replies.map((reply) => reply.text)).toEqual([
      "正常回复",
      "正常回复",
      "正常回复",
    ]);
    expect(instance.botName).toBe("新名字");
    expect(names).toEqual(["新名字"]);
  });

  it("已经确认的旧回复重放不能把较新的名字回滚", async () => {
    const { instance, settings } = await setup();
    const socket = await plugin(settings.adapterPort);
    await ready(instance, socket);
    const replies = acknowledgeReplies(instance);
    const names: string[] = [];
    instance.on("bot-name", (name) => names.push(name));
    await sendReply(socket, "previous-reply", { botName: "旧名字" });
    await sendReply(socket, "current-reply", { botName: "新名字" });
    await sendReply(socket, "previous-reply", { botName: "旧名字" });
    expect(instance.botName).toBe("新名字");
    expect(replies).toHaveLength(2);
    expect(names).toEqual(["旧名字", "新名字"]);
  });

  it("同一回复仍在保存时的重复帧不能另行更新名字", async () => {
    const { instance, settings } = await setup();
    const socket = await plugin(settings.adapterPort);
    await ready(instance, socket);
    const names: string[] = [];
    instance.on("bot-name", (name) => names.push(name));
    const firstReply = once(instance, "reply");
    socket.send(
      JSON.stringify(replyFrame("pending-save", { botName: "首次名字" })),
    );
    const [, complete] = await firstReply;
    socket.send(
      JSON.stringify(replyFrame("pending-save", { botName: "重复帧名字" })),
    );
    // 同一真实 WS 的 pong 是有序读取第二个数据帧后的屏障。
    const processed = once(socket, "pong");
    socket.ping("metadata-dedup-barrier");
    await processed;
    expect(instance.botName).toBe("首次名字");
    expect(names).toEqual(["首次名字"]);
    const acknowledgments: unknown[] = [];
    const saved = new Promise<void>((resolve) => {
      socket.on("message", (raw) => {
        acknowledgments.push(JSON.parse(raw.toString()));
        if (acknowledgments.length === 2) resolve();
      });
    });
    complete();
    await saved;
    expect(acknowledgments).toEqual([
      { v: 1, type: "reply_ack", id: "pending-save", ok: true },
      { v: 1, type: "reply_ack", id: "pending-save", ok: true },
    ]);
  });

  it("无效 ready/reply 名字不阻止聊天，也不覆盖已有有效名字", async () => {
    const { instance, settings } = await setup();
    const socket = await plugin(settings.adapterPort);
    await ready(instance, socket, { botName: "无效\u0000名字" });
    expect(instance.botName).toBeNull();
    const replies = acknowledgeReplies(instance);
    await sendReply(socket, "initial-valid", { botName: "可信名字" });
    const names: string[] = [];
    instance.on("bot-name", (name) => names.push(name));
    const invalidNames = ["", "\t麦麦", "\u0085麦麦", "麦".repeat(41), 5, null];
    for (const [index, botName] of invalidNames.entries()) {
      await sendReply(socket, `invalid-${index}`, { botName });
      expect(instance.botName).toBe("可信名字");
      expect(instance.phase).toBe("connected");
    }
    expect(replies).toHaveLength(invalidNames.length + 1);
    expect(names).toEqual([]);
  });

  it("未 ready 的其他 peer 不能借回复元数据污染当前名字", async () => {
    const { instance, settings } = await setup();
    const first = await plugin(settings.adapterPort, 100);
    await ready(instance, first, { botName: "当前内核" });
    const pending = await plugin(settings.adapterPort, 200);
    const names: string[] = [];
    instance.on("bot-name", (name) => names.push(name));
    const closed = once(pending, "close");
    pending.send(
      JSON.stringify(replyFrame("not-ready", { botName: "伪造名字" })),
    );
    expect((await closed)[0]).toBe(1008);
    expect(instance.phase).toBe("connected");
    expect(instance.botName).toBe("当前内核");
    expect(names).toEqual([]);
  });

  it("实例切换后旧连接的迟到回调不能覆盖新内核名字", async () => {
    const { instance, settings } = await setup();
    const first = await plugin(settings.adapterPort, 100);
    await ready(instance, first, { botName: "旧内核" });
    // 保留真实服务端 WebSocket，重放它已经排队的 message 回调。
    // 这将到达 peer 检查，不依赖关闭帧与迟到数据包的时序。
    const server = Object.getOwnPropertyDescriptor(instance, "wss")!
      .value as WebSocketServer;
    const previousSocket = [...server.clients][0];
    const next = await plugin(settings.adapterPort, 200);
    const oldClosed = once(first, "close");
    await ready(instance, next, { botName: "新内核" });
    await oldClosed;
    const names: string[] = [];
    instance.on("bot-name", (name) => names.push(name));
    previousSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify(replyFrame("stale-peer", { botName: "迟到旧名" })),
      ),
    );
    expect(instance.botName).toBe("新内核");
    expect(names).toEqual([]);
  });

  it("错误 session 的名字不能被采用，协议错误断开后不残留旧名字", async () => {
    const { instance, settings } = await setup();
    const socket = await plugin(settings.adapterPort);
    await ready(instance, socket, { botName: "当前内核" });
    const names: string[] = [];
    instance.on("bot-name", (name) => names.push(name));
    const closed = once(socket, "close");
    socket.send(
      JSON.stringify(
        replyFrame("wrong-session", {
          sessionId: "someone-elses-session",
          botName: "其他内核",
        }),
      ),
    );
    expect((await closed)[0]).toBe(1008);
    expect(instance.botName).toBeNull();
    expect(names).toEqual([]);
  });

  it("断开和下一代接入立即清除名字，不把旧内核名传给新连接", async () => {
    const { instance, settings } = await setup();
    await ready(instance, await plugin(settings.adapterPort), {
      botName: "上一个内核",
    });
    const disconnected = instance.disconnect();
    expect(instance.botName).toBeNull();
    await disconnected;
    await instance.connect(settings, token);
    expect(instance.botName).toBeNull();
    await ready(instance, await plugin(settings.adapterPort));
    expect(instance.phase).toBe("connected");
    expect(instance.botName).toBeNull();
  });

  it("直接切换连接代次后，上一代排队回调不再有名字更新权限", async () => {
    const { instance, settings } = await setup();
    await ready(instance, await plugin(settings.adapterPort), {
      botName: "上一代",
    });
    const previousServer = Object.getOwnPropertyDescriptor(instance, "wss")!
      .value as WebSocketServer;
    const previousSocket = [...previousServer.clients][0];
    const connecting = instance.connect(settings, token);
    expect(instance.botName).toBeNull();
    await connecting;
    previousSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify(
          replyFrame("previous-generation", { botName: "过期名字" }),
        ),
      ),
    );
    expect(instance.phase).toBe("connecting");
    expect(instance.botName).toBeNull();
    await ready(instance, await plugin(settings.adapterPort), {
      botName: "新一代",
    });
    previousSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify(
          replyFrame("previous-generation-again", { botName: "过期名字" }),
        ),
      ),
    );
    expect(instance.botName).toBe("新一代");
  });

  it("本机 Upgrade 协商能力但保持原 welcome 帧兼容", async () => {
    const { instance, settings } = await setup();
    const socket = new WebSocket(
      `ws://127.0.0.1:${settings.adapterPort}/maibot`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    sockets.push(socket);
    const upgraded = once(socket, "upgrade");
    await once(socket, "open");
    const [response] = await upgraded;
    expect(response.headers["x-mai-desktop-features"]).toBe("bot-name");
    const welcome = once(socket, "message");
    socket.send(
      JSON.stringify({
        v: 1,
        type: "hello",
        protocol: "mai-desktop",
        pluginVersion: "0.2.0",
        instanceId: randomUUID(),
        startedAt: Date.now(),
        identity: identity(settings),
      }),
    );
    expect(JSON.parse((await welcome)[0].toString())).toEqual({
      v: 1,
      type: "welcome",
      userName: settings.userName,
    });
    await ready(instance, socket);
    expect(instance.phase).toBe("connected");
  });

  it("远程服务器通过 Upgrade 请求协商，认证后同样读取 ready 元数据", async () => {
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      path: "/desktop",
    });
    remoteServers.push(server);
    await once(server, "listening");
    const incoming = once(server, "connection");
    const instance = new MaiBotBridge();
    bridge = instance;
    const port = (server.address() as { port: number }).port;
    const settings = {
      ...defaultSettings,
      connectionMode: "server" as const,
      serverUrl: `ws://127.0.0.1:${port}/desktop`,
    };
    await instance.connect(settings, token);
    const [socket, request] = await incoming;
    sockets.push(socket);
    expect(request.headers["x-mai-desktop-features"]).toBe("bot-name");
    expect(request.headers.authorization).toBe(`Bearer ${token}`);
    const welcome = once(socket, "message");
    socket.send(
      JSON.stringify({
        v: 1,
        type: "hello",
        protocol: "mai-desktop",
        pluginVersion: "0.2.0",
        instanceId: randomUUID(),
        startedAt: Date.now(),
        identity: identity(settings),
      }),
    );
    expect(JSON.parse((await welcome)[0].toString())).toEqual({
      v: 1,
      type: "welcome",
      userName: settings.userName,
    });
    await ready(instance, socket, { botName: "服务器内核" });
    expect(instance.botName).toBe("服务器内核");
  });
});
