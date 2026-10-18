-- A move of less than 1% either way is "flat"; 1% or more counts as up or
-- down (0034 used 2%). Regrade scored calls in the 1%..2% gap that 0034 or
-- outcome.v2 at 2% marked flat. Calls under 1% stay flat.
UPDATE "creator_call_outcome" o
SET "directional_correct" = CASE
  WHEN (c.direction = 'bullish') = (o.return_pct > 0) THEN 'correct'
  ELSE 'incorrect'
END
FROM "creator_call" c
WHERE c.id = o.call_id
  AND o.evaluation_status = 'evaluated'
  AND c.direction IN ('bullish', 'bearish')
  AND o.return_pct IS NOT NULL
  AND abs(o.return_pct) >= 0.01
  AND o.directional_correct = 'flat';
