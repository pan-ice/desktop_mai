import { afterEach, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:net";
import { join, resolve, sep } from "node:path";
import { AccountClient } from "../electron/accounts";
import { LocalServer } from "../electron/local-server";

const plugin = resolve("MaiBot/plugins/desktop_pet_adapter");
const python =
  process.env.MAI_PYTHON ||
  join(
    plugin,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
const base = resolve(".cache/local-server-tests");
const local = new LocalServer(python);
const client = new AccountClient();
let directory = "";
let host: ChildProcess | undefined;

afterEach(async () => {
  client.close();
  if (host && host.exitCode === null) {
    const exited = once(host, "exit");
    host.stdin?.end("STOP\n");
    const timer = setTimeout(() => host?.kill(), 4000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
  host = undefined;
  await local.stop();
  if (directory) {
    expect(resolve(directory).startsWith(base + sep)).toBe(true);
    await rm(directory, { recursive: true, force: true });
  }
  directory = "";
});

async function fixture() {
  await mkdir(base, { recursive: true });
  directory = await mkdtemp(join(base, "run-"));
  const target = join(directory, "plugins/desktop_pet_adapter");
  await mkdir(join(target, "tools"), { recursive: true });
  await cp(join(plugin, "desktop_adapter"), join(target, "desktop_adapter"), {
    recursive: true,
    filter: (path) => !path.includes("__pycache__"),
  });
  await cp(join(plugin, "tools/server.py"), join(target, "tools/server.py"));
  await writeFile(
    join(directory, "bot.py"),
    "# 本机中继测试目录，不启动真实 MaiBot\n",
  );
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  return {
    url: `ws://127.0.0.1:${port}/desktop`,
    adapter: join(target, "config.toml"),
    config: join(directory, "data/desktop-server/server.json"),
  };
}

it("空目录自动初始化、启动账号服务，QQ 登录与账号在重启后保留；复用者不停止外部中继", async () => {
  const { url, adapter, config } = await fixture();
  const results = await Promise.all([
    local.ensure(directory, url),
    local.ensure(directory, url),
  ]);
  expect(results[0].created).toBe(true);
  expect(results[1].created).toBe(false);
  const before = await readFile(config);
  const adapterBefore = await readFile(adapter);
  // 没有后端时也应连通账号服务，明确报告 MaiBot 状态，不能退回截图中的连接失败。
  await expect(client.begin(url, "测试电脑")).rejects.toThrow(
    "MaiBot 适配器尚未就绪",
  );
  host = spawn(python, [join(plugin, "tests/host_fixture.py"), adapter], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PYTHONUTF8: "1" },
  });
  host.stderr?.resume();
  host.stdout?.resume();
  let proof: Awaited<ReturnType<AccountClient["begin"]>> | undefined;
  await expect
    .poll(
      async () => {
        try {
          proof = await client.begin(url, "测试电脑");
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 5000 },
    )
    .toBe(true);
  if (!proof) throw new Error("登录码未创建");
  host.stdin?.write(`QQ 12345678 ${proof.code}\n`);
  let token = "";
  await expect
    .poll(
      async () => {
        const status = await client.poll(url, proof!);
        if (status.status === "confirmed") token = status.token;
        return status.status;
      },
      { timeout: 4000 },
    )
    .toBe("confirmed");
  const account = await client.create(url, token, "本机小麦");
  const observer = new LocalServer(python);
  try {
    expect((await observer.ensure("不存在的 MaiBot 目录", url)).created).toBe(
      false,
    );
  } finally {
    await observer.stop();
  }
  expect((await client.accounts(url, token)).accounts).toEqual([account]);
  await local.stop();
  await expect(client.accounts(url, token)).rejects.toThrow("无法连接账号服务");
  await local.ensure(directory, url);
  expect(await readFile(config)).toEqual(before);
  expect(await readFile(adapter)).toEqual(adapterBefore);
  expect((await client.accounts(url, token)).accounts).toEqual([account]);
});

it("托管控制管道关闭后中继自动退出；远程地址不会触发本机初始化", async () => {
  const { url, config } = await fixture();
  for (const remote of [
    "ws://remote.example.com/desktop",
    "wss://remote.example.com/desktop",
  ])
    await expect(local.ensure(directory, remote)).rejects.toThrow(
      "自动初始化仅用于本机",
    );
  await local.ensure(directory, url);
  await local.stop();
  host = spawn(
    python,
    [join(plugin, "tools/server.py"), "serve", "--config", config, "--managed"],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUTF8: "1" },
    },
  );
  let output = "";
  host.stdout?.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  host.stderr?.resume();
  await expect
    .poll(() => output.includes("桌宠接入程序已启动："), { timeout: 5000 })
    .toBe(true);
  const stopped = once(host, "exit");
  host.stdin?.end();
  expect((await stopped)[0]).toBe(0);
  await expect(client.begin(url, "已关闭")).rejects.toThrow("无法连接账号服务");
});
