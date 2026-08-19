import type { TcgResolveQuery, TcgResolveResult } from "./resolve.js";

/** In-memory TCG Card Central sandbox. No network, no tokens, no production host. */

export type TcgIdentityProviderPrinting = {
  id: string;
  game: string;
  set: string;
  collector_number: string;
  language: string;
  variant: string;
  canonical_printing_key: string;
};

export type TcgIdentityProviderSet = {
  id: string;
  game: string;
  canonical_set_key: string;
  name: string;
};

export interface TcgIdentityProvider {
  getPrintingByExternalId(externalId: string): Promise<TcgIdentityProviderPrinting | null>;
  resolvePrinting(query: TcgResolveQuery): Promise<TcgResolveResult>;
  getSet(input: { game: string; set: string }): Promise<TcgIdentityProviderSet | null>;
  healthCheck(): Promise<{ ok: true; mode: "sandbox_fixture" }>;
}

export type SandboxPrinting = TcgIdentityProviderPrinting & {
  tccId?: string;
};

export class SandboxTcgCardCentralProvider implements TcgIdentityProvider {
  constructor(
    private readonly catalog: {
      printings: SandboxPrinting[];
      sets: TcgIdentityProviderSet[];
    },
  ) {}

  async healthCheck() {
    return { ok: true as const, mode: "sandbox_fixture" as const };
  }

  async getSet(input: { game: string; set: string }) {
    return (
      this.catalog.sets.find(
        (row) => row.game === input.game && row.canonical_set_key === input.set,
      ) ?? null
    );
  }

  async getPrintingByExternalId(externalId: string) {
    return this.catalog.printings.find((row) => row.tccId === externalId) ?? null;
  }

  async resolvePrinting(query: TcgResolveQuery): Promise<TcgResolveResult> {
    if (query.external_id) {
      const hit = this.catalog.printings.find(
        (row) => row.tccId === query.external_id?.identifier_value,
      );
      if (!hit) {
        return { status: "not_found", confidence: null, printingId: null, candidates: [] };
      }
      return { status: "exact", confidence: 1, printingId: hit.id, candidates: [hit.id] };
    }
    if (!query.language) {
      throw new Error("Language is required for exact printing resolution.");
    }
    const matches = this.catalog.printings.filter((row) => {
      if (query.game && row.game !== query.game) {
        return false;
      }
      if (query.set && row.set !== query.set) {
        return false;
      }
      if (query.collector_number && row.collector_number !== query.collector_number) {
        return false;
      }
      if (row.language !== query.language) {
        return false;
      }
      if (query.variant && row.variant !== query.variant) {
        return false;
      }
      return true;
    });
    if (matches.length === 0) {
      return { status: "not_found", confidence: null, printingId: null, candidates: [] };
    }
    if (matches.length > 1) {
      return {
        status: "ambiguous",
        confidence: null,
        printingId: null,
        candidates: matches.map((row) => row.id),
      };
    }
    return {
      status: "exact",
      confidence: 1,
      printingId: matches[0]!.id,
      candidates: [matches[0]!.id],
    };
  }
}

export function sandboxProviderFromFixtures(printings: SandboxPrinting[], sets: TcgIdentityProviderSet[]) {
  return new SandboxTcgCardCentralProvider({ printings, sets });
}
