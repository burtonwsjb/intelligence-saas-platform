import { describe, expect, it } from "vitest";
import { publicAuthErrorMessage, publicAuthRouteError } from "./auth-errors.js";

describe("public auth errors", () => {
  it("does not echo provider text that could enumerate accounts", () => {
    expect(publicAuthErrorMessage("login")).toBe("Unable to sign in.");
    expect(publicAuthErrorMessage("signup")).toMatch(/try signing in/i);
    expect(publicAuthRouteError()).not.toMatch(/already exists|invalid password|user not found/i);
  });
});
