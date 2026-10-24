import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { developmentCsp } from "./dev-csp";
import { automaticDevPort } from "./dev-server";

export default defineConfig({
  plugins: [automaticDevPort(), developmentCsp(), react()],
  server: {
    host: "127.0.0.1",
    port: 0,
    strictPort: false,
    watch: {
      ignored: ["**/.cache/**", "**/release/**", "**/out/**", "**/dist/**"],
    },
  },
});
