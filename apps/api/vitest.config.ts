import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.integration.test.ts"],
    // Tests build a PGlite database from every migration: ~3s locally, but
    // commercial.test.ts passed 30s in CI on a busy shared runner (2026-11-20).
    // Same fix as packages/auth (PR #62).
    testTimeout: 60_000,
  },
});
