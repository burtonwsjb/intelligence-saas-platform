import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const SKIP_DIR = new Set([
  "node_modules",
  "dist",
  ".next",
  ".git",
  ".turbo",
  "coverage",
]);

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".sql", ".yml", ".yaml"]);

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIR.has(entry)) {
      continue;
    }
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, files);
    } else if (SOURCE_EXT.has(path.extname(entry))) {
      files.push(full);
    }
  }
  return files;
}

describe("static security scan", () => {
  it("does not introduce eval, Function constructors, disabled TLS, or live Stripe keys", () => {
    const files = [
      ...walk(path.join(repoRoot, "apps")),
      ...walk(path.join(repoRoot, "packages")),
      ...walk(path.join(repoRoot, ".github")),
    ];
    const liveKeyHits: string[] = [];
    const evalHits: string[] = [];
    const tlsHits: string[] = [];
    const htmlHits: string[] = [];
    for (const file of files) {
      if (file.includes(`${path.sep}dist${path.sep}`) || file.endsWith(".test.ts")) {
        continue;
      }
      const text = readFileSync(file, "utf8");
      const rel = path.relative(repoRoot, file).replaceAll("\\", "/");
      if (/\beval\s*\(|new Function\s*\(/.test(text)) {
        evalHits.push(rel);
      }
      if (/NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/.test(text)) {
        tlsHits.push(rel);
      }
      if (/dangerouslySetInnerHTML/.test(text)) {
        htmlHits.push(rel);
      }
      if (/sk_live_[A-Za-z0-9]{8,}/.test(text) && !rel.endsWith("stripe-env.ts")) {
        liveKeyHits.push(rel);
      }
    }
    expect(evalHits).toEqual([]);
    expect(tlsHits).toEqual([]);
    expect(htmlHits).toEqual([]);
    expect(liveKeyHits).toEqual([]);
  });
});
