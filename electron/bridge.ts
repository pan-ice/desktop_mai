import { MEDIA_SAVE_TIMEOUT } from "../shared/media-limits";
import { EventEmitter } from "node:events";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import type { ConnectionPhase, Settings } from "../shared/types";
import { serverUrlSchema } from "../shared/schemas";
import {
  isCertificateValidationError,
  type CertificateAuthorityProvider,
} from "./server-certificates";
import {
  buildRequest,
  identity,
  MAX_FRAME,
  MAX_REPLY_FRAME,
  parseReply,
  pluginFrameSchema,
  REQUIRED_CAPABILITIES,
  type Reply,
} from "./protocol";

interface Peer {
  socket: WebSocket;
  timer: ReturnType<typeof setTimeout> | null;
  instanceId: string;
  startedAt: number;
  sessionId: string;
  userId?: string;
  generation: number;
  alive: boolean;
  capabilities: string[];
  transport: "gateway" | "legacy";
  botName: string | null;
}
interface Pending {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class DeliveryUnknownError extends Error {}

/** 本机适配器入口。认证、能力及通道握手完成后才允许请求。 */
export class MaiBotBridge extends EventEmitter {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private active: Peer | null = null;
  private peers = new Set<Peer>();
  private pending = new Map<string, Pending>();
  private acceptedReplies = new Set<string>();
  private savingReplies = new Map<string, Promise<void>>();
  private saveWaiters = new Set<(error?: Error) => void>();
  private settings: Settings | null = null;
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();
  private remoteSocket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private remoteFatalGeneration = -1;
  private remoteAttempts = 0;
  phase: ConnectionPhase = "disconnected";

  get botName(): string | null {
    return this.phase === "connected" &&
      this.active?.generation === this.generation
      ? this.active.botName
      : null;
  }

  get localPort(): number | undefined {
    if (!this.server?.listening) return;
    const address = this.server.address();
    return address && typeof address !== "string" ? address.port : undefined;
  }

  constructor(
    private readonly certificateAuthority: CertificateAuthorityProvider = () =>
      undefined,
  ) {
    super();
  }

  private status(phase: ConnectionPhase, detail: string) {
    this.phase = phase;
    this.emit("status", {
      phase,
      detail,
      since: Date.now(),
      ...(this.active
        ? {
            sessionId: this.active.sessionId,
            protocol: 1,
            userId: this.active.userId,
            capabilities: this.active.capabilities,
            transport: this.active.transport,
          }
        : {}),
    });
  }

  supports(capability: string): boolean {
    return (
      this.phase === "connected" &&
      Boolean(this.active?.capabilities.includes(capability))
    );
  }

  connect(settings: Settings, token: string): Promise<void> {
    const generation = ++this.generation;
    const task = this.tail
      .catch(() => {})
      .then(async () => {
        await this.close();
        if (generation !== this.generation) return;
        if (!/^[A-Za-z0-9_\-]{32,256}$/.test(token))
          throw new Error("请先生成桌宠的独立连接令牌");
        this.settings = { ...settings };
        if (settings.connectionMode === "server") {
          const url = serverUrlSchema.parse(settings.serverUrl);
          this.remoteAttempts = 0;
          this.openRemote(url, token, generation);
          return;
        }
        this.status("connecting", "正在开启本机适配器接入…");
        const server = createServer((_request, response) => {
          response.writeHead(404).end();
        });
        const wss = new WebSocketServer({
          noServer: true,
          maxPayload: MAX_REPLY_FRAME,
          perMessageDeflate: false,
        });
        wss.on("headers", (headers) => {
          headers.push("X-Mai-Desktop-Features: bot-name");
        });
        this.server = server;
        this.wss = wss;
        const expected = createHash("sha256")
          .update(`Bearer ${token}`)
          .digest();
        server.on("upgrade", (request, socket, head) => {
          const supplied = createHash("sha256")
            .update(request.headers.authorization || "")
            .digest();
          if (
            request.url !== "/maibot" ||
            request.headers.origin ||
            !timingSafeEqual(expected, supplied) ||
            wss.clients.size >= 4
          ) {
            socket.end(
              "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
            );
            this.emit(
              "diagnostic",
              "插件握手被拒绝，请检查独立令牌、地址或浏览器来源",
            );
            return;
          }
          wss.handleUpgrade(request, socket, head, (client) =>
            this.attach(client, generation),
          );
        });
        try {
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(settings.adapterPort, "127.0.0.1", () => {
              server.off("error", reject);
              resolve();
            });
          });
        } catch (error) {
          await this.close();
          this.status(
            "error",
            settings.adapterPort
              ? `本机端口 ${settings.adapterPort} 无法使用。请释放该端口，或重新自动分配并导出适配器配置。`
              : "无法自动分配本机接入端口，请检查系统网络权限后重试",
          );
          throw error;
        }
        server.on("error", () =>
          this.status("error", "本机插件服务发生错误，请重新开启接入"),
        );
        if (generation !== this.generation) {
          await this.close();
          return;
        }
        this.heartbeat = setInterval(() => {
          for (const peer of this.peers) {
            if (!peer.alive) peer.socket.terminate();
            else {
              peer.alive = false;
              peer.socket.ping();
            }
          }
        }, 20000);
        this.status(
          "connecting",
          `接入已开启（127.0.0.1:${this.localPort}），等待 MaiBot 适配器`,
        );
      });
    this.tail = task;
    return task;
  }

  private openRemote(url: string, token: string, generation: number) {
    if (generation !== this.generation) return;
    this.status(
      this.remoteAttempts ? "reconnecting" : "connecting",
      "正在连接 MaiBot 服务器…",
    );
    const parsedUrl = new URL(url);
    const ca = this.certificateAuthority(parsedUrl);
    const socket = new WebSocket(parsedUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Mai-Desktop-Features": "bot-name",
        ...(this.settings?.serverAccountId
          ? { "X-Mai-Account": this.settings.serverAccountId }
          : {}),
      },
      handshakeTimeout: 8000,
      maxPayload: MAX_REPLY_FRAME,
      perMessageDeflate: false,
      followRedirects: false,
      ...(ca?.length ? { ca, rejectUnauthorized: true } : {}),
    });
    this.remoteSocket = socket;
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      if ([401, 403].includes(response.statusCode || 0)) {
        this.remoteFatalGeneration = generation;
        this.status(
          "error",
          "服务器拒绝设备凭证，请通过 QQ 重新登录，或重新导入管理员凭证",
        );
      }
      socket.terminate();
    });
    this.attach(socket, generation, { url, token });
  }

  private attach(
    socket: WebSocket,
    generation: number,
    remote?: { url: string; token: string },
  ) {
    const peer: Peer = {
      socket,
      timer: null,
      instanceId: "",
      startedAt: 0,
      sessionId: "",
      alive: true,
      generation,
      capabilities: [],
      transport: "gateway",
      botName: null,
    };
    this.peers.add(peer);
    peer.timer = setTimeout(
      () => socket.close(1008, "handshake timeout"),
      10000,
    );
    socket.on("pong", () => {
      peer.alive = true;
    });
    socket.on("error", (error) => {
      if (remote && isCertificateValidationError(error)) {
        this.remoteFatalGeneration = generation;
        this.status(
          "error",
          "WSS 证书验证失败，请在连接与账号中导入该服务器的 CA 或自签名证书",
        );
      }
    });
    socket.on("message", (raw) => {
      if (generation !== this.generation || !this.settings) return;
      try {
        const parsed = pluginFrameSchema.safeParse(JSON.parse(raw.toString()));
        if (!parsed.success)
          throw new Error("插件协议不兼容，请同步更新桌宠与适配器");
        const frame = parsed.data;
        if (!peer.instanceId) {
          if (
            frame.type !== "hello" ||
            (!remote &&
              JSON.stringify(frame.identity) !==
                JSON.stringify(identity(this.settings)))
          )
            throw new Error("插件身份不一致，请重新导出配置");
          if (this.active && frame.startedAt <= this.active.startedAt)
            throw new Error("旧插件实例仍在运行，等待新实例完成切换");
          peer.instanceId = frame.instanceId;
          peer.startedAt = frame.startedAt;
          peer.userId = frame.identity.userId;
          if (
            remote &&
            this.settings.serverAccountId &&
            peer.userId !== this.settings.serverAccountId
          )
            throw new Error("服务器返回了其他桌宠账号");
          this.write(socket, {
            v: 1,
            type: "welcome",
            userName: this.settings.userName,
          });
          return;
        }
        if (!peer.sessionId) {
          if (
            frame.type !== "ready" ||
            (frame.transport === "legacy"
              ? ["chat", "image", "audio"]
              : REQUIRED_CAPABILITIES
            ).some((capability) => !frame.capabilities.includes(capability))
          )
            throw new Error("适配器未提供所需能力或有效通道");
          if (this.active && peer.startedAt <= this.active.startedAt)
            throw new Error("插件实例已过期");
          if (peer.timer) clearTimeout(peer.timer);
          peer.timer = null;
          const old = this.active;
          peer.sessionId = frame.sessionId;
          peer.capabilities = frame.capabilities;
          peer.transport = frame.transport ?? "gateway";
          peer.botName = frame.botName ?? null;
          this.active = peer;
          this.remoteAttempts = 0;
          this.rejectPending("插件实例已切换，之前请求的内核接收状态未确认");
          old?.socket.close(1012, "plugin replaced");
          this.status(
            "connected",
            remote
              ? this.settings.serverAccountId
                ? "服务器已连接 · 桌宠账号已确认"
                : `服务器已连接 · 用户 ${peer.userId} · 会话已确认`
              : peer.transport === "legacy"
                ? "MaiBot 消息服务已连接"
                : "MaiBot 插件已连接 · 协议 v1 · 会话已确认",
          );
          return;
        }
        if (peer !== this.active) return;
        if (frame.type === "result") {
          const pending = this.pending.get(frame.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(frame.id);
          if (frame.ok) pending.resolve();
          else {
            const message = frame.error?.message || "插件拒绝了请求";
            pending.reject(
              frame.error?.code === "delivery_unknown"
                ? new DeliveryUnknownError(message)
                : new Error(message),
            );
          }
        } else if (remote && frame.type === "history") {
          this.emit("history", frame.messages);
        } else if (remote && frame.type === "history_clear") {
          this.emit("history_clear");
        } else if (frame.type === "reply") {
          if (frame.sessionId !== peer.sessionId)
            throw new Error("插件返回了其他会话的消息");
          void this.receive(
            peer,
            frame.id,
            parseReply(frame),
            frame.botName,
          ).catch(() => {});
        } else throw new Error("插件发送了顺序错误的握手消息");
      } catch (error) {
        const message =
          error instanceof SyntaxError
            ? "插件返回了无效 JSON"
            : error instanceof Error
              ? error.message
              : "插件协议错误";
        this.emit("diagnostic", message);
        socket.close(1008, "invalid protocol or identity");
      }
    });
    socket.on("close", (code) => {
      if (peer.timer) clearTimeout(peer.timer);
      this.peers.delete(peer);
      if (remote) {
        if (this.remoteSocket !== socket || generation !== this.generation)
          return;
        this.remoteSocket = null;
        this.active = null;
        this.rejectPending("服务器连接中断，内核是否接收未确认，请先检查记录");
        if (this.remoteFatalGeneration === generation) return;
        if ([4001, 4003, 1008].includes(code)) {
          this.remoteFatalGeneration = generation;
          this.status(
            "error",
            code === 4001
              ? "该账号已在其他桌宠连接，本机已断开"
              : "接入凭证已失效或协议被拒绝，请联系管理员",
          );
          return;
        }
        this.status("reconnecting", "服务器连接已断开，正在等待自动重连…");
        const delay = Math.min(1000 * 2 ** this.remoteAttempts++, 30000);
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.openRemote(remote.url, remote.token, generation);
        }, delay);
        return;
      }
      if (peer !== this.active) return;
      this.active = null;
      this.rejectPending("插件连接中断，内核是否接收未确认，请先检查记录");
      if (generation === this.generation)
        this.status("reconnecting", "MaiBot 适配器已断开，等待适配器自动重连…");
    });
  }

  private async receive(
    peer: Peer,
    id: string,
    reply: Reply,
    botName?: string,
  ) {
    const key = `${peer.generation}:${peer.sessionId}:${id}`;
    try {
      if (!this.acceptedReplies.has(key)) {
        let saving = this.savingReplies.get(key);
        if (!saving) {
          if (this.savingReplies.size >= 64) throw new Error("待保存回复过多");
          if (botName && botName !== peer.botName) {
            peer.botName = botName;
            this.emit("bot-name", botName);
          }
          // ack 回调由主进程在媒体及历史持久化完成后触发。
          saving = new Promise<void>((resolve, reject) => {
            const complete = (error?: Error) => {
              clearTimeout(timer);
              this.saveWaiters.delete(complete);
              error ? reject(error) : resolve();
            };
            const timer = setTimeout(
              () => complete(new Error("保存回复超时")),
              MEDIA_SAVE_TIMEOUT,
            );
            this.saveWaiters.add(complete);
            this.emit("reply", reply, complete);
          });
          this.savingReplies.set(key, saving);
        }
        await saving;
        this.acceptedReplies.add(key);
        if (this.acceptedReplies.size > 2000)
          this.acceptedReplies.delete(
            this.acceptedReplies.values().next().value!,
          );
      }
      this.write(peer.socket, { v: 1, type: "reply_ack", id, ok: true });
    } catch {
      this.emit("diagnostic", "内核回复未保存，已向插件报告投递失败");
      this.write(peer.socket, { v: 1, type: "reply_ack", id, ok: false });
    } finally {
      this.savingReplies.delete(key);
    }
  }

  private write(socket: WebSocket, frame: unknown) {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(frame), () => {});
  }

  send(
    text: string,
    image?: string,
    id: string = randomUUID(),
    source?: string,
  ): Promise<void> {
    return this.request("chat", text, image, id, source);
  }
  proactive(intent: string, id: string = randomUUID()): Promise<void> {
    if (!this.supports("proactive"))
      return Promise.reject(new Error("当前适配器不支持主动陪伴任务"));
    return this.request("proactive", intent, undefined, id);
  }

  private request(
    method: "chat" | "proactive",
    text: string,
    image: string | undefined,
    id: string,
    source?: string,
  ): Promise<void> {
    const socket = this.active?.socket;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      this.phase !== "connected"
    )
      return Promise.reject(new Error("请先连接 MaiBot 桌宠适配器"));
    if (this.pending.size >= 32 || this.pending.has(id))
      return Promise.reject(new Error("请求过多或请求 ID 重复"));
    const payload = JSON.stringify(
      buildRequest(method, text, image, id, source),
    );
    if (Buffer.byteLength(payload) > MAX_FRAME)
      return Promise.reject(new Error("消息超过协议上限"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DeliveryUnknownError("内核接收回执超时，请先检查聊天记录"));
      }, 25000);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(payload, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new DeliveryUnknownError("发送中断，内核接收状态未确认"));
      });
    });
  }

  private rejectPending(message: string) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new DeliveryUnknownError(message));
    }
    this.pending.clear();
  }

  private async close() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.remoteSocket = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.active = null;
    this.rejectPending("接入已关闭，未完成请求的内核接收状态未确认");
    for (const complete of this.saveWaiters) complete(new Error("接入已关闭"));
    for (const peer of this.peers) {
      if (peer.timer) clearTimeout(peer.timer);
      peer.socket.terminate();
    }
    this.peers.clear();
    const wss = this.wss;
    const server = this.server;
    this.wss = null;
    this.server = null;
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()));
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  disconnect(notify = true): Promise<void> {
    ++this.generation;
    this.rejectPending("已断开连接，内核接收状态未确认");
    if (notify) this.status("disconnected", "MaiBot 接入已关闭");
    const task = this.tail.catch(() => {}).then(() => this.close());
    this.tail = task;
    return task;
  }
}
