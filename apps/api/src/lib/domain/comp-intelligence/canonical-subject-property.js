import { supabase } from '@/lib/supabase/client.js';
import { loadSubjectProperty } from '@/lib/acquisition/acquisitionDecisionEngine.js';
import { resolveCanonicalLocation } from '@/lib/cockpit/deal-intelligence-dossier.js';
import { normalizeAssetClass, normalizeMarket, normalizeState, normalizeZip } from '@/lib/intel/normalize.js';
import { resolveCanonicalCoordinates } from './coordinate-resolver.js';
import { evidenceField, evidenceNumber, evidenceString } from './field-evidence.js';

const SUBJECT_PROPERTY_SELECT = [
  'property_id',
  'master_owner_id',
  'property_address_full',
  'property_address',
  'property_address_city',
  'property_address_state',
  'property_address_zip',
  'property_zip',
  'property_address_county_name',
  'property_county_name',
  'apn_parcel_id',
  'market',
  'market_region',
  'latitude',
  'longitude',
  'asset_type',
  'asset_class',
  'normalized_asset_class',
  'property_type',
  'property_class',
  'total_bedrooms',
  'total_baths',
  'building_square_feet',
  'units_count',
  'year_built',
  'effective_year_built',
  'lot_square_feet',
  'lot_acreage',
  'building_condition',
  'construction_type',
  'zoning',
  'estimated_value',
  'equity_amount',
  'equity_percent',
  'estimated_repair_cost',
  'owner_type',
  'owner_name',
  'owner_1_name',
  'raw_payload_json',
  'updated_at',
].join(',');

function clean(value) {
  return String(value ?? '').trim();
}

function buildAddress(propertyRow = {}) {
  return clean(
    propertyRow.property_address_full ??
      [
        propertyRow.property_address,
        propertyRow.property_address_city,
        propertyRow.property_address_state,
        propertyRow.property_address_zip,
      ]
        .filter(Boolean)
        .join(', '),
  );
}

export async function loadCanonicalSubjectProperty(propertyId, context = {}, deps = {}) {
  const startedAt = Date.now();
  const db = deps.db ?? supabase;
  const id = clean(propertyId);
  if (!id) {
    return {
      ok: false,
      error: 'missing_property_id',
      subject: null,
      queryMs: Date.now() - startedAt,
    };
  }

  const [{ data: propertyRow, error: propertyError }, enrichedSubject] = await Promise.all([
    db.from('properties').select(SUBJECT_PROPERTY_SELECT).eq('property_id', id).maybeSingle(),
    loadSubjectProperty(id, deps).catch(() => null),
  ]);

  if (propertyError) throw propertyError;
  if (!propertyRow && !enrichedSubject) {
    return {
      ok: false,
      error: 'property_not_found',
      subject: null,
      queryMs: Date.now() - startedAt,
    };
  }

  const row = { ...(propertyRow ?? {}), ...(enrichedSubject ?? {}) };
  const location = resolveCanonicalLocation({
    propertyRow: row,
    hydrated: context.hydrated ?? context.dealContext ?? {},
    identity: context.identity ?? {},
  });
  const coordinates = resolveCanonicalCoordinates({
    property: row,
    hydrated: context.hydrated ?? context.dealContext ?? {},
    enriched: enrichedSubject,
    geocode: context.geocode ?? null,
  });

  const assetClass =
    normalizeAssetClass(
      row.normalized_asset_class ?? row.asset_class ?? row.asset_type ?? row.property_type,
    ) || 'single_family';
  const zip = normalizeZip(row.property_address_zip ?? row.property_zip ?? location.zip);
  const state = normalizeState(row.property_address_state ?? location.state);
  const market = normalizeMarket(row.market ?? row.market_region ?? location.market, location.city, state);

  const subject = {
    property_id: id,
    source_property_id: clean(row.property_export_id ?? row.source_property_id) || null,
    parcel_apn: evidenceString(row.apn_parcel_id, { source: 'properties.apn_parcel_id' }),
    canonical_address: evidenceString(buildAddress(row) || location.full_address, {
      source: 'properties.property_address_full',
    }),
    normalized_address: evidenceString(buildAddress(row) || location.full_address, {
      source: 'properties.property_address_full',
    }),
    owner_id: evidenceString(row.master_owner_id, { source: 'properties.master_owner_id' }),
    master_owner_id: evidenceString(row.master_owner_id, { source: 'properties.master_owner_id' }),
    opportunity_id: evidenceString(context.opportunityId ?? context.opportunity_id, {
      source: 'universal_entity_context',
      missingReason: 'opportunity_not_linked',
    }),
    thread_key: evidenceString(context.threadKey ?? context.thread_key, {
      source: 'universal_entity_context',
      missingReason: 'thread_not_linked',
    }),
    asset_type: evidenceString(assetClass, { source: 'properties.normalized_asset_class' }),
    units: evidenceNumber(row.units_count, { source: 'properties.units_count' }),
    latitude: evidenceNumber(coordinates.latitude, {
      source: coordinates.coordinate_source,
      confidence: coordinates.coordinate_confidence,
    }),
    longitude: evidenceNumber(coordinates.longitude, {
      source: coordinates.coordinate_source,
      confidence: coordinates.coordinate_confidence,
    }),
    coordinate_source: coordinates.coordinate_source,
    coordinate_confidence: coordinates.coordinate_confidence,
    coordinate_reversed: coordinates.coordinate_reversed,
    is_market_fallback: coordinates.is_market_fallback,
    is_subject_resolved: coordinates.is_subject_resolved,
    coordinate_failure_reason: coordinates.failure_reason,
    market: evidenceString(market, { source: 'properties.market' }),
    county: evidenceString(
      row.property_address_county_name ?? row.property_county_name ?? location.county,
      { source: 'properties.property_address_county_name' },
    ),
    state: evidenceString(state, { source: 'properties.property_address_state' }),
    zip: evidenceString(zip, { source: 'properties.property_address_zip' }),
    city: evidenceString(row.property_address_city ?? location.city, {
      source: 'properties.property_address_city',
    }),
    property_type: evidenceString(row.property_type, { source: 'properties.property_type' }),
    bedrooms: evidenceNumber(row.total_bedrooms, { source: 'properties.total_bedrooms' }),
    bathrooms: evidenceNumber(row.total_baths, { source: 'properties.total_baths' }),
    square_feet: evidenceNumber(row.building_square_feet, { source: 'properties.building_square_feet' }),
    lot_square_feet: evidenceNumber(row.lot_square_feet, { source: 'properties.lot_square_feet' }),
    lot_acreage: evidenceNumber(row.lot_acreage, { source: 'properties.lot_acreage' }),
    year_built: evidenceNumber(row.year_built ?? row.effective_year_built, {
      source: 'properties.year_built',
    }),
    condition: evidenceString(row.building_condition, { source: 'properties.building_condition' }),
    construction_type: evidenceString(row.construction_type, { source: 'properties.construction_type' }),
    zoning: evidenceString(row.zoning, { source: 'properties.zoning' }),
    estimated_value: evidenceNumber(row.estimated_value, { source: 'properties.estimated_value' }),
    estimated_arv: evidenceNumber(row.estimated_value, {
      source: 'properties.estimated_value',
      missingReason: 'estimated_arv_not_materialized_use_estimated_value',
    }),
    equity_amount: evidenceNumber(row.equity_amount, { source: 'properties.equity_amount' }),
    equity_percent: evidenceNumber(row.equity_percent, { source: 'properties.equity_percent' }),
    repair_estimate: evidenceNumber(row.estimated_repair_cost, {
      source: 'properties.estimated_repair_cost',
    }),
    last_sale_date: evidenceString(null, { source: 'properties.last_sale_date', missingReason: 'not_selected_in_subject_query' }),
    last_sale_price: evidenceNumber(null, { source: 'properties.last_sale_price', missingReason: 'not_selected_in_subject_query' }),
    tax_assessed_value: evidenceNumber(null, { source: 'properties.tax_assessed_value', missingReason: 'not_selected_in_subject_query' }),
    market_value: evidenceNumber(null, { source: 'properties.market_value', missingReason: 'not_selected_in_subject_query' }),
    owner_name: evidenceString(row.owner_name ?? row.owner_1_name, { source: 'properties.owner_name' }),
    owner_type: evidenceString(row.owner_type ?? row.owner_type_guess, {
      source: 'properties.owner_type',
    }),
    coordinates,
    location_resolution: location.resolution,
    enrichment: {
      acquisition_contact: enrichedSubject?.acquisition_contact ?? null,
      owner_context: enrichedSubject?.owner_context ?? null,
      owner_context_loading: enrichedSubject?.owner_context_loading ?? null,
    },
    data_freshness: {
      property_updated_at: row.updated_at ?? null,
      loaded_at: new Date().toISOString(),
    },
    contract_version: 'comp_intelligence_subject_v1',
  };

  return {
    ok: true,
    subject,
    queryMs: Date.now() - startedAt,
  };
}

export function flattenSubjectForConsumers(subject) {
  if (!subject) return null;
  return {
    property_id: subject.property_id,
    master_owner_id: subject.master_owner_id?.value ?? null,
    opportunity_id: subject.opportunity_id?.value ?? null,
    thread_key: subject.thread_key?.value ?? null,
    canonical_address: subject.canonical_address?.value ?? null,
    asset_type: subject.asset_type?.value ?? null,
    units: subject.units?.value ?? null,
    latitude: subject.latitude?.value ?? null,
    longitude: subject.longitude?.value ?? null,
    lat: subject.latitude?.value ?? null,
    lng: subject.longitude?.value ?? null,
    coordinate_source: subject.coordinate_source,
    coordinate_confidence: subject.coordinate_confidence,
    is_market_fallback: subject.is_market_fallback,
    is_subject_resolved: subject.is_subject_resolved,
    market: subject.market?.value ?? null,
    zip: subject.zip?.value ?? null,
    state: subject.state?.value ?? null,
    square_feet: subject.square_feet?.value ?? null,
    bedrooms: subject.bedrooms?.value ?? null,
    bathrooms: subject.bathrooms?.value ?? null,
    year_built: subject.year_built?.value ?? null,
    condition: subject.condition?.value ?? null,
    estimated_value: subject.estimated_value?.value ?? null,
    repair_estimate: subject.repair_estimate?.value ?? null,
  };
}

export default { loadCanonicalSubjectProperty, flattenSubjectForConsumers };