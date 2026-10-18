import { describe, expect, it } from "vitest";
import { activeNavKey } from "./nav";

const items = [
  { href: "/app", key: "overview" },
  { href: "/app/cards", key: "cards" },
  { href: "/app/markets", key: "markets" },
  { href: "/app/creators", key: "creators" },
  { href: "/app/alerts", key: "alerts" },
  { href: "/app/team", key: "team" },
];

describe("active navigation", () => {
  it("highlights the destination that owns a nested or legacy route", () => {
    expect(activeNavKey(items, "/app")).toBe("overview");
    expect(activeNavKey(items, "/app/")).toBe("overview");
    expect(activeNavKey(items, "/app/cards/abc")).toBe("cards");
    expect(activeNavKey(items, "/app/opportunities/abc")).toBe("cards");
    expect(activeNavKey(items, "/app/indices/pokemon-en")).toBe("markets");
    expect(activeNavKey(items, "/app/team")).toBe("team");
    expect(activeNavKey(items, "/app/cardsx")).toBeNull();
  });
});
