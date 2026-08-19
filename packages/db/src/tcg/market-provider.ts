import type { TcgMarketRecordInput } from "./market-identity.js";

export interface TcgMarketProvider {
  getMarketSnapshots(query: { printingExternalId?: string; language?: string }): Promise<TcgMarketRecordInput[]>;
  getSoldTransactions(query: { printingExternalId?: string; language?: string }): Promise<TcgMarketRecordInput[]>;
  getListingSnapshot(query: { printingExternalId?: string; language?: string }): Promise<TcgMarketRecordInput | null>;
  healthCheck(): Promise<{ ok: true; mode: "sandbox_fixture" }>;
}

export class FixtureTcgMarketProvider implements TcgMarketProvider {
  constructor(
    private readonly records: TcgMarketRecordInput[],
    private readonly provider: string,
  ) {}

  async healthCheck() {
    return { ok: true as const, mode: "sandbox_fixture" as const };
  }

  private matches(record: TcgMarketRecordInput, query: { printingExternalId?: string; language?: string }) {
    if (this.provider && record.provider !== this.provider) {
      return false;
    }
    if (query.language && record.printing?.language !== query.language) {
      return false;
    }
    if (query.printingExternalId && record.external_id?.identifier_value !== query.printingExternalId) {
      return false;
    }
    return true;
  }

  async getMarketSnapshots(query: { printingExternalId?: string; language?: string }) {
    return this.records.filter((record) => this.matches(record, query));
  }

  async getSoldTransactions(query: { printingExternalId?: string; language?: string }) {
    return (await this.getMarketSnapshots(query)).filter((record) => record.market_type === "marketplace_sold");
  }

  async getListingSnapshot(query: { printingExternalId?: string; language?: string }) {
    return (
      (await this.getMarketSnapshots(query)).find((record) => record.market_type === "marketplace_listing") ?? null
    );
  }
}

export function fixtureTcgCardCentralMarketProvider(records: TcgMarketRecordInput[]) {
  return new FixtureTcgMarketProvider(records, "tcg_card_central");
}

export function fixtureTcgplayerMarketProvider(records: TcgMarketRecordInput[]) {
  return new FixtureTcgMarketProvider(records, "tcgplayer");
}

export function fixtureEbayMarketProvider(records: TcgMarketRecordInput[]) {
  return new FixtureTcgMarketProvider(records, "ebay");
}
