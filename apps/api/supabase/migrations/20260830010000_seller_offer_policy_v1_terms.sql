-- ════════════════════════════════════════════════════════════════════════
-- SELLER_OFFER_POLICY_V1 durable contractual terms.
--
-- The offer package must carry the EXACT numeric values (not just prose), so a
-- contract can be reconstructed from the accepted offer alone. policy_version
-- stamps which policy produced them, so a future policy change is auditable and
-- never retroactively reinterprets an offer that was already sent or accepted.
--
-- Values live in ONE place in code: lib/domain/seller-flow/seller-offer-policy.js
-- (closing_window_days=14, earnest_money_amount=1000,
--  earnest_money_due_business_days=3, policy_version="v1").
--
-- ADDITIVE ONLY. Rollback = DROP these four columns + the index.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE public.seller_offers ADD COLUMN IF NOT EXISTS closing_window_days     integer;
ALTER TABLE public.seller_offers ADD COLUMN IF NOT EXISTS emd_due_business_days   integer;
ALTER TABLE public.seller_offers ADD COLUMN IF NOT EXISTS emd_due_date            date;
ALTER TABLE public.seller_offers ADD COLUMN IF NOT EXISTS policy_version          text;

CREATE INDEX IF NOT EXISTS idx_seller_offers_policy_version ON public.seller_offers (policy_version);
