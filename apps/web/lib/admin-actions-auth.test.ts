import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isProtectedPath } from "./protected-paths";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../app");
const read = (relative: string) => readFileSync(path.join(appDir, relative), "utf8");

describe("admin server actions", () => {
  it("check the platform operator grant before doing anything", () => {
    const source = read("admin-actions.ts");
    const exported = [...source.matchAll(/export async function (\w+)\(/g)].map((match) => match[1]);
    const guarded = [
      ...source.matchAll(/export async function (\w+)\([^)]*\) \{\n {2}const operator = await requireGrantedOperator\(\);/g),
    ].map((match) => match[1]);
    expect(exported).toContain("registerWebFeedSiteAction");
    expect(exported).toContain("setWebFeedSiteStateAction");
    expect(exported).toContain("requestInfluencerSeedAction");
    expect(guarded).toEqual(exported);
  });

  it("serves the website registry only on the operator-gated sources page", () => {
    const page = read("admin/sources/page.tsx");
    expect(page).toContain("await requireGrantedOperator()");
    expect(page).toContain("registerWebFeedSiteAction");
    expect(page).toContain("requestInfluencerSeedAction");
    expect(isProtectedPath("/admin/sources")).toBe(true);
  });
});
