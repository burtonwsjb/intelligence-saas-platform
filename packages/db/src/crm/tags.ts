import { eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { crmOrganizationTag, crmTag } from "../schema/crm.js";

const TAG_KEY = /^[a-z0-9_]{1,40}$/;

export class InvalidCrmTagError extends Error {
  constructor() {
    super("CRM tag keys must be lowercase snake_case.");
    this.name = "InvalidCrmTagError";
  }
}

export async function upsertCrmTag(
  db: Database,
  input: { key: string; label: string },
) {
  if (!TAG_KEY.test(input.key)) {
    throw new InvalidCrmTagError();
  }
  await db
    .insert(crmTag)
    .values({ key: input.key, label: input.label.slice(0, 80) })
    .onConflictDoUpdate({
      target: crmTag.key,
      set: { label: input.label.slice(0, 80) },
    });
}

export async function listCrmTags(db: Database) {
  return db.select().from(crmTag);
}

export async function assignOrganizationTag(
  db: Database,
  input: { organizationId: string; tagKey: string },
) {
  if (!TAG_KEY.test(input.tagKey)) {
    throw new InvalidCrmTagError();
  }
  await db
    .insert(crmOrganizationTag)
    .values({
      organizationId: input.organizationId,
      tagKey: input.tagKey,
    })
    .onConflictDoNothing();
}

export async function listOrganizationTags(db: Database, organizationId: string) {
  return db
    .select({
      tagKey: crmOrganizationTag.tagKey,
      label: crmTag.label,
      createdAt: crmOrganizationTag.createdAt,
    })
    .from(crmOrganizationTag)
    .innerJoin(crmTag, eq(crmOrganizationTag.tagKey, crmTag.key))
    .where(eq(crmOrganizationTag.organizationId, organizationId));
}
