/**
 * Read-time property hydration for acquisition opportunities.
 * Join: properties.property_id = acquisition_opportunities.primary_property_id
 * Does not mutate stored opportunity rows.
 */
import { normalizeMapAssetType } from '@/lib/domain/map/map-asset-type.js';
import { normalizeMarket, normalizeState } from '@/lib/intel/normalize.js';

const PROPERTIES_TABLE = 'properties';

const OPERATOR_LABEL_BY_MAP_TYPE = Object.freeze({
  sfr: 'Single Family',
  condo: 'Condo / Townhome',
  townhome: 'Condo / Townhome',
  multifamily_small: 'Multifamily 2–4',
  multifamily_large: 'Multifamily 5+',
  mhp: 'Mobile Home',
  land: 'Land',
  shopping_plaza: 'Retail / Strip Mall',
  retail: 'Retail / Strip Mall',
  storage: 'Self-Storage',
  office: 'Office',
  industrial: 'Industrial',
  warehouse: 'Industrial',
  hotel: 'Hospitality',
  mixed_use: 'Mixed Use',
  commercial: 'Commercial Other',
  unknown: 'Unknown',
});

const PROPERTY_SELECT = [
  'property_id',
  'property_export_id',
  'property_type',
  'original_property_type',
  'property_subtype',
  'normalized_asset_class',
  'asset_class',
  'asset_type_label',
  'commercial_property_type',
  'commercial_subtype',
  'property_address_full',
  'property_address_city',
  'property_address_state',
  'property_state',
  'property_address_zip',
  'market',
  'units_count',
  'multifamily_units',
  'commercial_units',
  'storage_units',
  'estimated_value',
  'equity_amount',
  'building_square_feet',
  'lot_square_feet',
].join(',');

function clean(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

export function operatorPropertyTypeLabel(property = {}) {
  const mapType = normalizeMapAssetType(property);
  if (mapType && OPERATOR_LABEL_BY_MAP_TYPE[mapType]) {
    return OPERATOR_LABEL_BY_MAP_TYPE[mapType];
  }

  const raw = lower(
    property.asset_type_label
    || property.normalized_asset_class
    || property.property_type
    || property.original_property_type
    || '',
  );
  if (raw.includes('sfr') || raw.includes('single')) return 'Single Family';
  if (raw.includes('condo') || raw.includes('town')) return 'Condo / Townhome';
  if (raw.includes('mobile') || raw.includes('manufactured')) return 'Mobile Home';
  if (raw.includes('land') || raw.includes('lot')) return 'Land';
  if (raw.includes('storage')) return 'Self-Storage';
  if (raw.includes('retail') || raw.includes('strip') || raw.includes('plaza')) return 'Retail / Strip Mall';
  if (raw.includes('office')) return 'Office';
  if (raw.includes('industrial') || raw.includes('warehouse')) return 'Industrial';
  if (raw.includes('hotel') || raw.includes('hospitality')) return 'Hospitality';
  if (raw.includes('mixed')) return 'Mixed Use';
  if (raw.includes('multifam') || raw.includes('apartment')) {
    const units = Math.max(Number(property.units_count) || 0, Number(property.multifamily_units) || 0);
    return units >= 5 ? 'Multifamily 5+' : 'Multifamily 2–4';
  }
  if (raw.includes('commercial')) return 'Commercial Other';
  return 'Unknown';
}

export function hydrateOpportunityFromProperty(opportunity = {}, property = null) {
  if (!property?.property_id) {
    return {
      ...opportunity,
      property_hydrated: false,
      property_match_status: opportunity.primary_property_id ? 'unresolved' : 'no_property_id',
    };
  }

  const state = normalizeState(property.property_address_state || property.property_state) || null;
  const city = clean(property.property_address_city) || null;
  const zip = clean(property.property_address_zip) || null;
  const market = normalizeMarket(property.market, city, state) || clean(property.market) || null;
  const propertyTypeLabel = operatorPropertyTypeLabel(property);

  return {
    ...opportunity,
    property_hydrated: true,
    property_match_status: 'matched',
    property_export_id: clean(property.property_export_id) || opportunity.property_export_id || null,
    property_type: propertyTypeLabel,
    property_type_raw: clean(property.property_type) || null,
    property_state: state,
    property_city: city,
    property_zip: zip,
    property_county: null,
    market: market || opportunity.market || null,
    property_address_full: clean(property.property_address_full) || opportunity.property_address_full || null,
    asset_class: clean(property.normalized_asset_class || property.asset_class) || opportunity.asset_class || null,
    units_count: Number(property.units_count) || Number(property.multifamily_units) || null,
    building_sqft: Number(property.building_square_feet) || null,
    lot_sqft: Number(property.lot_square_feet) || null,
    estimated_value: opportunity.estimated_value ?? (Number(property.estimated_value) || null),
    equity_amount: Number(property.equity_amount) || null,
    arv: opportunity.arv ?? null,
    metadata: {
      ...(opportunity.metadata && typeof opportunity.metadata === 'object' ? opportunity.metadata : {}),
      property_id: property.property_id,
      property_export_id: property.property_export_id,
      property_type: propertyTypeLabel,
      property_state: state,
      state,
      city,
      zip,
      market,
    },
  };
}

export async function batchHydrateOpportunityProperties(client, rows = []) {
  const propertyIds = [...new Set(
    rows.map((row) => clean(row.primary_property_id)).filter(Boolean),
  )];
  if (!propertyIds.length) {
    return rows.map((row) => hydrateOpportunityFromProperty(row, null));
  }

  const { data, error } = await client
    .from(PROPERTIES_TABLE)
    .select(PROPERTY_SELECT)
    .in('property_id', propertyIds);
  if (error) throw error;

  const byId = new Map((data ?? []).map((property) => [clean(property.property_id), property]));
  return rows.map((row) => {
    const property = byId.get(clean(row.primary_property_id)) ?? null;
    return hydrateOpportunityFromProperty(row, property);
  });
}

export async function reportPropertyHydrationCounts(client, rows = []) {
  let matched = 0;
  let unresolved = 0;
  const byPropertyType = {};
  const byState = {};
  const byMarket = {};

  for (const row of rows) {
    const hydrated = await hydrateOpportunityFromProperty(row, null);
    const propertyId = clean(row.primary_property_id);
    if (!propertyId) {
      unresolved += 1;
      continue;
    }
    const { data: property } = await client
      .from(PROPERTIES_TABLE)
      .select(PROPERTY_SELECT)
      .eq('property_id', propertyId)
      .maybeSingle();
    if (!property) {
      unresolved += 1;
      continue;
    }
    matched += 1;
    const h = hydrateOpportunityFromProperty(row, property);
    const pt = h.property_type || 'Unknown';
    const st = h.property_state || 'Unknown';
    const mk = h.market || 'Unknown';
    byPropertyType[pt] = (byPropertyType[pt] ?? 0) + 1;
    byState[st] = (byState[st] ?? 0) + 1;
    byMarket[mk] = (byMarket[mk] ?? 0) + 1;
  }

  return {
    total: rows.length,
    matched,
    unresolved,
    by_property_type: byPropertyType,
    by_state: byState,
    by_market: byMarket,
  };
}