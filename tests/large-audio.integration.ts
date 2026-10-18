import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once, EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { MaiBotBridge } from "../electron/bridge";
import { AccountClient } from "../electron/accounts";
import { mediaFile, saveAttachment } from "../electron/media";
import { MAX_AUDIO_BYTES } from "../shared/media-limits";
import { defaultSettings } from "../shared/defaults";
import type { Reply } from "../electron/protocol";

type Event = { event: string; command?: string; [key: string]: unknown };
async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

it("100 MiB 音频经过真实网关和中继在线落盘，离线回复可分页恢复且哈希一致", async () => {
  const plugin =
    process.env.MAI_DESKTOP_ADAPTER_ROOT ||
    resolve("MaiBot/plugins/desktop_pet_adapter");
  const python =
    process.env.MAI_PYTHON ||
    join(
      plugin,
      ".venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
  const child = spawn(python, [join(plugin, "tests/large_audio_fixture.py")], {
    windowsHide: true,
    stdio: "pipe",
    env: { ...process.env, PYTHONUTF8: "1" },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  const events = new Map<string, Event>();
  const emitter = new EventEmitter();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const event: Event = JSON.parse(line);
    const key = `${event.event}:${event.command || ""}`;
    events.set(key, event);
    emitter.emit(key, event);
  });
  const event = (name: string) =>
    events.has(name)
      ? Promise.resolve(events.get(name)!)
      : new Promise<Event>((done, reject) => {
          const timer = setTimeout(
            () => finish(new Error("音频验收等待超时: " + stderr)),
            150_000,
          );
          const receive = (value: Event) => finish(undefined, value);
          const exit = () => finish(new Error("音频验收服务退出: " + stderr));
          const finish = (error?: Error, value?: Event) => {
            clearTimeout(timer);
            emitter.off(name, receive);
            child.off("exit", exit);
            error ? reject(error) : done(value!);
          };
          emitter.once(name, receive);
          child.once("exit", exit);
        });
  const bridge = new MaiBotBridge();
  const client = new AccountClient();
  const base = resolve(".cache/large-audio-tests");
  await mkdir(base, { recursive: true });
  const folder = await mkdtemp(join(base, "run-"));
  try {
    const ready = await event("ready:");
    expect(ready.bytes).toBe(100 * 1024 * 1024);
    expect(MAX_AUDIO_BYTES).toBeGreaterThanOrEqual(Number(ready.bytes));
    const received = new Promise<string>((done, reject) => {
      bridge.once(
        "reply",
        (reply: Reply, complete: (error?: Error) => void) => {
          saveAttachment(folder, reply.attachments[0])
            .then(async (attachment) => {
              const path = mediaFile(folder, attachment.dataUrl);
              expect((await stat(path)).size).toBe(ready.bytes);
              expect(await sha256(path)).toBe(ready.sha256);
              complete();
              done(path);
            })
            .catch((error: Error) => {
              complete(error);
              reject(error);
            });
        },
      );
    });
    await bridge.connect(
      {
        ...defaultSettings,
        connectionMode: "server",
        serverUrl: String(ready.url),
        serverAccountId: String(ready.account),
      },
      String(ready.token),
    );
    await expect.poll(() => bridge.phase).toBe("connected");
    child.stdin.write("SEND\n");
    expect((await event("receipt:SEND")).success).toBe(true);
    await received;
    await bridge.disconnect();
    child.stdin.write("OFFLINE\n");
    expect((await event("receipt:OFFLINE")).success).toBe(true);
    let before: number | undefined;
    const ids: string[] = [];
    for (let pageIndex = 0; pageIndex < 2; pageIndex++) {
      const page = await client.history(
        String(ready.url),
        String(ready.token),
        String(ready.account),
        before,
      );
      expect(page.messages.length).toBe(1);
      const message = page.messages[0];
      ids.push(message.id);
      const saved = await saveAttachment(folder, message.attachments![0]);
      const path = mediaFile(folder, saved.dataUrl);
      expect((await stat(path)).size).toBe(ready.bytes);
      expect(await sha256(path)).toBe(ready.sha256);
      expect(page.hasMore).toBe(pageIndex === 0);
      before = page.before ?? undefined;
    }
    expect(ids).toEqual(["large-offline", "large-send"]);
  } finally {
    client.close();
    await bridge.disconnect();
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.stdin.end("STOP\n");
      const timer = setTimeout(() => child.kill(), 5000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    }
    expect(folder.startsWith(base + sep)).toBe(true);
    await rm(folder, { recursive: true, force: true });
  }
});
