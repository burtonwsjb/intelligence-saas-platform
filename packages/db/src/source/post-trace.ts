/**
 * Diagnostics for one website post: whether its site was read, whether the
 * post was stored, the card mentions found in it and how each resolved, and
 * the catalog printings for a card name. Read only; used by the worker when
 * MENTION_TRACE_URL is set, to see why a post does not count toward a card.
 */
import { sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { withPlatformContext } from "../rls.js";
import { canonicalPostUrl } from "./web-feed-ingest.js";

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: T[] }).rows ?? [])) as T[];
}

export async function traceSourcePost(db: Database, input: { url: string; cardName?: string | null }) {
  const url = canonicalPostUrl(input.url);
  if (!url) return { url: input.url, error: "invalid_url" };
  const domain = new URL(url).hostname.replace(/^www\./, "");
  return withPlatformContext(db, async (tx) => {
    const accounts = rowsOf<{ id: string; handle: string; status: string }>(
      await tx.execute(sql`SELECT id, handle, status FROM source_account WHERE source_type = 'web' AND handle = ${domain}`),
    );
    const accountIds = accounts.map((row) => row.id);
    const runs = accountIds.length
      ? rowsOf(
          await tx.execute(sql`
            SELECT started_at, status, "trigger", checkpoint->>'outcome' AS outcome, checkpoint->>'reason' AS reason,
              checkpoint->>'posts_new' AS posts_new, checkpoint->>'feed_url' AS feed_url
            FROM provider_sync_run
            WHERE provider_key = 'web_feed' AND checkpoint->>'account_id' IN (${sql.join(accountIds.map((id) => sql`${id}`), sql`, `)})
            ORDER BY started_at DESC LIMIT 6
          `),
        )
      : [];
    const stored = accountIds.length
      ? rowsOf(
          await tx.execute(sql`
            SELECT count(*)::int AS posts, min(published_at) AS oldest, max(published_at) AS newest
            FROM source_content WHERE account_id IN (${sql.join(accountIds.map((id) => sql`${id}`), sql`, `)})
          `),
        )[0]
      : null;
    const posts = rowsOf<{ id: string; title: string | null; published_at: unknown; text_source: string | null }>(
      await tx.execute(sql`
        SELECT id, title, published_at, metadata->>'text_source' AS text_source
        FROM source_content WHERE canonical_url = ${url} OR canonical_url = ${url.replace(/\/$/, "")} LIMIT 3
      `),
    );
    const mentions = [];
    for (const post of posts) {
      const rows = rowsOf(
        await tx.execute(sql`
          SELECT sm.raw_entity_text AS raw, sm.metadata->'card_detect' AS hints, sm.created_at,
            latest.status, latest.input_signals - 'context_text' AS signals,
            p.collector_number AS chosen_number, p.language_code AS chosen_language, s.canonical_set_key AS chosen_set,
            (SELECT count(*)::int FROM entity_resolution_candidate c WHERE c.attempt_id = latest.id) AS candidates
          FROM source_mention sm
          LEFT JOIN LATERAL (
            SELECT a.id, a.status, a.input_signals, a.chosen_printing_id FROM entity_resolution_attempt a
            WHERE a.mention_id = sm.id ORDER BY a.created_at DESC, a.id DESC LIMIT 1
          ) latest ON TRUE
          LEFT JOIN tcg_printing p ON p.id = latest.chosen_printing_id
          LEFT JOIN tcg_set s ON s.id = p.set_id
          WHERE sm.content_id = ${post.id}
          ORDER BY sm.created_at, sm.id
        `),
      );
      const segments = rowsOf<{ n: number }>(
        await tx.execute(sql`SELECT count(*)::int AS n FROM source_content_segment WHERE content_id = ${post.id}`),
      )[0]?.n;
      const calls = rowsOf(
        await tx.execute(sql`SELECT direction, printing_id IS NOT NULL AS bound, resolution_status FROM creator_call WHERE content_id = ${post.id}`),
      );
      mentions.push({ post, segments, mentions: rows, calls });
    }
    const printings = input.cardName
      ? rowsOf(
          await tx.execute(sql`
            SELECT c.canonical_name AS name, s.canonical_set_key AS set_key, s.name AS set_name, p.collector_number,
              p.collector_number_normalized AS normalized, p.language_code, p.variant_key, p.rarity
            FROM tcg_printing p
            JOIN tcg_card_concept c ON c.id = p.card_id
            JOIN tcg_set s ON s.id = p.set_id
            WHERE lower(c.canonical_name) = lower(${input.cardName})
               OR p.card_id IN (SELECT card_id FROM tcg_card_name_alias WHERE lower(name) = lower(${input.cardName}))
            ORDER BY s.canonical_set_key, p.collector_number_normalized, p.language_code
            LIMIT 60
          `),
        )
      : [];
    return { url, domain, accounts, runs, stored, posts: mentions, printings };
  });
}
