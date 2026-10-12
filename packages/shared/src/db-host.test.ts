import { describe, expect, it } from "vitest";
import { describeDatabaseTarget, isHostedDatabaseHostname } from "./db-host.js";

const REF = "abcdefghijklmnopqrst";
const target = (raw: string) => describeDatabaseTarget(new URL(raw));

describe("describeDatabaseTarget", () => {
  it("collapses a Supabase project's direct, session and transaction URLs to one target", () => {
    const direct = target(`postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`);
    const session = target(`postgresql://app_admin.${REF}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`);
    const transaction = target(`postgresql://app_user.${REF}:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres`);
    for (const t of [direct, session, transaction]) {
      expect(t).toMatchObject({ provider: "supabase", instance: REF, host: `supabase:${REF}`, port: "5432" });
    }
    expect(direct.pooled).toBe(false);
    expect(transaction.pooled).toBe(true);
  });

  it("keeps two Supabase projects on the same regional pooler apart", () => {
    const a = target(`postgresql://app_user.${REF}:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres`);
    const b = target(`postgresql://app_user.zyxwvutsrqponmlkjihg:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres`);
    expect(a.host).not.toBe(b.host);
  });

  it("does not invent a project for a pooler URL without a project ref", () => {
    const t = target("postgresql://app_user:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres");
    expect(t).toMatchObject({ provider: "supabase", instance: null, host: "aws-0-us-east-1.pooler.supabase.com", port: "6543" });
  });

  it("keeps the existing Neon pooler normalization and leaves other hosts alone", () => {
    expect(target("postgresql://u:p@ep-a-pooler.us-east-1.aws.neon.tech/db")).toMatchObject({
      provider: "neon", pooled: true, instance: "ep-a", host: "ep-a.us-east-1.aws.neon.tech", port: "5432",
    });
    expect(target("postgresql://u:p@host-pooler.example:6543/db")).toMatchObject({
      provider: null, host: "host-pooler.example", port: "6543",
    });
  });

  it("recognizes hosted Postgres hostnames", () => {
    expect(isHostedDatabaseHostname(`db.${REF}.supabase.co`)).toBe(true);
    expect(isHostedDatabaseHostname("aws-0-us-east-1.pooler.supabase.com")).toBe(true);
    expect(isHostedDatabaseHostname("ep-x.us-east-1.aws.neon.tech")).toBe(true);
    expect(isHostedDatabaseHostname("127.0.0.1")).toBe(false);
    expect(isHostedDatabaseHostname("supabase.co.evil.example")).toBe(false);
  });
});
