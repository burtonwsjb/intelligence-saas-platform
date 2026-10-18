export type CallGrade = { company: "psa" | "bgs" | "cgc" | "sgc"; grade: number };

const COMPANY: Record<string, CallGrade["company"]> = {
  psa: "psa",
  bgs: "bgs",
  beckett: "bgs",
  cgc: "cgc",
  sgc: "sgc",
};

/**
 * The grade a post names ("PSA 10", "BGS 9.5", "CGC 9s"), or null for raw
 * cards. Only whole and half grades from 1 to 10 count.
 */
export function detectCallGrade(text: string): CallGrade | null {
  const match = text.match(/\b(psa|bgs|beckett|cgc|sgc)\s*-?\s*(10|[1-9](?:\.5)?)s?\b/i);
  if (!match) return null;
  const company = COMPANY[match[1]!.toLowerCase()];
  const grade = Number(match[2]);
  if (!company || !Number.isFinite(grade)) return null;
  return { company, grade };
}

/** The grade stored on a call's evidence, if the call was about a graded copy. */
export function callGradeFromEvidence(evidence: unknown): CallGrade | null {
  const raw = (evidence as { grade?: { company?: unknown; grade?: unknown } } | null)?.grade;
  if (!raw || typeof raw.company !== "string" || typeof raw.grade !== "number") return null;
  const company = COMPANY[raw.company];
  return company ? { company, grade: raw.grade } : null;
}
