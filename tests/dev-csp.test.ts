import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { afterEach, expect, it } from "vitest";
import { build, createServer } from "vite";
import { developmentCsp } from "../dev-csp";
import { automaticDevPort } from "../dev-server";

const base = resolve(".cache/dev-csp-tests");
const roots: string[] = [];
async function fixture() {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "run-"));
  roots.push(root);
  const template = await readFile(resolve("index.html"), "utf8");
  const html = template.replace(
    /<script[^>]+src="\/src\/main\.tsx"[^>]*><\/script>/,
    "",
  );
  await writeFile(join(root, "index.html"), html);
  return { root, html };
}
function policy(html: string) {
  const meta = html.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/,
  );
  expect(meta).not.toBeNull();
  return meta![1];
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    expect(root.startsWith(base + sep)).toBe(true);
    await rm(root, { recursive: true, force: true });
  }
});

it("开发页面只授权真实自动监听端口的热更新连接", async () => {
  const { root } = await fixture();
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [automaticDevPort(), developmentCsp()],
    server: { host: "127.0.0.1", port: 0, watch: null },
  });
  try {
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === "string")
      throw new Error("Missing TCP listener");
    const html = await (
      await fetch(`http://127.0.0.1:${address.port}/`)
    ).text();
    const csp = policy(html);
    expect(csp).toContain(`connect-src 'self' ws://127.0.0.1:${address.port} `);
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("connect-src 'self' ws: ");
    expect(server.config.server.port).toBe(address.port);
  } finally {
    await server.close();
  }
});

it("正式构建不包含开发端口或开发内联脚本授权", async () => {
  const { root, html } = await fixture();
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [developmentCsp()],
    build: { write: false },
  });
  if (Array.isArray(result) || !("output" in result))
    throw new Error("Unexpected Vite build result");
  const index = result.output.find(
    (file) => file.type === "asset" && file.fileName === "index.html",
  );
  if (!index || index.type !== "asset") throw new Error("Missing built HTML");
  const csp = policy(String(index.source));
  expect(csp).toBe(policy(html));
  expect(csp).not.toContain("ws://");
  expect(csp).not.toContain("wss://");
  expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
});
