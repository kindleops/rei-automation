-- ════════════════════════════════════════════════════════════════════════════
-- CANONICAL MARKET GEOGRAPHY — part 2 of 3: properties backfill and the
-- ingestion boundary. Part 3 (20260924140200) carries it into the graph.
--
-- Requires part 1 (20260924140000). Raw geography — property_address_city,
-- _county_name, _state, _zip and the visible address — is NEVER written.
--
-- properties.market becomes a MIRROR of canonical_market_id: the canonical
-- display name, or NULL when the geography resolves to no operating market.
-- Thirty-odd views, the campaign graph and the feeders already read
-- properties.market; correcting it at the source is what makes every one of
-- them canonical without a parallel resolver in each.
--
-- Dry run on 2026-09-24 (169,802 properties): 169,761 resolve by ZIP, 33 by
-- county, 8 unresolved (Ashtabula OH, Bainbridge GA ×6, Hopkinsville KY — no
-- operating market there). 45,749 unlabelled rows gain a market; 13,071
-- labels change; 110,974 are already canonical.
--
-- ROLLBACK: canonical_market_backfill_log holds every changed row's previous
-- label. Restoring is
--   UPDATE properties p SET market = l.old_market
--   FROM canonical_market_backfill_log l
--   WHERE l.table_name = 'properties' AND l.row_id = p.property_id;
-- after dropping trg_properties_canonical_market (which would re-canonicalise).
-- ════════════════════════════════════════════════════════════════════════════

-- ── columns ───────────────────────────────────────────────────────────────
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS canonical_market_id text REFERENCES public.canonical_markets(id),
  ADD COLUMN IF NOT EXISTS canonical_market_source text,
  ADD COLUMN IF NOT EXISTS source_market_label text;

COMMENT ON COLUMN public.properties.canonical_market_id IS
  'Operating market identity, from resolve_canonical_market(). properties.market mirrors its display name.';
COMMENT ON COLUMN public.properties.canonical_market_source IS
  'How the market was resolved: zip | county | alias | existing_label | unresolved | ambiguous.';
COMMENT ON COLUMN public.properties.source_market_label IS
  'The market label a writer supplied (import, list, sync) before canonicalisation. Evidence, never displayed as the market.';

CREATE INDEX IF NOT EXISTS properties_canonical_market_id_idx ON public.properties (canonical_market_id);

CREATE TABLE IF NOT EXISTS public.canonical_market_backfill_log (
  id            bigserial PRIMARY KEY,
  table_name    text NOT NULL,
  row_id        text NOT NULL,
  old_market    text,
  new_market_id text,
  new_market    text,
  source        text,
  backfilled_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.canonical_market_backfill_log IS
  'Every row whose market label the 2026-09-24 canonical backfill changed, with its previous value — the rollback and reconciliation record.';

ALTER TABLE public.canonical_market_backfill_log ENABLE ROW LEVEL SECURITY;

-- ── backfill properties (idempotent: only rows whose values differ) ──────
-- updated_at is left alone: the geography did not change, only its market.
ALTER TABLE public.properties DISABLE TRIGGER trg_properties_updated_at;

CREATE TEMP TABLE _canonical_market_resolution ON COMMIT DROP AS
SELECT p.property_id,
       p.market AS old_market,
       r.market_id,
       r.market_name,
       COALESCE(r.resolution_source, r.status) AS source
FROM public.properties p
CROSS JOIN LATERAL public.resolve_canonical_market(
  p.property_address_zip,
  p.property_address_county_name,
  p.property_address_city,
  p.property_address_state,
  COALESCE(p.source_market_label, p.market)
) r;

INSERT INTO public.canonical_market_backfill_log (table_name, row_id, old_market, new_market_id, new_market, source)
SELECT 'properties', property_id, old_market, market_id, market_name, source
FROM _canonical_market_resolution
WHERE old_market IS DISTINCT FROM market_name;

UPDATE public.properties p
SET canonical_market_id = r.market_id,
    canonical_market_source = r.source,
    source_market_label = COALESCE(p.source_market_label, r.old_market),
    market = r.market_name
FROM _canonical_market_resolution r
WHERE r.property_id = p.property_id
  AND (p.canonical_market_id IS DISTINCT FROM r.market_id
       OR p.market IS DISTINCT FROM r.market_name
       OR p.canonical_market_source IS DISTINCT FROM r.source);

ALTER TABLE public.properties ENABLE TRIGGER trg_properties_updated_at;

-- ── the ingestion boundary ────────────────────────────────────────────────
-- Nothing in the application writes properties; imports arrive from outside.
-- So the boundary is here: any insert, or any update to geography or market,
-- is canonicalised before it lands. A resolver failure never blocks the write.
CREATE OR REPLACE FUNCTION public.properties_apply_canonical_market()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  r record;
BEGIN
  -- A writer that supplies a label that isn't the canonical name is giving
  -- evidence; keep it, then decide the market from geography first.
  IF NEW.market IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.market IS DISTINCT FROM OLD.market)
     AND NOT EXISTS (SELECT 1 FROM canonical_markets m WHERE m.display_name = NEW.market) THEN
    NEW.source_market_label := NEW.market;
  END IF;

  BEGIN
    SELECT * INTO r
    FROM resolve_canonical_market(
      NEW.property_address_zip,
      NEW.property_address_county_name,
      NEW.property_address_city,
      NEW.property_address_state,
      COALESCE(NEW.source_market_label, NEW.market)
    );
    NEW.canonical_market_id := r.market_id;
    NEW.canonical_market_source := COALESCE(r.resolution_source, r.status);
    NEW.market := r.market_name;           -- NULL when unresolved; never the city
  EXCEPTION WHEN OTHERS THEN
    NEW.canonical_market_source := 'resolver_error';
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_properties_canonical_market ON public.properties;
CREATE TRIGGER trg_properties_canonical_market
  BEFORE INSERT OR UPDATE OF market, property_address_zip, property_address_county_name,
                             property_address_city, property_address_state
  ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.properties_apply_canonical_market();

-- ── derived identity for immutable history (send_queue, message_events) ──
-- Historical transport rows keep the label they were written with; analytics
-- derive the canonical market instead of rewriting audit history.
CREATE OR REPLACE FUNCTION public.canonical_market_id_for_label(p_label text, p_state text DEFAULT NULL)
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT r.market_id FROM resolve_canonical_market(NULL, NULL, NULL, p_state, p_label) r;
$$;

COMMENT ON FUNCTION public.canonical_market_id_for_label(text, text) IS
  'Canonical market id for a historical market label (send_queue.market, message_events.market). Derives; never rewrites the row.';

GRANT EXECUTE ON FUNCTION public.canonical_market_id_for_label(text, text) TO authenticated, service_role;

