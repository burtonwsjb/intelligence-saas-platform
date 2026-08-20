import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/*.pg.test.ts", "node_modules/**"],
    testTimeout: 15_000,
  },
});
