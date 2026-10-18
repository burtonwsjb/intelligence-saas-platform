-- Sets are market assets too, so "Ascended Heroes is going to rise" becomes a
-- call about the set. A set has no price of its own: its calls are scored on
-- the median move of the set's card prices (see creator/outcomes.ts).
ALTER TABLE "market_asset" DROP CONSTRAINT IF EXISTS market_asset_kind_chk;
ALTER TABLE "market_asset" ADD CONSTRAINT market_asset_kind_chk
  CHECK ("kind" IN ('crypto', 'stock', 'commodity', 'index', 'sealed', 'set', 'other'));

DO $$
BEGIN
  ALTER TABLE "market_asset" ADD CONSTRAINT market_asset_set_chk CHECK (
    "kind" <> 'set' OR ("set_id" IS NOT NULL AND "product_type" IS NULL)
  );
EXCEPTION
  WHEN duplicate_object THEN
    NULL;
END;
$$;

-- outcome.v2 calls a move within 2% either way "flat" (it was 0.5%), and a
-- call that said up or down but stayed flat now counts against the creator.
-- Regrade already scored calls with the new band so old and new agree.
UPDATE "creator_call_outcome" o
SET "directional_correct" = 'flat'
FROM "creator_call" c
WHERE c.id = o.call_id
  AND o.evaluation_status = 'evaluated'
  AND c.direction IN ('bullish', 'bearish')
  AND o.return_pct IS NOT NULL
  AND abs(o.return_pct) <= 0.02
  AND o.directional_correct IN ('correct', 'incorrect');
