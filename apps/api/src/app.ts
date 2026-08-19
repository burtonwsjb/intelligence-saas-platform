import { Hono } from "hono";
import { healthOk } from "@isp/contracts";
import { isNonEmptyString } from "@isp/shared";
import {
  createDbFromEnv,
  recordUsage,
  withMachineContext,
  type Database,
} from "@isp/db";
import {
  EntitlementDeniedError,
  InvalidStripeSignatureError,
  QuotaExceededError,
  StripeCustomerMismatchError,
  assertQuota,
  processStripeWebhook,
} from "@isp/billing";
import { publishOutboxJob, QueueUnavailableError, type IngestQueue } from "@isp/queue";
import { createMachineAuth, requireScope, type MachinePrincipal } from "./machine-auth.js";
import { jsonError } from "./errors.js";
import {
  IngestIdempotencyConflictError,
  IngestPayloadTooLargeError,
  IngestValidationError,
  INGEST_MAX_BYTES,
  acceptIngestEvent,
  parseIngestBody,
} from "./ingest.js";
import { resolveRequestId } from "./request-id.js";

export function createApiApp(options?: {
  db?: import("@isp/db").Database;
  env?: NodeJS.ProcessEnv;
  queue?: IngestQueue;
}) {
  const app = new Hono<{
    Variables: { db: Database; machine: MachinePrincipal };
  }>();
  const machineAuth = createMachineAuth(options);

  app.get("/health", (c) => {
    const body = healthOk();
    if (!isNonEmptyString(body.status)) {
      return new Response(JSON.stringify({ status: "error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    return c.json(body);
  });

  app.post("/webhooks/stripe", async (c) => {
    const payload = await c.req.text();
    const signature = c.req.header("stripe-signature") ?? null;
    try {
      const db = options?.db ?? createDbFromEnv(options?.env);
      const result = await processStripeWebhook(db, {
        payload,
        signature,
        env: options?.env,
      });
      return c.json({ received: true, ...result });
    } catch (error) {
      if (error instanceof InvalidStripeSignatureError) {
        return jsonError("unauthorized", "Invalid signature.", 401);
      }
      if (error instanceof StripeCustomerMismatchError) {
        return jsonError("forbidden", "Webhook customer mismatch.", 403);
      }
      throw error;
    }
  });

  app.use("/v1/events", async (c, next) => {
    const headerLen = Number(c.req.header("content-length") ?? Number.NaN);
    if (Number.isFinite(headerLen) && headerLen > INGEST_MAX_BYTES) {
      return jsonError(
        "payload_too_large",
        `Ingest payload exceeds ${INGEST_MAX_BYTES} bytes.`,
        413,
      );
    }
    return next();
  });

  app.use("/v1/*", machineAuth);

  app.post("/v1/events", requireScope("ingest:write"), async (c) => {
    const machine = c.get("machine");
    const db = c.get("db");
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    const raw = await c.req.text();
    if (Buffer.byteLength(raw, "utf8") > INGEST_MAX_BYTES) {
      return jsonError("payload_too_large", `Ingest payload exceeds ${INGEST_MAX_BYTES} bytes.`, 413);
    }
    try {
      const body = parseIngestBody(raw);
      const accepted = await withMachineContext(
        db,
        { organizationId: machine.organizationId, apiKeyId: machine.apiKeyId },
        (scoped) =>
          acceptIngestEvent(scoped, {
            organizationId: machine.organizationId,
            apiKeyId: machine.apiKeyId,
            requestId,
            body,
          }),
      );
      if (accepted.outbox_id) {
        try {
          await publishOutboxJob(db, {
            organizationId: machine.organizationId,
            outboxId: accepted.outbox_id,
            queue: options?.queue,
            env: options?.env,
          });
        } catch (error) {
          if (!(error instanceof QueueUnavailableError)) {
            throw error;
          }
        }
      }
      return new Response(
        JSON.stringify({ event_id: accepted.event_id, accepted: true }),
        {
          status: 202,
          headers: {
            "content-type": "application/json",
            "x-request-id": requestId,
          },
        },
      );
    } catch (error) {
      if (error instanceof IngestPayloadTooLargeError) {
        return jsonError("payload_too_large", error.message, 413);
      }
      if (error instanceof IngestValidationError) {
        return jsonError("validation_error", error.message, 400);
      }
      if (error instanceof IngestIdempotencyConflictError) {
        return jsonError("idempotency_conflict", error.message, 409);
      }
      if (error instanceof QuotaExceededError) {
        return jsonError("quota_exceeded", "Plan quota exceeded.", 429);
      }
      if (error instanceof EntitlementDeniedError) {
        return jsonError("entitlement_denied", "Plan entitlement denied.", 402);
      }
      throw error;
    }
  });

  app.get("/v1/me", requireScope("decisions:read"), async (c) => {
    const machine = c.get("machine");
    const db = c.get("db");
    try {
      await withMachineContext(
        db,
        { organizationId: machine.organizationId, apiKeyId: machine.apiKeyId },
        async (scoped) => {
          await assertQuota(scoped, {
            organizationId: machine.organizationId,
            meterKey: "api.reads",
          });
          await recordUsage(scoped, {
            id: crypto.randomUUID(),
            organizationId: machine.organizationId,
            apiKeyId: machine.apiKeyId,
            meterKey: "api.reads",
            quantity: 1,
            idempotencyKey: c.req.header("idempotency-key") ?? crypto.randomUUID(),
          });
        },
      );
    } catch (error) {
      if (error instanceof QuotaExceededError) {
        return jsonError("quota_exceeded", "Plan quota exceeded.", 429);
      }
      if (error instanceof EntitlementDeniedError) {
        return jsonError("entitlement_denied", "Plan entitlement denied.", 402);
      }
      throw error;
    }
    return c.json({
      organization_id: machine.organizationId,
      api_key_id: machine.apiKeyId,
      scopes: machine.scopes,
    });
  });

  return app;
}

export const app = createApiApp();
