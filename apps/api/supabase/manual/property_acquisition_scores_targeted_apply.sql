-- Targeted manual apply for:
--   20260612082848_create_property_acquisition_scores.sql
--   20260613224827_acquisition_owner_situation_phase2.sql
--
-- Intended for the Supabase SQL Editor while normal migration push is blocked.
-- This script does not write to supabase_migrations.schema_migrations.
-- It does not remove, rename, truncate, or delete any production object or row.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE IF NOT EXISTS public.property_acquisition_scores (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id                TEXT        NOT NULL,
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
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Complete a safely rerunnable Phase 1 apply if the table already exists but
-- an earlier manual attempt stopped before every column was present.
ALTER TABLE public.property_acquisition_scores
  ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS property_id text,
  ADD COLUMN IF NOT EXISTS valuation_low numeric,
  ADD COLUMN IF NOT EXISTS valuation_mid numeric,
  ADD COLUMN IF NOT EXISTS valuation_high numeric,
  ADD COLUMN IF NOT EXISTS valuation_confidence integer,
  ADD COLUMN IF NOT EXISTS comp_count integer,
  ADD COLUMN IF NOT EXISTS weighted_comp_score numeric,
  ADD COLUMN IF NOT EXISTS investor_ceiling_low numeric,
  ADD COLUMN IF NOT EXISTS investor_ceiling_mid numeric,
  ADD COLUMN IF NOT EXISTS investor_ceiling_high numeric,
  ADD COLUMN IF NOT EXISTS buyer_demand_score integer,
  ADD COLUMN IF NOT EXISTS liquidity_score integer,
  ADD COLUMN IF NOT EXISTS estimated_repairs numeric,
  ADD COLUMN IF NOT EXISTS recommended_cash_offer numeric,
  ADD COLUMN IF NOT EXISTS minimum_acceptable_offer numeric,
  ADD COLUMN IF NOT EXISTS expected_assignment_fee numeric,
  ADD COLUMN IF NOT EXISTS subject_to_score integer,
  ADD COLUMN IF NOT EXISTS seller_finance_score integer,
  ADD COLUMN IF NOT EXISTS lease_option_score integer,
  ADD COLUMN IF NOT EXISTS novation_score integer,
  ADD COLUMN IF NOT EXISTS best_strategy text,
  ADD COLUMN IF NOT EXISTS aos_score integer,
  ADD COLUMN IF NOT EXISTS confidence integer,
  ADD COLUMN IF NOT EXISTS decision_tier text,
  ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS computed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- Phase 2 is additive only.
ALTER TABLE public.property_acquisition_scores
  ADD COLUMN IF NOT EXISTS seller_financial_pressure_score integer,
  ADD COLUMN IF NOT EXISTS forced_sale_pressure_score integer,
  ADD COLUMN IF NOT EXISTS foreclosure_risk_score integer,
  ADD COLUMN IF NOT EXISTS transaction_probability_90 integer,
  ADD COLUMN IF NOT EXISTS transaction_probability_180 integer,
  ADD COLUMN IF NOT EXISTS transaction_probability_365 integer,
  ADD COLUMN IF NOT EXISTS landlord_fatigue_score integer,
  ADD COLUMN IF NOT EXISTS tax_pain_score integer,
  ADD COLUMN IF NOT EXISTS equity_unlock_score integer,
  ADD COLUMN IF NOT EXISTS debt_pressure_score integer,
  ADD COLUMN IF NOT EXISTS repair_burden_score integer,
  ADD COLUMN IF NOT EXISTS offer_aggression_score integer,
  ADD COLUMN IF NOT EXISTS owner_situation_primary text,
  ADD COLUMN IF NOT EXISTS owner_situation_scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS recommended_conversation_angle text,
  ADD COLUMN IF NOT EXISTS recommended_offer_stack jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Fail safely instead of coercing data if a partial pre-existing table has
-- incompatible nullable keys.
DO $$
BEGIN
  IF (
    SELECT a.atttypid
    FROM pg_attribute a
    WHERE a.attrelid = 'public.property_acquisition_scores'::regclass
      AND a.attname = 'property_id'
      AND NOT a.attisdropped
  ) <> 'text'::regtype THEN
    RAISE EXCEPTION
      'property_acquisition_scores.property_id must be text; aborting without type conversion';
  END IF;

  IF (
    SELECT a.atttypid
    FROM pg_attribute a
    WHERE a.attrelid = 'public.property_acquisition_scores'::regclass
      AND a.attname = 'id'
      AND NOT a.attisdropped
  ) <> 'uuid'::regtype THEN
    RAISE EXCEPTION
      'property_acquisition_scores.id must be uuid; aborting without type conversion';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.property_acquisition_scores
    WHERE id IS NULL OR property_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'property_acquisition_scores contains null id/property_id values; aborting without coercion';
  END IF;

  ALTER TABLE public.property_acquisition_scores
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN id SET NOT NULL,
    ALTER COLUMN property_id SET NOT NULL,
    ALTER COLUMN evidence SET DEFAULT '{}'::jsonb,
    ALTER COLUMN evidence SET NOT NULL,
    ALTER COLUMN owner_situation_scores SET DEFAULT '{}'::jsonb,
    ALTER COLUMN owner_situation_scores SET NOT NULL,
    ALTER COLUMN recommended_offer_stack SET DEFAULT '{}'::jsonb,
    ALTER COLUMN recommended_offer_stack SET NOT NULL,
    ALTER COLUMN computed_at SET DEFAULT now(),
    ALTER COLUMN computed_at SET NOT NULL,
    ALTER COLUMN created_at SET DEFAULT now(),
    ALTER COLUMN created_at SET NOT NULL;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.property_acquisition_scores'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE public.property_acquisition_scores
      ADD CONSTRAINT property_acquisition_scores_pkey PRIMARY KEY (id);
  END IF;
END
$$;

-- A unique btree index both enforces property_id uniqueness and serves direct
-- property_id lookups and ON CONFLICT (property_id) upserts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_property_acquisition_scores_property_id
  ON public.property_acquisition_scores (property_id);

DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT *
    FROM (
      VALUES
        (
          'property_acquisition_scores_valuation_confidence_check',
          'valuation_confidence IS NULL OR valuation_confidence BETWEEN 0 AND 100'
        ),
        (
          'property_acquisition_scores_comp_count_check',
          'comp_count IS NULL OR comp_count >= 0'
        ),
        (
          'property_acquisition_scores_buyer_demand_check',
          'buyer_demand_score IS NULL OR buyer_demand_score BETWEEN 0 AND 100'
        ),
        (
          'property_acquisition_scores_liquidity_check',
          'liquidity_score IS NULL OR liquidity_score BETWEEN 0 AND 100'
        ),
        (
          'property_acquisition_scores_subject_to_check',
          'subject_to_score IS NULL OR subject_to_score BETWEEN 0 AND 100'
        ),
        (
          'property_acquisition_scores_seller_finance_check',
          'seller_finance_score IS NULL OR seller_finance_score BETWEEN 0 AND 100'
        ),
        (
          'property_acquisition_scores_lease_option_check',
          'lease_option_score IS NULL OR lease_option_score BETWEEN 0 AND 100'
        ),
        (
          'property_acquisition_scores_novation_check',
          'novation_score IS NULL OR novation_score BETWEEN 0 AND 100'
        ),
        (
          'property_acquisition_scores_aos_check',
          'aos_score IS NULL OR aos_score BETWEEN 0 AND 1000'
        ),
        (
          'property_acquisition_scores_confidence_check',
          'confidence IS NULL OR confidence BETWEEN 0 AND 100'
        ),
        (
          'property_acquisition_scores_decision_tier_check',
          $constraint$
            decision_tier IS NULL OR decision_tier IN (
              'AUTO_HARD_OFFER',
              'AUTO_RANGE_OFFER',
              'CREATIVE_TERMS',
              'NURTURE',
              'REVIEW_REQUIRED'
            )
          $constraint$
        ),
        (
          'property_acquisition_scores_phase2_bounded_scores_check',
          $constraint$
            (seller_financial_pressure_score IS NULL OR seller_financial_pressure_score BETWEEN 0 AND 100)
            AND (forced_sale_pressure_score IS NULL OR forced_sale_pressure_score BETWEEN 0 AND 100)
            AND (foreclosure_risk_score IS NULL OR foreclosure_risk_score BETWEEN 0 AND 100)
            AND (transaction_probability_90 IS NULL OR transaction_probability_90 BETWEEN 0 AND 100)
            AND (transaction_probability_180 IS NULL OR transaction_probability_180 BETWEEN 0 AND 100)
            AND (transaction_probability_365 IS NULL OR transaction_probability_365 BETWEEN 0 AND 100)
            AND (landlord_fatigue_score IS NULL OR landlord_fatigue_score BETWEEN 0 AND 100)
            AND (tax_pain_score IS NULL OR tax_pain_score BETWEEN 0 AND 100)
            AND (equity_unlock_score IS NULL OR equity_unlock_score BETWEEN 0 AND 100)
            AND (debt_pressure_score IS NULL OR debt_pressure_score BETWEEN 0 AND 100)
            AND (repair_burden_score IS NULL OR repair_burden_score BETWEEN 0 AND 100)
            AND (offer_aggression_score IS NULL OR offer_aggression_score BETWEEN 0 AND 100)
          $constraint$
        )
    ) AS checks(constraint_name, check_expression)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = 'public.property_acquisition_scores'::regclass
        AND conname = item.constraint_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.property_acquisition_scores ADD CONSTRAINT %I CHECK (%s)',
        item.constraint_name,
        item.check_expression
      );
    END IF;
  END LOOP;
END
$$;

CREATE INDEX IF NOT EXISTS idx_property_acquisition_scores_decision_tier
  ON public.property_acquisition_scores (decision_tier);

CREATE INDEX IF NOT EXISTS idx_property_acquisition_scores_aos
  ON public.property_acquisition_scores (aos_score DESC);

CREATE INDEX IF NOT EXISTS idx_property_acquisition_scores_owner_situation_primary
  ON public.property_acquisition_scores (owner_situation_primary);

CREATE INDEX IF NOT EXISTS idx_property_acquisition_scores_transaction_probability_365
  ON public.property_acquisition_scores (transaction_probability_365 DESC);

CREATE INDEX IF NOT EXISTS idx_property_acquisition_scores_computed_at
  ON public.property_acquisition_scores (computed_at DESC);

ALTER TABLE public.property_acquisition_scores ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'property_acquisition_scores'
      AND policyname = 'property_acquisition_scores_service_role_all'
  ) THEN
    CREATE POLICY property_acquisition_scores_service_role_all
      ON public.property_acquisition_scores
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END
$$;

REVOKE ALL ON TABLE public.property_acquisition_scores FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.property_acquisition_scores
  TO service_role;

COMMENT ON TABLE public.property_acquisition_scores IS
  'Deterministic property valuation, offer, creative-finance, owner-situation, transaction-probability, confidence, and evidence output.';

COMMENT ON COLUMN public.property_acquisition_scores.property_id IS
  'Canonical properties.property_id. Production source identifiers are stored as text.';

COMMENT ON COLUMN public.property_acquisition_scores.evidence IS
  'Explainable inputs, selected/rejected comps, feature scores, valuation math, strategy reasoning, confidence, and decision gates.';

COMMENT ON COLUMN public.property_acquisition_scores.seller_financial_pressure_score IS
  'Deterministic 0-100 seller financial pressure score based only on observed financial and property signals.';

COMMENT ON COLUMN public.property_acquisition_scores.owner_situation_scores IS
  'Deterministic scores for distress, landlord fatigue, wealth preservation, estate transition, portfolio rebalancing, debt pressure, asset performance, retail, and creative-finance situations.';

COMMENT ON COLUMN public.property_acquisition_scores.recommended_offer_stack IS
  'Non-executing offer and conversation strategy recommendation. This field does not enqueue or send messages.';

COMMIT;

-- ---------------------------------------------------------------------------
-- Validation 1: table exists and property_id is the production-compatible type.
-- Expected: table_exists = true, data_type = text, is_nullable = NO.
-- ---------------------------------------------------------------------------

SELECT
  to_regclass('public.property_acquisition_scores') IS NOT NULL AS table_exists,
  (
    SELECT c.data_type
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'property_acquisition_scores'
      AND c.column_name = 'property_id'
  ) AS data_type,
  (
    SELECT c.is_nullable
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'property_acquisition_scores'
      AND c.column_name = 'property_id'
  ) AS is_nullable;

-- ---------------------------------------------------------------------------
-- Validation 2: all required columns exist with the expected data types.
-- Expected: zero rows. Any returned row is missing or has the wrong type.
-- ---------------------------------------------------------------------------

WITH expected(column_name, data_type) AS (
  VALUES
    ('id', 'uuid'),
    ('property_id', 'text'),
    ('valuation_low', 'numeric'),
    ('valuation_mid', 'numeric'),
    ('valuation_high', 'numeric'),
    ('valuation_confidence', 'integer'),
    ('comp_count', 'integer'),
    ('weighted_comp_score', 'numeric'),
    ('investor_ceiling_low', 'numeric'),
    ('investor_ceiling_mid', 'numeric'),
    ('investor_ceiling_high', 'numeric'),
    ('buyer_demand_score', 'integer'),
    ('liquidity_score', 'integer'),
    ('estimated_repairs', 'numeric'),
    ('recommended_cash_offer', 'numeric'),
    ('minimum_acceptable_offer', 'numeric'),
    ('expected_assignment_fee', 'numeric'),
    ('subject_to_score', 'integer'),
    ('seller_finance_score', 'integer'),
    ('lease_option_score', 'integer'),
    ('novation_score', 'integer'),
    ('best_strategy', 'text'),
    ('aos_score', 'integer'),
    ('confidence', 'integer'),
    ('decision_tier', 'text'),
    ('evidence', 'jsonb'),
    ('computed_at', 'timestamp with time zone'),
    ('created_at', 'timestamp with time zone'),
    ('seller_financial_pressure_score', 'integer'),
    ('forced_sale_pressure_score', 'integer'),
    ('foreclosure_risk_score', 'integer'),
    ('transaction_probability_90', 'integer'),
    ('transaction_probability_180', 'integer'),
    ('transaction_probability_365', 'integer'),
    ('landlord_fatigue_score', 'integer'),
    ('tax_pain_score', 'integer'),
    ('equity_unlock_score', 'integer'),
    ('debt_pressure_score', 'integer'),
    ('repair_burden_score', 'integer'),
    ('offer_aggression_score', 'integer'),
    ('owner_situation_primary', 'text'),
    ('owner_situation_scores', 'jsonb'),
    ('recommended_conversation_angle', 'text'),
    ('recommended_offer_stack', 'jsonb')
)
SELECT
  e.column_name,
  e.data_type AS expected_type,
  c.data_type AS actual_type
FROM expected e
LEFT JOIN information_schema.columns c
  ON c.table_schema = 'public'
 AND c.table_name = 'property_acquisition_scores'
 AND c.column_name = e.column_name
WHERE c.column_name IS NULL
   OR c.data_type <> e.data_type
ORDER BY e.column_name;

-- ---------------------------------------------------------------------------
-- Validation 3: required indexes exist.
-- Expected: five rows, each with index_exists = true.
-- ---------------------------------------------------------------------------

WITH expected(index_name) AS (
  VALUES
    ('idx_property_acquisition_scores_property_id'),
    ('idx_property_acquisition_scores_decision_tier'),
    ('idx_property_acquisition_scores_aos'),
    ('idx_property_acquisition_scores_owner_situation_primary'),
    ('idx_property_acquisition_scores_transaction_probability_365')
)
SELECT
  e.index_name,
  p.indexname IS NOT NULL AS index_exists,
  p.indexdef
FROM expected e
LEFT JOIN pg_indexes p
  ON p.schemaname = 'public'
 AND p.tablename = 'property_acquisition_scores'
 AND p.indexname = e.index_name
ORDER BY e.index_name;

-- ---------------------------------------------------------------------------
-- Validation 4: RLS and service-role policy exist.
-- Expected: rls_enabled = true, service_role_policy_exists = true.
-- ---------------------------------------------------------------------------

SELECT
  c.relrowsecurity AS rls_enabled,
  EXISTS (
    SELECT 1
    FROM pg_policies p
    WHERE p.schemaname = 'public'
      AND p.tablename = 'property_acquisition_scores'
      AND p.policyname = 'property_acquisition_scores_service_role_all'
  ) AS service_role_policy_exists
FROM pg_class c
JOIN pg_namespace n
  ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'property_acquisition_scores';

-- ---------------------------------------------------------------------------
-- Validation 5: insert and true conflict-update test. Everything is rolled back.
-- Expected inside the transaction: one row with upsert_pass = true and
-- transaction_probability_365 = 65. No validation row survives ROLLBACK.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TEMP TABLE acquisition_score_validation_key
AS
SELECT
  '__acquisition_score_validation__' || gen_random_uuid()::text AS property_id;

INSERT INTO public.property_acquisition_scores (
  property_id,
  valuation_mid,
  valuation_confidence,
  aos_score,
  confidence,
  decision_tier,
  transaction_probability_365,
  owner_situation_primary,
  owner_situation_scores,
  recommended_conversation_angle,
  recommended_offer_stack,
  evidence
)
SELECT
  property_id,
  250000,
  70,
  600,
  70,
  'REVIEW_REQUIRED',
  55,
  'RETAIL_SELLER',
  '{"RETAIL_SELLER": 60}'::jsonb,
  'CONDITION_AND_TIMELINE_DISCOVERY',
  '{"primary_offer_to_lead_with": "CASH"}'::jsonb,
  '{"validation": "initial_insert"}'::jsonb
FROM acquisition_score_validation_key
ON CONFLICT (property_id) DO UPDATE
SET
  valuation_mid = EXCLUDED.valuation_mid,
  computed_at = now(),
  evidence = EXCLUDED.evidence;

INSERT INTO public.property_acquisition_scores (
  property_id,
  valuation_mid,
  valuation_confidence,
  aos_score,
  confidence,
  decision_tier,
  transaction_probability_365,
  owner_situation_primary,
  owner_situation_scores,
  recommended_conversation_angle,
  recommended_offer_stack,
  evidence
)
SELECT
  property_id,
  255000,
  72,
  620,
  72,
  'AUTO_RANGE_OFFER',
  65,
  'WEALTH_PRESERVATION',
  '{"WEALTH_PRESERVATION": 68}'::jsonb,
  'TAX_EFFICIENT_EQUITY_EXIT',
  '{"primary_offer_to_lead_with": "SELLER_FINANCE"}'::jsonb,
  '{"validation": "conflict_update"}'::jsonb
FROM acquisition_score_validation_key
ON CONFLICT (property_id) DO UPDATE
SET
  valuation_mid = EXCLUDED.valuation_mid,
  valuation_confidence = EXCLUDED.valuation_confidence,
  aos_score = EXCLUDED.aos_score,
  confidence = EXCLUDED.confidence,
  decision_tier = EXCLUDED.decision_tier,
  transaction_probability_365 = EXCLUDED.transaction_probability_365,
  owner_situation_primary = EXCLUDED.owner_situation_primary,
  owner_situation_scores = EXCLUDED.owner_situation_scores,
  recommended_conversation_angle = EXCLUDED.recommended_conversation_angle,
  recommended_offer_stack = EXCLUDED.recommended_offer_stack,
  computed_at = now(),
  evidence = EXCLUDED.evidence;

SELECT
  s.property_id,
  s.valuation_mid,
  s.decision_tier,
  s.transaction_probability_365,
  s.owner_situation_primary,
  s.evidence ->> 'validation' = 'conflict_update' AS upsert_pass
FROM public.property_acquisition_scores s
JOIN acquisition_score_validation_key v
  ON v.property_id = s.property_id;

ROLLBACK;
