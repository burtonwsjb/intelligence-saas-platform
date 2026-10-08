import { index, numeric, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/** An asset outside trading cards that creators make calls about, such as Bitcoin. */
export const marketAsset = pgTable(
  "market_asset",
  {
    id: text("id").primaryKey(),
    assetKey: text("asset_key").notNull(),
    kind: text("kind").notNull(),
    displayName: text("display_name").notNull(),
    aliases: text("aliases").array().notNull().default([]),
    quoteCurrency: text("quote_currency").notNull().default("USD"),
    priceSourceKey: text("price_source_key"),
    priceSourceRef: text("price_source_ref"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    keyUidx: uniqueIndex("market_asset_key_uidx").on(table.assetKey),
  }),
);

/** Append-only price points for a market asset, with the source that reported them. */
export const marketAssetPrice = pgTable(
  "market_asset_price",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
      .notNull()
      .references(() => marketAsset.id),
    sourceKey: text("source_key").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    price: numeric("price", { precision: 28, scale: 10, mode: "string" }).notNull(),
    currency: text("currency").notNull(),
    sourceReference: text("source_reference"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pointUidx: uniqueIndex("market_asset_price_point_uidx").on(table.assetId, table.sourceKey, table.observedAt),
    timeIdx: index("market_asset_price_time_idx").on(table.assetId, table.observedAt),
  }),
);
