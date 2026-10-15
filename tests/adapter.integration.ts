import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MaiBotBridge } from "../electron/bridge";
import { adapterConfig, type Reply } from "../electron/protocol";
import { defaultSettings } from "../shared/defaults";

const pluginRoot = resolve("MaiBot/plugins/desktop_pet_adapter");
const python =
  process.env.MAI_PYTHON ||
  join(
    pluginRoot,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
const fixture = join(pluginRoot, "tests/host_fixture.py");
const token = "integration-test-token-0123456789abcdef";
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
let bridge: MaiBotBridge;
let directory: string;
const children: ChildProcessWithoutNullStreams[] = [];

async function stop(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.stdin.end("STOP\n");
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
afterEach(async () => {
  for (const child of children.splice(0)) await stop(child);
  await bridge?.disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("实际 Python 插件与桌宠桥接", () => {
  it("官方 SDK 图文与主动任务往返、持久化回执、插件卸载后重新连接", async () => {
    const portServer = createServer();
    portServer.listen(0, "127.0.0.1");
    await once(portServer, "listening");
    const port = (portServer.address() as { port: number }).port;
    await new Promise<void>((resolveClose) =>
      portServer.close(() => resolveClose()),
    );
    const base = resolve(".cache/adapter-tests");
    await mkdir(base, { recursive: true });
    directory = await mkdtemp(join(base, "sdk-"));
    const configPath = join(directory, "config.toml");
    const settings = { ...defaultSettings, adapterPort: port };
    await writeFile(configPath, adapterConfig(settings, token));
    bridge = new MaiBotBridge();
    await bridge.connect(settings, token);
    const events: Record<string, any>[] = [];
    let errors = "";
    const start = () => {
      const child = spawn(python, [fixture, configPath], {
        stdio: "pipe",
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: "1" },
      });
      children.push(child);
      child.stderr.on("data", (chunk) => {
        errors += chunk;
      });
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        const event = JSON.parse(line);
        events.push(event);
      });
      child.once("exit", () => lines.close());
      return child;
    };
    const connected = once(bridge, "status");
    const first = start();
    await connected;
    expect(bridge.phase, errors).toBe("connected");
    const replies: Reply[] = [];
    bridge.on("reply", (reply, ack) => {
      replies.push(reply);
      ack();
    });
    const incoming = once(bridge, "reply");
    await bridge.send(
      "一起看图",
      `data:image/png;base64,${PNG}`,
      "integration-1",
    );
    await incoming;
    await bridge.proactive("自然开启话题", "integration-intent");
    // Host 的出站调用要等桌宠保存回执，下一请求可作为顺序屏障。
    await bridge.send("第二次", undefined, "integration-2");
    const inbound = events.find((event) => event.event === "inbound");
    expect(inbound?.payload.message).toMatchObject({
      account_id: "mai_desktop_pet",
      scope: null,
      session_id: "fixture-session-issued-by-host",
      message_info: { additional_config: {} },
    });
    expect(inbound?.payload.message.raw_message[1].binary_data_base64).toBe(
      PNG,
    );
    expect(replies[0].attachments[0].dataUrl).toBe(
      `data:image/png;base64,${PNG}`,
    );
    expect(
      events.find((event) => event.event === "proactive")?.args,
    ).toMatchObject({
      stream_id: "fixture-session-issued-by-host",
      intent: "自然开启话题",
    });
    const receiptDeadline = Date.now() + 2000;
    while (
      !events.some((event) => event.event === "receipt") &&
      Date.now() < receiptDeadline
    )
      await new Promise((r) => setTimeout(r, 10));
    expect(
      events.find((event) => event.event === "receipt")?.receipt.success,
    ).toBe(true);
    await bridge.send("长回复测试", undefined, "long-reply");
    await expect
      .poll(
        () =>
          replies.find((reply) => reply.id === "reply-long-reply-0")?.text
            .length,
      )
      .toBe(12003);
    expect(
      replies.find((reply) => reply.id === "reply-long-reply-0")?.text ===
        "长😀".repeat(4001),
    ).toBe(true);
    await bridge.send("超量消息段测试", undefined, "too-many-segments");
    await expect
      .poll(
        () =>
          events.find((event) => event.request_id === "too-many-segments")
            ?.receipt.success,
      )
      .toBe(false);
    expect(bridge.phase).toBe("connected");
    await bridge.send("拒绝超量回复后仍可聊天", undefined, "after-rejection");
    await expect
      .poll(
        () =>
          replies.find((reply) => reply.id === "reply-after-rejection-0")?.text,
      )
      .toBe("你好呀！今天也想陪着你。");
    const disconnected = once(bridge, "status");
    await stop(first);
    await disconnected;
    expect(bridge.phase).toBe("reconnecting");
    const reconnected = once(bridge, "status");
    const second = start();
    await reconnected;
    expect(bridge.phase, errors).toBe("connected");
    await bridge.send("重新连接后", undefined, "integration-after-reload");
    await stop(second);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(errors).not.toContain("Traceback");
  });
});
