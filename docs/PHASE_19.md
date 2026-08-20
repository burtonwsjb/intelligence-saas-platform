# Phase 19 — Content intelligence and SEO foundation

Status: **implemented**. Phase 20 has **not** started.

Publishing is evidence-driven. There is no generation step without an evidence package that cites market observations, scores, and creator calls when used. Live LLM APIs are not required. Local and fixture generators are the default. Production LLM mode remains fail-closed.

## Domain boundary

| Location | Role |
|---|---|
| `packages/db/src/schema/content.ts` | Candidates, evidence packages, drafts, claims, validations, publications, tenant reports |
| `packages/db/drizzle/0019_phase19_content.sql` | Global SEO facts + tenant-owned reports (`public_seo` forced false) |
| `packages/db/src/content/` | Evidence.v1, local/fixture generators, validate.v1, human approval |
| `apps/web/app/intelligence/[...slug]/page.tsx` | Public canonical URL renderer |

TCG Card Central is not used. Platform admin UI remains Phase 20.

## Required flow

Data → observations/signals/scores → content candidate → **evidence package** → generation → validation → approval.

`generateDraft` throws `MissingEvidenceError` when no package exists. Thin evidence becomes a **noindex stub**. Duplicate canonical URLs are **noindex**. `insufficient_data` is never indexable.

## Output types

`seo_article`, `market_report`, `card_analysis`, `newsletter`, `email`, `social_post`, `youtube_outline`, `push_notification`, `tenant_report`. Each has minimum source/signal/substance rules in `CONTENT_TEMPLATES`.

## Evidence package (`evidence.v1`)

Must include printing/language identity, as-of snapshot, material signals, recommendation or `insufficient_data`, optional prediction, sources, and a falsifier. Cross-language price merge is rejected unless `comparative=true`.

## Validation (`validate.v1`)

Numeric claims must resolve to evidence source ids. Language of the printing must match the page language. Model/generator version is recorded. HTML is escaped. Human approval is required; approval throws if validation failed.

## SEO rules

One canonical URL per printing+language: `/intelligence/{game}/{language}/{canonicalPrintingKey}`. `noindex` when thin, duplicate, or insufficient. Tenant reports with holdings cannot be public SEO (`public_seo = false` enforced).

## Phase 20 boundary

Do not build the platform admin console, creator-trust operator UI, or break-glass tools here.
