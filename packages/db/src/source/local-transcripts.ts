/**
 * The local transcription queue: podcast episodes (source/podcast-ingest.ts)
 * waiting for the owner's own computer to transcribe them with Whisper.
 *
 * The helper on that computer (tools/local-whisper) claims a few jobs, downloads
 * each episode's audio from the podcast's own enclosure URL, runs Whisper,
 * and sends back the timestamped cues, which go through the same card
 * detection, retention rules and call extraction as YouTube transcripts
 * (storeTranscriptMentions). Only podcast episodes are ever queued: YouTube
 * audio is never downloaded.
 *
 * Tracking: no new table. Each episode's job is one provider_sync_run row
 * (provider `web_feed`, trigger `local_transcript`, id `plt_<content id>`).
 * `started` means claimed (a claim expires after LOCAL_TRANSCRIPT_LEASE_HOURS,
 * so a computer that switched off mid-job does not hold it); `completed` and
 * `skipped` are final; `failed` is retried, at most LOCAL_TRANSCRIPT_MAX_ATTEMPTS
 * times. A job the helper hands back unfinished (its nightly window ended)
 * does not count as an attempt.
 */
import { eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { ensureProviderRuntimeRows } from "../providers/runtime.js";
import { cleanCueText, type TranscriptCue } from "../providers/transcripts.js";
import { withPlatformContext } from "../rls.js";
import { providerSyncRun } from "../schema/provider.js";
import { sourceContent } from "../schema/source.js";
import { storeTranscriptMentions } from "./transcript-ingest.js";

export const LOCAL_TRANSCRIPT_TRIGGER = "local_transcript";
export const LOCAL_TRANSCRIPT_ID_PREFIX = "plt_";
export const LOCAL_TRANSCRIPT_PROVIDER = "local_whisper";
export const LOCAL_TRANSCRIPT_LEASE_HOURS = 12;
export const LOCAL_TRANSCRIPT_MAX_ATTEMPTS = 3;
export const LOCAL_TRANSCRIPT_MAX_CLAIM = 10;
export const LOCAL_TRANSCRIPT_MAX_CUES = 20_000;
/** Longest episode accepted, in milliseconds of cue offsets (6 hours). */
const MAX_OFFSET_MS = 6 * 3_600_000;
const MIN_TOKEN_LENGTH = 32;

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function localTranscriptJobId(contentId: string) {
  return `${LOCAL_TRANSCRIPT_ID_PREFIX}${contentId}`;
}

/**
 * LOCAL_TRANSCRIBER_TOKEN turns the queue's API on. It is a shared secret the
 * helper sends as a Bearer token; at least 32 characters. Off when unset.
 */
export function localTranscriberToken(env: NodeJS.ProcessEnv): string | null {
  const token = env.LOCAL_TRANSCRIBER_TOKEN?.trim() ?? "";
  return token.length >= MIN_TOKEN_LENGTH ? token : null;
}

export type LocalTranscriptJob = {
  content_id: string;
  audio_url: string;
  audio_type: string | null;
  audio_bytes: number | null;
  duration_seconds: number | null;
  title: string | null;
  published_at: string;
  podcast: string | null;
};

function cleanWorker(value: string | undefined): string {
  return (value ?? "").replace(/[^A-Za-z0-9 ._-]/g, "").trim().slice(0, 60) || "unknown";
}

/**
 * Claims up to `limit` waiting episodes, newest first, for one helper. Each
 * claim is committed before the helper downloads anything; an advisory lock
 * keeps two helpers from claiming the same episode.
 */
export async function claimLocalTranscriptJobs(
  db: Database,
  input: { limit?: number; worker?: string },
): Promise<LocalTranscriptJob[]> {
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 1), LOCAL_TRANSCRIPT_MAX_CLAIM));
  const worker = cleanWorker(input.worker);
  return withPlatformContext(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('local_transcript.claim.v1'))`);
    // Job rows reference the web_feed runtime row; make sure it exists even before the first feed run.
    await ensureProviderRuntimeRows(tx, process.env);
    const rows = rowsOf<{
      id: string;
      title: string | null;
      published_at: Date | string;
      metadata: unknown;
      podcast: string | null;
    }>(
      await tx.execute(sql`
        SELECT sc.id, sc.title, sc.published_at, sc.metadata, sa.display_name AS podcast
        FROM source_content sc
        JOIN source_account sa ON sa.id = sc.account_id
        WHERE sc.source_type = 'rss'
          AND sc.metadata->>'audio_url' IS NOT NULL
          AND sa.status = 'active'
          AND sa.metadata->'podcast_feed'->>'state' = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM provider_sync_run r
            WHERE r.id = ${LOCAL_TRANSCRIPT_ID_PREFIX}::text || sc.id
              AND (r.status IN ('completed', 'skipped')
                OR (r.status = 'started' AND r.started_at > now() - (${LOCAL_TRANSCRIPT_LEASE_HOURS}::int * interval '1 hour'))
                OR COALESCE((r.checkpoint->>'attempts')::int, 0) >= ${LOCAL_TRANSCRIPT_MAX_ATTEMPTS}))
          AND NOT EXISTS (
            SELECT 1 FROM creator_source_account csa
            WHERE csa.source_account_id = sc.account_id
              AND (SELECT te.trust_state FROM creator_trust_event te
                   WHERE te.creator_id = csa.creator_id
                   ORDER BY te.created_at DESC LIMIT 1) = 'excluded')
        ORDER BY sc.published_at DESC, sc.id
        LIMIT ${limit}`),
    );
    const jobs: LocalTranscriptJob[] = [];
    for (const row of rows) {
      const metadata = asRecord(typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata);
      const audioUrl = typeof metadata.audio_url === "string" ? metadata.audio_url : null;
      if (!audioUrl) continue;
      await tx.execute(sql`
        INSERT INTO provider_sync_run (id, provider_key, mode, "trigger", status, limit_count, checkpoint)
        VALUES (${localTranscriptJobId(row.id)}, 'web_feed', 'live', ${LOCAL_TRANSCRIPT_TRIGGER}, 'started', 1,
          jsonb_build_object('content_id', ${row.id}::text, 'worker', ${worker}::text, 'attempts', 1))
        ON CONFLICT (id) DO UPDATE SET
          status = 'started',
          started_at = now(),
          completed_at = NULL,
          error_class = NULL,
          received_count = 0,
          checkpoint = jsonb_build_object(
            'content_id', ${row.id}::text,
            'worker', ${worker}::text,
            'attempts', COALESCE((provider_sync_run.checkpoint->>'attempts')::int, 0) + 1)`);
      const bytes = Number(metadata.audio_bytes);
      const duration = Number(metadata.duration_seconds);
      jobs.push({
        content_id: row.id,
        audio_url: audioUrl,
        audio_type: typeof metadata.audio_type === "string" ? metadata.audio_type : null,
        audio_bytes: Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null,
        duration_seconds: Number.isFinite(duration) && duration > 0 ? duration : null,
        title: row.title,
        published_at: new Date(row.published_at).toISOString(),
        podcast: row.podcast,
      });
    }
    return jobs;
  });
}

export class LocalTranscriptValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalTranscriptValidationError";
  }
}

export type LocalTranscriptSubmission =
  | { status: "ok"; lang: string; cues: TranscriptCue[]; model: string | null }
  | { status: "unavailable"; reason: string }
  | { status: "error"; reason: string }
  | { status: "release" };

function reasonOf(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/[^a-z0-9_]/gi, "_").slice(0, 60) : "";
  return text || "unspecified";
}

/**
 * Validates what the helper sends. Cues are `{ text, start, end }` in seconds
 * (Whisper's own segment shape) or `{ text, offset_ms, duration_ms }`.
 */
export function parseLocalTranscriptSubmission(body: unknown): LocalTranscriptSubmission {
  const record = asRecord(body);
  const status = record.status;
  if (status === "release") return { status: "release" };
  if (status === "unavailable") return { status, reason: reasonOf(record.reason) };
  if (status === "error") return { status, reason: reasonOf(record.reason) };
  if (status !== "ok") throw new LocalTranscriptValidationError("status must be ok, unavailable, error or release.");
  const lang = typeof record.lang === "string" ? record.lang.trim().toLowerCase() : "en";
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(lang)) throw new LocalTranscriptValidationError("lang is invalid.");
  if (!Array.isArray(record.cues)) throw new LocalTranscriptValidationError("cues must be an array.");
  if (record.cues.length > LOCAL_TRANSCRIPT_MAX_CUES) throw new LocalTranscriptValidationError("Too many cues.");
  const cues: TranscriptCue[] = [];
  for (const raw of record.cues) {
    const cue = asRecord(raw);
    if (typeof cue.text !== "string") throw new LocalTranscriptValidationError("Each cue needs text.");
    let offsetMs: number;
    let durationMs: number;
    if (typeof cue.start === "number") {
      const end = typeof cue.end === "number" ? cue.end : cue.start;
      offsetMs = Math.round(cue.start * 1000);
      durationMs = Math.round((end - cue.start) * 1000);
    } else {
      offsetMs = Number(cue.offset_ms);
      durationMs = Number(cue.duration_ms ?? 0);
    }
    if (!Number.isFinite(offsetMs) || offsetMs < 0 || offsetMs > MAX_OFFSET_MS) {
      throw new LocalTranscriptValidationError("Cue times are invalid.");
    }
    if (!Number.isFinite(durationMs) || durationMs < 0) durationMs = 0;
    const text = cleanCueText(cue.text);
    if (!text) continue;
    cues.push({ text, offsetMs, durationMs: Math.min(durationMs, MAX_OFFSET_MS) });
  }
  const model = typeof record.model === "string" ? record.model.replace(/[^A-Za-z0-9 ._/-]/g, "").slice(0, 80) || null : null;
  return { status: "ok", lang, cues, model };
}

export type LocalTranscriptOutcome = "ingested" | "no_mentions" | "unavailable" | "failed" | "released" | "not_claimed";

export type LocalTranscriptReport = {
  contentId: string;
  outcome: LocalTranscriptOutcome;
  segments: number;
  mentions: number;
  callsCreated: number;
};

/**
 * Records the helper's answer for a claimed episode. A transcript is stored
 * through storeTranscriptMentions (only card-naming windows are kept). An
 * episode that is not currently claimed is refused, so nothing can be written
 * to content the queue did not hand out.
 */
export async function submitLocalTranscript(
  db: Database,
  input: { contentId: string; submission: LocalTranscriptSubmission },
): Promise<LocalTranscriptReport> {
  const report: LocalTranscriptReport = { contentId: input.contentId, outcome: "not_claimed", segments: 0, mentions: 0, callsCreated: 0 };
  const id = localTranscriptJobId(input.contentId);
  return withPlatformContext(db, async (tx) => {
    const [job] = await tx.select().from(providerSyncRun).where(eq(providerSyncRun.id, id)).for("update").limit(1);
    if (!job || job.trigger !== LOCAL_TRANSCRIPT_TRIGGER || job.status !== "started") return report;
    const [content] = await tx.select().from(sourceContent).where(eq(sourceContent.id, input.contentId)).limit(1);
    if (!content || content.sourceType !== "rss") return report;
    const previous = asRecord(job.checkpoint);
    const finish = async (
      status: "completed" | "skipped" | "failed",
      errorClass: string | null,
      received: number,
      extra: Record<string, unknown>,
    ) => {
      await tx
        .update(providerSyncRun)
        .set({
          status,
          errorClass,
          receivedCount: received,
          completedAt: new Date(),
          checkpoint: { ...previous, ...extra },
        })
        .where(eq(providerSyncRun.id, id));
    };
    const submission = input.submission;
    if (submission.status === "release") {
      const attempts = Math.max(0, Number(previous.attempts ?? 1) - 1);
      await finish("failed", "released", 0, { outcome: "released", attempts });
      return { ...report, outcome: "released" };
    }
    if (submission.status === "unavailable") {
      await finish("skipped", null, 0, { outcome: "unavailable", reason: submission.reason, transcript_available: false });
      return { ...report, outcome: "unavailable" };
    }
    if (submission.status === "error") {
      await finish("failed", submission.reason, 0, { outcome: "error", reason: submission.reason });
      return { ...report, outcome: "failed" };
    }
    const stored = await storeTranscriptMentions(tx, {
      contentId: input.contentId,
      contentTitle: content.title,
      transcript: { lang: submission.lang, cues: submission.cues, trackKind: "whisper" },
      provider: LOCAL_TRANSCRIPT_PROVIDER,
    });
    const outcome = stored.segments > 0 ? "ingested" : "no_mentions";
    await finish("completed", null, stored.mentions, {
      outcome,
      transcript_available: true,
      transcript_lang: submission.lang,
      model: submission.model,
      cues: submission.cues.length,
      windows: stored.windows,
      segments: stored.segments,
      mentions: stored.mentions,
      calls_created: stored.callsCreated,
    });
    return { ...report, outcome, segments: stored.segments, mentions: stored.mentions, callsCreated: stored.callsCreated };
  });
}
