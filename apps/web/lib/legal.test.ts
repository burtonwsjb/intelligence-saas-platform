import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { legalFacts } = await import("./legal");

describe("legal facts", () => {
  it("never leaves a blank when the owner has not configured a value", () => {
    expect(legalFacts({})).toEqual({ operator: "Sentiment", contactEmail: null, governingLaw: null });
    expect(legalFacts({ LEGAL_CONTACT_EMAIL: "  " }).contactEmail).toBeNull();
  });

  it("uses the configured operator, contact and governing law", () => {
    expect(
      legalFacts({
        LEGAL_ENTITY_NAME: "Example LLC",
        LEGAL_CONTACT_EMAIL: "legal@example.com",
        LEGAL_GOVERNING_LAW: "the State of Texas, USA",
      }),
    ).toEqual({ operator: "Example LLC", contactEmail: "legal@example.com", governingLaw: "the State of Texas, USA" });
  });
});
