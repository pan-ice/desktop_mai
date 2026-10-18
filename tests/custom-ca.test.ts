import { afterEach, expect, it } from "vitest";
import { createServer, type Server } from "node:https";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { AccountClient } from "../electron/accounts";
import { MaiBotBridge } from "../electron/bridge";
import { defaultSettings } from "../shared/defaults";
import { TEST_CERTIFICATE, TEST_PRIVATE_KEY } from "./fixtures/self-signed-tls";

let server: Server | undefined;
let wss: WebSocketServer | undefined;
let bridge: MaiBotBridge | undefined;

afterEach(async () => {
  await bridge?.disconnect();
  for (const socket of wss?.clients ?? []) socket.terminate();
  if (wss) await new Promise<void>((resolve) => wss!.close(() => resolve()));
  if (server?.listening)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  wss = undefined;
  server = undefined;
  bridge = undefined;
});

it("导入自签名证书后账号与聊天链路都可连接真实 WSS 服务", async () => {
  server = createServer({ cert: TEST_CERTIFICATE, key: TEST_PRIVATE_KEY });
  wss = new WebSocketServer({ server });
  wss.on("connection", (socket, request) => {
    if (request.url === "/desktop") {
      socket.send(
        JSON.stringify({
          v: 1,
          type: "hello",
          protocol: "mai-desktop",
          pluginVersion: "1.0.0",
          instanceId: randomUUID(),
          startedAt: Date.now(),
          identity: {
            platform: "desktop_pet",
            accountId: "mai_desktop_pet",
            userId: "remote-user",
            scope: "",
          },
        }),
      );
    }
    socket.on("message", (raw) => {
      const call = JSON.parse(raw.toString());
      if (request.url === "/desktop" && call.type === "welcome") {
        socket.send(
          JSON.stringify({
            v: 1,
            type: "ready",
            sessionId: "tls-session",
            capabilities: ["chat", "image", "audio", "proactive"],
          }),
        );
        return;
      }
      socket.send(
        JSON.stringify({
          v: 1,
          id: call.id,
          ok: true,
          value: { accounts: [] },
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("测试服务未监听");
  const url = `wss://127.0.0.1:${address.port}/desktop`;
  const certificateAuthority = () => [TEST_CERTIFICATE];

  const client = new AccountClient(certificateAuthority);
  try {
    await expect(client.accounts(url, "device-a")).resolves.toEqual({
      accounts: [],
    });
    bridge = new MaiBotBridge(certificateAuthority);
    await bridge.connect(
      { ...defaultSettings, connectionMode: "server", serverUrl: url },
      "test-device-token-" + "x".repeat(32),
    );
    await expect.poll(() => bridge?.phase).toBe("connected");
  } finally {
    client.close();
  }
});

it("导入证书不会跳过服务器主机名校验", async () => {
  server = createServer({ cert: TEST_CERTIFICATE, key: TEST_PRIVATE_KEY });
  wss = new WebSocketServer({ server });
  server.listen(0, "0.0.0.0");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("测试服务未监听");
  const client = new AccountClient(() => [TEST_CERTIFICATE]);
  try {
    await expect(
      client.accounts(`wss://127.0.0.2:${address.port}/desktop`, "device-a"),
    ).rejects.toThrow("证书验证失败");
  } finally {
    client.close();
  }
});
