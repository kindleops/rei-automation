-- Deterministic output of the Acquisition Decision Engine.
--
-- properties.property_id is TEXT in the production schema (numeric Podio/source
-- identifiers), so this table intentionally uses TEXT instead of UUID for the
-- property link. The score row itself uses a UUID primary key.

CREATE TABLE IF NOT EXISTS public.property_acquisition_scores (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id                TEXT        NOT NULL UNIQUE,
  valuation_low              NUMERIC,
  valuation_mid              NUMERIC,
  valuation_high             NUMERIC,
  valuation_confidence       INTEGER,
  comp_count                 INTEGER,
  weighted_comp_score        NUMERIC,
  investor_ceiling_low       NUMERIC,
  investor_ceiling_mid       NUMERIC,
  investor_ceiling_high      NUMERIC,
  buyer_demand_score         INTEGER,
  liquidity_score            INTEGER,
  estimated_repairs          NUMERIC,
  recommended_cash_offer     NUMERIC,
  minimum_acceptable_offer   NUMERIC,
  expected_assignment_fee    NUMERIC,
  subject_to_score           INTEGER,
  seller_finance_score       INTEGER,
  lease_option_score         INTEGER,
  novation_score             INTEGER,
  best_strategy              TEXT,
  aos_score                  INTEGER,
  confidence                 INTEGER,
  decision_tier              TEXT,
  evidence                   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  computed_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT property_acquisition_scores_valuation_confidence_check
    CHECK (valuation_confidence IS NULL OR valuation_confidence BETWEEN 0 AND 100),
  CONSTRAINT property_acquisition_scores_comp_count_check
    CHECK (comp_count IS NULL OR comp_count >= 0),
  CONSTRAINT property_acquisition_scores_buyer_demand_check
    CHECK (buyer_demand_score IS NULL OR buyer_demand_score BETWEEN 0 AND 100),
  CONSTRAINT property_acquisition_scores_liquidity_check
    CHECK (liquidity_score IS NULL OR liquidity_score BETWEEN 0 AND 100),
  CONSTRAINT property_acquisition_scores_subject_to_check
    CHECK (subject_to_score IS NULL OR subject_to_score BETWEEN 0 AND 100),
  CONSTRAINT property_acquisition_scores_seller_finance_check
    CHECK (seller_finance_score IS NULL OR seller_finance_score BETWEEN 0 AND 100),
  CONSTRAINT property_acquisition_scores_lease_option_check
    CHECK (lease_option_score IS NULL OR lease_option_score BETWEEN 0 AND 100),
  CONSTRAINT property_acquisition_scores_novation_check
    CHECK (novation_score IS NULL OR novation_score BETWEEN 0 AND 100),
  CONSTRAINT property_acquisition_scores_aos_check
    CHECK (aos_score IS NULL OR aos_score BETWEEN 0 AND 1000),
  CONSTRAINT property_acquisition_scores_confidence_check
    CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100),
  CONSTRAINT property_acquisition_scores_decision_tier_check
    CHECK (
      decision_tier IS NULL OR decision_tier IN (
        'AUTO_HARD_OFFER',
        'AUTO_RANGE_OFFER',
        'CREATIVE_TERMS',
        'NURTURE',
        'REVIEW_REQUIRED'
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_property_acquisition_scores_decision_tier
  ON public.property_acquisition_scores (decision_tier);

CREATE INDEX IF NOT EXISTS idx_property_acquisition_scores_aos
  ON public.property_acquisition_scores (aos_score DESC);

CREATE INDEX IF NOT EXISTS idx_property_acquisition_scores_computed_at
  ON public.property_acquisition_scores (computed_at DESC);

ALTER TABLE public.property_acquisition_scores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS property_acquisition_scores_service_role_all
  ON public.property_acquisition_scores;
CREATE POLICY property_acquisition_scores_service_role_all
  ON public.property_acquisition_scores
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON TABLE public.property_acquisition_scores FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.property_acquisition_scores
  TO service_role;

COMMENT ON TABLE public.property_acquisition_scores IS
  'Deterministic property valuation, offer, creative-finance, AOS, confidence, and evidence output.';

COMMENT ON COLUMN public.property_acquisition_scores.property_id IS
  'Canonical properties.property_id. Production source identifiers are stored as text.';

COMMENT ON COLUMN public.property_acquisition_scores.evidence IS
  'Explainable inputs, selected/rejected comps, feature scores, valuation math, strategy reasoning, confidence, and decision gates.';
