/** A packaged application always uses its bundled page; dev URLs stay local. */
export function developmentRendererUrl(packaged: boolean, value?: string) {
  if (packaged || !value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("开发页面地址无效，请重新运行 npm run dev");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("开发页面必须来自本机 Vite 服务，请重新运行 npm run dev");
  return url.origin;
}
