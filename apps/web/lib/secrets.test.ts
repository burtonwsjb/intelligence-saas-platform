import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("committed secrets", () => {
  it("does not commit secret values in env examples or docs", () => {
    const example = readFileSync(path.join(repoRoot, ".env.example"), "utf8");
    expect(example).toMatch(/^BETTER_AUTH_SECRET=$/m);
    expect(example).toMatch(/^DATABASE_URL=$/m);
    expect(example).toMatch(/^DATABASE_ADMIN_URL=$/m);
    expect(example).not.toMatch(/postgresql:\/\/[^:]+:[^@]+@/);
    expect(example).not.toMatch(/sk_live_/);

    const phase02 = readFileSync(path.join(repoRoot, "docs/PHASE_02.md"), "utf8");
    expect(phase02).not.toMatch(/BETTER_AUTH_SECRET=[^\s]+/);
    expect(phase02).not.toMatch(/postgresql:\/\/[^:]+:[^@]+@neondb/);

    const phase03 = readFileSync(path.join(repoRoot, "docs/PHASE_03.md"), "utf8");
    expect(phase03).not.toMatch(/BETTER_AUTH_SECRET=[^\s]+/);
    expect(phase03).not.toMatch(/postgresql:\/\/[^:]+:[^@]+@neondb/);

    expect(example).toMatch(/^BILLING_MODE=$/m);
    expect(example).toMatch(/^STRIPE_SECRET_KEY=$/m);
    expect(example).toMatch(/^API_KEY_PEPPER=$/m);
    expect(example).not.toMatch(/sk_live_/);

    const phase04 = readFileSync(path.join(repoRoot, "docs/PHASE_04.md"), "utf8");
    expect(phase04).not.toMatch(/BETTER_AUTH_SECRET=[^\s]+/);
    expect(phase04).not.toMatch(/sk_live_[A-Za-z0-9]+/);
    expect(phase04).not.toMatch(/sk_test_[A-Za-z0-9]{10,}/);
  });
});
