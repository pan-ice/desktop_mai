import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { DeliveryUnknownError, MaiBotBridge } from "../electron/bridge";
import { identity, type Reply } from "../electron/protocol";
import { defaultSettings } from "../shared/defaults";

const token = "test-only-token-0123456789abcdefgh";
let bridge: MaiBotBridge | undefined;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await bridge?.disconnect();
  bridge = undefined;
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
async function ready(instance: MaiBotBridge, socket: WebSocket) {
  const connected = once(instance, "status");
  socket.send(
    JSON.stringify({
      v: 1,
      type: "ready",
      sessionId: "session-from-host",
      capabilities: ["chat", "image", "audio", "proactive"],
    }),
  );
  await connected;
}

describe("独立插件入口", () => {
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
