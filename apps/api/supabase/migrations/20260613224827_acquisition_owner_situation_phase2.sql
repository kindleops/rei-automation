-- Phase 2 Acquisition Decision Engine outputs.
--
-- Additive only: no existing columns, policies, indexes, or rows are removed.

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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'property_acquisition_scores_phase2_bounded_scores_check'
      AND conrelid = 'public.property_acquisition_scores'::regclass
  ) THEN
    ALTER TABLE public.property_acquisition_scores
      ADD CONSTRAINT property_acquisition_scores_phase2_bounded_scores_check
      CHECK (
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
      );
  END IF;
END
$$;

COMMENT ON COLUMN public.property_acquisition_scores.seller_financial_pressure_score IS
  'Deterministic 0-100 seller financial pressure score based only on observed financial and property signals.';
COMMENT ON COLUMN public.property_acquisition_scores.owner_situation_scores IS
  'Deterministic scores for distress, landlord fatigue, wealth preservation, estate transition, portfolio rebalancing, debt pressure, asset performance, retail, and creative-finance situations.';
COMMENT ON COLUMN public.property_acquisition_scores.recommended_offer_stack IS
  'Non-executing offer and conversation strategy recommendation. This field does not enqueue or send messages.';
