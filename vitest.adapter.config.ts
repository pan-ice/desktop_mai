import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/adapter.integration.ts",
      "tests/server.integration.ts",
      "tests/local-server.integration.ts",
    ],
    testTimeout: 20000,
  },
});
