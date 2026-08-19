import { describe, expect, it } from "vitest";
import Stripe from "stripe";
import type { Database } from "@isp/db";
import {
  InvalidStripeSignatureError,
  StripeCustomerMismatchError,
  constructStripeEvent,
  processStripeWebhook,
} from "./webhooks.js";

const secret = "whsec_test_phase04";

function signed(payload: string): string {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret });
}

describe("stripe webhooks", () => {
  it("rejects invalid signatures", () => {
    expect(() =>
      constructStripeEvent("{}", "invalid", secret),
    ).toThrow(InvalidStripeSignatureError);
  });

  it("accepts a signed test event", () => {
    const payload = JSON.stringify({
      id: "evt_test_1",
      object: "event",
      type: "invoice.paid",
      data: { object: { id: "in_1", object: "invoice", customer: "cus_1" } },
    });
    const event = constructStripeEvent(payload, signed(payload), secret);
    expect(event.id).toBe("evt_test_1");
  });

  it("fails closed when metadata organization does not match the mapped customer", async () => {
    const payload = JSON.stringify({
      id: "evt_mismatch",
      object: "event",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          object: "subscription",
          customer: "cus_mapped",
          status: "active",
          metadata: { organization_id: "org_b" },
          items: { data: [] },
        },
      },
    });
    const db = {
      execute: async () => [{ organization_id: "org_a" }],
      transaction: async () => {
        throw new Error("must not apply a mismatched webhook");
      },
    } as unknown as Database;
    await expect(
      processStripeWebhook(db, {
        payload,
        signature: signed(payload),
        env: { STRIPE_WEBHOOK_SECRET: secret },
      }),
    ).rejects.toThrow(StripeCustomerMismatchError);
  });

  it("does not apply side effects for a duplicate Stripe event id", async () => {
    let calls = 0;
    const payload = JSON.stringify({
      id: "evt_dup",
      object: "event",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_1",
          object: "invoice",
          customer: "cus_mapped",
          metadata: { organization_id: "org_a" },
        },
      },
    });
    const db = {
      execute: async () => {
        calls += 1;
        if (calls === 1) {
          return [{ organization_id: "org_a" }];
        }
        return [{ claimed: false }];
      },
      transaction: async () => {
        throw new Error("duplicate webhook must not upsert billing");
      },
    } as unknown as Database;
    await expect(
      processStripeWebhook(db, {
        payload,
        signature: signed(payload),
        env: { STRIPE_WEBHOOK_SECRET: secret },
      }),
    ).resolves.toEqual({ duplicate: true, ignored: false });
  });
});
