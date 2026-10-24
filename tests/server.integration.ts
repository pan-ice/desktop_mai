import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { MaiBotBridge } from "../electron/bridge";
import type { Reply } from "../electron/protocol";
import { defaultSettings } from "../shared/defaults";

const plugin = resolve(
  process.env.MAI_DESKTOP_ADAPTER_ROOT || "MaiBot/plugins/desktop_pet_adapter",
);
const python =
  process.env.MAI_PYTHON ||
  join(
    plugin,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
const tokens = {
  alice: "a".repeat(40),
  bob: "b".repeat(40),
  adapter: "internal-adapter-test-" + "x".repeat(40),
};
const bridges: MaiBotBridge[] = [];
let child: ChildProcessWithoutNullStreams | undefined;
let directory = "";

async function port() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const value = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return value;
}

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.disconnect();
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");
    child.stdin.end("STOP\n");
    const timer = setTimeout(() => child?.kill(), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
  child = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("多人服务器与实际桌宠连接", () => {
  it("两份客户端共享适配器，图文、主动任务、回复、重连和认证相互隔离", async () => {
    const serverPort = await port();
    await mkdir(resolve(".cache/adapter-tests"), { recursive: true });
    directory = await mkdtemp(resolve(".cache/adapter-tests/server-"));
    const configPath = join(directory, "adapter.toml");
    const relayPath = join(directory, "server.json");
    await writeFile(
      configPath,
      `[plugin]\nconfig_version = "1.1.0"\nmode = "server"\n[server]\nrelay_url = "ws://127.0.0.1:${serverPort}/adapter"\ntoken = "${tokens.adapter}"\n[identity]\nplatform = "desktop_pet"\naccount_id = "mai_desktop_pet"\nuser_id = "server"\nscope = ""\n`,
    );
    const digest = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    await writeFile(
      relayPath,
      JSON.stringify({
        port: serverPort,
        backend_token_sha256: digest(tokens.adapter),
        users: ["alice", "bob"].map((id) => ({
          id,
          name: id,
          token_sha256: digest(tokens[id as "alice" | "bob"]),
        })),
      }),
    );
    const events: Record<string, any>[] = [];
    let errors = "";
    child = spawn(
      python,
      [join(plugin, "tests/host_fixture.py"), configPath, relayPath],
      {
        stdio: "pipe",
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: "1" },
      },
    );
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => events.push(JSON.parse(line)));
    child.once("exit", () => lines.close());
    await expect
      .poll(
        () => {
          if (child?.exitCode !== null)
            throw new Error(errors || "Python fixture exited");
          return events.some((event) => event.event === "started");
        },
        { timeout: 5000, message: "多人服务器测试进程应启动" },
      )
      .toBe(true);

    const settings = {
      ...defaultSettings,
      connectionMode: "server" as const,
      serverUrl: `ws://127.0.0.1:${serverPort}/desktop`,
    };
    const alice = new MaiBotBridge();
    const bob = new MaiBotBridge();
    const bad = new MaiBotBridge();
    bridges.push(alice, bob, bad);
    const repliesA: Reply[] = [];
    const repliesB: Reply[] = [];
    alice.on("reply", (reply, ack) => {
      repliesA.push(reply);
      ack();
    });
    bob.on("reply", (reply, ack) => {
      repliesB.push(reply);
      ack();
    });
    await Promise.all([
      alice.connect(settings, tokens.alice),
      bob.connect(settings, tokens.bob),
    ]);
    await expect
      .poll(() => [alice.phase, bob.phase], { timeout: 5000 })
      .toEqual(["connected", "connected"]);
    // 客户端默认身份相同，服务器仍为两个凭证分配不同的内核会话。
    await Promise.all([
      alice.send("Alice 的消息", undefined, "same-id"),
      bob.send("Bob 的消息", undefined, "same-id"),
    ]);
    await expect.poll(() => [repliesA.length, repliesB.length]).toEqual([1, 1]);
    const messages = events.filter((event) => event.event === "inbound");
    expect(
      messages.map((event) => event.payload.message.session_id).sort(),
    ).toEqual(["fixture-session-alice", "fixture-session-bob"]);
    expect(messages.map((event) => event.payload.dedupe_key).sort()).toEqual([
      "alice:same-id",
      "bob:same-id",
    ]);
    await alice.proactive("主动陪伴只属于 Alice", "intent-a");
    await expect
      .poll(
        () =>
          events.find((event) => event.event === "proactive")?.args.stream_id,
      )
      .toBe("fixture-session-alice");

    await bad.connect(settings, "invalid-but-well-formed-" + "z".repeat(32));
    await expect.poll(() => bad.phase).toBe("error");
    expect([alice.phase, bob.phase]).toEqual(["connected", "connected"]);

    await alice.disconnect();
    await bob.send("Alice 下线后仍能聊天", undefined, "bob-only");
    await expect.poll(() => repliesB.at(-1)?.id).toBe("reply-bob-only-0");
    expect(repliesA.some((reply) => reply.id === "reply-bob-only-0")).toBe(
      false,
    );
    await alice.connect(settings, tokens.alice);
    await expect.poll(() => alice.phase).toBe("connected");
    await alice.send("重连后", undefined, "alice-restored");
    await expect.poll(() => repliesA.at(-1)?.id).toBe("reply-alice-restored-0");
    expect(
      repliesB.some((reply) => reply.id === "reply-alice-restored-0"),
    ).toBe(false);
    child.stdin.write("RELOAD\n");
    await expect
      .poll(() => events.some((event) => event.event === "reloaded"))
      .toBe(true);
    await expect
      .poll(() => [alice.phase, bob.phase], { timeout: 5000 })
      .toEqual(["connected", "connected"]);
    await bob.send("服务器适配器重载后", undefined, "after-server-reload");
    await expect
      .poll(() => repliesB.at(-1)?.id)
      .toBe("reply-after-server-reload-0");
    expect(
      repliesA.some((reply) => reply.id === "reply-after-server-reload-0"),
    ).toBe(false);
    expect(errors).not.toContain("Traceback");
  });
});
