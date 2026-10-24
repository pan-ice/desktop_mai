import type { Plugin } from "vite";

export function developmentCsp(): Plugin {
  return {
    name: "mai-development-csp",
    transformIndexHtml: {
      order: "pre",
      handler(html, context) {
        // React 的 Vite 热更新前导只在开发模式需要内联脚本；发行版保持原始 CSP。
        if (!context.server) return html;
        const address = context.server.httpServer?.address();
        if (!address || typeof address !== "object" || !address.port)
          throw new Error("开发页面服务尚未开始监听，无法生成热更新地址");
        const host = address.address.includes(":")
          ? `[${address.address}]`
          : address.address;
        const websocket = `${context.server.config.server.https ? "wss" : "ws"}://${host}:${address.port}`;
        return html
          .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
          .replace("connect-src 'self'", `connect-src 'self' ${websocket}`);
      },
    },
  };
}
