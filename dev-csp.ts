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
        const port =
          address && typeof address === "object"
            ? address.port
            : context.server.config.server.port || 5173;
        return html
          .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
          .replace("ws://127.0.0.1:5173", `ws://127.0.0.1:${port}`);
      },
    },
  };
}
