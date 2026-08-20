import {
  boolean,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { organization } from "./organization.js";
import { tcgPrinting } from "./tcg.js";

export const contentCandidate = pgTable(
  "content_candidate",
  {
    id: text("id").primaryKey(),
    outputType: text("output_type").notNull(),
    printingId: text("printing_id").references(() => tcgPrinting.id),
    languageCode: text("language_code").notNull(),
    comparative: boolean("comparative").notNull().default(false),
    asOf: timestamp("as_of", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("proposed"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    printingIdx: index("content_candidate_printing_idx").on(table.printingId, table.languageCode, table.asOf),
  }),
);

export const contentEvidencePackage = pgTable("content_evidence_package", {
  id: text("id").primaryKey(),
  candidateId: text("candidate_id")
    .notNull()
    .references(() => contentCandidate.id),
  printingId: text("printing_id"),
  languageCode: text("language_code").notNull(),
  asOf: timestamp("as_of", { withTimezone: true }).notNull(),
  recommendation: text("recommendation").notNull(),
  thin: boolean("thin").notNull().default(false),
  comparative: boolean("comparative").notNull().default(false),
  snapshotId: text("snapshot_id"),
  scoreId: text("score_id"),
  predictionId: text("prediction_id"),
  signals: jsonb("signals").$type<unknown[]>().notNull().default([]),
  sources: jsonb("sources").$type<Array<{ type: string; id: string }>>().notNull().default([]),
  falsifiers: jsonb("falsifiers").$type<string[]>().notNull().default([]),
  identity: jsonb("identity").$type<Record<string, unknown>>().notNull().default({}),
  evidenceVersion: text("evidence_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const contentDraft = pgTable(
  "content_draft",
  {
    id: text("id").primaryKey(),
    candidateId: text("candidate_id")
      .notNull()
      .references(() => contentCandidate.id),
    evidenceId: text("evidence_id")
      .notNull()
      .references(() => contentEvidencePackage.id),
    generatorKey: text("generator_key").notNull(),
    generatorVersion: text("generator_version").notNull(),
    title: text("title").notNull(),
    bodyText: text("body_text").notNull(),
    bodyHtml: text("body_html").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    candidateIdx: index("content_draft_candidate_idx").on(table.candidateId, table.createdAt),
  }),
);

export const contentClaim = pgTable(
  "content_claim",
  {
    id: text("id").primaryKey(),
    draftId: text("draft_id")
      .notNull()
      .references(() => contentDraft.id),
    claimKey: text("claim_key").notNull(),
    numericValue: numeric("numeric_value", { precision: 20, scale: 8, mode: "string" }).notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
  },
  (table) => ({
    draftIdx: index("content_claim_draft_idx").on(table.draftId),
  }),
);

export const contentValidation = pgTable("content_validation", {
  id: text("id").primaryKey(),
  draftId: text("draft_id")
    .notNull()
    .references(() => contentDraft.id),
  passed: boolean("passed").notNull(),
  failures: jsonb("failures").$type<string[]>().notNull().default([]),
  validatorVersion: text("validator_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const contentPublication = pgTable("content_publication", {
  id: text("id").primaryKey(),
  draftId: text("draft_id")
    .notNull()
    .references(() => contentDraft.id),
  candidateId: text("candidate_id")
    .notNull()
    .references(() => contentCandidate.id),
  canonicalUrl: text("canonical_url").notNull(),
  robots: text("robots").notNull(),
  indexable: boolean("indexable").notNull().default(false),
  approvedAt: timestamp("approved_at", { withTimezone: true }).defaultNow().notNull(),
  approvedBy: text("approved_by"),
  status: text("status").notNull().default("approved"),
});

export const tenantContentReport = pgTable(
  "tenant_content_report",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    outputType: text("output_type").notNull().default("tenant_report"),
    title: text("title").notNull(),
    bodyText: text("body_text").notNull(),
    holdings: jsonb("holdings").$type<unknown[]>().notNull().default([]),
    publicSeo: boolean("public_seo").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("tenant_content_report_org_idx").on(table.organizationId, table.createdAt),
  }),
);
