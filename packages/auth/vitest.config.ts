import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each test builds a PGlite database by applying every migration. Locally
    // that takes ~3s, but CI runs all packages' suites at once on a shared
    // runner and the same setup took 21s, then over 30s (2026-11-20).
    testTimeout: 60_000,
  },
});
