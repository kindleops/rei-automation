-- ─────────────────────────────────────────────────────────────────────────────
-- Campaign recommendations — shadow / recommend-only (spine gap G11).
--
-- Persisted output of lib/domain/recommendation/campaign-recommendation-service.js:
-- deterministic, versioned, explainable campaign recommendations. Rows are
-- PROPOSALS ONLY: nothing in this table triggers campaign creation, activation,
-- queueing, or sending. An operator (or a future, separately-gated integration)
-- moves status to approved/dismissed; autonomous scheduling is explicitly out
-- of scope for this build.
--
-- Idempotency (spine §10): one row per
--   (market, property_class, campaign_type, model_version, recommended_on)
-- where recommended_on is the UTC date of recommendation — re-running the
-- recommender on the same day for the same model version is a no-op per cell.
--
-- This migration is written, NOT applied (build rule §11). The service degrades
-- to compute-only (no persistence) while the table is absent.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.campaign_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recommended_at timestamptz NOT NULL DEFAULT now(),
  -- UTC calendar day of the recommendation; part of the natural idempotency
  -- key. timezone('utc', timestamptz) is immutable, so this can be STORED.
  recommended_on date GENERATED ALWAYS AS ((timezone('utc', recommended_at))::date) STORED,
  market text NOT NULL,
  -- Canonical communication classes (spine §7) plus 'all' while class-level
  -- response metrics are not yet broken out upstream.
  property_class text NOT NULL DEFAULT 'all',
  campaign_type text NOT NULL,
  score numeric NOT NULL,
  -- Every signal that produced the score: [{signal, weight, value, contribution, status}]
  score_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Human-readable reasons: ["market X replied at Y% ...", ...]
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Per-source freshness/availability at compute time.
  data_freshness jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_version text NOT NULL,
  status text NOT NULL DEFAULT 'proposed' CHECK (
    status IN ('proposed', 'approved', 'dismissed', 'expired')
  ),
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A decision must carry who/when together.
  CONSTRAINT campaign_recommendations_decision_consistency CHECK (
    (status = 'proposed' AND decided_by IS NULL AND decided_at IS NULL)
    OR (
      status IN ('approved', 'dismissed')
      AND decided_by IS NOT NULL
      AND decided_at IS NOT NULL
    )
    OR (status = 'expired')
  ),
  CONSTRAINT campaign_recommendations_daily_cell_unique
    UNIQUE (market, property_class, campaign_type, model_version, recommended_on)
);

CREATE INDEX IF NOT EXISTS campaign_recommendations_status_idx
  ON public.campaign_recommendations (status, recommended_at DESC);

CREATE INDEX IF NOT EXISTS campaign_recommendations_market_idx
  ON public.campaign_recommendations (market, recommended_at DESC);

COMMENT ON TABLE public.campaign_recommendations IS
  'Shadow-only campaign recommendations (spine gap G11). Deterministic, versioned scoring output with full per-signal breakdown and readable reasons. Rows are proposals; no automation reads this table to create or activate campaigns. Natural key (market, property_class, campaign_type, model_version, recommended_on) makes same-day recomputation idempotent.';

COMMENT ON COLUMN public.campaign_recommendations.score_breakdown IS
  'Array of {signal, weight, value, contribution, status}. status ''pending_unfed'' marks declared-but-unfed input slots (seller score, buyer demand/liquidity) that contribute 0 until wired.';

COMMENT ON COLUMN public.campaign_recommendations.status IS
  'proposed = machine output awaiting review; approved/dismissed = operator decision (decided_by/decided_at set); expired = superseded without decision. No status value triggers execution.';

ALTER TABLE public.campaign_recommendations ENABLE ROW LEVEL SECURITY;

-- Containment posture per 20260729193000_launch_containment_security_addendum:
-- RLS-with-no-policies does not cover TRUNCATE, and Supabase default
-- privileges grant broadly to anon/authenticated on new public tables.
-- Service-role is the only writer.
REVOKE ALL ON TABLE public.campaign_recommendations FROM PUBLIC;
REVOKE ALL ON TABLE public.campaign_recommendations FROM anon;
REVOKE ALL ON TABLE public.campaign_recommendations FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.campaign_recommendations TO service_role;
