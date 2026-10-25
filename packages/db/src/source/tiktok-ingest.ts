/**
 * TikTok creators as a source, from video links an operator pastes on
 * /admin/sources. Each link becomes a `tiktok` video of the creator's account;
 * the transcript backfill (source/transcript-ingest.ts) then gets its
 * transcript from the paid transcript service (TRANSCRIPT_PROVIDER=supadata),
 * which fetches the video itself. Sentiment never downloads TikTok media and
 * does not list a creator's videos on its own.
 *
 * Needs migration 0039_tiktok_source (the `tiktok` source platform); until it
 * runs, adding links fails with TikTokLinkError("migration_missing").
 *
 * A TikTok video id carries its upload time (the top 32 bits are Unix
 * seconds), so calls get the video's real date without fetching the page.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { ensureCreatorForSourceAccount } from "../creator/ingest.js";
import { insertBreakGlassAudit } from "../platform/audit.js";
import { SOURCE_NORMALIZER_VERSION } from "../providers/catalog.js";
import { withPlatformContext } from "../rls.js";
import { sourceIngest } from "../schema/source.js";
import { ingestSourceContentRecord } from "./ingest.js";
import { stableSourceId } from "./identity.js";

export const TIKTOK_MAX_LINKS_PER_ADD = 100;
const HANDLE = /^[a-z0-9._]{2,24}$/;
const VIDEO_ID = /^\d{15,25}$/;
/** TikTok launched internationally in 2017; earlier timestamps mean a malformed id. */
const EARLIEST_UPLOAD = Date.UTC(2016, 0, 1);

export class TikTokLinkError extends Error {
  constructor(
    readonly code: "no_links" | "too_many" | "migration_missing",
    message: string,
  ) {
    super(message);
    this.name = "TikTokLinkError";
  }
}

export type TikTokVideoLink = { handle: string; videoId: string; url: string; publishedAt: Date };

/** Upload time encoded in a TikTok video id, or null when it is not plausible. */
export function tiktokVideoTime(videoId: string, now = new Date()): Date | null {
  if (!VIDEO_ID.test(videoId)) return null;
  const seconds = Number(BigInt(videoId) >> 32n);
  const time = seconds * 1000;
  return time >= EARLIEST_UPLOAD && time <= now.getTime() + 86_400_000 ? new Date(time) : null;
}

/**
 * Reads a pasted TikTok video link: https://www.tiktok.com/@handle/video/<id>
 * (m. and www. hosts, query strings ignored). Short vm.tiktok.com links name
 * no creator or video and are refused rather than followed.
 */
export function parseTikTokVideoLink(raw: string, now = new Date()): TikTokVideoLink | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!/^(www\.|m\.)?tiktok\.com$/i.test(url.hostname)) return null;
  const match = url.pathname.match(/^\/@([^/]+)\/video\/(\d+)\/?$/);
  if (!match) return null;
  const handle = decodeURIComponent(match[1]!).toLowerCase();
  const videoId = match[2]!;
  if (!HANDLE.test(handle)) return null;
  const publishedAt = tiktokVideoTime(videoId, now);
  if (!publishedAt) return null;
  return { handle, videoId, url: `https://www.tiktok.com/@${handle}/video/${videoId}`, publishedAt };
}

export function tiktokAccountId(handle: string) {
  return stableSourceId("sac", ["tiktok", handle]);
}

export type TikTokAddReport = {
  added: number;
  duplicates: number;
  rejected: string[];
  accounts: Array<{ handle: string; sourceAccountId: string; creatorId: string }>;
};

/**
 * Stores pasted TikTok video links as videos of their creators' accounts
 * (one creator per handle, created on first sight). Idempotent per video.
 * Platform context; audited. Lines that are not TikTok video links are
 * returned in `rejected`, untouched.
 */
export async function addTikTokVideoLinks(
  db: Database,
  input: { links: string; displayName?: string | null; actorUserId: string; now?: Date },
): Promise<TikTokAddReport> {
  const now = input.now ?? new Date();
  const lines = input.links
    .split(/[\s,]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) throw new TikTokLinkError("no_links", "Paste at least one TikTok video link.");
  if (lines.length > TIKTOK_MAX_LINKS_PER_ADD) {
    throw new TikTokLinkError("too_many", `Paste at most ${TIKTOK_MAX_LINKS_PER_ADD} links at a time.`);
  }
  const report: TikTokAddReport = { added: 0, duplicates: 0, rejected: [], accounts: [] };
  const videos = new Map<string, TikTokVideoLink>();
  for (const line of lines) {
    const link = parseTikTokVideoLink(line, now);
    if (link) videos.set(link.videoId, link);
    else report.rejected.push(line.slice(0, 200));
  }
  if (videos.size === 0) return report;
  const displayName = input.displayName?.replace(/\s+/g, " ").trim().slice(0, 120) || null;

  try {
    await withPlatformContext(db, async (tx) => {
      const handles = new Map<string, string>();
      for (const video of videos.values()) {
        const recordId = `tiktok:${video.videoId}`;
        const [existing] = await tx
          .select({ status: sourceIngest.processingStatus })
          .from(sourceIngest)
          .where(and(eq(sourceIngest.sourceType, "tiktok"), eq(sourceIngest.sourceRecordId, recordId)))
          .limit(1);
        if (existing?.status === "processed") {
          report.duplicates += 1;
        } else {
          await ingestSourceContentRecord(tx, {
            provider: "tiktok",
            provider_record_id: recordId,
            event_type: "source.content.ingested",
            account: {
              external_account_id: video.handle,
              handle: video.handle,
              display_name: displayName ?? `@${video.handle}`,
              canonical_url: `https://www.tiktok.com/@${video.handle}`,
              metadata: { kind: "tiktok" },
            },
            content: {
              external_content_id: video.videoId,
              content_type: "video",
              published_at: video.publishedAt.toISOString(),
              title: null,
              summary: null,
              canonical_url: video.url,
              language: null,
              license_status: "reference_only",
              retention_policy: "bounded_excerpt",
              transcript_available: false,
              excerpt: null,
              metadata: {
                normalizer_version: SOURCE_NORMALIZER_VERSION,
                added_via: "admin_links",
                published_at_source: "video_id",
              },
            },
          });
          report.added += 1;
        }
        handles.set(video.handle, tiktokAccountId(video.handle));
      }
      for (const [handle, sourceAccountId] of handles) {
        const { creator } = await ensureCreatorForSourceAccount(tx, sourceAccountId);
        report.accounts.push({ handle, sourceAccountId, creatorId: creator.id });
        await insertBreakGlassAudit(tx, {
          actorUserId: input.actorUserId,
          action: "discovery.monitor",
          targetType: "source_account",
          targetId: sourceAccountId,
          metadata: { change: "tiktok.add_links", handle },
        });
      }
    });
  } catch (error) {
    if (/source_platform|foreign key/i.test(String((error as { cause?: unknown })?.cause ?? error))) {
      throw new TikTokLinkError("migration_missing", "TikTok needs database update 0039_tiktok_source first.");
    }
    throw error;
  }
  return report;
}

export type TikTokAccountRow = {
  sourceAccountId: string;
  handle: string;
  displayName: string | null;
  videos: number;
  transcribed: number;
  calls: number;
};

/** TikTok creators with their pasted videos, transcripts checked and calls, for the admin sources page. */
export async function listTikTokAccounts(db: Database, limit = 200): Promise<TikTokAccountRow[]> {
  const result = await db.execute(sql`
    SELECT sa.id, sa.handle, sa.display_name,
      (SELECT count(*) FROM source_content sc WHERE sc.account_id = sa.id) AS videos,
      (SELECT count(*) FROM source_content sc
        JOIN provider_sync_run r ON r.id = 'ptx_' || sc.id AND r.status IN ('completed', 'skipped')
        WHERE sc.account_id = sa.id) AS transcribed,
      (SELECT count(*) FROM creator_call cc
        JOIN source_content sc ON sc.id = cc.content_id
        WHERE sc.account_id = sa.id) AS calls
    FROM source_account sa
    WHERE sa.source_type = 'tiktok'
    ORDER BY sa.handle
    LIMIT ${Math.max(1, Math.min(limit, 500))}`);
  const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Array<{
    id: string;
    handle: string | null;
    display_name: string | null;
    videos: number | string;
    transcribed: number | string;
    calls: number | string;
  }>;
  return rows.map((row) => ({
    sourceAccountId: row.id,
    handle: row.handle ?? "",
    displayName: row.display_name,
    videos: Number(row.videos),
    transcribed: Number(row.transcribed),
    calls: Number(row.calls),
  }));
}
