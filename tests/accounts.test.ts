import { afterEach, expect, it, vi } from "vitest";
import { once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import { AccountClient } from "../electron/accounts";

const client = new AccountClient();
const servers: WebSocketServer[] = [];
type Call = { id: string; method: string; params: Record<string, unknown> };

afterEach(async () => {
  vi.useRealTimers();
  client.close();
  for (const server of servers.splice(0)) {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function serve(
  handler: (socket: WebSocket, call: Call) => void,
  reuse = true,
  host = "127.0.0.1",
) {
  const server = new WebSocketServer({ host, port: 0 });
  servers.push(server);
  if (reuse)
    server.on("headers", (headers) => headers.push("X-Mai-Account-Reuse: 1"));
  let connections = 0;
  const authorization: string[] = [];
  server.on("connection", (socket, request) => {
    connections++;
    authorization.push(request.headers.authorization || "");
    socket.on("message", (raw) => handler(socket, JSON.parse(raw.toString())));
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("测试服务未监听");
  return {
    url: `ws://${host}:${address.port}/desktop`,
    connections: () => connections,
    authorization,
  };
}

it("非白名单主机也可通过明文 ws 完成账号请求", async () => {
  const server = await serve(
    (socket, call) => reply(socket, call, { accounts: [] }),
    true,
    "127.0.0.2",
  );
  await expect(client.accounts(server.url, "device-a")).resolves.toEqual({
    accounts: [],
  });
});

function reply(socket: WebSocket, call: Call, value: unknown) {
  socket.send(JSON.stringify({ v: 1, id: call.id, ok: true, value }));
}

it("同一服务器和设备并发、连续操作复用一次握手，乱序响应按请求 ID 匹配", async () => {
  const pending: Array<[WebSocket, Call]> = [];
  const server = await serve((socket, call) => {
    pending.push([socket, call]);
    if (pending.length === 2) {
      for (const [peer, request] of pending.splice(0).reverse()) {
        reply(
          peer,
          request,
          request.method === "devices.list"
            ? { devices: [] }
            : { accounts: [] },
        );
      }
    }
  });
  const [accounts, devices] = await Promise.all([
    client.accounts(server.url, "device-a"),
    client.devices(server.url, "device-a"),
  ]);
  expect(accounts).toEqual({ accounts: [] });
  expect(devices).toEqual({ devices: [] });
  await Promise.all([
    client.accounts(server.url, "device-a"),
    client.devices(server.url, "device-a"),
  ]);
  expect(server.connections()).toBe(1);
});

it("不同设备凭证分别认证，复用连接不会串用身份", async () => {
  const server = await serve((socket, call) =>
    reply(socket, call, { accounts: [] }),
  );
  await client.accounts(server.url, "device-a");
  await client.accounts(server.url, "device-b");
  await client.accounts(server.url, "device-a");
  expect(server.authorization).toEqual(["Bearer device-a", "Bearer device-b"]);
});

it("旧中继未声明复用能力时，每个请求仍使用独立连接", async () => {
  const server = await serve((socket, call) => {
    reply(socket, call, { accounts: [] });
    socket.close();
  }, false);
  const results = await Promise.all([
    client.accounts(server.url, "device-a"),
    client.accounts(server.url, "device-a"),
  ]);
  expect(results).toEqual([{ accounts: [] }, { accounts: [] }]);
  expect(server.connections()).toBe(2);
});

it("创建操作断线后返回未确认，下次读取重新连接且不会重发创建", async () => {
  let creates = 0;
  const server = await serve((socket, call) => {
    if (call.method === "accounts.create") {
      creates++;
      socket.terminate();
    } else reply(socket, call, { accounts: [] });
  });
  await expect(client.create(server.url, "device-a", "小麦")).rejects.toThrow();
  await expect(client.accounts(server.url, "device-a")).resolves.toEqual({
    accounts: [],
  });
  expect(creates).toBe(1);
  expect(server.connections()).toBe(2);
});

it("账号操作被拒绝后，同连接可继续处理下一次请求", async () => {
  let calls = 0;
  const server = await serve((socket, call) => {
    if (++calls === 1)
      socket.send(
        JSON.stringify({ v: 1, id: call.id, ok: false, error: "已撤销" }),
      );
    else reply(socket, call, { accounts: [] });
  });
  await expect(client.accounts(server.url, "device-a")).rejects.toThrow(
    "已撤销",
  );
  await expect(client.accounts(server.url, "device-a")).resolves.toEqual({
    accounts: [],
  });
  expect(server.connections()).toBe(1);
});

it("超时结束未确认的请求，不重放写操作，下一次请求可重新连接", async () => {
  let creates = 0;
  let received!: () => void;
  const requestSeen = new Promise<void>((resolve) => {
    received = resolve;
  });
  const server = await serve((socket, call) => {
    if (call.method === "accounts.create") {
      creates++;
      received();
    } else reply(socket, call, { accounts: [] });
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const rejected = expect(
    client.create(server.url, "device-a", "小麦"),
  ).rejects.toThrow("未确认");
  await requestSeen;
  await vi.advanceTimersByTimeAsync(15001);
  await rejected;
  vi.useRealTimers();
  await expect(client.accounts(server.url, "device-a")).resolves.toEqual({
    accounts: [],
  });
  expect(creates).toBe(1);
  expect(server.connections()).toBe(2);
});

it("关闭客户端会结束未完成请求，之后可重新创建连接", async () => {
  let respond = false;
  let received!: () => void;
  const requestSeen = new Promise<void>((resolve) => {
    received = resolve;
  });
  const server = await serve((socket, call) => {
    if (respond) reply(socket, call, { accounts: [] });
    else received();
  });
  const rejected = expect(
    client.accounts(server.url, "device-a"),
  ).rejects.toThrow("取消");
  await requestSeen;
  client.close();
  await rejected;
  respond = true;
  await expect(client.accounts(server.url, "device-a")).resolves.toEqual({
    accounts: [],
  });
  expect(server.connections()).toBe(2);
});

it("空闲连接会释放，下次操作再按需连接", async () => {
  const server = await serve((socket, call) =>
    reply(socket, call, { accounts: [] }),
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  await client.accounts(server.url, "device-a");
  await vi.advanceTimersByTimeAsync(20001);
  vi.useRealTimers();
  await client.accounts(server.url, "device-a");
  expect(server.connections()).toBe(2);
});
