-- PROPOSED — NOT APPLIED. Seller Situation v2 slim score store (Acquisition OS §5–9, owner A1, 2026-10-07).
--
-- Purpose: persist seller_situation_v2 / raw_facts_v1 (apps/api/src/lib/acquisition/seller-situation)
-- for every property, nationwide, at ≈1.1 KB of row payload per property — NOT inside
-- property_acquisition_scores (≈92 KB/row today, 90% comp evidence; that table stays the
-- offer engine's and is untouched here).
--
-- Changes (all additive, no existing table touched):
--   1. public.seller_situation_scores          one row per property (PK property_id; upsert target)
--   2. public.seller_situation_evidence_sources  index -> 'table.field' (evidence tuples reference it)
--   3. public.seller_situation_evidence_codes    code -> label / kind (why-targeted labels; internal only)
--   4. public.seller_situation_score_failures    failed property ids per run (§9: logged separately)
--   5. system_control['seller_scoring_raw_facts'] = 'false'  (runtime half of the SELLER_SCORING_RAW_FACTS
--      double gate; the env ceiling must ALSO be 'true'), and
--      system_control['seller_situation_scoring_backfill'] = stopped state.
--   Nothing runs or changes behaviour when this is applied: the runner only writes after an operator
--   starts it (RUNBOOK.md) and the engine path stays OFF until BOTH flag halves are on.
--
-- Evidence encoding: evidence = jsonb array of [code, points, component_index, source_index, value?]
--   component_index → 0 forced_sale_pressure, 1 landlord_fatigue, 2 equity_unlock, 3 property_burden,
--   4 tax_pain, 5 debt_pressure; source_index → seller_situation_evidence_sources.idx. value is omitted
--   when it is boolean true. Decoder: codec.js decodeEvidence().
-- Size (measured on 10,856 real properties): payload mean 1,117 B; with tuple header + index ≈ 1.8–2.2 KB
--   on disk; 176,610 properties ≈ 0.35–0.45 GB total (vs 25–35 GB if full engine evidence were stored).
--
-- Rollback: PROPOSED_20261007071100_seller_situation_scores_rollback.sql

BEGIN;

CREATE TABLE IF NOT EXISTS public.seller_situation_scores (
  property_id text PRIMARY KEY,
  score_version text NOT NULL,
  input_model_version text NOT NULL,
  weights_version text NOT NULL,
  scored_at timestamptz NOT NULL,
  forced_sale_pressure smallint CHECK (forced_sale_pressure BETWEEN 0 AND 100),
  landlord_fatigue smallint CHECK (landlord_fatigue BETWEEN 0 AND 100),
  equity_unlock smallint CHECK (equity_unlock BETWEEN 0 AND 100),
  property_burden smallint CHECK (property_burden BETWEEN 0 AND 100),
  tax_pain smallint CHECK (tax_pain BETWEEN 0 AND 100),
  debt_pressure smallint CHECK (debt_pressure BETWEEN 0 AND 100),
  sell_p90 smallint CHECK (sell_p90 BETWEEN 0 AND 100),
  sell_p180 smallint CHECK (sell_p180 BETWEEN 0 AND 100),
  sell_p365 smallint CHECK (sell_p365 BETWEEN 0 AND 100),
  seller_situation text NOT NULL,
  conversation_angle text,
  opportunity_tier text NOT NULL CHECK (opportunity_tier IN ('A','B','C','UNKNOWN')),
  tier_reasons text[] NOT NULL DEFAULT '{}',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  coverage numeric(4,3),
  missing_fields text[] NOT NULL DEFAULT '{}',
  confidence numeric(4,3),
  features_as_of date,
  legacy_final_acquisition_score numeric,
  run_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.seller_situation_scores IS
  'Seller Situation v2 (raw_facts_v1): who to contact and why. Targeting / ranking / angle ONLY — never monetary authority (Acquisition OS §75). Slim: evidence is compact tuples, see seller_situation_evidence_sources / _codes.';
COMMENT ON COLUMN public.seller_situation_scores.legacy_final_acquisition_score IS
  'Podio-era properties.final_acquisition_score at scoring time. SHADOW COMPARISON ONLY — never an input (§3).';
COMMENT ON COLUMN public.seller_situation_scores.sell_p365 IS
  'Transparent heuristic index (percent), not a calibrated probability until the §10 calibration is signed off.';

-- Composer / screener access paths (A2): tier + sell_p365 ordering, forced-sale screens.
CREATE INDEX IF NOT EXISTS idx_seller_situation_scores_tier_p365
  ON public.seller_situation_scores (opportunity_tier, sell_p365 DESC);
CREATE INDEX IF NOT EXISTS idx_seller_situation_scores_forced_sale
  ON public.seller_situation_scores (forced_sale_pressure DESC) WHERE forced_sale_pressure >= 40;

CREATE TABLE IF NOT EXISTS public.seller_situation_evidence_sources (
  idx smallint PRIMARY KEY,
  source text NOT NULL UNIQUE
);
INSERT INTO public.seller_situation_evidence_sources (idx, source) VALUES
  (0, 'unknown.unknown'),
  (1, 'properties.property_flags_text'),
  (2, 'seller.property_features_v1.lien_tax_delinquent'),
  (3, 'properties.tax_delinquent'),
  (4, 'seller.property_features_v1.lien_tax_delinq_years'),
  (5, 'seller.property_features_v1.lien_has_tax'),
  (6, 'seller.property_features_v1.lien_active'),
  (7, 'properties.active_lien'),
  (8, 'seller.property_features_v1.lien_has_judgment'),
  (9, 'seller.property_features_v1.lien_has_lis_pendens'),
  (10, 'seller.property_features_v1.lien_has_municipal'),
  (11, 'seller.property_features_v1.lien_has_hoa'),
  (12, 'seller.property_features_v1.lien_total_amount_due'),
  (13, 'seller.property_features_v1.fcl_any'),
  (14, 'properties.is_preforeclosure'),
  (15, 'seller.property_features_v1.fcl_stale_nod'),
  (16, 'seller.property_features_v1.fcl_stage'),
  (17, 'seller.property_features_v1.fcl_auction_within_90d'),
  (18, 'seller.property_features_v1.life_probate'),
  (19, 'seller.property_features_v1.life_death_event'),
  (20, 'seller.property_features_v1.ent_owner_dissolved'),
  (21, 'seller.property_features_v1.phy_is_vacant'),
  (22, 'seller.property_features_v1.own_owner_occupied'),
  (23, 'seller.property_features_v1.own_absentee'),
  (24, 'seller.property_features_v1.own_absentee_class'),
  (25, 'properties.out_of_state_owner'),
  (26, 'seller.property_features_v1.own_is_corporate'),
  (27, 'properties.is_corporate_owner'),
  (28, 'seller.property_features_v1.own_is_bank_reo'),
  (29, 'seller.property_features_v1.own_tenure_years'),
  (30, 'properties.ownership_years'),
  (31, 'seller.property_features_v1.prt_total_properties'),
  (32, 'seller.property_features_v1.prt_tired_landlord_corroborated'),
  (33, 'seller.property_features_v1.val_estimated_value'),
  (34, 'properties.estimated_value'),
  (35, 'seller.property_features_v1.eqt_equity_percent'),
  (36, 'properties.equity_percent'),
  (37, 'seller.property_features_v1.eqt_free_and_clear'),
  (38, 'seller.property_features_v1.eqt_high_equity_corroborated'),
  (39, 'seller.property_features_v1.eqt_ltv'),
  (40, 'seller.property_features_v1.dbt_total_balance'),
  (41, 'properties.total_loan_balance'),
  (42, 'seller.property_features_v1.dbt_total_payment_mo'),
  (43, 'properties.total_loan_payment'),
  (44, 'seller.property_features_v1.dbt_payment_to_value'),
  (45, 'seller.property_features_v1.dbt_has_adjustable'),
  (46, 'seller.property_features_v1.dbt_maturity_within_24m'),
  (47, 'seller.property_features_v1.dbt_junior_lien_count'),
  (48, 'seller.property_features_v1.val_tax_amount'),
  (49, 'properties.tax_amt'),
  (50, 'seller.property_features_v1.val_eff_tax_rate'),
  (51, 'seller.property_features_v1.txn_appreciation_ratio'),
  (52, 'seller.property_features_v1.txn_price_reliable'),
  (53, 'seller.property_features_v1.phy_condition_class'),
  (54, 'properties.building_condition'),
  (55, 'seller.property_features_v1.phy_year_built'),
  (56, 'properties.year_built'),
  (57, 'seller.property_features_v1.phy_repair_tier'),
  (58, 'seller.property_features_v1.phy_asset_class'),
  (59, 'properties.normalized_asset_class'),
  (60, 'seller.property_features_v1.phy_units_count'),
  (61, 'properties.units_count'),
  (62, 'seller.property_features_v1.dsp_buyer_liquidity'),
  (63, 'seller.property_features_v1.mkt_sale_velocity_5y'),
  (64, 'seller.property_features_v1.as_of_date'),
  (65, 'properties.owner_location'),
  (66, 'properties.is_foreclosure'),
  (67, 'properties.is_pre_foreclosure'),
  (68, 'properties.is_hot_preforeclosure'),
  (69, 'properties.is_hot_pre_foreclosure');
-- (ON CONFLICT is intentionally absent: the registry is append-only; a clash means the code and the table disagree.)

CREATE TABLE IF NOT EXISTS public.seller_situation_evidence_codes (
  code text PRIMARY KEY,
  label text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('hard','strong','support','context'))
);
INSERT INTO public.seller_situation_evidence_codes (code, label, kind) VALUES
  ('FORECLOSURE_ACTIVE', 'Foreclosure filing (recorded)', 'hard'),
  ('FORECLOSURE_STALE_NOD', 'Old notice of default (stale)', 'context'),
  ('AUCTION_WITHIN_90D', 'Auction within 90 days', 'hard'),
  ('VF_PREFORECLOSURE', 'Preforeclosure (DealMachine flag)', 'hard'),
  ('TAX_DELINQUENT', 'Tax delinquent', 'hard'),
  ('TAX_DELINQUENT_MULTI_YEAR', 'Tax delinquent 2+ years', 'hard'),
  ('VF_TAX_DELINQUENT', 'Tax delinquent (DealMachine flag)', 'hard'),
  ('TAX_LIEN', 'Recorded tax lien', 'hard'),
  ('LIS_PENDENS', 'Lis pendens recorded', 'hard'),
  ('JUDGMENT_LIEN', 'Judgment lien', 'hard'),
  ('MUNICIPAL_LIEN', 'Municipal lien (code/utility)', 'hard'),
  ('MUNICIPAL_LIEN_UPKEEP', 'Municipal lien (upkeep burden)', 'context'),
  ('HOA_LIEN', 'HOA lien', 'hard'),
  ('LIEN_RECORDED', 'Recorded lien', 'hard'),
  ('VF_ACTIVE_LIEN', 'Active lien (DealMachine flag)', 'hard'),
  ('LIEN_AMOUNT_GE_5PCT_VALUE', 'Liens ≥ 5% of value', 'context'),
  ('PROBATE', 'Probate filing', 'hard'),
  ('DEATH_EVENT', 'Owner death recorded', 'hard'),
  ('VF_PROBATE', 'Probate (DealMachine flag)', 'hard'),
  ('VACANT', 'Vacant', 'hard'),
  ('VF_VACANT', 'Vacant (DealMachine flag)', 'hard'),
  ('VACANT_UPKEEP', 'Vacant (upkeep burden)', 'context'),
  ('VACANT_RENTAL', 'Vacant rental', 'context'),
  ('ENTITY_DISSOLVED', 'Owning entity dissolved', 'strong'),
  ('CONDITION_UNSOUND', 'Condition: unsound', 'hard'),
  ('CONDITION_POOR', 'Condition: poor', 'hard'),
  ('CONDITION_FAIR', 'Condition: fair', 'strong'),
  ('VF_HEAVILY_DATED', 'Heavily dated (DealMachine flag)', 'support'),
  ('VF_NO_UPDATES', 'No updates (DealMachine flag)', 'context'),
  ('BUILT_PRE_1960', 'Built before 1960', 'support'),
  ('BUILT_PRE_1980', 'Built before 1980', 'context'),
  ('REPAIR_TIER_HEAVY_FORMULA', 'Heavy repair tier (formula estimate)', 'context'),
  ('ABSENTEE', 'Absentee owner', 'support'),
  ('OUT_OF_STATE', 'Out-of-state owner', 'strong'),
  ('RENTAL_ASSET_CLASS', 'Rental asset (2+ units)', 'context'),
  ('TENURE_20Y', 'Owned 20+ years', 'strong'),
  ('TENURE_15Y', 'Owned 15+ years', 'support'),
  ('TENURE_10Y', 'Owned 10+ years', 'context'),
  ('TENURE_5Y', 'Owned 5+ years', 'context'),
  ('PORTFOLIO_5P', 'Owns 5+ properties', 'strong'),
  ('PORTFOLIO_3P', 'Owns 3–4 properties', 'strong'),
  ('PORTFOLIO_2', 'Owns 2 properties', 'context'),
  ('TIRED_LANDLORD_CORROBORATED', 'Tired landlord (corroborated by portfolio)', 'strong'),
  ('VF_TIRED_LANDLORD', 'Tired landlord (DealMachine flag only)', 'context'),
  ('OLD_RENTAL_STOCK', 'Older rental (50+ yrs)', 'context'),
  ('RENTAL_CONDITION_BURDEN', 'Rental in fair/poor condition', 'context'),
  ('EQUITY_80P', 'Equity ≥ 80%', 'support'),
  ('EQUITY_60P', 'Equity ≥ 60%', 'support'),
  ('EQUITY_40P', 'Equity ≥ 40%', 'support'),
  ('EQUITY_20P', 'Equity ≥ 20%', 'context'),
  ('FREE_AND_CLEAR', 'Free and clear', 'support'),
  ('HIGH_EQUITY_CORROBORATED', 'High equity (corroborated)', 'context'),
  ('LONG_HOLD_EQUITY', 'Long hold (15+ yrs) equity', 'context'),
  ('MID_HOLD_EQUITY', 'Hold 10+ yrs equity', 'context'),
  ('VALUE_2X_PURCHASE', 'Value ≥ 2× purchase price', 'context'),
  ('NON_PRIMARY_EQUITY', 'Equity in a non-primary asset', 'context'),
  ('TAX_RATE_GE_2PCT', 'Property tax ≥ 2% of value', 'context'),
  ('TAX_RATE_GE_1_5PCT', 'Property tax ≥ 1.5% of value', 'context'),
  ('CAPITAL_GAINS_EXPOSURE', 'Large embedded gain (absentee, 10+ yrs)', 'context'),
  ('LTV_95P', 'Loan ≥ 95% of value', 'strong'),
  ('LTV_80P', 'Loan ≥ 80% of value', 'strong'),
  ('LTV_65P', 'Loan ≥ 65% of value', 'context'),
  ('LTV_45P', 'Loan ≥ 45% of value', 'context'),
  ('NEGATIVE_EQUITY', 'Negative equity', 'context'),
  ('PAYMENT_GE_6PCT_VALUE', 'Debt service ≥ 6% of value / yr', 'context'),
  ('FORECLOSURE_DEBT_ENFORCEMENT', 'Lender enforcing debt', 'context'),
  ('ARM_LOAN', 'Adjustable-rate loan', 'strong'),
  ('LOAN_MATURES_24M', 'Loan matures within 24 months', 'strong'),
  ('JUNIOR_LIEN', 'Junior mortgage lien', 'context');

CREATE TABLE IF NOT EXISTS public.seller_situation_score_failures (
  id bigserial PRIMARY KEY,
  property_id text NOT NULL,
  run_id text,
  run_version text,
  error text,
  transient boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seller_situation_score_failures_run
  ON public.seller_situation_score_failures (run_id, created_at DESC);

-- Service-role only (same posture as property_acquisition_scores).
ALTER TABLE public.seller_situation_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seller_situation_evidence_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seller_situation_evidence_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seller_situation_score_failures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seller_situation_scores, public.seller_situation_evidence_sources,
  public.seller_situation_evidence_codes, public.seller_situation_score_failures FROM anon, authenticated;

INSERT INTO public.system_control (key, value, updated_at) VALUES
  ('seller_scoring_raw_facts', 'false', now()),
  ('seller_situation_scoring_backfill', '{"status":"stopped"}', now())
ON CONFLICT (key) DO NOTHING;

COMMIT;
