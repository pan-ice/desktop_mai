import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { MaiBotBridge } from "../electron/bridge";
import { messageAdapterConfig, type Reply } from "../electron/protocol";
import { defaultSettings } from "../shared/defaults";

const python = process.env.MAI_MESSAGE_ADAPTER_PYTHON || "python";
const token = "message-adapter-integration-" + "x".repeat(40);
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
let bridge: MaiBotBridge | undefined;
let child: ChildProcessWithoutNullStreams | undefined;
let directory: string | undefined;

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

afterEach(async () => {
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");
    child.stdin.end("STOP\n");
    const timeout = setTimeout(() => child?.kill(), 8000);
    try {
      await exited;
    } finally {
      clearTimeout(timeout);
    }
  }
  await bridge?.disconnect();
  if (directory) await rm(directory, { force: true, recursive: true });
});

describe("官方 maim_message 经典消息服务与桌宠", () => {
  it("真实认证、图文往返、收件人隔离、保存后 ID 回执及两端重连", async () => {
    const corePort = await freePort();
    const settings = {
      ...defaultSettings,
      adapterPort: await freePort(),
      adapterScope: "integration",
    };
    await mkdir(resolve(".cache/adapter-tests"), { recursive: true });
    directory = await mkdtemp(resolve(".cache/adapter-tests/message-"));
    const path = join(directory, "config.toml");
    await writeFile(
      path,
      messageAdapterConfig(settings, token)
        .replace("127.0.0.1:8000", `127.0.0.1:${corePort}`)
        .replace('token = ""', 'token = "actual-raw-core-token"'),
    );
    bridge = new MaiBotBridge();
    await bridge.connect(settings, token);
    const statuses: Record<string, any>[] = [];
    bridge.on("status", (status) => statuses.push(status));
    const events: Record<string, any>[] = [];
    let errors = "";
    child = spawn(python, [resolve("adapter/tests/sdk_fixture.py"), path], {
      windowsHide: true,
      stdio: "pipe",
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        MAIBOT_TOKEN: "actual-raw-core-token",
        MAI_DESKTOP_TOKEN: token,
      },
    });
    child.stderr.on("data", (data) => {
      errors += data.toString();
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        events.push(JSON.parse(line));
      } catch {
        /* SDK server startup logs */
      }
    });
    child.once("exit", () => lines.close());
    await expect
      .poll(() => bridge?.phase, { timeout: 12000, message: errors })
      .toBe("connected");
    expect(statuses.at(-1)).toMatchObject({
      transport: "legacy",
      capabilities: ["chat", "image", "audio"],
    });
    expect(statuses.at(-1)?.detail).not.toContain("会话已确认");
    await expect(bridge.proactive("主动任务")).rejects.toThrow(
      "不支持主动陪伴",
    );
    let save: (() => void) | undefined;
    const replies: Reply[] = [];
    bridge.on("reply", (reply, ack) => {
      replies.push(reply);
      save = ack;
    });
    await bridge.send(
      "一起看图",
      `data:image/png;base64,${PNG}`,
      "first-message",
    );
    await expect.poll(() => replies.length).toBe(1);
    const inbound = events.find((event) => event.event === "inbound")?.message;
    expect(inbound.message_info).toMatchObject({
      platform: "desktop_pet",
      user_info: { user_id: "desktop_owner", user_nickname: "你" },
      additional_config: {
        platform_io_account_id: "mai_desktop_pet",
        platform_io_scope: "integration",
        platform_io_target_user_id: "desktop_owner",
      },
    });
    expect(inbound.message_segment.data[1]).toEqual({
      type: "image",
      data: PNG,
    });
    expect(replies[0]).toMatchObject({
      text: "真实消息服务回复一起看图",
      attachments: [{ type: "image", dataUrl: `data:image/png;base64,${PNG}` }],
    });
    expect(events.filter((event) => event.event === "echo")).toHaveLength(0);
    save!();
    await expect
      .poll(() => events.find((event) => event.event === "echo")?.content)
      .toEqual({
        type: "echo",
        echo: "reply-first-message",
        actual_id: replies[0].id,
      });
    // 重启桌宠监听，适配器只恢复连接，不重放入站消息。
    await bridge.disconnect();
    await bridge.connect(settings, token);
    await expect
      .poll(() => bridge?.phase, { timeout: 10000 })
      .toBe("connected");
    expect(events.filter((event) => event.event === "inbound")).toHaveLength(1);
    // MaiBot 端断线时桌宠离线；官方库自行重连后重新完成握手。
    const start = statuses.length;
    child.stdin.write("DROP_CORE\n");
    await expect
      .poll(
        () =>
          statuses
            .slice(start)
            .some((status) => status.phase === "reconnecting"),
        { timeout: 10000 },
      )
      .toBe(true);
    await expect
      .poll(() => bridge?.phase, { timeout: 15000 })
      .toBe("connected");
    await bridge.send("重连后", undefined, "after-reconnect");
    await expect.poll(() => replies.length).toBe(2);
    save!();
    await expect
      .poll(() => events.filter((event) => event.event === "echo").length)
      .toBe(2);
    expect(events.filter((event) => event.event === "inbound")).toHaveLength(2);
    expect(errors).not.toContain("Traceback");
  });
});
