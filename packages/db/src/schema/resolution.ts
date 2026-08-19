import { index, integer, jsonb, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { tcgCardConcept, tcgPrinting } from "./tcg.js";
import { sourceMention } from "./source.js";

export const entityResolutionAttempt = pgTable(
  "entity_resolution_attempt",
  {
    id: text("id").primaryKey(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    mentionId: text("mention_id").references(() => sourceMention.id),
    targetLayer: text("target_layer").notNull(),
    status: text("status").notNull(),
    chosenPrintingId: text("chosen_printing_id").references(() => tcgPrinting.id),
    chosenConceptId: text("chosen_concept_id").references(() => tcgCardConcept.id),
    chosenEntityId: text("chosen_entity_id"),
    confidence: numeric("confidence", { precision: 5, scale: 4, mode: "string" }),
    resolverVersion: text("resolver_version").notNull(),
    reviewState: text("review_state").notNull().default("none"),
    inputSignals: jsonb("input_signals").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    subjectIdx: index("entity_resolution_subject_idx").on(
      table.subjectType,
      table.subjectId,
      table.createdAt,
    ),
    mentionIdx: index("entity_resolution_mention_idx").on(table.mentionId, table.createdAt),
  }),
);

export const entityResolutionCandidate = pgTable(
  "entity_resolution_candidate",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => entityResolutionAttempt.id),
    printingId: text("printing_id").references(() => tcgPrinting.id),
    conceptId: text("concept_id").references(() => tcgCardConcept.id),
    entityId: text("entity_id"),
    score: numeric("score", { precision: 12, scale: 4, mode: "string" }).notNull(),
    rank: integer("rank").notNull(),
    matchedAttributes: jsonb("matched_attributes").$type<string[]>().notNull().default([]),
    conflictingAttributes: jsonb("conflicting_attributes").$type<string[]>().notNull().default([]),
    evidence: jsonb("evidence").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    attemptIdx: index("entity_resolution_candidate_attempt_idx").on(table.attemptId, table.rank),
  }),
);

export const entityResolutionCorrection = pgTable(
  "entity_resolution_correction",
  {
    id: text("id").primaryKey(),
    sourceAttemptId: text("source_attempt_id")
      .notNull()
      .references(() => entityResolutionAttempt.id),
    resultAttemptId: text("result_attempt_id")
      .notNull()
      .references(() => entityResolutionAttempt.id),
    action: text("action").notNull(),
    candidateId: text("candidate_id").references(() => entityResolutionCandidate.id),
    printingId: text("printing_id").references(() => tcgPrinting.id),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    sourceIdx: index("entity_resolution_correction_source_idx").on(table.sourceAttemptId),
  }),
);
