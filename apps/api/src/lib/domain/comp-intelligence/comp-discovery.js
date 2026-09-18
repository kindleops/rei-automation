import { supabase } from '@/lib/supabase/client.js';
import { calculateCompMatchScore, detectOutliers } from './comp-scoring.js';
import { flattenSubjectForConsumers } from './canonical-subject-property.js';

const EXPANSION_STEPS = [
  { radius: 0.5, monthsBack: 6, confidencePenalty: 0, label: 'strict_nearby' },
  { radius: 1.0, monthsBack: 6, confidencePenalty: 2, label: 'radius_1mi_6mo' },
  { radius: 1.5, monthsBack: 12, confidencePenalty: 5, label: 'radius_1_5mi_12mo' },
  { radius: 3.0, monthsBack: 12, confidencePenalty: 8, label: 'radius_3mi_12mo' },
  { radius: 5.0, monthsBack: 24, confidencePenalty: 14, label: 'radius_5mi_24mo' },
];

function clean(value) {
  return String(value ?? '').trim();
}

async function fetchSubjectComps(db, propertyId, { radius, monthsBack, limit, assetClass }) {
  const { data, error } = await db.rpc('get_comp_candidates_for_subject', {
    p_subject_property_id: propertyId,
    p_radius_miles: radius,
    p_months_back: monthsBack,
    p_limit: limit,
  });
  if (error) throw error;
  let rows = data ?? [];
  if (assetClass) {
    rows = rows.filter((row) => (row.normalized_asset_class || row.asset_class) === assetClass);
  }
  return rows;
}

async function fetchMarketComps(db, { market, zip, monthsBack, limit, assetClass }) {
  let query = db.from('v_recent_sold_comps').select('*').limit(limit);
  if (market) query = query.eq('market', market);
  else if (zip) query = query.eq('property_address_zip', zip);
  else return [];

  if (assetClass) query = query.eq('normalized_asset_class', assetClass);

  const dateLimit = new Date();
  dateLimit.setMonth(dateLimit.getMonth() - monthsBack);
  query = query.gte('sale_date', dateLimit.toISOString().split('T')[0]);
  query = query.order('sale_date', { ascending: false });

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

function normalizeCompRow(row, index, subjectFlat) {
  const soldPrice = Number(row.mls_sold_price || row.sale_price || 0) || null;
  const soldDate = row.mls_sold_date || row.sale_date || null;
  let soldSource = 'UNKNOWN';
  if (row.mls_sold_price || row.mls_sold_date) soldSource = 'MLS SOLD';
  else if (row.sale_price || row.sale_date) soldSource = 'PUBLIC RECORD SOLD';

  const comp = {
    comp_property_id: clean(row.property_id || row.comp_id || row.id) || `comp-${index}`,
    property_id: clean(row.property_id || row.comp_id || row.id),
    source: row.source || soldSource,
    sale_list_status: 'sold',
    sale_list_price: soldPrice,
    sale_list_date: soldDate,
    sold_price: soldPrice,
    sold_date: soldDate,
    sold_source: soldSource,
    distance_miles: row.distance_miles ?? null,
    latitude: row.latitude ?? row.lat ?? null,
    longitude: row.longitude ?? row.lng ?? null,
    asset_type: row.normalized_asset_class || row.asset_class || null,
    property_subtype: row.property_type || null,
    units: row.units_count ?? null,
    /**
     * TWO ROW VOCABULARIES REACH THIS MAPPER, AND IT ONLY SPOKE ONE.
     *
     * `fetchMarketComps` reads `v_recent_sold_comps`, whose columns are
     * `total_bedrooms` / `total_baths` / `building_square_feet` /
     * `computed_ppsf`. `fetchSubjectComps` — the PRIMARY path — calls the RPC
     * `get_comp_candidates_for_subject`, which returns `beds` / `baths` / `sqft`
     * / `ppsf`. The mapper named only the view's columns, so every comp arriving
     * from the RPC was flattened to null.
     *
     * Measured on subject 2172967028: the API returned six comps, each with
     * `bedrooms: null, bathrooms: null, ppsf: null` while its own `raw` carried
     * `beds: 4, baths: 2, ppsf: 638.46, mls_sold_price: 830000`. The data was
     * present the whole time and the card had nothing to render — which is
     * exactly the "meaningless marker with no information" §7 forbids.
     *
     * Both vocabularies are accepted rather than picking one, because both
     * sources are canonical for their own path.
     */
    bedrooms: row.total_bedrooms ?? row.beds ?? null,
    bathrooms: row.total_baths ?? row.baths ?? null,
    square_feet: row.building_square_feet ?? row.sqft ?? null,
    lot_size: row.lot_square_feet ?? null,
    year_built: row.year_built ?? null,
    condition: row.building_condition || row.renovation_level_classification || null,
    address: row.property_address_full || row.address || null,
    city: row.property_address_city || row.city || null,
    state: row.property_address_state || row.state || null,
    zip: row.property_address_zip || row.zip || null,
    ppsf:
      row.computed_ppsf ||
      row.ppsf ||
      (soldPrice && (row.building_square_feet || row.sqft)
        ? Math.round(soldPrice / (row.building_square_feet || row.sqft))
        : null),
    ppu:
      row.ppu ||
      (soldPrice && row.units_count && row.units_count > 1
        ? Math.round(soldPrice / row.units_count)
        : null),
    estimated_value: row.estimated_value ?? null,
    // The RPC scores every candidate; surfacing it lets a card say WHY a comp
    // matters instead of only that it exists (§9).
    comp_confidence_score: row.comp_confidence_score ?? null,
    similarity_score: row.similarity_score ?? null,
    deal_grade: row.deal_grade || null,
    data_freshness: soldDate,
    raw: row,
  };

  const scoring = calculateCompMatchScore(comp, subjectFlat);
  return {
    ...comp,
    similarity_score: scoring.score,
    comp_match_label: scoring.label,
    scoring,
    inclusion_eligible: scoring.auto_included,
    excluded: scoring.auto_excluded,
    exclusion_reasons: scoring.exclusion_reasons,
    selected: scoring.auto_included,
  };
}

export async function discoverCompsForSubject(subjectContract, options = {}, deps = {}) {
  const startedAt = Date.now();
  const db = deps.db ?? supabase;
  const subjectFlat = flattenSubjectForConsumers(subjectContract);
  const propertyId = subjectFlat?.property_id;
  // Only filter by asset class when the operator explicitly requests it.
  const assetClass = options.assetClass ?? null;
  const limit = options.limit ?? 100;
  const relaxations = [];
  let expansionUsed = null;
  let rows = [];
  let searchMode = 'subject_radius';

  if (subjectFlat?.is_subject_resolved && propertyId) {
    const maxRadius = Number(options.radius) > 0 ? Number(options.radius) : 5;
    const steps = EXPANSION_STEPS.filter((step) => step.radius <= maxRadius);
    const effectiveSteps = steps.length ? steps : EXPANSION_STEPS;

    for (const step of effectiveSteps) {
      rows = await fetchSubjectComps(db, propertyId, {
        radius: step.radius,
        monthsBack: options.monthsBack ?? step.monthsBack,
        limit,
        assetClass,
      });
      relaxations.push({
        step: step.label,
        radius_miles: step.radius,
        months_back: options.monthsBack ?? step.monthsBack,
        result_count: rows.length,
        confidence_penalty: step.confidencePenalty,
      });
      if (rows.length >= (options.minComps ?? 3)) {
        expansionUsed = step;
        break;
      }
      expansionUsed = step;
    }
  } else {
    searchMode = 'market_fallback';
    const market = subjectFlat?.market;
    const zip = subjectFlat?.zip;
    const monthsBack = options.monthsBack ?? 6;
    rows = await fetchMarketComps(db, { market, zip, monthsBack, limit, assetClass });
    relaxations.push({
      step: 'market_fallback',
      market,
      zip,
      months_back: monthsBack,
      result_count: rows.length,
      confidence_penalty: 25,
      reason: subjectContract?.coordinate_failure_reason ?? 'subject_coordinates_unavailable',
    });
  }

  const seen = new Set();
  const candidates = [];
  for (const [index, row] of rows.entries()) {
    const id = clean(row.property_id || row.comp_id || row.id);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    candidates.push(normalizeCompRow(row, index, subjectFlat));
  }

  let scored = detectOutliers(candidates, subjectFlat);

  const ranked = [...scored]
    .filter((c) => (c.sold_price ?? c.sale_list_price) && (c.latitude ?? c.lat))
    .sort((a, b) => (b.similarity_score ?? 0) - (a.similarity_score ?? 0));
  const autoIncludeCount = Math.min(6, Math.max(2, Math.ceil(ranked.length * 0.4)));
  const forceIncludeIds = new Set(ranked.slice(0, autoIncludeCount).map((c) => c.comp_property_id || c.property_id));

  scored = scored.map((comp) => {
    const id = comp.comp_property_id || comp.property_id;
    if (!forceIncludeIds.has(id)) return comp;
    return {
      ...comp,
      selected: true,
      excluded: false,
      inclusion_eligible: true,
      exclusion_reasons: (comp.exclusion_reasons ?? []).filter((r) => r !== 'Similarity below inclusion threshold'),
      scoring: comp.scoring
        ? { ...comp.scoring, auto_included: true, auto_excluded: false }
        : comp.scoring,
    };
  });

  const included = scored.filter((c) => c.selected && !c.excluded);
  const excluded = scored.filter((c) => c.excluded);

  return {
    ok: true,
    search_mode: searchMode,
    is_market_fallback: searchMode === 'market_fallback',
    original_criteria: EXPANSION_STEPS[0],
    expanded_criteria: expansionUsed,
    relaxations,
    candidates: scored,
    included,
    excluded,
    counts: {
      total: scored.length,
      included: included.length,
      excluded: excluded.length,
    },
    queryMs: Date.now() - startedAt,
  };
}

export default { discoverCompsForSubject, EXPANSION_STEPS };