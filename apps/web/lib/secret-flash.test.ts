import { describe, expect, it } from "vitest";
import { decodeSecretFlash, encodeSecretFlash } from "./secret-flash.js";

describe("secret flash encoding", () => {
  it("round-trips a secret without putting it in a query string", () => {
    const encoded = encodeSecretFlash("api_key", "isp_test_abcd1234_secretvalue");
    expect(encoded).not.toContain("isp_test_");
    expect(decodeSecretFlash(encoded)).toEqual({
      kind: "api_key",
      value: "isp_test_abcd1234_secretvalue",
    });
    expect(decodeSecretFlash("not-valid")).toBeNull();
    expect(decodeSecretFlash(encodeSecretFlash("webhook_secret", "whsec_x"))?.kind).toBe("webhook_secret");
  });
});
