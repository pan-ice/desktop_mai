import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createServer } from "vite";
import { describe, expect, it } from "vitest";
import electronConfig from "../electron.vite.config";
import webConfig from "../vite.config";

describe.each([
  ["Electron", electronConfig.renderer!],
  ["浏览器预览", webConfig],
] as const)("%s 开发服务", (_name, config) => {
  it("监听源码，并排除可能被 Windows 锁定的运行时缓存", async () => {
    const root = await mkdtemp(join(tmpdir(), "mai-dev-watch-"));
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
