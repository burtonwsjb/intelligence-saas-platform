import { describe, expect, it } from "vitest";
import { exportOrganizationData } from "./portability.js";

describe("privacy portability", () => {
  it("omits secret hashes from the export shape", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: async () => [],
        }),
      }),
    };
    const pack = await exportOrganizationData(db as never, "org_test");
    expect(pack.organization_id).toBe("org_test");
    expect(JSON.stringify(pack)).not.toMatch(/secretHash|secretCiphertext|password/i);
  });
});
