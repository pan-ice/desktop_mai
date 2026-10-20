import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { developmentCsp } from "./dev-csp";

export default defineConfig({
  plugins: [developmentCsp(), react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false,
    watch: { ignored: ["**/.cache/**"] },
  },
});
