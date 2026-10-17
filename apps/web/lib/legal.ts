import "server-only";

/**
 * Facts the legal pages need that only the owner can supply. Each comes from an
 * environment variable so the pages never show a bracketed blank: when a value
 * is unset the sentence that needs it falls back to a neutral wording.
 */
export const LEGAL_EFFECTIVE_DATE = "October 17, 2026";

export type LegalFacts = {
  /** Legal name of the business that operates Sentiment, e.g. "Example LLC". */
  operator: string;
  /** Address for legal, privacy and support requests. */
  contactEmail: string | null;
  /** Governing law and venue, e.g. "the State of Texas, USA". */
  governingLaw: string | null;
};

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function legalFacts(env: NodeJS.ProcessEnv = process.env): LegalFacts {
  return {
    operator: clean(env.LEGAL_ENTITY_NAME) ?? "Sentiment",
    contactEmail: clean(env.LEGAL_CONTACT_EMAIL),
    governingLaw: clean(env.LEGAL_GOVERNING_LAW),
  };
}
