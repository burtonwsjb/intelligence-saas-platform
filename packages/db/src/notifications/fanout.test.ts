import { describe, expect, it } from "vitest";
import { processQueuedEmailDeliveries } from "./delivery.js";

describe("notification fan-out", () => {
  it("does not send when a live transport is not configured", async () => {
    const queued: Array<{ id: string; templateKey: string; userId: string | null; status: string; attempt: number; createdAt: Date }> = [
      {
        id: "eml_1",
        templateKey: "alert.creator_call",
        userId: "user_1",
        status: "queued",
        attempt: 1,
        createdAt: new Date(),
      },
    ];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => queued,
            }),
          }),
        }),
      }),
    };
    const result = await processQueuedEmailDeliveries(db as never);
    expect(result.processed).toBe(0);
    expect(result.reason).toBe("send_not_configured");
  });

  it("marks injected sends as sent without leaking secrets", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const queued = [
      {
        id: "eml_2",
        templateKey: "alert.creator_call",
        userId: "user_1",
        status: "queued",
        attempt: 1,
        createdAt: new Date(),
      },
    ];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => queued,
            }),
          }),
        }),
      }),
      update: () => ({
        set: (value: Record<string, unknown>) => {
          updates.push(value);
          return { where: async () => undefined };
        },
      }),
    };
    const result = await processQueuedEmailDeliveries(db as never, {
      send: async () => undefined,
    });
    expect(result.processed).toBe(1);
    expect(JSON.stringify(updates)).not.toMatch(/RESEND_API_KEY|re_/);
  });
});
