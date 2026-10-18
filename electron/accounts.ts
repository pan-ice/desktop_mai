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
import {
  isCertificateValidationError,
  type CertificateAuthorityProvider,
} from "./server-certificates";

const proofSchema = z
  .object({
    loginId: z.string().min(16).max(100),
    secret: z.string().min(32).max(100),
    code: z.string().regex(/^[A-Z2-9]{10}$/),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type LoginProof = z.infer<typeof proofSchema>;

const envelopeSchema = z
  .object({
    v: z.literal(1),
    id: z.string().min(1).max(100),
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: z.string().max(500).optional(),
  })
  .strict();
type Envelope = z.infer<typeof envelopeSchema>;
type Pending = {
  receive: (reply: Envelope) => void;
  reject: (error: Error) => void;
};
type AccountChannel = {
  key: string;
  socket: WebSocket;
  ready: Promise<void>;
  reusable: boolean;
  used: boolean;
  closed: boolean;
  idle: ReturnType<typeof setTimeout> | null;
  pending: Map<string, Pending>;
  fail: (error: Error) => void;
};

/** 账号 RPC 仅在主进程使用；同一服务器和设备凭证复用连接。 */
export class AccountClient {
  private channels = new Map<string, AccountChannel>();
  private sockets = new Set<AccountChannel>();
  private inflight = 0;
  private generation = 0;

  constructor(
    private readonly certificateAuthority: CertificateAuthorityProvider = () =>
      undefined,
  ) {}

  private connection(url: URL, token: string): AccountChannel {
    const key = `${url.href}\0${token}`;
    const existing = this.channels.get(key);
    if (
      existing &&
      !existing.closed &&
      existing.socket.readyState < WebSocket.CLOSING
    )
      return existing;
    if (this.sockets.size >= 32) throw new Error("账号连接过多，请稍后重试");
    const ca = this.certificateAuthority(url);
    const socket = new WebSocket(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      handshakeTimeout: 10000,
      maxPayload: MAX_FRAME,
      perMessageDeflate: false,
      ...(ca?.length ? { ca, rejectUnauthorized: true } : {}),
    });
    const channel: AccountChannel = {
      key,
      socket,
      ready: Promise.resolve(),
      reusable: false,
      used: false,
      closed: false,
      idle: null,
      pending: new Map(),
      fail: () => {},
    };
    this.channels.set(key, channel);
    this.sockets.add(channel);
    channel.ready = new Promise<void>((resolve, reject) => {
      channel.fail = (error) => {
        if (channel.closed) return;
        channel.closed = true;
        if (channel.idle) clearTimeout(channel.idle);
        if (this.channels.get(key) === channel) this.channels.delete(key);
        this.sockets.delete(channel);
        reject(error);
        for (const pending of [...channel.pending.values()])
          pending.reject(error);
        socket.terminate();
      };
      socket.on("upgrade", (response) => {
        channel.reusable = response.headers["x-mai-account-reuse"] === "1";
      });
      socket.on("open", resolve);
      socket.on("message", (raw) => {
        try {
          const envelope = envelopeSchema.parse(JSON.parse(raw.toString()));
          const pending = channel.pending.get(envelope.id);
          if (!pending) throw new Error("未知请求 ID");
          pending.receive(envelope);
        } catch {
          channel.fail(new Error("账号服务协议不兼容，请更新服务器适配器"));
        }
      });
      socket.on("error", (error) =>
        channel.fail(
          new Error(
            isCertificateValidationError(error)
              ? "WSS 证书验证失败，请导入该服务器的 CA 或自签名证书"
              : "无法连接账号服务，请检查服务器地址和适配器版本",
          ),
        ),
      );
      socket.on("close", () =>
        channel.fail(
          new Error("账号服务连接已关闭，已发送请求的结果未确认，请先检查记录"),
        ),
      );
    });
    return channel;
  }

  private release(channel: AccountChannel) {
    if (channel.closed || channel.pending.size) return;
    if (!channel.reusable) {
      channel.socket.close();
      return;
    }
    channel.idle = setTimeout(() => {
      if (this.channels.get(channel.key) === channel)
        this.channels.delete(channel.key);
      channel.socket.close();
    }, 20000);
    channel.idle.unref();
  }

  private async call<T>(
    serverUrl: string,
    method: string,
    params: unknown,
    schema: z.ZodType<T>,
    token = "",
  ): Promise<T> {
    const url = new URL(serverUrlSchema.parse(serverUrl));
    url.pathname = "/account";
    if (this.inflight >= 32) throw new Error("账号请求过多，请稍后重试");
    const generation = this.generation;
    const deadline = Date.now() + 15000;
    this.inflight++;
    try {
      let channel: AccountChannel;
      while (true) {
        if (generation !== this.generation) throw new Error("账号操作已取消");
        if (Date.now() >= deadline)
          throw new Error("账号服务请求超时，请检查服务器地址与连接");
        channel = this.connection(url, token);
        await channel.ready;
        if (generation !== this.generation) throw new Error("账号操作已取消");
        if (channel.closed || channel.socket.readyState !== WebSocket.OPEN)
          continue;
        if (!channel.reusable && channel.used) continue;
        channel.used = true;
        // 旧服务器一次只受理一个请求；尚未发送的并发调用各自取得下一条连接。
        if (!channel.reusable && this.channels.get(channel.key) === channel)
          this.channels.delete(channel.key);
        if (channel.idle) clearTimeout(channel.idle);
        channel.idle = null;
        break;
      }
      return await new Promise<T>((resolve, reject) => {
        const id = randomUUID();
        const finish = (error?: Error, result?: T) => {
          if (!channel.pending.delete(id)) return;
          clearTimeout(timer);
          this.release(channel);
          if (error) reject(error);
          else resolve(result!);
        };
        const timer = setTimeout(
          () => {
            // 已发出的创建/撤销/清空操作不自动重放；关闭连接并结束所有未确认请求。
            channel.fail(
              new Error("账号服务请求超时，操作结果未确认，请先检查记录"),
            );
          },
          Math.max(1, deadline - Date.now()),
        );
        channel.pending.set(id, {
          reject: (error) => finish(error),
          receive: (reply) => {
            if (!reply.ok)
              return finish(new Error(reply.error || "账号操作失败"));
            try {
              finish(undefined, schema.parse(reply.value));
            } catch {
              channel.fail(new Error("账号服务协议不兼容，请更新服务器适配器"));
            }
          },
        });
        try {
          channel.socket.send(
            JSON.stringify({ v: 1, id, method, params }),
            (error) => {
              if (error)
                channel.fail(new Error("账号请求发送失败，操作结果未确认"));
            },
          );
        } catch {
          channel.fail(new Error("账号请求发送失败，操作结果未确认"));
        }
      });
    } finally {
      this.inflight--;
    }
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
    this.generation++;
    for (const channel of [...this.sockets])
      channel.fail(new Error("账号操作已取消"));
    this.channels.clear();
  }
}
