import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/large-audio.integration.ts"],
    testTimeout: 180_000,
    hookTimeout: 30_000,
    maxWorkers: 1,
  },
});
