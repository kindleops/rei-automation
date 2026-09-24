-- ════════════════════════════════════════════════════════════════════════════
-- CANONICAL MARKET GEOGRAPHY — part 1 of 3: schema, taxonomy, resolver.
--
-- RAW LOCALITY ≠ OPERATING MARKET.
--
-- properties.market held 493 distinct values on 2026-09-24. 48 of them (118,526
-- rows) were real operating markets — the markets lists were bought against.
-- ~445 were raw municipalities ("Diamond Bar, CA", "Wayzata, MN") covering
-- ~5,500 rows, 45,750 rows had no market at all, and some labels were simply
-- wrong: 1,819 Columbus, OH properties carried "Tampa, FL"; 43 South St. Paul
-- properties carried "Cleveland, OH"; "Tuscon, AZ" was misspelled; "Clayton, GA"
-- is a county; "Charlotte, NC" absorbed Durham, Fayetteville and Rocky Mount.
--
-- This part is ADDITIVE: new tables, seed and one resolver. Nothing existing
-- reads them until part 2.
--
-- TAXONOMY — how the vocabulary below was chosen (evidence, not invention):
--   * The operating markets are the head of properties.market (list-purchase
--     markets), cross-checked against prospects.primary_market, textgrid_numbers
--     .market and lib/config/market-sending-zones.js MARKET_ALIASES.
--   * One market per metro. Submarkets inside a metro are ALIASES — exactly
--     the rollups the business already encoded in market-sending-zones.js:
--     St. Paul→Minneapolis, Fort Worth→Dallas, West Palm Beach and Fort
--     Lauderdale→Miami, Kansas City KS→Kansas City MO.
--   * A different metro is a different market, when the business already names
--     it: Durham, Fayetteville and Rocky Mount (prospects.primary_market) are
--     split out of "Charlotte, NC"; Columbus, OH (prospects) receives Franklin
--     County back from "Tampa, FL".
--   * Names keep the existing vocabulary. Two regional names win over city
--     names because the data already uses them: "Inland Empire, CA" (properties
--     and prospects; market-sending-zones called it "Riverside, CA" — alias) and
--     "Hampton Roads, VA" (prospects, market-sending-zones; properties said
--     "Norfolk, VA" — alias). "Tuscon" is corrected to "Tucson"; "Saint Louis"
--     and "St. Louis" collapse to "St. Louis, MO".
--   * Orange County, CA → Los Angeles (Los Angeles–Long Beach–Anaheim metro; the
--     LA sender already covers it). San Diego and Seattle exist in the data as
--     their own metros and get their own markets.
--   * Counties with no operating market stay UNMAPPED — Decatur GA
--     (Bainbridge), Christian KY, Bladen NC, Ashtabula OH, Portage OH, Hudspeth
--     TX. Records there resolve by ZIP if their ZIP says otherwise, else stay
--     unresolved. Nothing falls back to "market = city".
--
-- RESOLUTION ORDER (resolve_canonical_market):
--   1 ZIP  → market_zip_membership   (derived from county membership, majority)
--   2 county + state → market_county_membership (explicit, reviewed, 98 rows)
--   3 city + state   → market_aliases locality rows (derived from 1–2)
--   4 existing label → market_aliases (names, nicknames, legacy, misspellings)
--   5 unresolved / ambiguous — never the raw city.
-- ════════════════════════════════════════════════════════════════════════════

-- ── normalisation shared by every key ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.canonical_geo_key(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
AS $$
  SELECT NULLIF(
    trim(regexp_replace(
      regexp_replace(
        regexp_replace(lower(COALESCE(p_value, '')), '\m(saint|st)\M\.?', 'st', 'g'),
        '\mft\M\.?', 'fort', 'g'),
      '[^a-z0-9]+', ' ', 'g')),
    '');
$$;

COMMENT ON FUNCTION public.canonical_geo_key(text) IS
  'Normalises a locality, county or market label for keyed lookups: lower-case, punctuation-free, Saint/St. → st, Ft → fort.';

-- ── canonical markets ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.canonical_markets (
  id            text PRIMARY KEY,               -- stable slug, e.g. los-angeles-ca
  display_name  text NOT NULL UNIQUE,           -- "Los Angeles, CA"
  state         char(2) NOT NULL,
  region        text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT canonical_markets_id_slug CHECK (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

COMMENT ON TABLE public.canonical_markets IS
  'The operating-market universe. ONE id and ONE display name per market; every other spelling is a row in market_aliases.';

INSERT INTO public.canonical_markets (id, display_name, state, region) VALUES
  ('albuquerque-nm',      'Albuquerque, NM',      'NM', 'southwest'),
  ('atlanta-ga',          'Atlanta, GA',          'GA', 'southeast'),
  ('austin-tx',           'Austin, TX',           'TX', 'south_central'),
  ('bakersfield-ca',      'Bakersfield, CA',      'CA', 'west_coast'),
  ('baltimore-md',        'Baltimore, MD',        'MD', 'east_coast'),
  ('birmingham-al',       'Birmingham, AL',       'AL', 'southeast'),
  ('boise-id',            'Boise, ID',            'ID', 'mountain'),
  ('charlotte-nc',        'Charlotte, NC',        'NC', 'southeast'),
  ('chicago-il',          'Chicago, IL',          'IL', 'midwest'),
  ('cincinnati-oh',       'Cincinnati, OH',       'OH', 'midwest'),
  ('cleveland-oh',        'Cleveland, OH',        'OH', 'midwest'),
  ('colorado-springs-co', 'Colorado Springs, CO', 'CO', 'mountain'),
  ('columbus-oh',         'Columbus, OH',         'OH', 'midwest'),
  ('dallas-tx',           'Dallas, TX',           'TX', 'south_central'),
  ('des-moines-ia',       'Des Moines, IA',       'IA', 'midwest'),
  ('detroit-mi',          'Detroit, MI',          'MI', 'midwest'),
  ('durham-nc',           'Durham, NC',           'NC', 'southeast'),
  ('el-paso-tx',          'El Paso, TX',          'TX', 'south_central'),
  ('fayetteville-nc',     'Fayetteville, NC',     'NC', 'southeast'),
  ('fresno-ca',           'Fresno, CA',           'CA', 'west_coast'),
  ('hampton-roads-va',    'Hampton Roads, VA',    'VA', 'east_coast'),
  ('hartford-ct',         'Hartford, CT',         'CT', 'northeast'),
  ('houston-tx',          'Houston, TX',          'TX', 'south_central'),
  ('indianapolis-in',     'Indianapolis, IN',     'IN', 'midwest'),
  ('inland-empire-ca',    'Inland Empire, CA',    'CA', 'west_coast'),
  ('jacksonville-fl',     'Jacksonville, FL',     'FL', 'southeast'),
  ('kansas-city-mo',      'Kansas City, MO',      'MO', 'midwest'),
  ('las-vegas-nv',        'Las Vegas, NV',        'NV', 'mountain'),
  ('los-angeles-ca',      'Los Angeles, CA',      'CA', 'west_coast'),
  ('louisville-ky',       'Louisville, KY',       'KY', 'southeast'),
  ('memphis-tn',          'Memphis, TN',          'TN', 'southeast'),
  ('miami-fl',            'Miami, FL',            'FL', 'southeast'),
  ('milwaukee-wi',        'Milwaukee, WI',        'WI', 'midwest'),
  ('minneapolis-mn',      'Minneapolis, MN',      'MN', 'midwest'),
  ('modesto-ca',          'Modesto, CA',          'CA', 'west_coast'),
  ('new-orleans-la',      'New Orleans, LA',      'LA', 'south_central'),
  ('oklahoma-city-ok',    'Oklahoma City, OK',    'OK', 'south_central'),
  ('omaha-ne',            'Omaha, NE',            'NE', 'midwest'),
  ('orlando-fl',          'Orlando, FL',          'FL', 'southeast'),
  ('philadelphia-pa',     'Philadelphia, PA',     'PA', 'northeast'),
  ('phoenix-az',          'Phoenix, AZ',          'AZ', 'southwest'),
  ('pittsburgh-pa',       'Pittsburgh, PA',       'PA', 'northeast'),
  ('providence-ri',       'Providence, RI',       'RI', 'northeast'),
  ('richmond-va',         'Richmond, VA',         'VA', 'east_coast'),
  ('rochester-ny',        'Rochester, NY',        'NY', 'northeast'),
  ('rocky-mount-nc',      'Rocky Mount, NC',      'NC', 'southeast'),
  ('sacramento-ca',       'Sacramento, CA',       'CA', 'west_coast'),
  ('salt-lake-city-ut',   'Salt Lake City, UT',   'UT', 'mountain'),
  ('san-antonio-tx',      'San Antonio, TX',      'TX', 'south_central'),
  ('san-diego-ca',        'San Diego, CA',        'CA', 'west_coast'),
  ('seattle-wa',          'Seattle, WA',          'WA', 'west_coast'),
  ('spokane-wa',          'Spokane, WA',          'WA', 'west_coast'),
  ('st-louis-mo',         'St. Louis, MO',        'MO', 'midwest'),
  ('stockton-ca',         'Stockton, CA',         'CA', 'west_coast'),
  ('tampa-fl',            'Tampa, FL',            'FL', 'southeast'),
  ('tucson-az',           'Tucson, AZ',           'AZ', 'southwest'),
  ('tulsa-ok',            'Tulsa, OK',            'OK', 'south_central'),
  ('wichita-ks',          'Wichita, KS',          'KS', 'midwest')
ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  state = EXCLUDED.state,
  region = EXCLUDED.region,
  updated_at = now();

-- ── county membership: the reviewed core of the taxonomy ──────────────────
CREATE TABLE IF NOT EXISTS public.market_county_membership (
  state               char(2) NOT NULL,
  county_key          text NOT NULL,            -- canonical_geo_key(county)
  county_name         text NOT NULL,
  canonical_market_id text NOT NULL REFERENCES public.canonical_markets(id),
  source              text NOT NULL DEFAULT 'reviewed_county_decision',
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (state, county_key)
);

COMMENT ON TABLE public.market_county_membership IS
  'Which operating market each county belongs to. Explicit and reviewed; a county absent here has no operating market. Keyed by state, so same-named counties in different states never collide (Orange CA ≠ Orange FL).';

INSERT INTO public.market_county_membership (state, county_key, county_name, canonical_market_id, notes)
SELECT v.state, public.canonical_geo_key(v.county), v.county, v.market_id, v.notes
FROM (VALUES
  ('AL','Jefferson','birmingham-al',NULL),
  ('AZ','Maricopa','phoenix-az',NULL),
  ('AZ','Pima','tucson-az','properties labelled it "Tuscon, AZ"'),
  ('CA','Fresno','fresno-ca',NULL),
  ('CA','Kern','bakersfield-ca',NULL),
  ('CA','Los Angeles','los-angeles-ca',NULL),
  ('CA','Orange','los-angeles-ca','Los Angeles–Long Beach–Anaheim metro; served by the LA sender'),
  ('CA','Riverside','inland-empire-ca',NULL),
  ('CA','San Bernardino','inland-empire-ca',NULL),
  ('CA','Sacramento','sacramento-ca',NULL),
  ('CA','San Diego','san-diego-ca',NULL),
  ('CA','San Joaquin','stockton-ca',NULL),
  ('CA','Stanislaus','modesto-ca',NULL),
  ('CO','El Paso','colorado-springs-co',NULL),
  ('CT','Hartford','hartford-ct',NULL),
  ('FL','Broward','miami-fl','Miami metro; market-sending-zones aliases Fort Lauderdale to Miami'),
  ('FL','Miami-Dade','miami-fl',NULL),
  ('FL','Palm Beach','miami-fl','Miami metro; market-sending-zones aliases West Palm Beach to Miami'),
  ('FL','Duval','jacksonville-fl',NULL),
  ('FL','Hillsborough','tampa-fl',NULL),
  ('FL','Orange','orlando-fl',NULL),
  ('FL','Seminole','orlando-fl',NULL),
  ('GA','Fulton','atlanta-ga',NULL),
  ('GA','De Kalb','atlanta-ga',NULL),
  ('GA','Gwinnett','atlanta-ga',NULL),
  ('GA','Cobb','atlanta-ga',NULL),
  ('GA','Clayton','atlanta-ga','was its own label "Clayton, GA" — a county list inside the Atlanta metro'),
  ('GA','Fayette','atlanta-ga',NULL),
  ('GA','Henry','atlanta-ga',NULL),
  ('GA','Rockdale','atlanta-ga',NULL),
  ('IA','Polk','des-moines-ia',NULL),
  ('ID','Canyon','boise-id',NULL),
  ('IL','Cook','chicago-il',NULL),
  ('IN','Marion','indianapolis-in',NULL),
  ('KS','Sedgwick','wichita-ks',NULL),
  ('KS','Wyandotte','kansas-city-mo','bi-state metro; market-sending-zones aliases Kansas City KS to Kansas City MO'),
  ('KY','Jefferson','louisville-ky',NULL),
  ('LA','Orleans','new-orleans-la',NULL),
  ('MD','Baltimore','baltimore-md',NULL),
  ('MD','Baltimore City','baltimore-md',NULL),
  ('MI','Wayne','detroit-mi',NULL),
  ('MN','Anoka','minneapolis-mn',NULL),
  ('MN','Dakota','minneapolis-mn','43 rows were labelled "Cleveland, OH"'),
  ('MN','Hennepin','minneapolis-mn',NULL),
  ('MN','Ramsey','minneapolis-mn','St. Paul; market-sending-zones aliases St. Paul to Minneapolis'),
  ('MN','Washington','minneapolis-mn',NULL),
  ('MO','Jackson','kansas-city-mo',NULL),
  ('MO','Saint Louis','st-louis-mo',NULL),
  ('MO','Saint Louis City','st-louis-mo',NULL),
  ('NC','Mecklenburg','charlotte-nc',NULL),
  ('NC','Cabarrus','charlotte-nc',NULL),
  ('NC','Durham','durham-nc','separate metro; was absorbed into "Charlotte, NC"'),
  ('NC','Cumberland','fayetteville-nc','separate metro; was absorbed into "Charlotte, NC"'),
  ('NC','Nash','rocky-mount-nc','separate metro; was absorbed into "Charlotte, NC"'),
  ('NC','Edgecombe','rocky-mount-nc','separate metro; was absorbed into "Charlotte, NC"'),
  ('NC','Wilson','rocky-mount-nc','grouped with Rocky Mount in prospects.primary_market'),
  ('NE','Douglas','omaha-ne',NULL),
  ('NM','Bernalillo','albuquerque-nm',NULL),
  ('NV','Clark','las-vegas-nv',NULL),
  ('NY','Monroe','rochester-ny',NULL),
  ('OH','Cuyahoga','cleveland-oh',NULL),
  ('OH','Franklin','columbus-oh','1,819 rows were labelled "Tampa, FL"'),
  ('OH','Hamilton','cincinnati-oh',NULL),
  ('OK','Oklahoma','oklahoma-city-ok',NULL),
  ('OK','Cleveland','oklahoma-city-ok',NULL),
  ('OK','Tulsa','tulsa-ok',NULL),
  ('OK','Osage','tulsa-ok',NULL),
  ('OK','Creek','tulsa-ok',NULL),
  ('OK','Wagoner','tulsa-ok',NULL),
  ('PA','Philadelphia','philadelphia-pa',NULL),
  ('PA','Allegheny','pittsburgh-pa',NULL),
  ('PA','Beaver','pittsburgh-pa',NULL),
  ('RI','Providence','providence-ri',NULL),
  ('TN','Shelby','memphis-tn',NULL),
  ('TX','Bexar','san-antonio-tx',NULL),
  ('TX','Dallas','dallas-tx',NULL),
  ('TX','Tarrant','dallas-tx','Fort Worth; market-sending-zones aliases Fort Worth to Dallas'),
  ('TX','El Paso','el-paso-tx',NULL),
  ('TX','Harris','houston-tx',NULL),
  ('TX','Fort Bend','houston-tx',NULL),
  ('TX','Galveston','houston-tx',NULL),
  ('TX','Travis','austin-tx',NULL),
  ('TX','Williamson','austin-tx',NULL),
  ('TX','Hays','austin-tx',NULL),
  ('TX','Bastrop','austin-tx',NULL),
  ('UT','Salt Lake','salt-lake-city-ut',NULL),
  ('UT','Weber','salt-lake-city-ut','no separate Ogden market in any taxonomy'),
  ('VA','Richmond City','richmond-va',NULL),
  ('VA','Henrico','richmond-va',NULL),
  ('VA','Chesterfield','richmond-va',NULL),
  ('VA','Norfolk City','hampton-roads-va',NULL),
  ('VA','Hampton City','hampton-roads-va',NULL),
  ('VA','Newport News City','hampton-roads-va',NULL),
  ('VA','Suffolk City','hampton-roads-va',NULL),
  ('VA','Portsmouth City','hampton-roads-va','was its own label "Portsmouth, VA"'),
  ('WA','Spokane','spokane-wa',NULL),
  ('WA','King','seattle-wa',NULL),
  ('WI','Milwaukee','milwaukee-wi',NULL)
) AS v(state, county, market_id, notes)
ON CONFLICT (state, county_key) DO UPDATE SET
  county_name = EXCLUDED.county_name,
  canonical_market_id = EXCLUDED.canonical_market_id,
  notes = EXCLUDED.notes;

-- ── aliases: names, nicknames, legacy taxonomies, misspellings, localities ─
CREATE TABLE IF NOT EXISTS public.market_aliases (
  alias_key           text PRIMARY KEY,         -- canonical_geo_key(name) || '|' || state
  alias               text NOT NULL,
  state               char(2) NOT NULL,
  canonical_market_id text NOT NULL REFERENCES public.canonical_markets(id),
  alias_type          text NOT NULL CHECK (alias_type IN (
                        'canonical_name', 'nickname', 'legacy_label', 'misspelling', 'locality_derived')),
  evidence_rows       integer,
  created_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.market_aliases IS
  'Every other spelling of a market, keyed with its state so same-named places in different states never collide. An alias can only point at an existing canonical market — it cannot create one.';

CREATE INDEX IF NOT EXISTS market_aliases_market_idx ON public.market_aliases (canonical_market_id);

-- Each market's own name.
INSERT INTO public.market_aliases (alias_key, alias, state, canonical_market_id, alias_type)
SELECT public.canonical_geo_key(split_part(display_name, ',', 1)) || '|' || state,
       display_name, state, id, 'canonical_name'
FROM public.canonical_markets
ON CONFLICT (alias_key) DO UPDATE SET canonical_market_id = EXCLUDED.canonical_market_id, alias_type = EXCLUDED.alias_type;

-- Nicknames, legacy labels from the other taxonomies, misspellings.
INSERT INTO public.market_aliases (alias_key, alias, state, canonical_market_id, alias_type)
SELECT public.canonical_geo_key(v.alias) || '|' || v.state, v.alias || ', ' || v.state, v.state, v.market_id, v.alias_type
FROM (VALUES
  ('Tuscon', 'AZ', 'tucson-az', 'misspelling'),
  ('Clayton', 'GA', 'atlanta-ga', 'legacy_label'),
  ('Fort Lauderdale', 'FL', 'miami-fl', 'legacy_label'),
  ('West Palm Beach', 'FL', 'miami-fl', 'legacy_label'),
  ('Palm Beach', 'FL', 'miami-fl', 'nickname'),
  ('South Florida', 'FL', 'miami-fl', 'nickname'),
  ('Fort Worth', 'TX', 'dallas-tx', 'legacy_label'),
  ('Dallas Fort Worth', 'TX', 'dallas-tx', 'nickname'),
  ('DFW', 'TX', 'dallas-tx', 'nickname'),
  ('St Paul', 'MN', 'minneapolis-mn', 'legacy_label'),
  ('Twin Cities', 'MN', 'minneapolis-mn', 'nickname'),
  ('Minneapolis St Paul', 'MN', 'minneapolis-mn', 'nickname'),
  ('Kansas City', 'KS', 'kansas-city-mo', 'legacy_label'),
  ('Riverside', 'CA', 'inland-empire-ca', 'legacy_label'),
  ('San Bernardino', 'CA', 'inland-empire-ca', 'legacy_label'),
  ('Palm Springs', 'CA', 'inland-empire-ca', 'legacy_label'),
  ('Stockton Modesto', 'CA', 'stockton-ca', 'legacy_label'),
  ('LA', 'CA', 'los-angeles-ca', 'nickname'),
  ('L A', 'CA', 'los-angeles-ca', 'nickname'),
  ('Norfolk', 'VA', 'hampton-roads-va', 'legacy_label'),
  ('Portsmouth', 'VA', 'hampton-roads-va', 'legacy_label'),
  ('Virginia Beach', 'VA', 'hampton-roads-va', 'nickname'),
  ('Chesapeake', 'VA', 'hampton-roads-va', 'nickname')
) AS v(alias, state, market_id, alias_type)
ON CONFLICT (alias_key) DO UPDATE SET canonical_market_id = EXCLUDED.canonical_market_id, alias_type = EXCLUDED.alias_type;

-- ── ZIP membership (derived from county membership, majority vote) ────────
CREATE TABLE IF NOT EXISTS public.market_zip_membership (
  zip5                text NOT NULL,
  state               char(2) NOT NULL,
  canonical_market_id text REFERENCES public.canonical_markets(id),
  status              text NOT NULL CHECK (status IN ('resolved', 'ambiguous')),
  source              text NOT NULL DEFAULT 'derived_county_majority',
  evidence_rows       integer NOT NULL,
  top_share           numeric(5,4) NOT NULL,
  computed_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (zip5, state),
  CONSTRAINT market_zip_membership_resolved_has_market
    CHECK (status = 'ambiguous' OR canonical_market_id IS NOT NULL)
);

COMMENT ON TABLE public.market_zip_membership IS
  'ZIP → operating market. Derived from the reviewed county membership by majority of the properties in each ZIP, so one bad county value cannot move a ZIP. A ZIP split across markets is recorded as ambiguous and resolves nothing.';

CREATE INDEX IF NOT EXISTS market_zip_membership_market_idx ON public.market_zip_membership (canonical_market_id);

-- ── the resolver — the ONE place a market is decided ──────────────────────
CREATE OR REPLACE FUNCTION public.resolve_canonical_market(
  p_zip text DEFAULT NULL,
  p_county text DEFAULT NULL,
  p_city text DEFAULT NULL,
  p_state text DEFAULT NULL,
  p_existing_market text DEFAULT NULL
)
RETURNS TABLE (market_id text, market_name text, resolution_source text, status text)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
DECLARE
  v_zip text := substring(COALESCE(p_zip, '') from '^\s*([0-9]{5})');
  v_label text := NULLIF(trim(COALESCE(p_existing_market, '')), '');
  v_label_state text := upper(substring(COALESCE(v_label, '') from ',\s*([A-Za-z]{2})\s*$'));
  v_state text := upper(NULLIF(trim(COALESCE(p_state, '')), ''));
  v_market text;
  v_ambiguous boolean := false;
BEGIN
  IF v_state IS NULL THEN v_state := v_label_state; END IF;

  -- 1. ZIP
  IF v_zip IS NOT NULL THEN
    SELECT z.canonical_market_id, (z.status = 'ambiguous')
    INTO v_market, v_ambiguous
    FROM market_zip_membership z
    WHERE z.zip5 = v_zip AND (v_state IS NULL OR z.state = v_state)
    ORDER BY (z.status = 'resolved') DESC, z.evidence_rows DESC
    LIMIT 1;
    IF v_market IS NOT NULL THEN
      RETURN QUERY SELECT m.id, m.display_name, 'zip'::text, 'resolved_zip'::text
        FROM canonical_markets m WHERE m.id = v_market;
      RETURN;
    END IF;
    v_ambiguous := COALESCE(v_ambiguous, false);
  END IF;

  -- 2. county + state
  IF v_state IS NOT NULL AND canonical_geo_key(p_county) IS NOT NULL THEN
    SELECT c.canonical_market_id INTO v_market
    FROM market_county_membership c
    WHERE c.state = v_state AND c.county_key = canonical_geo_key(p_county);
    IF v_market IS NOT NULL THEN
      RETURN QUERY SELECT m.id, m.display_name, 'county'::text, 'resolved_county'::text
        FROM canonical_markets m WHERE m.id = v_market;
      RETURN;
    END IF;
  END IF;

  -- 3. city + state (locality aliases and market names; never a bare city).
  --    Legacy labels and nicknames are LABEL spellings, not places: "Clayton,
  --    GA" the list is Clayton County (Atlanta); Clayton the city is in Rabun
  --    County. Only step 4 reads them.
  IF v_state IS NOT NULL AND canonical_geo_key(p_city) IS NOT NULL THEN
    SELECT a.canonical_market_id INTO v_market
    FROM market_aliases a
    WHERE a.alias_key = canonical_geo_key(p_city) || '|' || v_state
      AND a.alias_type IN ('canonical_name', 'locality_derived');
    IF v_market IS NOT NULL THEN
      RETURN QUERY SELECT m.id, m.display_name, 'alias'::text, 'resolved_alias'::text
        FROM canonical_markets m WHERE m.id = v_market;
      RETURN;
    END IF;
  END IF;

  -- 4. an existing label, trusted only inside its own state
  IF v_label IS NOT NULL AND v_label_state IS NOT NULL
     AND (v_state IS NULL OR v_state = v_label_state) THEN
    SELECT a.canonical_market_id INTO v_market
    FROM market_aliases a
    WHERE a.alias_key = canonical_geo_key(regexp_replace(v_label, ',\s*[A-Za-z]{2}\s*$', '')) || '|' || v_label_state;
    IF v_market IS NOT NULL THEN
      RETURN QUERY SELECT m.id, m.display_name, 'existing_label'::text, 'resolved_existing'::text
        FROM canonical_markets m WHERE m.id = v_market;
      RETURN;
    END IF;
  END IF;

  -- 5. no guess
  RETURN QUERY SELECT NULL::text, NULL::text, NULL::text,
    CASE WHEN v_ambiguous THEN 'ambiguous' ELSE 'unresolved' END;
END;
$$;

COMMENT ON FUNCTION public.resolve_canonical_market(text, text, text, text, text) IS
  'The single operating-market resolver: ZIP → county → locality alias → existing label → unresolved. Returns market_id, market_name, resolution_source, status. Never returns a raw city.';

-- ZIP membership needs the county map above; derived from current properties.
-- Re-running this block recomputes it (idempotent).
WITH per_zip AS (
  SELECT p.property_address_zip AS zip5,
         upper(p.property_address_state) AS state,
         c.canonical_market_id,
         count(*) AS n
  FROM public.properties p
  LEFT JOIN public.market_county_membership c
    ON c.state = upper(p.property_address_state)
   AND c.county_key = public.canonical_geo_key(p.property_address_county_name)
  WHERE p.property_address_zip ~ '^[0-9]{5}$'
    AND p.property_address_state ~ '^[A-Za-z]{2}$'
  GROUP BY 1, 2, 3
), ranked AS (
  SELECT zip5, state, canonical_market_id, n,
         sum(n) OVER (PARTITION BY zip5, state) AS total,
         sum(n) FILTER (WHERE canonical_market_id IS NOT NULL) OVER (PARTITION BY zip5, state) AS mapped_total,
         row_number() OVER (PARTITION BY zip5, state ORDER BY (canonical_market_id IS NULL), n DESC) AS rk
  FROM per_zip
)
INSERT INTO public.market_zip_membership (zip5, state, canonical_market_id, status, evidence_rows, top_share, computed_at)
SELECT zip5, state,
       CASE WHEN canonical_market_id IS NOT NULL AND n::numeric / total >= 0.9 THEN canonical_market_id END,
       CASE WHEN canonical_market_id IS NOT NULL AND n::numeric / total >= 0.9 THEN 'resolved' ELSE 'ambiguous' END,
       total, round(CASE WHEN canonical_market_id IS NULL THEN 0 ELSE n::numeric / total END, 4), now()
FROM ranked
WHERE rk = 1
  -- a ZIP with no mapped county at all is not "ambiguous", it is simply absent
  AND mapped_total IS NOT NULL
ON CONFLICT (zip5, state) DO UPDATE SET
  canonical_market_id = EXCLUDED.canonical_market_id,
  status = EXCLUDED.status,
  evidence_rows = EXCLUDED.evidence_rows,
  top_share = EXCLUDED.top_share,
  computed_at = now();

-- Locality aliases: a city resolves to a market when every property in that
-- city + state that ZIP/county evidence resolves lands in one market (≥ 95%).
WITH resolved AS (
  SELECT upper(p.property_address_state) AS state,
         p.property_address_city AS city,
         COALESCE(z.canonical_market_id, c.canonical_market_id) AS market_id
  FROM public.properties p
  LEFT JOIN public.market_zip_membership z
    ON z.zip5 = p.property_address_zip AND z.state = upper(p.property_address_state) AND z.status = 'resolved'
  LEFT JOIN public.market_county_membership c
    ON c.state = upper(p.property_address_state)
   AND c.county_key = public.canonical_geo_key(p.property_address_county_name)
  WHERE public.canonical_geo_key(p.property_address_city) IS NOT NULL
    AND p.property_address_state ~ '^[A-Za-z]{2}$'
), per_city AS (
  SELECT state, public.canonical_geo_key(city) AS city_key, min(city) AS city, market_id, count(*) AS n
  FROM resolved WHERE market_id IS NOT NULL
  GROUP BY 1, 2, 4
), ranked AS (
  SELECT *, sum(n) OVER (PARTITION BY state, city_key) AS total,
         row_number() OVER (PARTITION BY state, city_key ORDER BY n DESC) AS rk
  FROM per_city
)
INSERT INTO public.market_aliases (alias_key, alias, state, canonical_market_id, alias_type, evidence_rows)
SELECT city_key || '|' || state, city || ', ' || state, state, market_id, 'locality_derived', total
FROM ranked
WHERE rk = 1 AND n::numeric / total >= 0.95
-- explicit names, nicknames and legacy labels are never overwritten by derivation
ON CONFLICT (alias_key) DO NOTHING;

GRANT SELECT ON public.canonical_markets, public.market_aliases,
               public.market_county_membership, public.market_zip_membership
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_canonical_market(text, text, text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.canonical_geo_key(text) TO authenticated, service_role;

ALTER TABLE public.canonical_markets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.market_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.market_county_membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.market_zip_membership ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS canonical_markets_read ON public.canonical_markets;
CREATE POLICY canonical_markets_read ON public.canonical_markets FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS market_aliases_read ON public.market_aliases;
CREATE POLICY market_aliases_read ON public.market_aliases FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS market_county_membership_read ON public.market_county_membership;
CREATE POLICY market_county_membership_read ON public.market_county_membership FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS market_zip_membership_read ON public.market_zip_membership;
CREATE POLICY market_zip_membership_read ON public.market_zip_membership FOR SELECT TO authenticated USING (true);
