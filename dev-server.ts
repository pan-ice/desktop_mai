import type { Plugin } from "vite";

/** Bind an automatic development port without releasing a temporary listener. */
export function automaticDevPort(): Plugin {
  return {
    name: "mai-automatic-dev-port",
    apply: "serve",
    configureServer(server) {
      const httpServer = server.httpServer;
      if (server.config.server.port !== 0 || !httpServer) return;

      // Vite currently replaces port 0 with 5173 before reaching Node.
      const listen = httpServer.listen;
      httpServer.listen = function (...args: unknown[]) {
        httpServer.listen = listen;
        const [options, ...rest] = args;
        const binding =
          options && typeof options === "object" ? { ...options, port: 0 } : 0;
        return Reflect.apply(listen, this, [binding, ...rest]);
      };
      httpServer.once("listening", () => {
        const address = httpServer.address();
        if (!address || typeof address === "string") return;
        // A restart keeps this listener's port; a second server keeps its own
        // automatic setting because the caller's shared config is untouched.
        server.config = {
          ...server.config,
          inlineConfig: {
            ...server.config.inlineConfig,
            server: {
              ...server.config.inlineConfig.server,
              port: address.port,
            },
          },
        };
      });
    },
  };
}
