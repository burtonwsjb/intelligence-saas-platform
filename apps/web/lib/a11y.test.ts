import { describe, expect, it } from "vitest";
import { preferenceControlLabel, SKIP_LINK_HREF } from "./a11y.js";

describe("accessibility helpers", () => {
  it("names notification preference controls for assistive tech", () => {
    expect(preferenceControlLabel("market_alert", "in_app")).toBe("market alert in app notifications");
    expect(preferenceControlLabel("security", "email")).toBe("security email notifications");
  });

  it("keeps a single skip-to-content target", () => {
    expect(SKIP_LINK_HREF).toBe("#main");
  });
});
