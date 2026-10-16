import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import WebSocket from "ws";
import { z } from "zod";
import { isLocalServerUrl } from "../shared/schemas";

const preparedSchema = z
  .object({
    serverUrl: z.string(),
    adapterChanged: z.boolean(),
    created: z.boolean(),
  })
  .strict();
export type LocalServerResult = z.infer<typeof preparedSchema>;

/** 只管理桌面端自己启动的本机中继，外部已运行的服务保持原有生命周期。 */
export class LocalServer extends EventEmitter {
  private child: ChildProcess | null = null;
  private serverUrl = "";
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly pythonOverride?: string) {
    super();
  }

  private queue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(action);
    this.pending = result.catch(() => {});
    return result;
  }

  ensure(root: string, serverUrl: string): Promise<LocalServerResult> {
    return this.queue(() => this.start(root, serverUrl));
  }

  stopUnless(serverUrl: string): Promise<void> {
    return this.queue(async () => {
      if (this.child && this.serverUrl !== serverUrl) await this.stopChild();
    });
  }

  stop(): Promise<void> {
    return this.queue(() => this.stopChild());
  }

  private async start(
    root: string,
    serverUrl: string,
  ): Promise<LocalServerResult> {
    if (!isLocalServerUrl(serverUrl))
      throw new Error("自动初始化仅用于本机 ws://127.0.0.1:端口/desktop 地址");
    if (this.child && this.serverUrl !== serverUrl) await this.stopChild();
    if (await this.available(serverUrl))
      return { serverUrl, adapterChanged: false, created: false };
    if (!root) throw new Error("请先在「本机测试」中自动准备桌宠连接");
    const plugin = join(root, "plugins/desktop_pet_adapter");
    const tool = join(plugin, "tools/server.py");
    try {
      await access(join(root, "bot.py"));
      await access(tool);
    } catch {
      throw new Error(
        "所选 MaiBot 目录缺少桌宠适配器，请先安装 0.4.0 或更新的插件",
      );
    }
    const executable =
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python";
    let python = this.pythonOverride || "";
    if (!python) {
      for (const candidate of [
        join(plugin, ".venv", executable),
        join(root, ".venv", executable),
      ]) {
        try {
          await access(candidate);
          python = candidate;
          break;
        } catch {
          /* 仅使用明确存在的本地 Python 环境。 */
        }
      }
    }
    if (!python)
      throw new Error(
        "未找到本机 Python 环境，请在 MaiBot 或桌宠适配器目录完成 uv sync",
      );
    const config = join(root, "data/desktop-server/server.json");
    const port = new URL(serverUrl).port || "80";
    this.emit("log", "正在自动准备本机中继配置…");
    const prepared = await this.prepare(python, tool, root, [
      "prepare-local",
      "--config",
      config,
      "--adapter-config",
      join(plugin, "config.toml"),
      "--port",
      port,
    ]);
    const child = spawn(
      python,
      ["-u", tool, "serve", "--config", config, "--managed"],
      {
        cwd: root,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONUTF8: "1" },
      },
    );
    this.child = child;
    this.serverUrl = prepared.serverUrl;
    child.stdin?.on("error", () => {
      /* 子进程退出时控制管道可能已关闭。 */
    });
    child.on("error", () => {
      this.emit("log", "本机中继进程异常，请检查 Python 环境后重新准备");
    });
    child.on("exit", () => {
      if (this.child !== child) return;
      this.child = null;
      this.serverUrl = "";
      this.emit("log", "本机中继已停止，账号和聊天记录已保留");
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let output = "";
        const timer = setTimeout(
          () => finish(new Error("本机中继启动超时，请检查插件依赖")),
          12000,
        );
        const finish = (error?: Error) => {
          clearTimeout(timer);
          child.stdout?.removeListener("data", onData);
          child.removeListener("exit", onExit);
          child.removeListener("error", onError);
          if (error) reject(error);
          else resolve();
        };
        const onData = (chunk: Buffer) => {
          output = (output + chunk.toString("utf8")).slice(-4096);
          if (output.includes("桌宠接入程序已启动：")) finish();
        };
        const onExit = () =>
          finish(new Error("本机中继未能启动，请检查端口占用和插件依赖"));
        const onError = () =>
          finish(new Error("无法启动本机中继，请检查 Python 环境"));
        child.stdout?.on("data", onData);
        child.once("exit", onExit);
        child.once("error", onError);
      });
      // 消费日志管道，避免后台服务因输出缓冲区满而阻塞；不转发凭证或用户消息。
      child.stdout?.resume();
      child.stderr?.resume();
      if (!(await this.available(prepared.serverUrl)))
        throw new Error("本机中继已启动，但账号服务未能连接");
      this.emit("log", "本机中继已就绪，退出桌宠时会自动停止");
      return prepared;
    } catch (error) {
      await this.stopChild();
      throw error;
    }
  }

  private async prepare(
    python: string,
    tool: string,
    root: string,
    args: string[],
  ): Promise<LocalServerResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(python, ["-u", tool, ...args], {
        cwd: root,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONUTF8: "1" },
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("本机中继初始化超时，请检查 Python 环境"));
      }, 15000);
      child.stdout?.on("data", (chunk) => {
        stdout = (stdout + chunk.toString("utf8")).slice(-8192);
      });
      child.stderr?.on("data", (chunk) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-2048);
      });
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("无法启动初始化程序，请检查 Python 环境"));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          // 仅显示初始化工具主动给出的安全错误，不把 Python 回溯或配置原文带到界面。
          const safe = stderr
            .split(/\r?\n/)
            .find((line) =>
              /^(此 MaiBot|已有中继|适配器令牌|操作失败|本机中继端口)/.test(
                line,
              ),
            );
          reject(new Error(safe || "本机中继初始化失败，请检查插件版本和依赖"));
          return;
        }
        try {
          resolve(preparedSchema.parse(JSON.parse(stdout)));
        } catch {
          reject(new Error("本机中继不支持自动初始化，请更新桌宠适配器"));
        }
      });
    });
  }

  private async available(serverUrl: string): Promise<boolean> {
    const url = new URL(serverUrl);
    url.pathname = "/account";
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, {
        handshakeTimeout: 2000,
        perMessageDeflate: false,
      });
      let settled = false;
      const finish = (result: boolean, error?: Error) => {
        if (settled) return;
        settled = true;
        socket.terminate();
        if (error) reject(error);
        else resolve(result);
      };
      socket.once("open", () => finish(true));
      socket.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED") finish(false);
        else
          finish(
            false,
            new Error("无法访问本机账号服务，请检查端口和本机网络权限"),
          );
      });
      socket.once("unexpected-response", (_, response) => {
        response.resume();
        finish(
          false,
          new Error(
            `本机端口未提供账号服务（HTTP ${response.statusCode}），请检查中继版本或端口占用`,
          ),
        );
      });
    });
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
        resolve();
        return;
      }
      const timer = setTimeout(() => child.kill(), 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin?.end("STOP\n");
    });
    if (this.child === child) this.child = null;
    this.serverUrl = "";
  }
}
