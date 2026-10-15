import { spawn, type ChildProcess } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { EventEmitter } from "node:events";

export class CoreProcess extends EventEmitter {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;

  constructor(private readonly hostPath: string) {
    super();
  }

  async start(root: string) {
    if (this.child || this.starting || this.stopping)
      throw new Error("本地内核正在启动、运行或关闭中");
    // 在第一个文件检查让出执行权前占用启动状态，避免并发调用覆盖进程引用。
    const starting = this.startChild(root);
    this.starting = starting;
    try {
      await starting;
    } finally {
      this.starting = null;
    }
  }

  private async startChild(root: string) {
    if (!root) throw new Error("请先选择 MaiBot 所在目录");
    const python = join(
      root,
      ".venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
    for (const file of [
      "bot.py",
      "config/bot_config.toml",
      "config/model_config.toml",
      "eula.confirmed",
      "privacy.confirmed",
    ]) {
      try {
        await access(join(root, file));
      } catch {
        throw new Error(
          `缺少 ${file}，请先按内核页的步骤在终端完成 MaiBot 初始化`,
        );
      }
    }
    try {
      await access(python);
    } catch {
      throw new Error("未找到 MaiBot 的 .venv，请先在 MaiBot 目录运行 uv sync");
    }
    for (const [document, confirmation] of [
      ["EULA.md", "eula.confirmed"],
      ["PRIVACY.md", "privacy.confirmed"],
    ]) {
      const content = (await readFile(join(root, document), "utf8")).replace(
        /\r\n/g,
        "\n",
      );
      const hash = createHash("md5").update(content).digest("hex");
      if ((await readFile(join(root, confirmation), "utf8")).trim() !== hash)
        throw new Error(
          `${document} 已更新，请先在终端启动 MaiBot 阅读并重新确认`,
        );
    }
    const child = spawn(python, ["-u", this.hostPath, root], {
      cwd: root,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUTF8: "1" },
    });
    this.child = child;
    child.stdin?.on("error", () => {
      /* 内核在受控关闭前退出时，控制管道可能先关闭。 */
    });
    const report = (data: Buffer) => {
      const lines = data
        .toString("utf8")
        .replace(/\x1b\[[0-9;]*m/g, "")
        .trim()
        .split(/\r?\n/);
      for (const line of lines.slice(-3)) {
        const clean = line
          .replace(
            /((?:api[_ -]?key|authorization|token|password)\s*[:=]\s*)\S+/gi,
            "$1[已隐藏]",
          )
          .replace(/sk-[A-Za-z0-9_-]+/g, "[已隐藏]");
        this.emit("log", clean.slice(0, 240));
      }
    };
    child.stdout?.on("data", report);
    child.stderr?.on("data", report);
    child.on("error", (error) => {
      if (this.child !== child) return;
      this.child = null;
      this.emit("status", {
        running: false,
        detail: `内核启动失败：${error.message}`,
      });
    });
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.emit("status", {
        running: false,
        detail: `内核已退出（${code ?? "已终止"}）`,
      });
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    this.emit("status", {
      running: true,
      pid: child.pid,
      detail: "本地内核进程已启动，等待消息服务就绪",
    });
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopChild().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  private async stopChild() {
    // 退出或停止可能发生在启动检查期间；失败由 start 的调用方报告。
    await this.starting?.catch(() => {});
    const child = this.child;
    if (!child) return;
    this.emit("status", {
      running: true,
      pid: child.pid,
      detail: "正在请求 MaiBot 正常关闭，请稍候…",
    });
    child.stdin?.write("STOP\n", () => {});
    const stopped = await new Promise<boolean>((resolve) => {
      if (child.exitCode !== null) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => {
        child.removeListener("exit", onExit);
        resolve(false);
      }, 65000);
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      child.once("exit", onExit);
    });
    if (!stopped && process.platform === "win32" && child.pid) {
      // 受控关闭超时后，只清理本应用创建的进程树。
      await new Promise<void>((resolve) => {
        const killer = spawn(
          "taskkill",
          ["/pid", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
        killer.once("error", () => {
          child.kill();
          resolve();
        });
        killer.once("exit", () => resolve());
      });
    } else if (!stopped) {
      child.kill("SIGKILL");
    }
    if (this.child === child) this.child = null;
    this.emit("status", { running: false, detail: "本地内核已停止" });
  }
}
