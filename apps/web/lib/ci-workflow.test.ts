import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("CI workflow", () => {
  it("validates PRs and main without deploying", () => {
    const workflow = readFileSync(
      path.join(repoRoot, ".github/workflows/ci.yml"),
      "utf8",
    );
    expect(workflow).toMatch(/pnpm install --frozen-lockfile/);
    expect(workflow).toMatch(/pnpm typecheck/);
    expect(workflow).toMatch(/pnpm lint/);
    expect(workflow).toMatch(/pnpm test/);
    expect(workflow).toMatch(/pnpm build/);
    expect(workflow).not.toMatch(/vercel/i);
    expect(workflow).not.toMatch(/railway/i);
    expect(workflow).not.toMatch(/secrets:/);
  });
});
