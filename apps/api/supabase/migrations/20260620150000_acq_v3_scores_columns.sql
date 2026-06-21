-- Acquisition Engine V3 — additive lineage / valuation-universe / execution-state
-- columns on property_acquisition_scores.
--
-- ADDITIVE ONLY. Every column is nullable. No drops, no type changes, no data
-- rewrite. Safe to apply, but DO NOT apply blindly: repo migration history is
-- drifted vs prod (see docs/backend/acquisition_engine_v3_audit.md §6/§11 and
-- the project's migration-history notes). Apply via the team's reconciled
-- process, then reload the PostgREST schema cache (NOTIFY at bottom).

ALTER TABLE public.property_acquisition_scores
  -- model lineage / versioning (mission §26)
  ADD COLUMN IF NOT EXISTS engine_version            text,
  ADD COLUMN IF NOT EXISTS model_version             text,
  ADD COLUMN IF NOT EXISTS formula_version           text,
  ADD COLUMN IF NOT EXISTS input_data_as_of          timestamptz,
  ADD COLUMN IF NOT EXISTS active_feature_flags      jsonb,

  -- canonical asset classification (mission §1)
  ADD COLUMN IF NOT EXISTS canonical_asset_lane      text,
  ADD COLUMN IF NOT EXISTS asset_lane_confidence     integer,
  ADD COLUMN IF NOT EXISTS asset_lane_reasoning      jsonb,
  ADD COLUMN IF NOT EXISTS conflicting_asset_signals jsonb,

  -- separate valuation universes (mission §9, §13)
  ADD COLUMN IF NOT EXISTS retail_value_low          numeric,
  ADD COLUMN IF NOT EXISTS retail_value_mid          numeric,
  ADD COLUMN IF NOT EXISTS retail_value_high         numeric,
  ADD COLUMN IF NOT EXISTS investor_value_low        numeric,
  ADD COLUMN IF NOT EXISTS investor_value_mid        numeric,
  ADD COLUMN IF NOT EXISTS investor_value_high       numeric,
  ADD COLUMN IF NOT EXISTS institutional_value_low   numeric,
  ADD COLUMN IF NOT EXISTS institutional_value_mid   numeric,
  ADD COLUMN IF NOT EXISTS institutional_value_high  numeric,
  ADD COLUMN IF NOT EXISTS income_value_low          numeric,
  ADD COLUMN IF NOT EXISTS income_value_mid          numeric,
  ADD COLUMN IF NOT EXISTS income_value_high         numeric,
  ADD COLUMN IF NOT EXISTS liquidation_value_low     numeric,
  ADD COLUMN IF NOT EXISTS liquidation_value_mid     numeric,
  ADD COLUMN IF NOT EXISTS liquidation_value_high    numeric,
  ADD COLUMN IF NOT EXISTS subject_anchor_value_low  numeric,
  ADD COLUMN IF NOT EXISTS subject_anchor_value_mid  numeric,
  ADD COLUMN IF NOT EXISTS subject_anchor_value_high numeric,
  ADD COLUMN IF NOT EXISTS reconciled_value_low      numeric,
  ADD COLUMN IF NOT EXISTS reconciled_value_mid      numeric,
  ADD COLUMN IF NOT EXISTS reconciled_value_high     numeric,

  -- buyer exit (mission §15, §16)
  ADD COLUMN IF NOT EXISTS conservative_buyer_exit   numeric,
  ADD COLUMN IF NOT EXISTS base_buyer_exit           numeric,
  ADD COLUMN IF NOT EXISTS optimistic_buyer_exit     numeric,

  -- sample integrity (mission §2, §22) — independent transactions, not rows
  ADD COLUMN IF NOT EXISTS raw_comp_row_count        integer,
  ADD COLUMN IF NOT EXISTS independent_comp_count    integer,
  ADD COLUMN IF NOT EXISTS effective_sample_size     integer,

  -- model reconciliation (mission §13)
  ADD COLUMN IF NOT EXISTS model_disagreement_score  integer,
  ADD COLUMN IF NOT EXISTS dominant_model            text,
  ADD COLUMN IF NOT EXISTS secondary_model           text,

  -- execution / anomaly / clusters (mission §24, §2)
  ADD COLUMN IF NOT EXISTS execution_state           text,
  ADD COLUMN IF NOT EXISTS anomaly_flags             jsonb,
  ADD COLUMN IF NOT EXISTS transaction_cluster_summary jsonb,

  -- creative finance / offer ladder / returns (mission §16-§21)
  ADD COLUMN IF NOT EXISTS novation_terms            jsonb,
  ADD COLUMN IF NOT EXISTS creative_finance_terms    jsonb,
  ADD COLUMN IF NOT EXISTS offer_ladder              jsonb,
  ADD COLUMN IF NOT EXISTS return_metrics            jsonb,

  -- multi-dimensional confidence + full V3 evidence (mission §22, §25)
  ADD COLUMN IF NOT EXISTS confidence_components     jsonb,
  ADD COLUMN IF NOT EXISTS v3_evidence               jsonb;

-- Lightweight indexes for model-health / anomaly queries (mission §30).
CREATE INDEX IF NOT EXISTS idx_pas_execution_state
  ON public.property_acquisition_scores (execution_state);
CREATE INDEX IF NOT EXISTS idx_pas_canonical_asset_lane
  ON public.property_acquisition_scores (canonical_asset_lane);
CREATE INDEX IF NOT EXISTS idx_pas_anomaly_flags
  ON public.property_acquisition_scores USING gin (anomaly_flags);

-- Reload PostgREST schema cache so new columns are immediately selectable
-- (prevents PGRST204 on the first V3 upsert — see audit §7).
NOTIFY pgrst, 'reload schema';
