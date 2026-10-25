import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Env, Hono } from "hono";
import {
  LocalTranscriptValidationError,
  claimLocalTranscriptJobs,
  createDbFromEnv,
  localTranscriberToken,
  parseLocalTranscriptSubmission,
  submitLocalTranscript,
  type Database,
} from "@isp/db";
import { jsonError } from "./errors.js";
import { allowApiAuthAttempt } from "./rate-limit.js";

/** Largest transcript body accepted (a 3-hour episode is well under 2 MB of cues). */
export const LOCAL_TRANSCRIPT_MAX_BYTES = 8_000_000;

function sameToken(presented: string, expected: string): boolean {
  // Hashing first keeps the comparison constant-time regardless of length.
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * The local Whisper helper's API (tools/local-whisper). Off unless
 * LOCAL_TRANSCRIBER_TOKEN is set; authenticated with that shared Bearer token,
 * not a tenant API key, because the queue writes platform source content.
 *
 * POST /internal/local-transcripts/claim         { limit?, worker? } -> { jobs: [...] }
 * POST /internal/local-transcripts/:contentId    { status: ok, lang, cues, model } | { status: unavailable|error, reason } | { status: release }
 */
export function registerLocalTranscriptRoutes<E extends Env>(
  app: Hono<E>,
  options: { db?: Database; env?: NodeJS.ProcessEnv } = {},
) {
  const env = options.env ?? process.env;
  const authorize = (c: Context<E>): Response | null => {
    const expected = localTranscriberToken(env);
    if (!expected) return jsonError("not_found", "Not found.", 404);
    const header = c.req.header("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!presented || !sameToken(presented, expected)) {
      if (!allowApiAuthAttempt({ get: (name) => c.req.header(name) ?? null })) {
        return jsonError("rate_limited", "Too many requests.", 429);
      }
      return jsonError("unauthorized", "Authentication required.", 401);
    }
    return null;
  };
  const database = () => options.db ?? createDbFromEnv(options.env);

  app.post("/internal/local-transcripts/claim", async (c) => {
    const denied = authorize(c);
    if (denied) return denied;
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      body = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      return jsonError("validation_error", "Body must be JSON.", 400);
    }
    const limit = Number(body.limit ?? 1);
    const jobs = await claimLocalTranscriptJobs(database(), {
      limit: Number.isFinite(limit) ? limit : 1,
      worker: typeof body.worker === "string" ? body.worker : undefined,
    });
    return c.json({ jobs });
  });

  app.post("/internal/local-transcripts/:contentId", async (c) => {
    const denied = authorize(c);
    if (denied) return denied;
    const contentId = c.req.param("contentId");
    if (!/^sct_[0-9a-f]{32}$/.test(contentId)) return jsonError("not_found", "Not found.", 404);
    const declared = Number(c.req.header("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > LOCAL_TRANSCRIPT_MAX_BYTES) {
      return jsonError("payload_too_large", "Transcript is too large.", 413);
    }
    const raw = await c.req.text();
    if (Buffer.byteLength(raw, "utf8") > LOCAL_TRANSCRIPT_MAX_BYTES) {
      return jsonError("payload_too_large", "Transcript is too large.", 413);
    }
    let submission;
    try {
      submission = parseLocalTranscriptSubmission(JSON.parse(raw));
    } catch (error) {
      if (error instanceof SyntaxError) return jsonError("validation_error", "Body must be JSON.", 400);
      if (error instanceof LocalTranscriptValidationError) return jsonError("validation_error", error.message, 400);
      throw error;
    }
    const report = await submitLocalTranscript(database(), { contentId, submission });
    if (report.outcome === "not_claimed") {
      return jsonError("not_claimed", "This episode is not claimed; claim it first.", 409);
    }
    return c.json({
      content_id: report.contentId,
      outcome: report.outcome,
      segments: report.segments,
      mentions: report.mentions,
      calls_created: report.callsCreated,
    });
  });
}
