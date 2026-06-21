-- Campaign recipient metrics RPC + dedup safeguard (additive, idempotent).

-- Distinct recipient counts for a campaign target snapshot.
CREATE OR REPLACE FUNCTION public.campaign_recipient_distinct_counts(p_campaign_id uuid)
RETURNS TABLE (
  distinct_owners bigint,
  distinct_prospects bigint,
  distinct_phones bigint,
  distinct_e164 bigint,
  compliant_count bigint,
  routable_count bigint,
  duplicate_owner_groups bigint,
  duplicate_phone_groups bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH base AS (
    SELECT
      master_owner_id,
      prospect_id,
      phone_id,
      to_phone_number,
      suppression_status,
      routing_status,
      template_status,
      target_status
    FROM public.campaign_targets
    WHERE campaign_id = p_campaign_id
  ),
  owner_dup AS (
    SELECT COUNT(*) AS n
    FROM (
      SELECT master_owner_id FROM base
      WHERE master_owner_id IS NOT NULL
      GROUP BY master_owner_id HAVING COUNT(*) > 1
    ) s
  ),
  phone_dup AS (
    SELECT COUNT(*) AS n
    FROM (
      SELECT to_phone_number FROM base
      WHERE to_phone_number IS NOT NULL
      GROUP BY to_phone_number HAVING COUNT(*) > 1
    ) s
  )
  SELECT
    COUNT(DISTINCT master_owner_id),
    COUNT(DISTINCT prospect_id),
    COUNT(DISTINCT phone_id),
    COUNT(DISTINCT to_phone_number),
    COUNT(*) FILTER (WHERE COALESCE(suppression_status, 'clear') NOT IN ('blocked', 'suppressed')),
    COUNT(*) FILTER (
      WHERE target_status = 'ready'
        AND COALESCE(suppression_status, 'clear') NOT IN ('blocked', 'suppressed')
        AND COALESCE(routing_status, '') = 'ready'
        AND COALESCE(template_status, '') = 'ready'
    ),
    (SELECT n FROM owner_dup),
    (SELECT n FROM phone_dup)
  FROM base;
$$;

-- Recipient metadata columns (portfolio context from dedup).
ALTER TABLE public.campaign_targets
  ADD COLUMN IF NOT EXISTS touch_number integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS matched_property_count integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS portfolio_property_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS primary_property_id text,
  ADD COLUMN IF NOT EXISTS recipient_dedup_key text;

-- Supersede historical duplicate active rows (preserve rows, block extras).
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY campaign_id, COALESCE(touch_number, 1), to_phone_number
      ORDER BY priority_score DESC NULLS LAST, created_at ASC, id ASC
    ) AS rn
  FROM public.campaign_targets
  WHERE to_phone_number IS NOT NULL
    AND target_status IN ('ready', 'planned', 'queued', 'scheduled')
)
UPDATE public.campaign_targets AS t
SET
  target_status = 'blocked',
  block_reason = 'duplicate_superseded_precheck',
  updated_at = NOW()
FROM ranked AS r
WHERE t.id = r.id
  AND r.rn > 1;

-- Partial unique guard: one active recipient row per campaign + touch + E.164.
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_targets_recipient_dedup
  ON public.campaign_targets (campaign_id, touch_number, to_phone_number)
  WHERE to_phone_number IS NOT NULL
    AND target_status IN ('ready', 'planned', 'queued', 'scheduled');