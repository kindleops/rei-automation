-- ════════════════════════════════════════════════════════════════════════
-- Supabase-native title-routing substrate (Slice 3).
--
-- Normalizes the ORIGINAL title-routing architecture rather than inventing one:
--   * The market layer is the existing canonical registry — lib/config/markets.js
--     (36 markets) plus MARKET_ALIASES / normalizeMarketLabel in
--     lib/config/market-sending-zones.js. Routes are keyed by the same canonical
--     market LABEL those modules produce ("Miami, FL"), not a new market id.
--   * The company columns mirror the original Podio "Title Companies" app field
--     set consumed by domain/title/select-title-company.js
--     (TITLE_COMPANY_FIELDS: title, market, contact-manager, new-order-email,
--     phone), so this is a faithful normalization of the prior schema.
--   * The prior selection semantics (filter by market, best-first, take one)
--     become an explicit ranked route: rank 1 = primary, rank 2 = backup.
--
-- NO VENDOR DATA IS SEEDED HERE. The original vendor records lived only in the
-- Podio Title Companies app, which is not in service and is not recoverable
-- from this repository, its full git history, or the production database
-- (searched: no CSV/JSON/SQL export, no Supabase title/escrow/vendor table,
-- wire_accounts holds our own bank accounts). Inventing company names or
-- contacts would fabricate vendor relationships, so the tables ship EMPTY and
-- routing fails closed with `title_route_unavailable` until the operator seeds
-- the real records.
--
-- ADDITIVE ONLY. Rollback = DROP the two tables + the added closing_cases columns.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.title_companies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_company_key   text UNIQUE NOT NULL,
  name                text NOT NULL,
  -- Mirrors the Podio TITLE_COMPANY_FIELDS the selector already consumed.
  contact_manager     text,
  new_order_email     text,
  phone               text,
  is_active           boolean NOT NULL DEFAULT true,
  -- Provenance of the record itself (where the vendor data came from).
  source_system       text NOT NULL DEFAULT 'operator_seed',
  source_version      text,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_title_companies_active ON public.title_companies (is_active);

DROP TRIGGER IF EXISTS trg_title_companies_updated_at ON public.title_companies;
CREATE TRIGGER trg_title_companies_updated_at
  BEFORE UPDATE ON public.title_companies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Market -> ranked title companies. route_rank 1 = primary, 2 = backup.
CREATE TABLE IF NOT EXISTS public.title_company_market_routes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market              text NOT NULL,
  title_company_key   text NOT NULL REFERENCES public.title_companies(title_company_key) ON DELETE CASCADE,
  route_rank          integer NOT NULL,
  is_active           boolean NOT NULL DEFAULT true,
  route_version       text NOT NULL DEFAULT 'v1',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT title_route_rank_check CHECK (route_rank >= 1)
);

-- Determinism: at most one ACTIVE company per (market, rank), so a market can
-- never present two primaries and selection cannot depend on row order.
CREATE UNIQUE INDEX IF NOT EXISTS uq_title_route_market_rank
  ON public.title_company_market_routes (market, route_rank)
  WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_title_routes_market ON public.title_company_market_routes (market, route_rank);

DROP TRIGGER IF EXISTS trg_title_routes_updated_at ON public.title_company_market_routes;
CREATE TRIGGER trg_title_routes_updated_at
  BEFORE UPDATE ON public.title_company_market_routes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Routing decision persisted on the closing case ───────────────────────────
ALTER TABLE public.closing_cases ADD COLUMN IF NOT EXISTS title_company_key        text;
ALTER TABLE public.closing_cases ADD COLUMN IF NOT EXISTS title_company_name       text;
ALTER TABLE public.closing_cases ADD COLUMN IF NOT EXISTS title_company_email      text;
ALTER TABLE public.closing_cases ADD COLUMN IF NOT EXISTS title_route_market       text;
ALTER TABLE public.closing_cases ADD COLUMN IF NOT EXISTS title_route_rank         integer;
ALTER TABLE public.closing_cases ADD COLUMN IF NOT EXISTS title_route_source       text;
ALTER TABLE public.closing_cases ADD COLUMN IF NOT EXISTS title_route_version      text;
ALTER TABLE public.closing_cases ADD COLUMN IF NOT EXISTS title_route_status       text;
ALTER TABLE public.closing_cases ADD COLUMN IF NOT EXISTS title_company_selected_at timestamptz;
ALTER TABLE public.closing_cases ADD COLUMN IF NOT EXISTS title_intro_sent_at      timestamptz;

CREATE INDEX IF NOT EXISTS idx_closing_cases_title_route_status
  ON public.closing_cases (title_route_status);

-- ── Access posture: service-role only (matches closing_cases) ────────────────
ALTER TABLE public.title_companies             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.title_company_market_routes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.title_companies             FROM anon, authenticated;
REVOKE ALL ON public.title_company_market_routes FROM anon, authenticated;
