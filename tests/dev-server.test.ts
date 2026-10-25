import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Server as HttpServer } from "node:http";
import { createServer as createPortProbe } from "node:net";
import { once } from "node:events";
import { createServer, type InlineConfig, type ViteDevServer } from "vite";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import electronConfig from "../electron.vite.config";
import webConfig from "../vite.config";
import { automaticDevPort } from "../dev-server";

async function temporaryRoot(prefix: string) {
  // Windows CI uses TEMP paths such as RUNNER~1. Vite rejects paths containing
  // '~' in strict filesystem mode, so resolve the 8.3 alias before serving files.
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

describe.each([
  ["Electron", electronConfig.renderer!],
  ["浏览器预览", webConfig],
] as const)("%s 开发服务", (_name, config) => {
  it("监听源码，并排除可能被 Windows 锁定的运行时缓存", async () => {
    const root = await temporaryRoot("mai-dev-watch-");
    const source = join(root, "src");
    const network = join(root, ".cache", "userdata", "Network");
    let server: Awaited<ReturnType<typeof createServer>> | undefined;
    try {
      await mkdir(source, { recursive: true });
      await mkdir(network, { recursive: true });
      await writeFile(join(source, "main.ts"), "export const value = 1;");
      await writeFile(join(network, "Cookies"), "runtime cache");
      server = await createServer({
        ...config,
        root,
        configFile: false,
        logLevel: "silent",
      });
      await expect
        .poll(() => server!.watcher.getWatched()[source] || [])
        .toContain("main.ts");
      const watched = server.watcher.getWatched();
      expect(watched[network] || []).not.toContain("Cookies");
      expect(
        Object.keys(watched).filter((path) =>
          path.includes(`${sep}.cache${sep}`),
        ),
      ).toEqual([]);
    } finally {
      await server?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function httpAndHmr(server: ViteDevServer, port: number) {
  const origin = `http://127.0.0.1:${port}`;
  const html = await (
    await fetch(origin, {
      signal: AbortSignal.timeout(5000),
      headers: { Connection: "close" },
    })
  ).text();
  expect(html).toContain("mai-port-fixture");
  expect(server.resolvedUrls?.local).toContain(origin + "/");
  const client = await (
    await fetch(origin + "/@vite/client", {
      signal: AbortSignal.timeout(5000),
      headers: { Connection: "close" },
    })
  ).text();
  const token = client.match(/const wsToken = "([^"]+)"/)?.[1];
  expect(token).toBeTruthy();
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token!)}`,
    "vite-hmr",
  );
  try {
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error("HMR did not connect on the actual HTTP port")),
        5000,
      );
      socket.once("message", (data) => {
        clearTimeout(timer);
        try {
          expect(JSON.parse(data.toString())).toMatchObject({
            type: "connected",
          });
          done();
        } catch (error) {
          reject(error);
        }
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  } finally {
    socket.terminate();
  }
}

async function automaticFixture() {
  const root = await temporaryRoot("mai-dev-port-");
  await writeFile(
    join(root, "index.html"),
    "<!doctype html><title>mai-port-fixture</title>",
  );
  const config: InlineConfig = {
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [automaticDevPort()],
    server: { host: "127.0.0.1", port: 0, watch: null },
    optimizeDeps: { noDiscovery: true },
  };
  return { root, config };
}

function actualPort(server: ViteDevServer) {
  const address = server.httpServer!.address();
  if (!address || typeof address === "string")
    throw new Error("Missing TCP listener");
  return address.port;
}

it("共用自动配置的两个服务实际监听0且互不影响，连续重启保持端口与HTTP/HMR", async () => {
  const { root, config } = await automaticFixture();
  const calls: { server: HttpServer; port: unknown }[] = [];
  const listen = HttpServer.prototype.listen;
  const spy = vi
    .spyOn(HttpServer.prototype, "listen")
    .mockImplementation(function (this: HttpServer, ...args: unknown[]) {
      const first = args[0];
      calls.push({
        server: this,
        port:
          first && typeof first === "object"
            ? (first as { port?: unknown }).port
            : first,
      });
      return Reflect.apply(listen, this, args);
    });
  let first: ViteDevServer | undefined;
  let second: ViteDevServer | undefined;
  try {
    first = await createServer(config);
    await first.listen();
    const firstPort = actualPort(first);
    expect(
      calls
        .filter((call) => call.server === first!.httpServer)
        .map((call) => call.port),
    ).toEqual([0]);
    expect(config.server?.port).toBe(0);
    second = await createServer(config);
    await second.listen();
    const secondPort = actualPort(second);
    expect(
      calls
        .filter((call) => call.server === second!.httpServer)
        .map((call) => call.port),
    ).toEqual([0]);
    expect(secondPort).not.toBe(firstPort);
    expect(first.config.server.port).toBe(firstPort);
    expect(second.config.server.port).toBe(secondPort);
    expect(config.server?.port).toBe(0);
    await httpAndHmr(first, firstPort);
    await httpAndHmr(second, secondPort);
    for (let restart = 0; restart < 2; restart++) {
      await first.restart();
      expect(actualPort(first)).toBe(firstPort);
      expect(first.config.server.port).toBe(firstPort);
      expect(actualPort(second)).toBe(secondPort);
      expect(config.server?.port).toBe(0);
      await httpAndHmr(first, firstPort);
      await httpAndHmr(second, secondPort);
    }
  } finally {
    await Promise.allSettled([first?.close(), second?.close()]);
    spy.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it("显式指定的非0开发端口继续生效", async () => {
  const { root, config } = await automaticFixture();
  const probe = createPortProbe();
  let server: ViteDevServer | undefined;
  try {
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const address = probe.address();
    if (!address || typeof address === "string")
      throw new Error("Missing port probe");
    const port = address.port;
    await new Promise<void>((done) => probe.close(() => done()));
    config.server = { ...config.server, port, strictPort: true };
    server = await createServer(config);
    await server.listen();
    expect(actualPort(server)).toBe(port);
    expect(config.server.port).toBe(port);
    await httpAndHmr(server, port);
  } finally {
    if (probe.listening)
      await new Promise<void>((done) => probe.close(() => done()));
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
