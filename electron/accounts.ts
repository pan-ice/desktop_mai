import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { z } from "zod";
import { serverUrlSchema } from "../shared/schemas";
import {
  deviceSchema,
  historyPageSchema,
  petAccountSchema,
} from "../shared/accounts";
import { MAX_FRAME } from "./protocol";

const proofSchema = z
  .object({
    loginId: z.string().min(16).max(100),
    secret: z.string().min(32).max(100),
    code: z.string().regex(/^[A-Z2-9]{10}$/),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type LoginProof = z.infer<typeof proofSchema>;

/** 账号 RPC 仅在主进程使用，登录密钥和设备凭证不会进入渲染器。 */
export class AccountClient {
  private sockets = new Set<WebSocket>();

  private call<T>(
    serverUrl: string,
    method: string,
    params: unknown,
    schema: z.ZodType<T>,
    token = "",
  ): Promise<T> {
    const url = new URL(serverUrlSchema.parse(serverUrl));
    url.pathname = "/account";
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        handshakeTimeout: 10000,
        maxPayload: MAX_FRAME,
        perMessageDeflate: false,
      });
      this.sockets.add(socket);
      let settled = false;
      const finish = (error?: Error, result?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.sockets.delete(socket);
        socket.close();
        if (error) reject(error);
        else resolve(result!);
      };
      const timer = setTimeout(() => {
        finish(new Error("账号服务请求超时，请检查服务器地址与连接"));
        socket.terminate();
      }, 15000);
      socket.on("open", () =>
        socket.send(JSON.stringify({ v: 1, id, method, params })),
      );
      socket.on("message", (raw) => {
        try {
          const envelope = z
            .object({
              v: z.literal(1),
              id: z.literal(id),
              ok: z.boolean(),
              value: z.unknown().optional(),
              error: z.string().max(500).optional(),
            })
            .strict()
            .parse(JSON.parse(raw.toString()));
          if (!envelope.ok)
            return finish(new Error(envelope.error || "账号操作失败"));
          finish(undefined, schema.parse(envelope.value));
        } catch {
          finish(new Error("账号服务协议不兼容，请更新服务器适配器"));
        }
      });
      socket.on("error", () =>
        finish(new Error("无法连接账号服务，请检查服务器地址和适配器版本")),
      );
      socket.on("close", () => finish(new Error("账号服务连接已关闭")));
    });
  }

  begin(server: string, deviceName: string) {
    return this.call(server, "login.begin", { deviceName }, proofSchema);
  }
  poll(server: string, proof: LoginProof) {
    return this.call(
      server,
      "login.poll",
      { loginId: proof.loginId, secret: proof.secret },
      z.discriminatedUnion("status", [
        z.object({ status: z.literal("pending") }).strict(),
        z.object({ status: z.literal("expired") }).strict(),
        z
          .object({
            status: z.literal("confirmed"),
            token: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
          })
          .strict(),
      ]),
    );
  }
  cancel(server: string, proof: LoginProof) {
    return this.call(
      server,
      "login.cancel",
      { loginId: proof.loginId, secret: proof.secret },
      z.object({}).strict(),
    );
  }
  accounts(server: string, token: string) {
    return this.call(
      server,
      "accounts.list",
      {},
      z.object({ accounts: z.array(petAccountSchema).max(16) }).strict(),
      token,
    );
  }
  create(server: string, token: string, name: string) {
    return this.call(
      server,
      "accounts.create",
      { name },
      petAccountSchema,
      token,
    );
  }
  devices(server: string, token: string) {
    return this.call(
      server,
      "devices.list",
      {},
      z.object({ devices: z.array(deviceSchema).max(32) }).strict(),
      token,
    );
  }
  revoke(server: string, token: string, deviceId: string) {
    return this.call(
      server,
      "devices.revoke",
      { deviceId },
      z.object({}).strict(),
      token,
    );
  }
  history(server: string, token: string, accountId: string, before?: number) {
    return this.call(
      server,
      "history.list",
      { accountId, ...(before ? { before } : {}) },
      historyPageSchema,
      token,
    );
  }
  clearHistory(server: string, token: string, accountId: string) {
    return this.call(
      server,
      "history.clear",
      { accountId },
      z.object({}).strict(),
      token,
    );
  }
  close() {
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
  }
}
