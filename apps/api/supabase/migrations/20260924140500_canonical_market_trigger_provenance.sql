-- ════════════════════════════════════════════════════════════════════════════
-- CANONICAL MARKET GEOGRAPHY — ingestion provenance.
--
-- The ingestion trigger kept a writer's label as evidence only when it was not
-- a canonical name. A writer sending "Tampa, FL" for a Franklin County OH
-- property (the exact 1,819-row mislabel the backfill corrected) had its label
-- overridden by the ZIP — correctly — but the overridden label vanished.
-- Now any incoming label the resolver does not keep is recorded in
-- source_market_label, canonical-looking or not. A resolver error now fails
-- closed (market NULL, label kept) instead of landing the raw label as market.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.properties_apply_canonical_market()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  r record;
  v_incoming text := NULL;
BEGIN
  IF NEW.market IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.market IS DISTINCT FROM OLD.market) THEN
    v_incoming := NEW.market;
  END IF;

  BEGIN
    SELECT * INTO r
    FROM resolve_canonical_market(
      NEW.property_address_zip,
      NEW.property_address_county_name,
      NEW.property_address_city,
      NEW.property_address_state,
      COALESCE(v_incoming, NEW.source_market_label, NEW.market)
    );
    NEW.canonical_market_id := r.market_id;
    NEW.canonical_market_source := COALESCE(r.resolution_source, r.status);
    NEW.market := r.market_name;           -- NULL when unresolved; never the city
  EXCEPTION WHEN OTHERS THEN
    -- fail closed: an unresolvable write never lands a raw label as the market
    NEW.canonical_market_id := NULL;
    NEW.canonical_market_source := 'resolver_error';
    NEW.market := NULL;
  END;

  -- A label the resolver did not keep is evidence, never discarded.
  IF v_incoming IS NOT NULL AND v_incoming IS DISTINCT FROM NEW.market THEN
    NEW.source_market_label := v_incoming;
  END IF;

  RETURN NEW;
END;
$$;
