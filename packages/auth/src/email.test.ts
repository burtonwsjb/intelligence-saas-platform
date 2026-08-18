import { describe, expect, it } from "vitest";
import { createEmailDelivery } from "./email.js";

describe("email delivery", () => {
  it("fails closed in production without Resend", async () => {
    const delivery = createEmailDelivery({ nodeEnv: "production" });
    await expect(
      delivery.send({ to: "a@example.com", url: "https://example.invalid" }),
    ).rejects.toThrow(/Resend/);
  });

  it("does not use memory mode from env", () => {
    expect(() => createEmailDelivery({ nodeEnv: "development", mode: "memory" })).toThrow(
      /createMemoryInbox/,
    );
  });
});
