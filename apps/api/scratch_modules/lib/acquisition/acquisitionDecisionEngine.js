import { getDefaultSupabaseClient } from '../lib/supabase/default-client.js';
import {
  normalizeAssetClass,
  normalizeMarket,
  normalizeState,
  normalizeZip,
} from '../lib/intel/normalize.js';

const SCORE_TABLE = 'property_acquisition_scores';
const DEFAULT_TARGET_ASSIGNMENT_FEE = 15_000;
const MAX_SELECTED_COMPS = 12;
const DECISION_TIERS = Object.freeze({
  AUTO_HARD_OFFER: 'AUTO_HARD_OFFER',
  AUTO_RANGE_OFFER: 'AUTO_RANGE_OFFER',
  CREATIVE_TERMS: 'CREATIVE_TERMS',
  NURTURE: 'NURTURE',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
});
const OWNER_SITUATIONS = Object.freeze([
  'DISTRESSED_OWNER',
  'FATIGUED_LANDLORD',
  'WEALTH_PRESERVATION',
  'ESTATE_TRANSITION',
  'PORTFOLIO_REBALANCE',
  'DEBT_PRESSURE',
  'UNDERPERFORMING_ASSET',
  'RETAIL_SELLER',
  'CREATIVE_FINANCE_CANDIDATE',
]);

const SUBJECT_SELECT = [
  'property_id',
  'master_owner_id',
  'property_address_full',
  'property_address_city',
  'property_address_state',
  'property_address_zip',
  'property_address_county_name',
  'market',
  'latitude',
  'longitude',
  'asset_type',
  'asset_class',
  'asset_subtype',
  'normalized_asset_class',
  'normalized_asset_subclass',
  'property_type',
  'property_class',
  'building_class',
  'property_subtype',
  'commercial_property_type',
  'commercial_subtype',
  'total_bedrooms',
  'total_baths',
  'building_square_feet',
  'units_count',
  'avg_sqft_per_unit',
  'sqft_per_unit',
  'beds_per_unit',
  'year_built',
  'effective_year_built',
  'lot_square_feet',
  'subdivision_name',
  'school_district_name',
  'zoning',
  'flood_zone',
  'hoa1_name',
  'geographic_features',
  'property_flags_text',
  'property_flags_json',
  'building_condition',
  'building_quality',
  'construction_type',
  'exterior_walls',
  'interior_walls',
  'floor_cover',
  'roof_cover',
  'roof_type',
  'estimated_repair_cost',
  'estimated_repair_cost_per_sqft',
  'rehab_level',
  'renovation_level_classification',
  'air_conditioning',
  'heating_type',
  'heating_fuel_type',
  'sewer',
  'water',
  'basement',
  'garage',
  'sum_garage_sqft',
  'pool',
  'porch',
  'patio',
  'deck',
  'driveway',
  'stories',
  'style',
  'sum_buildings_nbr',
  'sum_commercial_units',
  'commercial_units',
  'estimated_value',
  'calculated_total_value',
  'assd_total_value',
  'mls_current_listing_price',
  'mls_market_status',
  'mls_sold_date',
  'mls_sold_price',
  'sale_date',
  'sale_price',
  'equity_amount',
  'equity_percent',
  'total_loan_balance',
  'total_loan_amt',
  'total_loan_payment',
  'tax_amt',
  'ownership_years',
  'out_of_state_owner',
  'owner_location',
  'owner_type',
  'owner_type_guess',
  'is_corporate_owner',
  'tax_delinquent',
  'tax_delinquent_year',
  'past_due_amount',
  'active_lien',
  'lien_type',
  'foreclosure_status',
  'foreclosure_stage',
  'preforeclosure_status',
  'preforeclosure_stage',
  'default_date',
  'is_foreclosure',
  'is_preforeclosure',
  'is_pre_foreclosure',
  'is_hot_preforeclosure',
  'is_hot_pre_foreclosure',
  'seller_tags_text',
  'seller_tags_json',
  'podio_tags',
  'structured_motivation_score',
  'tag_distress_score',
  'deal_strength_score',
  'final_acquisition_score',
  'rent_estimate',
  'monthly_rent',
  'market_status_label',
].join(',');

const MASTER_OWNER_SELECT = [
  'master_owner_id',
  'owner_type_guess',
  'owner_location_text',
  'financial_pressure_score',
  'urgency_score',
  'portfolio_total_value',
  'portfolio_total_equity',
  'portfolio_total_loan_balance',
  'portfolio_total_loan_payment',
  'portfolio_total_tax_amount',
  'portfolio_total_units',
  'property_count',
  'tax_delinquent_count',
  'oldest_tax_delinquent_year',
  'active_lien_count',
  'seller_tags_text',
  'seller_tags_json',
].join(',');

const PROSPECT_SELECT = [
  'prospect_id',
  'master_owner_id',
  'est_household_income',
  'net_asset_value',
  'buying_power',
  'property_count',
  'owner_type_guess',
  'seller_tags_text',
  'seller_tags_json',
].join(',');

const PHONE_CONTEXT_SELECT = [
  'phone_id',
  'master_owner_id',
  'sort_rank',
  'phone_type',
  'activity_status',
  'linked_prospect_ids_json',
].join(',');

const ACQUISITION_CONTACT_SELECT = [
  'seller_asking_price',
  'internal_target_price',
  'current_stage',
  'contact_temperature',
  'updated_at',
].join(',');

const SOLD_COMP_SELECT = [
  'id',
  'property_id',
  'property_address_full',
  'property_address_city',
  'property_address_state',
  'property_address_zip',
  'property_address_county_name',
  'market',
  'latitude',
  'longitude',
  'property_type',
  'property_class',
  'total_bedrooms',
  'total_baths',
  'building_square_feet',
  'units_count',
  'year_built',
  'effective_year_built',
  'construction_type',
  'exterior_walls',
  'estimated_repair_cost',
  'renovation_level_classification',
  'sale_price',
  'sale_date',
  'mls_sold_price',
  'mls_sold_date',
  'estimated_value',
  'price_per_sqft',
  'price_per_unit',
  'price_per_bed',
  'comp_confidence_score',
  'deal_grade',
].join(',');

const RPC_COMP_DETAIL_SELECT = [
  'id',
  'property_id',
  'property_address_full',
  'property_address_city',
  'property_address_state',
  'property_address_zip',
  'property_address_county_name',
  'latitude',
  'longitude',
  'normalized_asset_class',
  'property_type',
  'property_class',
  'total_bedrooms',
  'total_baths',
  'building_square_feet',
  'lot_square_feet',
  'units_count',
  'year_built',
  'effective_year_built',
  'building_condition',
  'construction_type',
  'estimated_repair_cost',
  'renovation_level_classification',
  'sale_price',
  'sale_date',
  'mls_sold_price',
  'mls_sold_date',
  'estimated_value',
  'computed_ppsf',
  'comp_confidence_score',
  'deal_grade',
].join(',');

const ADVANCED_COMP_SELECT = [
  'id',
  'property_id',
  'property_address_full',
  'property_address_city',
  'property_address_state',
  'property_address_zip',
  'property_address_county_name',
  'market',
  'latitude',
  'longitude',
  'normalized_asset_class',
  'property_type',
  'property_class',
  'property_style',
  'zoning',
  'flood_zone',
  'school_district_name',
  'subdivision_name',
  'total_bedrooms',
  'total_baths',
  'building_square_feet',
  'units_count',
  'stories',
  'year_built',
  'effective_year_built',
  'avg_square_feet_per_unit',
  'avg_beds_per_unit',
  'building_condition',
  'building_quality',
  'construction_type',
  'exterior_walls',
  'roof_cover',
  'roof_type',
  'floor_cover',
  'interior_walls',
  'basement',
  'air_conditioning',
  'heating_type',
  'heating_fuel_type',
  'lot_square_feet',
  'sewer',
  'water',
  'patio',
  'porch',
  'deck',
  'driveway',
  'garage',
  'garage_square_feet',
  'pool',
  'sum_buildings_nbr',
  'sum_commercial_units',
  'estimated_repair_cost',
  'rehab_level',
  'sale_date',
  'sale_price',
  'mls_sold_date',
  'mls_sold_price',
  'hoa_1_name',
].join(',');

const BUYER_PURCHASE_SELECT = [
  'id',
  'buyer_key',
  'buyer_name',
  'buyer_type',
  'is_corporate_buyer',
  'purchase_date',
  'purchase_price',
  'purchase_price_source',
  'property_address_full',
  'property_city',
  'property_state',
  'property_zip',
  'county_name',
  'market',
  'latitude',
  'longitude',
  'normalized_asset_class',
  'property_type',
  'property_class',
  'beds',
  'baths',
  'sqft',
  'units_count',
  'year_built',
  'condition',
  'rehab_level',
  'estimated_value',
  'estimated_repair_cost',
  'purchase_to_value_ratio',
  'likely_strategy',
  'distress_purchase_score',
  'buyer_fit_signal_score',
].join(',');

const FEATURE_GROUPS = Object.freeze({
  core: {
    weight: 45,
    features: [
      ['asset_type', 'category'],
      ['property_class', 'category'],
      ['beds', 'bedrooms'],
      ['baths', 'baths'],
      ['sqft', 'relative'],
      ['units', 'units'],
      ['avg_sqft_per_unit', 'relative'],
      ['avg_beds_per_unit', 'relative'],
      ['year_built', 'year'],
      ['effective_year_built', 'year'],
      ['lot_sqft', 'relative'],
    ],
  },
  location_context: {
    weight: 20,
    features: [
      ['distance_miles', 'distance'],
      ['zip', 'category'],
      ['subdivision', 'category'],
      ['school_district', 'category'],
      ['zoning', 'zoning'],
      ['flood_zone', 'category'],
      ['hoa_name', 'category'],
      ['road_boundary', 'category'],
    ],
  },
  quality_condition: {
    weight: 15,
    features: [
      ['condition', 'condition'],
      ['quality', 'condition'],
      ['construction_type', 'category'],
      ['exterior_walls', 'category'],
      ['interior_walls', 'category'],
      ['floor_cover', 'category'],
      ['roof_cover', 'category'],
      ['roof_type', 'category'],
      ['estimated_repairs', 'repair'],
    ],
  },
  amenities_structure: {
    weight: 10,
    features: [
      ['basement', 'boolean_category'],
      ['garage', 'boolean_category'],
      ['garage_sqft', 'relative'],
      ['pool', 'boolean_category'],
      ['porch', 'boolean_category'],
      ['patio', 'boolean_category'],
      ['deck', 'boolean_category'],
      ['driveway', 'boolean_category'],
      ['stories', 'relative'],
      ['style', 'category'],
      ['buildings', 'units'],
      ['commercial_units', 'units'],
    ],
  },
  utility_mechanical: {
    weight: 5,
    features: [
      ['air_conditioning', 'category'],
      ['heating_type', 'category'],
      ['heating_fuel', 'category'],
      ['sewer', 'category'],
      ['water', 'category'],
    ],
  },
});

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

function clean(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function num(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed =
    typeof value === 'number'
      ? value
      : Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFinancialEstimate(value) {
  const direct = num(value);
  if (direct !== null) return direct;
  const normalized = lower(value);
  if (!normalized) return null;

  const values = [...normalized.matchAll(/\d[\d,]*(?:\.\d+)?\s*[kmb]?/gi)]
    .map((match) => {
      const token = match[0].replace(/,/g, '').replace(/\s+/g, '');
      const suffix = token.slice(-1);
      const multiplier =
        suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : suffix === 'b' ? 1_000_000_000 : 1;
      const parsed = Number(multiplier === 1 ? token : token.slice(0, -1));
      return Number.isFinite(parsed) ? parsed * multiplier : null;
    })
    .filter((entry) => entry !== null);
  if (!values.length) return null;
  if (values.length >= 2) return (values[0] + values[1]) / 2;
  if (includesAny(normalized, ['under ', 'less than', 'below '])) return values[0] / 2;
  return values[0];
}

function bool(value) {
  if (typeof value === 'boolean') return value;
  const normalized = lower(value);
  if (['1', 'true', 'yes', 'y', 'active', 'present'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'none', 'absent'].includes(normalized)) return false;
  return null;
}

function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, num(value, min)));
}

function round(value, places = 0) {
  const n = num(value);
  if (n === null) return null;
  const factor = 10 ** places;
  return Math.round(n * factor) / factor;
}

function roundMoney(value) {
  const n = num(value);
  if (n === null) return null;
  return Math.round(n / 100) * 100;
}

function first(...values) {
  return values.find((value) => value !== null && value !== undefined && clean(value) !== '') ?? null;
}

function jsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function textBlob(row = {}) {
  return [
    row.property_flags_text,
    JSON.stringify(row.property_flags_json ?? {}),
    row.seller_tags_text,
    JSON.stringify(row.seller_tags_json ?? {}),
    row.podio_tags,
    row.owner_type,
    row.owner_type_guess,
    row.owner_location,
    row.master_owner_seller_tags_text,
    JSON.stringify(row.master_owner_seller_tags_json ?? {}),
    row.prospect_seller_tags_text,
    JSON.stringify(row.prospect_seller_tags_json ?? {}),
    row.market_status_label,
    row.mls_market_status,
    row.foreclosure_status,
    row.foreclosure_stage,
    row.preforeclosure_status,
    row.preforeclosure_stage,
  ]
    .map(lower)
    .filter(Boolean)
    .join(' ');
}

function includesAny(value, terms = []) {
  const normalized = lower(value);
  return terms.some((term) => normalized.includes(lower(term)));
}

function hasValue(value) {
  return value !== null && value !== undefined && clean(value) !== '';
}

function ageMonths(dateValue, now = new Date()) {
  const date = new Date(dateValue);
  if (!dateValue || Number.isNaN(date.getTime())) return null;
  return Math.max(
    0,
    (now.getUTCFullYear() - date.getUTCFullYear()) * 12 +
      now.getUTCMonth() -
      date.getUTCMonth(),
  );
}

function haversineMiles(lat1, lng1, lat2, lng2) {
  const values = [lat1, lng1, lat2, lng2].map((value) => num(value));
  if (values.some((value) => value === null)) return null;
  const [aLat, aLng, bLat, bLng] = values;
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) *
      Math.cos(toRad(bLat)) *
      Math.sin(dLng / 2) ** 2;
  return 3958.7559 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function canonicalAssetType(row = {}) {
  const explicit = first(
    row.normalized_asset_class,
    row.asset_class,
    row.asset_type,
    row.normalized_asset_subclass,
    row.asset_subtype,
    row.commercial_property_type,
    row.property_type,
  );
  const normalized = normalizeAssetClass(explicit);
  const blob = lower(
    [
      explicit,
      row.property_subtype,
      row.commercial_subtype,
      row.asset_subtype,
      row.normalized_asset_subclass,
    ].join(' '),
  );

  if (/storage|self storage|mini storage/.test(blob)) return 'storage';
  if (/strip|shopping center|retail center/.test(blob)) return 'strip_mall';
  if (/commercial|retail|office|industrial|warehouse|hotel|motel/.test(blob)) return 'commercial';
  return normalized || 'other';
}

function assetFamily(assetType) {
  if (['single_family', 'condominium', 'townhouse', 'mobile_home'].includes(assetType)) {
    return 'residential';
  }
  if (assetType === 'multifamily') return 'multifamily';
  if (['commercial', 'strip_mall', 'storage'].includes(assetType)) return 'commercial';
  if (assetType === 'land') return 'land';
  return 'other';
}

function roadBoundarySignal(row = {}) {
  const geo = jsonObject(row.geographic_features);
  return first(
    geo.major_road,
    geo.majorRoad,
    geo.boundary,
    geo.road_boundary,
    geo.roadBoundary,
  );
}

function normalizeBooleanCategory(value) {
  const parsed = bool(value);
  if (parsed !== null) return parsed ? 'yes' : 'no';
  const normalized = lower(value);
  if (!normalized) return null;
  if (includesAny(normalized, ['none', 'no ', 'without', 'absent'])) return 'no';
  return 'yes';
}

export function normalizePropertyFeatures(row = {}, options = {}) {
  const source = options.source ?? row.source ?? 'unknown';
  const salePrice = num(first(row.mls_sold_price, row.sale_price, row.purchase_price));
  const saleDate = first(row.mls_sold_date, row.sale_date, row.purchase_date, row.recording_date);
  const sqft = num(first(row.building_square_feet, row.sqft));
  const units = num(first(row.units_count, row.units));
  const repairs = num(first(row.estimated_repair_cost, row.estimated_repairs));
  const tags = textBlob(row);
  const assetType = canonicalAssetType(row);

  return {
    source,
    source_id: clean(first(row.id, row.comp_id, row.property_id)) || null,
    property_id: clean(first(row.property_id, row.subject_property_id)) || null,
    master_owner_id: clean(row.master_owner_id) || null,
    address: clean(first(row.property_address_full, row.address)) || null,
    city: clean(first(row.property_address_city, row.property_city, row.city)) || null,
    state: normalizeState(first(row.property_address_state, row.property_state, row.state)),
    zip: normalizeZip(first(row.property_address_zip, row.property_zip, row.zip)),
    county: clean(first(row.property_address_county_name, row.county_name, row.county)) || null,
    market: normalizeMarket(
      row.market,
      first(row.property_address_city, row.property_city, row.city),
      first(row.property_address_state, row.property_state, row.state),
    ),
    latitude: num(first(row.latitude, row.lat)),
    longitude: num(first(row.longitude, row.lng)),
    distance_miles: num(first(options.distance_miles, row.distance_miles)),
    asset_type: assetType,
    asset_family: assetFamily(assetType),
    asset_subtype: clean(
      first(
        row.normalized_asset_subclass,
        row.asset_subtype,
        row.property_subtype,
        row.commercial_subtype,
        row.property_type,
      ),
    ) || null,
    property_class: clean(first(row.property_class, row.building_class)) || null,
    beds: num(first(row.total_bedrooms, row.beds)),
    baths: num(first(row.total_baths, row.baths)),
    sqft,
    units,
    avg_sqft_per_unit: num(
      first(
        row.avg_square_feet_per_unit,
        row.avg_sqft_per_unit,
        row.sqft_per_unit,
        sqft && units ? sqft / units : null,
      ),
    ),
    avg_beds_per_unit: num(
      first(
        row.avg_beds_per_unit,
        row.beds_per_unit,
        num(first(row.total_bedrooms, row.beds)) && units
          ? num(first(row.total_bedrooms, row.beds)) / units
          : null,
      ),
    ),
    year_built: num(row.year_built),
    effective_year_built: num(row.effective_year_built),
    lot_sqft: num(first(row.lot_square_feet, row.lot_sqft)),
    subdivision: clean(row.subdivision_name) || null,
    school_district: clean(row.school_district_name) || null,
    zoning: clean(row.zoning) || null,
    flood_zone: clean(row.flood_zone) || null,
    hoa_name: clean(first(row.hoa1_name, row.hoa_one_name, row.hoa_1_name)) || null,
    road_boundary: clean(roadBoundarySignal(row)) || null,
    condition: clean(first(row.building_condition, row.condition, row.rehab_level)) || null,
    quality: clean(row.building_quality) || null,
    construction_type: clean(row.construction_type) || null,
    exterior_walls: clean(row.exterior_walls) || null,
    interior_walls: clean(row.interior_walls) || null,
    floor_cover: clean(row.floor_cover) || null,
    roof_cover: clean(row.roof_cover) || null,
    roof_type: clean(row.roof_type) || null,
    estimated_repairs: repairs,
    rehab_level: clean(first(row.rehab_level, row.renovation_level_classification)) || null,
    air_conditioning: clean(row.air_conditioning) || null,
    heating_type: clean(row.heating_type) || null,
    heating_fuel: clean(row.heating_fuel_type) || null,
    sewer: clean(row.sewer) || null,
    water: clean(row.water) || null,
    basement: normalizeBooleanCategory(row.basement),
    garage: normalizeBooleanCategory(row.garage),
    garage_sqft: num(first(row.sum_garage_sqft, row.garage_square_feet)),
    pool: normalizeBooleanCategory(row.pool),
    porch: normalizeBooleanCategory(row.porch),
    patio: normalizeBooleanCategory(row.patio),
    deck: normalizeBooleanCategory(row.deck),
    driveway: normalizeBooleanCategory(row.driveway),
    stories: num(row.stories),
    style: clean(first(row.style, row.property_style)) || null,
    buildings: num(first(row.sum_buildings_nbr, row.sum_buildings)),
    commercial_units: num(first(row.sum_commercial_units, row.commercial_units)),
    sale_price: salePrice,
    sale_date: saleDate || null,
    sale_age_months: ageMonths(saleDate, options.now),
    sale_source:
      num(row.mls_sold_price) > 0
        ? 'mls_sold'
        : source.includes('buyer')
          ? 'investor_purchase'
          : 'public_record_sold',
    ppsf: num(
      first(
        row.computed_ppsf,
        row.ppsf,
        row.price_per_sqft,
        salePrice && sqft ? salePrice / sqft : null,
      ),
    ),
    estimated_value: num(
      first(
        row.estimated_value,
        row.calculated_total_value,
        row.assd_total_value,
        row.assessed_total_value,
      ),
    ),
    listing_price: num(first(row.mls_current_listing_price, row.asking_price, row.seller_asking_price)),
    market_status: clean(first(row.mls_market_status, row.market_status_label)) || null,
    last_sale_price: num(first(row.last_sale_price, row.sale_price, row.saleprice)),
    equity_amount: num(row.equity_amount),
    equity_percent: num(row.equity_percent),
    loan_balance: num(first(row.total_loan_balance, row.total_loan_amt, row.total_loan_amount)),
    monthly_loan_payment: num(first(row.monthly_loan_payment, row.total_loan_payment)),
    annual_property_taxes: num(first(row.annual_property_taxes, row.tax_amount, row.tax_amt)),
    estimated_household_income: parseFinancialEstimate(
      first(row.estimated_household_income, row.est_household_income, row.household_income),
    ),
    estimated_net_asset_value: parseFinancialEstimate(
      first(row.estimated_net_asset_value, row.net_asset_value),
    ),
    buying_power: clean(row.buying_power) || null,
    ownership_years: num(row.ownership_years),
    absentee_owner:
      bool(row.out_of_state_owner) ??
      (includesAny(first(row.owner_location, row.owner_type, row.owner_type_guess), ['absentee', 'out of state']) ? true : null),
    owner_occupied:
      includesAny(tags, ['owner occupied', 'owner-occupied']) ||
      includesAny(first(row.owner_location, row.owner_type, row.owner_type_guess), ['owner occupied', 'owner-occupied']),
    corporate_owner: bool(first(row.is_corporate_owner, row.is_corporate_buyer)),
    vacant: includesAny(tags, ['vacant', 'boarded', 'unoccupied', 'abandoned']),
    probate: includesAny(tags, ['probate', 'estate', 'inherited', 'heir', 'trust']),
    foreclosure:
      bool(first(row.is_foreclosure, row.is_preforeclosure, row.is_pre_foreclosure)) === true ||
      includesAny(tags, ['foreclosure', 'preforeclosure', 'pre-foreclosure', 'notice of default']),
    preforeclosure:
      [row.is_preforeclosure, row.is_pre_foreclosure].some((value) => bool(value) === true) ||
      includesAny(
        `${row.preforeclosure_status ?? ''} ${row.preforeclosure_stage ?? ''} ${tags}`,
        ['preforeclosure', 'pre-foreclosure', 'notice of default', 'notice of sale'],
      ),
    hot_preforeclosure:
      [row.is_hot_preforeclosure, row.is_hot_pre_foreclosure].some(
        (value) => bool(value) === true,
      ),
    foreclosure_status: clean(
      first(
        row.foreclosure_stage,
        row.foreclosure_status,
        row.preforeclosure_stage,
        row.preforeclosure_status,
      ),
    ) || null,
    default_date: first(row.default_date, row.default_date_raw) || null,
    tax_delinquent: bool(row.tax_delinquent) === true,
    tax_delinquent_year: num(row.tax_delinquent_year),
    past_due_amount: num(row.past_due_amount),
    active_lien: bool(row.active_lien) === true,
    code_violation: includesAny(tags, ['code violation', 'condemned', 'unsafe structure']),
    landlord_profile: includesAny(tags, ['landlord', 'tenant', 'rental', 'absentee']),
    tired_landlord: includesAny(tags, [
      'tired landlord',
      'landlord fatigue',
      'tenant issue',
      'done with tenants',
    ]),
    master_financial_pressure_score: num(row.master_financial_pressure_score),
    master_urgency_score: num(row.master_urgency_score),
    portfolio_total_value: num(row.portfolio_total_value),
    portfolio_total_equity: num(row.portfolio_total_equity),
    portfolio_total_loan_balance: num(row.portfolio_total_loan_balance),
    portfolio_total_loan_payment: num(row.portfolio_total_loan_payment),
    portfolio_total_tax_amount: num(row.portfolio_total_tax_amount),
    portfolio_total_units: num(row.portfolio_total_units),
    property_count: num(first(row.owner_property_count, row.property_count)),
    portfolio_tax_delinquent_count: num(
      first(row.portfolio_tax_delinquent_count, row.tax_delinquent_count),
    ),
    portfolio_oldest_tax_delinquent_year: num(
      first(row.portfolio_oldest_tax_delinquent_year, row.oldest_tax_delinquent_year),
    ),
    portfolio_active_lien_count: num(
      first(row.portfolio_active_lien_count, row.active_lien_count),
    ),
    phone_type: clean(row.phone_type) || null,
    phone_activity_status: clean(first(row.phone_activity_status, row.activity_status)) || null,
    phone_prepaid_indicator: bool(
      first(row.phone_prepaid_indicator, row.prepaid_indicator),
    ),
    distress_score: num(first(row.tag_distress_score, row.distress_purchase_score)),
    motivation_score: num(
      first(
        row.structured_motivation_score,
        row.final_acquisition_score,
        row.deal_strength_score,
      ),
    ),
    buyer_key: clean(row.buyer_key) || null,
    buyer_type: clean(row.buyer_type) || null,
    likely_strategy: clean(row.likely_strategy) || null,
    purchase_to_value_ratio: num(row.purchase_to_value_ratio),
    raw: row,
  };
}

function featurePriority(asset, feature) {
  const family = assetFamily(asset);
  if (family === 'commercial') {
    if (['beds', 'baths', 'avg_beds_per_unit'].includes(feature)) return 0.05;
    if (
      [
        'asset_type',
        'property_class',
        'sqft',
        'lot_sqft',
        'zoning',
        'quality',
        'condition',
        'commercial_units',
        'buildings',
        'distance_miles',
      ].includes(feature)
    ) return 1.7;
  }
  if (family === 'multifamily') {
    if (
      [
        'units',
        'avg_sqft_per_unit',
        'avg_beds_per_unit',
        'sqft',
        'year_built',
        'effective_year_built',
        'zoning',
        'garage',
        'garage_sqft',
      ].includes(feature)
    ) return 1.6;
  }
  if (family === 'residential') {
    if (
      [
        'distance_miles',
        'sqft',
        'beds',
        'baths',
        'effective_year_built',
        'condition',
        'garage',
        'pool',
        'lot_sqft',
      ].includes(feature)
    ) return 1.45;
  }
  if (family === 'land') {
    if (['lot_sqft', 'zoning', 'distance_miles', 'flood_zone'].includes(feature)) return 1.8;
    if (['beds', 'baths', 'sqft', 'units'].includes(feature)) return 0;
  }
  return 1;
}

function categorySimilarity(left, right) {
  const a = lower(left);
  const b = lower(right);
  if (!a || !b) return null;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 82;

  const groups = [
    ['single_family', 'condominium', 'townhouse', 'residential', 'sfr', 'house'],
    ['multifamily', 'duplex', 'triplex', 'fourplex', 'apartment'],
    ['commercial', 'retail', 'strip_mall', 'office', 'warehouse', 'industrial'],
    ['storage', 'self storage', 'mini storage'],
    ['good', 'average', 'standard', 'fair'],
    ['excellent', 'renovated', 'updated', 'turnkey'],
    ['poor', 'heavy', 'distressed', 'fixer'],
    ['central', 'forced air', 'hvac'],
    ['public', 'municipal', 'city'],
    ['private', 'well', 'septic'],
  ];
  if (groups.some((group) => group.includes(a) && group.includes(b))) return 68;
  return 15;
}

function numericSimilarity(left, right, kind = 'relative') {
  const a = num(left);
  const b = num(right);
  if (a === null || b === null) return null;
  const difference = Math.abs(a - b);

  if (kind === 'bedrooms') {
    if (difference === 0) return 100;
    if (difference <= 1) return 76;
    if (difference <= 2) return 38;
    return 8;
  }
  if (kind === 'baths') {
    if (difference <= 0.25) return 100;
    if (difference <= 1) return 76;
    if (difference <= 2) return 38;
    return 8;
  }
  if (kind === 'units') {
    if (difference === 0) return 100;
    const relative = difference / Math.max(Math.abs(a), 1);
    if (relative <= 0.2) return 85;
    if (relative <= 0.5) return 58;
    if (relative <= 1) return 28;
    return 5;
  }
  if (kind === 'year') {
    if (difference <= 3) return 100;
    if (difference <= 10) return 86;
    if (difference <= 20) return 66;
    if (difference <= 35) return 42;
    return 12;
  }
  if (kind === 'repair') {
    if (a === 0 && b === 0) return 100;
  }

  const relative = difference / Math.max(Math.abs(a), Math.abs(b), 1);
  if (relative <= 0.02) return 100;
  if (relative <= 0.1) return 90;
  if (relative <= 0.2) return 76;
  if (relative <= 0.35) return 56;
  if (relative <= 0.5) return 32;
  return 7;
}

function distanceSimilarity(distance) {
  const miles = num(distance);
  if (miles === null) return null;
  if (miles <= 0.25) return 100;
  if (miles <= 0.5) return 96;
  if (miles <= 1) return 88;
  if (miles <= 2) return 74;
  if (miles <= 3) return 60;
  if (miles <= 5) return 42;
  if (miles <= 10) return 22;
  return 8;
}

function zoningSimilarity(left, right) {
  const a = lower(left).replace(/[^a-z0-9]/g, '');
  const b = lower(right).replace(/[^a-z0-9]/g, '');
  if (!a || !b) return null;
  if (a === b) return 100;
  if (a.slice(0, 2) === b.slice(0, 2)) return 72;
  if (a[0] === b[0]) return 48;
  return 12;
}

function conditionRank(value) {
  const normalized = lower(value);
  if (!normalized) return null;
  if (includesAny(normalized, ['excellent', 'renovated', 'turnkey', 'new'])) return 5;
  if (includesAny(normalized, ['good', 'updated', 'light'])) return 4;
  if (includesAny(normalized, ['average', 'standard', 'fair'])) return 3;
  if (includesAny(normalized, ['poor', 'moderate', 'fixer'])) return 2;
  if (includesAny(normalized, ['heavy', 'gut', 'tear', 'condemned'])) return 1;
  return null;
}

function conditionSimilarity(left, right) {
  const a = conditionRank(left);
  const b = conditionRank(right);
  if (a === null || b === null) return categorySimilarity(left, right);
  const difference = Math.abs(a - b);
  if (difference === 0) return 100;
  if (difference === 1) return 72;
  if (difference === 2) return 38;
  return 10;
}

function scoreFeature(subjectValue, compValue, kind) {
  if (!hasValue(subjectValue) || !hasValue(compValue)) return null;
  if (kind === 'distance') return distanceSimilarity(compValue);
  if (kind === 'category') return categorySimilarity(subjectValue, compValue);
  if (kind === 'boolean_category') {
    return lower(subjectValue) === lower(compValue) ? 100 : 18;
  }
  if (kind === 'zoning') return zoningSimilarity(subjectValue, compValue);
  if (kind === 'condition') return conditionSimilarity(subjectValue, compValue);
  return numericSimilarity(subjectValue, compValue, kind);
}

function recencyScore(months) {
  const value = num(months);
  if (value === null) return 35;
  if (value <= 3) return 100;
  if (value <= 6) return 94;
  if (value <= 12) return 82;
  if (value <= 18) return 68;
  if (value <= 24) return 52;
  if (value <= 36) return 30;
  return 10;
}

function weightedAverage(rows, valueKey, weightKey = 'weight') {
  let numerator = 0;
  let denominator = 0;
  for (const row of rows) {
    const value = num(row?.[valueKey]);
    const weight = Math.max(0, num(row?.[weightKey], 0));
    if (value === null || weight <= 0) continue;
    numerator += value * weight;
    denominator += weight;
  }
  return denominator > 0 ? numerator / denominator : null;
}

function weightedQuantile(rows, valueKey, quantile, weightKey = 'weight') {
  const sorted = rows
    .map((row) => ({
      value: num(row?.[valueKey]),
      weight: Math.max(0, num(row?.[weightKey], 0)),
    }))
    .filter((row) => row.value !== null && row.weight > 0)
    .sort((a, b) => a.value - b.value);
  if (!sorted.length) return null;
  const total = sorted.reduce((sum, row) => sum + row.weight, 0);
  const target = total * clamp(quantile, 0, 1);
  let cumulative = 0;
  for (const row of sorted) {
    cumulative += row.weight;
    if (cumulative >= target) return row.value;
  }
  return sorted.at(-1).value;
}

function median(values = []) {
  const sorted = values
    .map((value) => num(value))
    .filter((value) => value !== null)
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function standardDeviation(values = []) {
  const cleanValues = values.map((value) => num(value)).filter((value) => value !== null);
  if (cleanValues.length < 2) return 0;
  const average = cleanValues.reduce((sum, value) => sum + value, 0) / cleanValues.length;
  const variance =
    cleanValues.reduce((sum, value) => sum + (value - average) ** 2, 0) /
    cleanValues.length;
  return Math.sqrt(variance);
}

function assetCompatible(subject, comp) {
  if (subject.asset_type === comp.asset_type) return true;
  if (subject.asset_family === comp.asset_family) {
    if (subject.asset_family === 'commercial') {
      return (
        subject.asset_type === 'commercial' ||
        comp.asset_type === 'commercial' ||
        subject.asset_type === comp.asset_type
      );
    }
    return true;
  }
  return false;
}

function eligibilityLimits(subject) {
  if (subject.asset_family === 'land') return { radius: 20, months: 48 };
  if (subject.asset_family === 'commercial') return { radius: 15, months: 48 };
  if (subject.asset_family === 'multifamily') return { radius: 7, months: 36 };
  return { radius: 4, months: 30 };
}

export function evaluateCompEligibility(subject, comp, now = new Date()) {
  const reasons = [];
  const limits = eligibilityLimits(subject);
  const age = comp.sale_age_months ?? ageMonths(comp.sale_date, now);
  const distance =
    comp.distance_miles ??
    haversineMiles(subject.latitude, subject.longitude, comp.latitude, comp.longitude);

  if (!num(comp.sale_price) || comp.sale_price < 10_000) reasons.push('invalid_sale_price');
  if (subject.property_id && comp.property_id === subject.property_id) reasons.push('same_property');
  if (!assetCompatible(subject, comp)) reasons.push('asset_type_mismatch');
  if (age !== null && age > limits.months) reasons.push('sale_too_old');
  if (distance !== null && distance > limits.radius) reasons.push('outside_radius');
  if (distance === null && subject.zip && comp.zip && subject.zip !== comp.zip) {
    reasons.push('outside_zip_without_coordinates');
  }

  if (subject.asset_family === 'residential' && subject.sqft && comp.sqft) {
    const ratio = comp.sqft / subject.sqft;
    if (ratio < 0.5 || ratio > 1.9) reasons.push('square_feet_outside_range');
  }
  if (subject.asset_family === 'multifamily' && subject.units && comp.units) {
    const ratio = comp.units / subject.units;
    if (ratio < 0.35 || ratio > 2.75) reasons.push('unit_count_outside_range');
  }
  if (subject.asset_family === 'commercial' && subject.sqft && comp.sqft) {
    const ratio = comp.sqft / subject.sqft;
    if (ratio < 0.3 || ratio > 3.5) reasons.push('building_size_outside_range');
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    distance_miles: distance === null ? null : round(distance, 2),
    sale_age_months: age,
  };
}

function adjustedCompPrice(subject, comp) {
  const salePrice = num(comp.sale_price);
  if (!salePrice) return { adjusted_price: null, adjustments: [] };
  const adjustments = [];
  const estimates = [{ value: salePrice, weight: 0.35, basis: 'sale_price' }];

  if (subject.asset_family === 'multifamily' && subject.units && comp.units) {
    estimates.push({
      value: salePrice * (subject.units / comp.units),
      weight: 0.5,
      basis: 'price_per_unit',
    });
  } else if (subject.asset_family === 'land' && subject.lot_sqft && comp.lot_sqft) {
    estimates.push({
      value: salePrice * (subject.lot_sqft / comp.lot_sqft),
      weight: 0.65,
      basis: 'price_per_lot_sqft',
    });
  } else if (subject.sqft && comp.sqft) {
    estimates.push({
      value: salePrice * (subject.sqft / comp.sqft),
      weight: subject.asset_family === 'commercial' ? 0.65 : 0.55,
      basis: 'price_per_building_sqft',
    });
  }

  if (
    subject.asset_family === 'residential' &&
    subject.beds &&
    comp.beds &&
    subject.sqft &&
    comp.sqft
  ) {
    const bedRatio = clamp(subject.beds / comp.beds, 0.75, 1.25);
    estimates.push({
      value: salePrice * bedRatio,
      weight: 0.1,
      basis: 'bedroom_count',
    });
  }

  let totalWeight = 0;
  let blended = 0;
  for (const estimate of estimates) {
    totalWeight += estimate.weight;
    blended += estimate.value * estimate.weight;
    adjustments.push({
      basis: estimate.basis,
      indicated_value: roundMoney(estimate.value),
      weight: round(estimate.weight, 2),
    });
  }
  blended /= totalWeight || 1;

  if (subject.estimated_repairs !== null || comp.estimated_repairs !== null) {
    const repairDifference =
      num(comp.estimated_repairs, 0) - num(subject.estimated_repairs, 0);
    const cappedDifference = clamp(repairDifference, -salePrice * 0.25, salePrice * 0.25);
    blended += cappedDifference;
    adjustments.push({
      basis: 'repair_difference',
      amount: roundMoney(cappedDifference),
    });
  }

  const capped = clamp(blended, salePrice * 0.55, salePrice * 1.65);
  return {
    adjusted_price: roundMoney(capped),
    adjustments,
  };
}

export function scoreComparable(subject, rawComp, options = {}) {
  const comp =
    rawComp?.asset_family
      ? { ...rawComp }
      : normalizePropertyFeatures(rawComp, {
          source: options.source,
          distance_miles: options.distance_miles,
          now: options.now,
        });
  const eligibility = evaluateCompEligibility(subject, comp, options.now);
  comp.distance_miles = eligibility.distance_miles;
  comp.sale_age_months = eligibility.sale_age_months;

  if (!eligibility.eligible) {
    return {
      eligible: false,
      comp,
      reasons: eligibility.reasons,
    };
  }

  const categoryBreakdown = {};
  let matchedFeatureWeight = 0;
  let possibleFeatureWeight = 0;
  let weightedCategoryScore = 0;
  let availableCategoryWeight = 0;

  for (const [category, definition] of Object.entries(FEATURE_GROUPS)) {
    const featureResults = [];
    let categoryNumerator = 0;
    let categoryDenominator = 0;

    for (const [feature, kind] of definition.features) {
      const priority = featurePriority(subject.asset_type, feature);
      if (priority <= 0) continue;
      possibleFeatureWeight += priority;

      const subjectValue = feature === 'distance_miles' ? 0 : subject[feature];
      const compValue = comp[feature];
      const score = scoreFeature(subjectValue, compValue, kind);
      if (score === null) {
        featureResults.push({
          feature,
          subject: subjectValue ?? null,
          comp: compValue ?? null,
          score: null,
          status: 'missing',
        });
        continue;
      }

      matchedFeatureWeight += priority;
      categoryNumerator += score * priority;
      categoryDenominator += priority;
      featureResults.push({
        feature,
        subject: subjectValue,
        comp: compValue,
        score: round(score, 1),
        status: score >= 90 ? 'exact_or_near' : score >= 60 ? 'similar' : 'mismatch',
      });
    }

    const categoryScore =
      categoryDenominator > 0 ? categoryNumerator / categoryDenominator : null;
    if (categoryScore !== null) {
      weightedCategoryScore += categoryScore * definition.weight;
      availableCategoryWeight += definition.weight;
    }
    categoryBreakdown[category] = {
      weight: definition.weight,
      score: round(categoryScore, 1),
      compared_features: featureResults.filter((feature) => feature.score !== null).length,
      missing_features: featureResults.filter((feature) => feature.score === null).length,
      features: featureResults,
    };
  }

  const completeness =
    possibleFeatureWeight > 0 ? (matchedFeatureWeight / possibleFeatureWeight) * 100 : 0;
  const directScore =
    availableCategoryWeight > 0
      ? weightedCategoryScore / availableCategoryWeight
      : 0;
  const recentScore = recencyScore(comp.sale_age_months);
  const riskCompletenessScore = 0.6 * recentScore + 0.4 * completeness;
  const finalScore = clamp(directScore * 0.95 + riskCompletenessScore * 0.05);
  const compConfidence = clamp(
    finalScore * 0.55 + completeness * 0.3 + recentScore * 0.15,
  );
  const price = adjustedCompPrice(subject, comp);
  const weight =
    (finalScore / 100) *
    (compConfidence / 100) *
    (recentScore / 100) *
    (comp.sale_source === 'mls_sold' ? 1 : 0.92);

  return {
    eligible: true,
    comp,
    comp_score: round(finalScore, 2),
    comp_confidence: round(compConfidence, 2),
    data_completeness: round(completeness, 2),
    recency_score: round(recentScore, 2),
    adjusted_price: price.adjusted_price,
    price_adjustments: price.adjustments,
    weight: round(weight, 4),
    feature_match_breakdown: categoryBreakdown,
  };
}

function removeOutliers(scoredComps = []) {
  if (scoredComps.length < 5) {
    return { selected: scoredComps, rejected: [], method: 'insufficient_count_for_mad' };
  }
  const values = scoredComps.map((comp) => comp.adjusted_price).filter(Boolean);
  const center = median(values);
  const mad = median(values.map((value) => Math.abs(value - center)));
  const allowedDeviation = Math.max((mad || 0) * 3.5, center * 0.28);
  const selected = [];
  const rejected = [];

  for (const comp of scoredComps) {
    if (Math.abs(comp.adjusted_price - center) > allowedDeviation) {
      rejected.push({ ...comp, reasons: ['adjusted_price_outlier'] });
    } else {
      selected.push(comp);
    }
  }
  return {
    selected,
    rejected,
    method: 'median_absolute_deviation',
    median: roundMoney(center),
    mad: roundMoney(mad),
    allowed_deviation: roundMoney(allowedDeviation),
  };
}

function fallbackValuation(subject) {
  const midpoint = num(
    first(subject.estimated_value, subject.listing_price, subject.raw?.calculated_total_value),
  );
  if (!midpoint) {
    return {
      low: null,
      mid: null,
      high: null,
      confidence: 0,
      weighted_comp_score: 0,
      calculation: {
        method: 'no_valuation_inputs',
        comp_status: 'no_eligible_comps_found',
        reason: 'no_eligible_comps_found',
        selected_comp_count: 0,
      },
    };
  }
  return {
    low: roundMoney(midpoint * 0.82),
    mid: roundMoney(midpoint),
    high: roundMoney(midpoint * 1.15),
    confidence: 25,
    weighted_comp_score: 0,
    calculation: {
      method: 'subject_value_fallback',
      source_value: roundMoney(midpoint),
      comp_status: 'no_eligible_comps_found',
      reason: 'no_eligible_comps_found',
      selected_comp_count: 0,
    },
  };
}

function calculateValuation(subject, selectedComps) {
  if (!selectedComps.length) return fallbackValuation(subject);

  const weightedInputs = selectedComps.map((comp) => ({
    comp_id: comp.comp.source_id,
    adjusted_value: comp.adjusted_price,
    weight: comp.weight,
    weighted_contribution: round(comp.adjusted_price * comp.weight, 2),
  }));
  const totalWeight = weightedInputs.reduce((sum, comp) => sum + comp.weight, 0);
  const weightedValueTotal = weightedInputs.reduce(
    (sum, comp) => sum + comp.weighted_contribution,
    0,
  );
  const mid = weightedAverage(selectedComps, 'adjusted_price');
  const q25 = weightedQuantile(selectedComps, 'adjusted_price', 0.25);
  const q75 = weightedQuantile(selectedComps, 'adjusted_price', 0.75);
  const values = selectedComps.map((comp) => comp.adjusted_price);
  const dispersion = mid ? standardDeviation(values) / mid : 1;
  const depthScore = clamp((selectedComps.length / 8) * 100);
  const averageCompScore = weightedAverage(selectedComps, 'comp_score');
  const averageCompleteness = weightedAverage(selectedComps, 'data_completeness');
  const consistencyScore = clamp(100 - dispersion * 180);
  const sourceTypes = new Set(selectedComps.map((comp) => comp.comp.sale_source));
  const sourceDiversityScore = sourceTypes.size >= 2 ? 100 : 70;
  const confidence = clamp(
    depthScore * 0.32 +
      averageCompScore * 0.25 +
      averageCompleteness * 0.18 +
      consistencyScore * 0.2 +
      sourceDiversityScore * 0.05,
  );
  const minimumSpread = 0.05 + ((100 - confidence) / 100) * 0.08;
  const low = Math.min(q25 ?? mid, mid * (1 - minimumSpread));
  const high = Math.max(q75 ?? mid, mid * (1 + minimumSpread));

  return {
    low: roundMoney(low),
    mid: roundMoney(mid),
    high: roundMoney(high),
    confidence: Math.round(confidence),
    weighted_comp_score: round(averageCompScore, 2),
    calculation: {
      method: 'weighted_adjusted_comp_value',
      formula: 'sum(adjusted_comp_price * comp_weight) / sum(comp_weight)',
      selected_comp_count: selectedComps.length,
      weighted_value_total: round(weightedValueTotal, 2),
      total_weight: round(totalWeight, 4),
      weighted_mid: roundMoney(mid),
      weighted_q25: roundMoney(q25),
      weighted_q75: roundMoney(q75),
      dispersion_ratio: round(dispersion, 4),
      source_types: [...sourceTypes],
      weighted_inputs: weightedInputs,
      components: {
        depth_score: round(depthScore, 1),
        average_comp_score: round(averageCompScore, 1),
        average_data_completeness: round(averageCompleteness, 1),
        consistency_score: round(consistencyScore, 1),
        source_diversity_score: sourceDiversityScore,
      },
    },
  };
}

function repairEstimate(subject) {
  if (subject.estimated_repairs !== null && subject.estimated_repairs >= 0) {
    return {
      amount: roundMoney(subject.estimated_repairs),
      source: 'property_estimated_repair_cost',
      confidence: 90,
    };
  }

  const sqft = num(subject.sqft, 0);
  if (subject.asset_family === 'land') {
    return { amount: 0, source: 'land_default', confidence: 70 };
  }
  const condition = lower(`${subject.condition || ''} ${subject.rehab_level || ''}`);
  let rate;
  if (includesAny(condition, ['heavy', 'gut', 'tear', 'condemned', 'poor'])) rate = 65;
  else if (includesAny(condition, ['moderate', 'fixer', 'fair', 'needs work'])) rate = 38;
  else if (includesAny(condition, ['light', 'good', 'updated', 'turnkey'])) rate = 14;
  else if (subject.asset_family === 'commercial') rate = 22;
  else if (subject.asset_family === 'multifamily') rate = 28;
  else rate = 24;

  return {
    amount: roundMoney(Math.max(5_000, sqft * rate)),
    source: condition ? 'condition_rate_per_sqft' : 'asset_default_rate_per_sqft',
    rate_per_sqft: rate,
    confidence: condition ? 62 : 35,
  };
}

function normalizeBuyerPurchase(row, subject, now) {
  const purchase = normalizePropertyFeatures(row, {
    source: 'buyer_purchase_events_v2',
    now,
  });
  purchase.distance_miles = haversineMiles(
    subject.latitude,
    subject.longitude,
    purchase.latitude,
    purchase.longitude,
  );
  return purchase;
}

function buyerPurchaseEligible(subject, purchase) {
  if (!purchase.sale_price || purchase.sale_price < 10_000) return false;
  if (!assetCompatible(subject, purchase)) return false;
  if (purchase.sale_age_months !== null && purchase.sale_age_months > 30) return false;
  if (
    purchase.distance_miles !== null &&
    purchase.distance_miles > eligibilityLimits(subject).radius * 2
  ) return false;
  if (
    purchase.distance_miles === null &&
    subject.zip &&
    purchase.zip &&
    subject.zip !== purchase.zip &&
    lower(subject.market) !== lower(purchase.market)
  ) return false;
  return true;
}

function calculateInvestorCeiling(subject, valuation, rawPurchases = [], now = new Date()) {
  const purchases = rawPurchases
    .map((row) => normalizeBuyerPurchase(row, subject, now))
    .filter((purchase) => buyerPurchaseEligible(subject, purchase))
    .map((purchase) => {
      const adjusted = adjustedCompPrice(subject, purchase);
      const locality =
        purchase.distance_miles !== null
          ? distanceSimilarity(purchase.distance_miles) / 100
          : purchase.zip === subject.zip
            ? 0.85
            : 0.55;
      const recency = recencyScore(purchase.sale_age_months) / 100;
      const investorSignal =
        purchase.corporate_owner ||
        includesAny(`${purchase.buyer_type} ${purchase.likely_strategy}`, [
          'investor',
          'corporate',
          'flip',
          'rental',
          'wholesale',
        ])
          ? 1
          : 0.75;
      return {
        ...purchase,
        adjusted_price: adjusted.adjusted_price,
        weight: locality * recency * investorSignal,
        cash_investor_proxy: investorSignal === 1,
      };
    })
    .filter((purchase) => purchase.adjusted_price && purchase.weight > 0);

  if (!purchases.length) {
    const factor =
      subject.asset_family === 'commercial'
        ? 0.68
        : subject.asset_family === 'multifamily'
          ? 0.72
          : subject.asset_family === 'land'
            ? 0.62
            : 0.7;
    return {
      low: roundMoney(valuation.low ? valuation.low * factor : null),
      mid: roundMoney(valuation.mid ? valuation.mid * factor : null),
      high: roundMoney(valuation.high ? valuation.high * factor : null),
      buyer_demand_score: 15,
      liquidity_score: 15,
      confidence: 20,
      purchases: [],
      summary: {
        method: 'valuation_discount_fallback',
        factor,
        reason: 'no_eligible_buyer_purchase_events',
      },
    };
  }

  const low = weightedQuantile(purchases, 'adjusted_price', 0.2);
  const mid = weightedQuantile(purchases, 'adjusted_price', 0.5);
  const high = weightedQuantile(purchases, 'adjusted_price', 0.8);
  const distinctBuyers = new Set(purchases.map((purchase) => purchase.buyer_key).filter(Boolean)).size;
  const recentCount = purchases.filter(
    (purchase) => purchase.sale_age_months !== null && purchase.sale_age_months <= 12,
  ).length;
  const localCount = purchases.filter(
    (purchase) =>
      (purchase.distance_miles !== null && purchase.distance_miles <= 5) ||
      purchase.zip === subject.zip,
  ).length;
  const proxyCount = purchases.filter((purchase) => purchase.cash_investor_proxy).length;
  const depthScore = clamp((Math.log2(purchases.length + 1) / Math.log2(33)) * 100);
  const recency = clamp((recentCount / purchases.length) * 100);
  const locality = clamp((localCount / purchases.length) * 100);
  const investorProxy = clamp((proxyCount / purchases.length) * 100);
  const demand = clamp(
    depthScore * 0.4 + recency * 0.25 + locality * 0.2 + investorProxy * 0.15,
  );
  const buyerDiversity = clamp((distinctBuyers / Math.max(purchases.length, 1)) * 130);
  const liquidity = clamp(
    depthScore * 0.45 + recency * 0.25 + locality * 0.2 + buyerDiversity * 0.1,
  );
  const confidence = clamp(
    depthScore * 0.45 + locality * 0.3 + recency * 0.25,
  );

  return {
    low: roundMoney(low),
    mid: roundMoney(mid),
    high: roundMoney(high),
    buyer_demand_score: Math.round(demand),
    liquidity_score: Math.round(liquidity),
    confidence: Math.round(confidence),
    purchases,
    summary: {
      method: 'weighted_nearby_investor_purchase_quantiles',
      eligible_purchase_count: purchases.length,
      distinct_buyer_count: distinctBuyers,
      recent_purchase_count: recentCount,
      local_purchase_count: localCount,
      cash_investor_proxy_count: proxyCount,
      note:
        'Cash financing is not explicit in the source; corporate buyer, buyer type, and strategy fields are deterministic investor/cash proxies.',
    },
  };
}

function addFactor(factors, condition, points, reason) {
  if (!condition) return 0;
  factors.push({ points, reason });
  return points;
}

function creativeFinanceScores(subject, valuation) {
  const equity = num(subject.equity_percent);
  const loan = num(subject.loan_balance);
  const value = num(first(valuation.mid, subject.estimated_value));
  const debtRatio = loan && value ? (loan / value) * 100 : null;
  const ownership = num(subject.ownership_years);
  const asking = num(subject.listing_price);
  const condition = conditionRank(first(subject.condition, subject.rehab_level));
  const severeTitleRisk = subject.foreclosure || subject.tax_delinquent || subject.active_lien;

  const subjectToFactors = [];
  let subjectTo = 20;
  subjectTo += addFactor(subjectToFactors, debtRatio !== null && debtRatio >= 45 && debtRatio <= 92, 35, 'existing_debt_is_material_but_not_overleveraged');
  subjectTo += addFactor(subjectToFactors, equity !== null && equity >= 5 && equity <= 40, 22, 'low_to_moderate_equity');
  subjectTo += addFactor(subjectToFactors, subject.absentee_owner || subject.landlord_profile, 10, 'absentee_or_landlord_profile');
  subjectTo += addFactor(subjectToFactors, subject.foreclosure, 8, 'foreclosure_pressure');
  subjectTo += addFactor(subjectToFactors, loan !== null, 5, 'mortgage_balance_available');
  if (subject.tax_delinquent || subject.active_lien) {
    subjectTo -= 12;
    subjectToFactors.push({ points: -12, reason: 'tax_or_lien_execution_risk' });
  }

  const sellerFinanceFactors = [];
  let sellerFinance = 18;
  sellerFinance += addFactor(sellerFinanceFactors, equity !== null && equity >= 55, 34, 'high_equity');
  sellerFinance += addFactor(sellerFinanceFactors, ownership !== null && ownership >= 10, 18, 'long_ownership_duration');
  sellerFinance += addFactor(sellerFinanceFactors, subject.absentee_owner || subject.landlord_profile, 12, 'absentee_or_landlord_profile');
  sellerFinance += addFactor(sellerFinanceFactors, loan === 0 || debtRatio !== null && debtRatio < 25, 15, 'low_debt_load');
  sellerFinance += addFactor(sellerFinanceFactors, subject.corporate_owner, 5, 'entity_owner');
  if (severeTitleRisk) {
    sellerFinance -= 10;
    sellerFinanceFactors.push({ points: -10, reason: 'title_or_tax_risk' });
  }

  const leaseOptionFactors = [];
  let leaseOption = 15;
  leaseOption += addFactor(leaseOptionFactors, subject.asset_family === 'residential', 25, 'residential_asset');
  leaseOption += addFactor(leaseOptionFactors, equity !== null && equity >= 20, 18, 'sufficient_equity');
  leaseOption += addFactor(leaseOptionFactors, subject.landlord_profile, 15, 'landlord_profile');
  leaseOption += addFactor(leaseOptionFactors, condition !== null && condition >= 3, 12, 'rentable_condition');
  leaseOption += addFactor(leaseOptionFactors, num(first(subject.raw?.rent_estimate, subject.raw?.monthly_rent)) > 0, 10, 'rent_signal_available');
  if (subject.foreclosure || subject.tax_delinquent) {
    leaseOption -= 15;
    leaseOptionFactors.push({ points: -15, reason: 'time_sensitive_distress' });
  }

  const novationFactors = [];
  let novation = 15;
  novation += addFactor(novationFactors, subject.asset_family === 'residential', 20, 'retail_residential_exit');
  novation += addFactor(novationFactors, condition !== null && condition >= 3, 24, 'retail_viable_condition');
  novation += addFactor(novationFactors, equity !== null && equity >= 25, 15, 'equity_supports_retail_exit');
  novation += addFactor(novationFactors, asking && valuation.high && asking <= valuation.high * 1.02, 12, 'asking_price_near_supported_retail_value');
  novation += addFactor(novationFactors, hasValue(subject.market_status), 8, 'mls_activity_available');
  if (subject.foreclosure || subject.code_violation) {
    novation -= 18;
    novationFactors.push({ points: -18, reason: 'retail_execution_risk' });
  }

  const scores = {
    subject_to_score: Math.round(clamp(subjectTo)),
    seller_finance_score: Math.round(clamp(sellerFinance)),
    lease_option_score: Math.round(clamp(leaseOption)),
    novation_score: Math.round(clamp(novation)),
  };
  const labels = {
    subject_to_score: 'SUBJECT_TO',
    seller_finance_score: 'SELLER_FINANCE',
    lease_option_score: 'LEASE_OPTION',
    novation_score: 'NOVATION',
  };
  const bestEntry = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];

  return {
    ...scores,
    best_creative_strategy: labels[bestEntry[0]],
    best_creative_score: bestEntry[1],
    reasoning: {
      subject_to: subjectToFactors,
      seller_finance: sellerFinanceFactors,
      lease_option: leaseOptionFactors,
      novation: novationFactors,
      inputs: {
        equity_percent: equity,
        loan_balance: loan,
        debt_to_value_percent: round(debtRatio, 1),
        ownership_years: ownership,
        asking_price: asking,
        severe_title_risk: severeTitleRisk,
      },
    },
  };
}

function distressAndMotivation(subject) {
  const reasons = [];
  let score = num(subject.motivation_score, 0) * 0.45 + num(subject.distress_score, 0) * 0.35;
  score += addFactor(reasons, subject.vacant, 12, 'vacancy');
  score += addFactor(reasons, subject.probate, 10, 'probate_or_inheritance');
  score += addFactor(reasons, subject.foreclosure, 18, 'foreclosure');
  score += addFactor(reasons, subject.tax_delinquent, 12, 'tax_delinquency');
  score += addFactor(reasons, subject.active_lien, 6, 'active_lien');
  score += addFactor(reasons, subject.code_violation, 12, 'code_violation');
  score += addFactor(reasons, subject.absentee_owner, 5, 'absentee_owner');
  score += addFactor(reasons, subject.landlord_profile, 5, 'landlord_profile');
  return { score: Math.round(clamp(score)), reasons };
}

function addThresholdFactor(factors, value, tiers, reason) {
  const numericValue = num(value);
  if (numericValue === null) return 0;
  const match = tiers.find(([threshold]) => numericValue >= threshold);
  if (!match) return 0;
  const [, points] = match;
  factors.push({
    points,
    reason,
    value: round(numericValue, 4),
    threshold: match[0],
  });
  return points;
}

function safeRatio(numerator, denominator) {
  const top = num(numerator);
  const bottom = num(denominator);
  if (top === null || bottom === null || bottom <= 0) return null;
  return top / bottom;
}

function phase2DataConfidence(subject) {
  const fields = [
    'estimated_household_income',
    'estimated_net_asset_value',
    'monthly_loan_payment',
    'annual_property_taxes',
    'loan_balance',
    'equity_amount',
    'estimated_repairs',
    'last_sale_price',
  ];
  if (subject.tax_delinquent) fields.push('past_due_amount');
  const available = fields.filter((field) => hasValue(subject[field]));
  const missing = fields.filter((field) => !hasValue(subject[field]));
  const weakContextSignals = [];
  let weakContextBonus = 0;
  if (hasValue(subject.buying_power)) {
    weakContextBonus += 2;
    weakContextSignals.push('buying_power_present_context_only');
  }
  if (hasValue(subject.phone_type)) {
    weakContextBonus += 2;
    weakContextSignals.push('phone_type_present_context_only');
  }
  if (hasValue(subject.phone_prepaid_indicator)) {
    weakContextBonus += 1;
    weakContextSignals.push('phone_prepaid_indicator_present_context_only');
  }
  return {
    score: Math.round(
      clamp((available.length / Math.max(fields.length, 1)) * 95 + weakContextBonus),
    ),
    available,
    missing,
    weak_context_signals: weakContextSignals,
    weak_context_policy:
      'Buying power, phone type, and prepaid indicators affect confidence only and never create pressure or strategy scores.',
  };
}

function calculateOwnerSituationPhase2({
  subject,
  valuation,
  creative,
  offer,
  overallConfidence,
}) {
  const income = num(subject.estimated_household_income);
  const netAssets = num(subject.estimated_net_asset_value);
  const monthlyLoanPayment = num(subject.monthly_loan_payment);
  const annualTaxes = num(subject.annual_property_taxes);
  const pastDue = num(subject.past_due_amount);
  const repairs = num(subject.estimated_repairs);
  const loanBalance = num(subject.loan_balance);
  const equityAmount = num(subject.equity_amount);
  const valuationMid = num(valuation.mid);
  const lastSalePrice = num(subject.last_sale_price);
  const equityPercent = num(subject.equity_percent);
  const ownershipYears = num(subject.ownership_years);
  const propertyCount = num(subject.property_count);
  const propertyValue = valuationMid ?? num(subject.estimated_value);
  const repairToValueRatio = safeRatio(repairs, propertyValue);
  const ratios = {
    housing_burden_ratio: safeRatio(
      monthlyLoanPayment === null ? null : monthlyLoanPayment * 12,
      income,
    ),
    tax_burden_ratio: safeRatio(annualTaxes, income),
    tax_arrears_ratio: safeRatio(pastDue, income),
    repair_burden_ratio: safeRatio(repairs, income),
    debt_to_value_ratio: safeRatio(loanBalance, valuationMid),
    equity_trapped_ratio: safeRatio(equityAmount, netAssets),
    appreciation_gain_ratio:
      valuationMid === null || lastSalePrice === null
        ? null
        : Math.max(valuationMid - lastSalePrice, 0) / Math.max(lastSalePrice, 1),
  };
  const roundedRatios = Object.fromEntries(
    Object.entries(ratios).map(([key, value]) => [key, round(value, 4)]),
  );
  const dataConfidence = phase2DataConfidence(subject);

  const pressureFactors = [];
  let sellerFinancialPressure = 0;
  sellerFinancialPressure += addThresholdFactor(
    pressureFactors,
    ratios.housing_burden_ratio,
    [[0.5, 25], [0.35, 18], [0.25, 10], [0.15, 5]],
    'housing_burden',
  );
  sellerFinancialPressure += addThresholdFactor(
    pressureFactors,
    ratios.tax_burden_ratio,
    [[0.1, 14], [0.06, 9], [0.03, 4]],
    'property_tax_burden',
  );
  sellerFinancialPressure += addThresholdFactor(
    pressureFactors,
    ratios.tax_arrears_ratio,
    [[0.2, 25], [0.1, 18], [0.03, 10]],
    'tax_arrears_burden',
  );
  sellerFinancialPressure += addThresholdFactor(
    pressureFactors,
    ratios.repair_burden_ratio,
    [[1, 20], [0.5, 14], [0.25, 8], [0.1, 4]],
    'repair_cost_burden',
  );
  sellerFinancialPressure += addThresholdFactor(
    pressureFactors,
    ratios.debt_to_value_ratio,
    [[0.9, 18], [0.75, 12], [0.55, 6]],
    'debt_to_value_burden',
  );
  sellerFinancialPressure += addFactor(
    pressureFactors,
    subject.tax_delinquent,
    18,
    'tax_delinquent',
  );
  sellerFinancialPressure += addFactor(
    pressureFactors,
    subject.foreclosure || subject.preforeclosure || subject.hot_preforeclosure,
    25,
    'foreclosure_or_preforeclosure',
  );
  sellerFinancialPressure += addFactor(
    pressureFactors,
    subject.active_lien,
    8,
    'active_lien',
  );
  sellerFinancialPressure += addFactor(pressureFactors, subject.vacant, 8, 'vacancy');
  sellerFinancialPressure += addFactor(
    pressureFactors,
    subject.code_violation,
    8,
    'code_violation',
  );
  sellerFinancialPressure += addThresholdFactor(
    pressureFactors,
    subject.master_financial_pressure_score,
    [[70, 8], [50, 5], [30, 2]],
    'existing_master_owner_pressure_weak_context',
  );
  sellerFinancialPressure = Math.round(clamp(sellerFinancialPressure));

  const foreclosureFactors = [];
  let foreclosureRisk = 0;
  foreclosureRisk += addFactor(
    foreclosureFactors,
    subject.foreclosure,
    55,
    'explicit_foreclosure_signal',
  );
  foreclosureRisk += addFactor(
    foreclosureFactors,
    subject.hot_preforeclosure,
    48,
    'hot_preforeclosure_signal',
  );
  foreclosureRisk += addFactor(
    foreclosureFactors,
    subject.preforeclosure && !subject.hot_preforeclosure,
    38,
    'preforeclosure_signal',
  );
  foreclosureRisk += addFactor(
    foreclosureFactors,
    hasValue(subject.default_date),
    12,
    'default_date_present',
  );
  foreclosureRisk += addThresholdFactor(
    foreclosureFactors,
    ratios.debt_to_value_ratio,
    [[0.95, 20], [0.85, 14], [0.7, 7]],
    'high_debt_to_value',
  );
  foreclosureRisk += addThresholdFactor(
    foreclosureFactors,
    ratios.housing_burden_ratio,
    [[0.5, 14], [0.35, 9]],
    'high_housing_burden',
  );
  foreclosureRisk += addFactor(
    foreclosureFactors,
    subject.active_lien,
    6,
    'active_lien',
  );
  foreclosureRisk = Math.round(clamp(foreclosureRisk));

  const forcedSaleFactors = [];
  let forcedSalePressure = 0;
  forcedSalePressure += addFactor(
    forcedSaleFactors,
    subject.foreclosure || subject.hot_preforeclosure,
    35,
    'foreclosure_timeline',
  );
  forcedSalePressure += addFactor(
    forcedSaleFactors,
    subject.preforeclosure && !subject.hot_preforeclosure,
    25,
    'preforeclosure_timeline',
  );
  forcedSalePressure += addFactor(
    forcedSaleFactors,
    subject.tax_delinquent,
    22,
    'tax_delinquency',
  );
  forcedSalePressure += addThresholdFactor(
    forcedSaleFactors,
    ratios.tax_arrears_ratio,
    [[0.2, 18], [0.1, 12], [0.03, 7]],
    'tax_arrears_burden',
  );
  forcedSalePressure += addFactor(forcedSaleFactors, subject.vacant, 12, 'vacancy');
  forcedSalePressure += addFactor(
    forcedSaleFactors,
    subject.code_violation,
    12,
    'code_enforcement_risk',
  );
  forcedSalePressure += addFactor(
    forcedSaleFactors,
    subject.active_lien,
    8,
    'active_lien',
  );
  forcedSalePressure += addThresholdFactor(
    forcedSaleFactors,
    ratios.debt_to_value_ratio,
    [[0.95, 14], [0.8, 9]],
    'limited_equity_cushion',
  );
  forcedSalePressure += addFactor(
    forcedSaleFactors,
    subject.vacant && ratios.repair_burden_ratio >= 0.5,
    10,
    'vacant_and_repair_heavy',
  );
  forcedSalePressure = Math.round(clamp(forcedSalePressure));

  const landlordFactors = [];
  let landlordFatigue = 0;
  landlordFatigue += addFactor(
    landlordFactors,
    subject.tired_landlord,
    32,
    'explicit_tired_landlord_signal',
  );
  landlordFatigue += addFactor(
    landlordFactors,
    subject.landlord_profile,
    24,
    'landlord_or_rental_profile',
  );
  landlordFatigue += addFactor(
    landlordFactors,
    subject.absentee_owner,
    8,
    'absentee_owner',
  );
  landlordFatigue += addThresholdFactor(
    landlordFactors,
    ownershipYears,
    [[20, 18], [10, 11], [5, 5]],
    'long_ownership_tenure',
  );
  landlordFatigue += addThresholdFactor(
    landlordFactors,
    ratios.repair_burden_ratio,
    [[0.75, 14], [0.35, 9], [0.15, 5]],
    'repair_management_burden',
  );
  landlordFatigue += addFactor(landlordFactors, subject.vacant, 12, 'vacancy');
  landlordFatigue += addThresholdFactor(
    landlordFactors,
    propertyCount,
    [[5, 8], [2, 5]],
    'multiple_property_management',
  );
  landlordFatigue = Math.round(clamp(landlordFatigue));

  const taxPainFactors = [];
  let taxPain = 0;
  taxPain += addFactor(taxPainFactors, subject.tax_delinquent, 30, 'tax_delinquent');
  taxPain += addThresholdFactor(
    taxPainFactors,
    ratios.tax_arrears_ratio,
    [[0.2, 25], [0.1, 18], [0.03, 10]],
    'tax_arrears_burden',
  );
  taxPain += addThresholdFactor(
    taxPainFactors,
    ratios.tax_burden_ratio,
    [[0.1, 15], [0.06, 10], [0.03, 5]],
    'annual_tax_burden',
  );
  const appreciationReliable = lastSalePrice !== null && lastSalePrice > 0;
  if (appreciationReliable) {
    taxPain += addThresholdFactor(
      taxPainFactors,
      ratios.appreciation_gain_ratio,
      [[2, 22], [1, 16], [0.5, 10], [0.25, 5]],
      'capital_gains_proxy',
    );
  }
  taxPain += addFactor(
    taxPainFactors,
    equityPercent >= 70 && ownershipYears >= 10,
    10,
    'high_equity_long_tenure_tax_exposure_proxy',
  );
  taxPain += addFactor(
    taxPainFactors,
    ['commercial', 'multifamily'].includes(subject.asset_family) &&
      appreciationReliable &&
      ratios.appreciation_gain_ratio >= 0.5,
    8,
    'income_property_appreciation_exposure',
  );
  taxPain = Math.round(clamp(taxPain));

  const equityUnlockFactors = [];
  let equityUnlock = 0;
  equityUnlock += addThresholdFactor(
    equityUnlockFactors,
    equityPercent,
    [[80, 48], [60, 38], [40, 28], [20, 14]],
    'equity_percent',
  );
  equityUnlock += addThresholdFactor(
    equityUnlockFactors,
    ratios.equity_trapped_ratio,
    [[1, 28], [0.5, 20], [0.25, 12], [0.1, 6]],
    'equity_concentration_relative_to_net_assets',
  );
  equityUnlock += addThresholdFactor(
    equityUnlockFactors,
    ownershipYears,
    [[20, 16], [10, 10], [5, 5]],
    'ownership_tenure',
  );
  equityUnlock += addFactor(
    equityUnlockFactors,
    subject.absentee_owner || subject.landlord_profile,
    6,
    'non_primary_or_landlord_asset',
  );
  equityUnlock = Math.round(clamp(equityUnlock));

  const debtFactors = [];
  let debtPressure = 0;
  debtPressure += addThresholdFactor(
    debtFactors,
    ratios.debt_to_value_ratio,
    [[0.95, 48], [0.8, 38], [0.65, 25], [0.45, 12]],
    'debt_to_value',
  );
  debtPressure += addThresholdFactor(
    debtFactors,
    ratios.housing_burden_ratio,
    [[0.5, 30], [0.35, 22], [0.25, 14], [0.15, 7]],
    'housing_burden',
  );
  debtPressure += addFactor(
    debtFactors,
    subject.foreclosure || subject.preforeclosure,
    20,
    'foreclosure_debt_enforcement',
  );
  debtPressure += addFactor(debtFactors, subject.active_lien, 8, 'active_lien');
  debtPressure = Math.round(clamp(debtPressure));

  const repairFactors = [];
  let repairBurden = 0;
  repairBurden += addThresholdFactor(
    repairFactors,
    ratios.repair_burden_ratio,
    [[1, 60], [0.5, 45], [0.25, 30], [0.1, 15]],
    'repair_cost_to_income',
  );
  repairBurden += addThresholdFactor(
    repairFactors,
    repairToValueRatio,
    [[0.3, 25], [0.15, 15], [0.05, 7]],
    'repair_cost_to_property_value',
  );
  repairBurden += addFactor(repairFactors, subject.code_violation, 10, 'code_violation');
  repairBurden += addFactor(repairFactors, subject.vacant, 8, 'vacancy');
  repairBurden = Math.round(clamp(repairBurden));

  const underperformingAsset = Math.round(
    clamp(
      (subject.vacant ? 30 : 0) +
        repairBurden * 0.35 +
        (subject.code_violation ? 20 : 0) +
        (subject.landlord_profile ? 15 : 0) +
        (subject.tax_delinquent ? 10 : 0),
    ),
  );
  const condition = conditionRank(first(subject.condition, subject.rehab_level));
  const asking = num(subject.listing_price);
  const supportedPrice =
    asking !== null && valuation.high !== null && asking <= valuation.high * 1.03;
  const retailSeller = Math.round(
    clamp(
      (condition !== null && condition >= 3 ? 35 : 0) +
        (repairToValueRatio !== null && repairToValueRatio <= 0.1 ? 20 : 0) +
        (supportedPrice ? 25 : 0) +
        (!subject.vacant && !subject.code_violation ? 10 : 0) +
        (sellerFinancialPressure < 35 ? 10 : 0),
    ),
  );
  const estateTransition = Math.round(
    clamp(
      (subject.probate ? 72 : 0) +
        (subject.vacant ? 10 : 0) +
        (ownershipYears >= 10 ? 10 : 0) +
        (equityPercent >= 50 ? 8 : 0),
    ),
  );
  const portfolioRebalance = Math.round(
    clamp(
      (propertyCount >= 5 ? 35 : propertyCount >= 2 ? 22 : 0) +
        (num(subject.portfolio_total_units) >= 5 ? 18 : num(subject.portfolio_total_units) >= 2 ? 10 : 0) +
        (subject.landlord_profile ? 15 : 0) +
        (subject.absentee_owner ? 10 : 0) +
        equityUnlock * 0.2 +
        (['commercial', 'multifamily'].includes(subject.asset_family) ? 10 : 0),
    ),
  );
  const wealthPreservation = Math.round(
    clamp(
      equityUnlock * 0.5 +
        taxPain * 0.2 +
        (ownershipYears >= 20 ? 20 : ownershipYears >= 10 ? 12 : 0) +
        (sellerFinancialPressure < 35 ? 10 : 0) +
        (['commercial', 'multifamily'].includes(subject.asset_family) ? 10 : 0),
    ),
  );
  const creativeFinanceCandidate = Math.round(
    clamp(
      Math.max(
        creative.subject_to_score,
        creative.seller_finance_score,
        creative.lease_option_score,
        creative.novation_score,
      ) *
        0.7 +
        Math.max(debtPressure, equityUnlock) * 0.3,
    ),
  );
  const ownerSituationScores = {
    DISTRESSED_OWNER: Math.round(
      clamp(
        sellerFinancialPressure * 0.45 +
          forcedSalePressure * 0.35 +
          foreclosureRisk * 0.2,
      ),
    ),
    FATIGUED_LANDLORD: landlordFatigue,
    WEALTH_PRESERVATION: wealthPreservation,
    ESTATE_TRANSITION: estateTransition,
    PORTFOLIO_REBALANCE: portfolioRebalance,
    DEBT_PRESSURE: debtPressure,
    UNDERPERFORMING_ASSET: underperformingAsset,
    RETAIL_SELLER: retailSeller,
    CREATIVE_FINANCE_CANDIDATE: creativeFinanceCandidate,
  };
  const rankedSituations = OWNER_SITUATIONS
    .map((name, priority) => ({ name, priority, score: ownerSituationScores[name] }))
    .sort((left, right) => right.score - left.score || left.priority - right.priority);
  const topSituation = rankedSituations[0];
  const topConcreteSituation = rankedSituations.find(
    (entry) => entry.name !== 'CREATIVE_FINANCE_CANDIDATE',
  );
  const primarySituation =
    topSituation.name === 'CREATIVE_FINANCE_CANDIDATE' &&
    topConcreteSituation &&
    topConcreteSituation.score >= topSituation.score - 10
      ? topConcreteSituation.name
      : topSituation.name;

  const reliability = 0.72 + (dataConfidence.score / 100) * 0.28;
  const motivationScore = clamp(num(subject.motivation_score, 0));
  const raw90 =
    5 +
    sellerFinancialPressure * 0.27 +
    forcedSalePressure * 0.3 +
    foreclosureRisk * 0.18 +
    landlordFatigue * 0.1 +
    underperformingAsset * 0.08 +
    motivationScore * 0.05;
  const probability90 = Math.round(clamp(5 + (raw90 - 5) * reliability, 0, 95));
  const raw180 =
    probability90 +
    8 +
    landlordFatigue * 0.08 +
    equityUnlock * 0.05 +
    creativeFinanceCandidate * 0.03;
  const probability180 = Math.round(
    clamp(Math.max(probability90, 8 + (raw180 - 8) * reliability), 0, 97),
  );
  const raw365 =
    probability180 +
    12 +
    portfolioRebalance * 0.05 +
    wealthPreservation * 0.05 +
    retailSeller * 0.03;
  const probability365 = Math.round(
    clamp(Math.max(probability180, 10 + (raw365 - 10) * reliability), 0, 98),
  );

  const aggressionRaw =
    sellerFinancialPressure * 0.35 +
    forcedSalePressure * 0.3 +
    foreclosureRisk * 0.15 +
    probability90 * 0.1 +
    equityUnlock * 0.1;
  const offerAggression = Math.round(
    clamp(aggressionRaw * (0.8 + (dataConfidence.score / 100) * 0.2)),
  );

  const sellerFinanceRange =
    valuationMid === null
      ? null
      : {
          low: roundMoney(
            Math.max(num(offer.recommended_cash_offer, 0), valuationMid * 0.85),
          ),
          high: roundMoney((num(valuation.high) ?? valuationMid) * 0.98),
        };
  const subjectToViability = Math.round(
    clamp(creative.subject_to_score * 0.7 + debtPressure * 0.3),
  );
  const sellerFinanceViability = Math.round(
    clamp(creative.seller_finance_score * 0.7 + equityUnlock * 0.3),
  );
  const cashConfidence = offer.recommended_cash_offer
    ? Math.round(clamp(overallConfidence * 0.75 + dataConfidence.score * 0.25))
    : 0;
  const commercialAppreciation =
    ['commercial', 'multifamily'].includes(subject.asset_family) &&
    appreciationReliable &&
    ratios.appreciation_gain_ratio >= 0.5;

  let primaryOffer = 'CASH';
  let backupOffer = creative.best_creative_strategy;
  let conversationAngle = 'CONDITION_AND_TIMELINE_DISCOVERY';
  let whyThisAngle =
    'Lead with a neutral condition and timing conversation because no single owner-situation signal dominates.';

  if (
    debtPressure >= 55 &&
    (sellerFinancialPressure >= 40 || foreclosureRisk >= 35)
  ) {
    primaryOffer = 'SUBJECT_TO';
    backupOffer = 'CASH_ARREARS_CURE';
    conversationAngle = 'DEBT_RELIEF_AND_ARREARS_CURE';
    whyThisAngle =
      'Material debt and enforcement pressure favor a payment-relief or arrears-cure structure before a conventional cash discount.';
  } else if (sellerFinancialPressure >= 60 && equityUnlock >= 55) {
    primaryOffer = 'AGGRESSIVE_CASH';
    backupOffer = 'SELLER_FINANCE';
    conversationAngle = 'CERTAINTY_SPEED_AND_AS_IS_EXIT';
    whyThisAngle =
      'High verified pressure and a strong equity cushion support an assertive cash offer centered on certainty, speed, and an as-is closing.';
  } else if (landlordFatigue >= 60 && equityPercent >= 55) {
    primaryOffer = 'SELLER_FINANCE';
    backupOffer = 'CASH';
    conversationAngle = 'LANDLORD_FATIGUE_AND_WEALTH_PRESERVATION';
    whyThisAngle =
      'A long-tenure, high-equity landlord profile supports relief from management burden while preserving income and spreading taxable gain through structured terms.';
  } else if (commercialAppreciation) {
    primaryOffer = 'SELLER_FINANCE';
    backupOffer = 'STRUCTURED_CASH';
    conversationAngle = 'WEALTH_PRESERVATION_AND_STRUCTURED_EXIT';
    whyThisAngle =
      'The income-property profile and supported appreciation proxy favor a structured exit focused on tax timing, income continuity, and capital preservation.';
  } else if (
    equityPercent >= 65 &&
    sellerFinancialPressure < 45 &&
    ownershipYears >= 10
  ) {
    primaryOffer = 'SELLER_FINANCE';
    backupOffer = 'CASH';
    conversationAngle = 'TAX_EFFICIENT_EQUITY_EXIT';
    whyThisAngle =
      'High equity, long ownership, and limited forced-sale pressure favor a tax-aware seller-finance conversation over a steep cash discount.';
  } else if (
    landlordFatigue >= 55 &&
    (repairBurden >= 35 || subject.vacant)
  ) {
    primaryOffer = sellerFinanceViability >= 65 ? 'SELLER_FINANCE' : 'CASH';
    backupOffer = primaryOffer === 'SELLER_FINANCE' ? 'CASH' : 'LEASE_OPTION';
    conversationAngle = 'LANDLORD_RELIEF_AND_REPAIR_CERTAINTY';
    whyThisAngle =
      'Management fatigue plus vacancy or repair burden favors a low-friction exit conversation focused on tenant, maintenance, and closing certainty.';
  } else if (retailSeller >= 65 && supportedPrice && probability90 >= 25) {
    primaryOffer = 'NOVATION';
    backupOffer = 'CASH';
    conversationAngle = 'RETAIL_UPSIDE_WITH_EXECUTION_CERTAINTY';
    whyThisAngle =
      'Retail-capable condition and a supported price make novation a viable lead while retaining cash as the certainty fallback.';
  } else if (probability90 < 25 && sellerFinancialPressure < 30) {
    primaryOffer = 'NURTURE';
    backupOffer = 'CASH_WHEN_TIMING_CHANGES';
    conversationAngle = 'LOW_PRESSURE_NURTURE';
    whyThisAngle =
      'The current profile has little verified seller pressure, so the appropriate strategy is discovery and patient follow-up rather than manufactured urgency.';
  } else if (creative.best_creative_score >= 68) {
    primaryOffer = creative.best_creative_strategy;
    backupOffer = 'CASH';
    conversationAngle = 'CREATIVE_TERMS_DISCOVERY';
    whyThisAngle =
      'The strongest deterministic path is a creative structure, but terms should be confirmed through debt, timing, and condition discovery.';
  }

  const recommendedOfferStack = {
    cash_offer: offer.recommended_cash_offer,
    cash_offer_confidence: cashConfidence,
    seller_finance_offer_range: sellerFinanceRange,
    subject_to_viability: subjectToViability,
    lease_option_viability: creative.lease_option_score,
    novation_viability: creative.novation_score,
    primary_offer_to_lead_with: primaryOffer,
    backup_offer: backupOffer,
    conversation_angle: conversationAngle,
    why_this_angle: whyThisAngle,
  };

  return {
    seller_financial_pressure_score: sellerFinancialPressure,
    forced_sale_pressure_score: forcedSalePressure,
    foreclosure_risk_score: foreclosureRisk,
    transaction_probability_90: probability90,
    transaction_probability_180: probability180,
    transaction_probability_365: probability365,
    landlord_fatigue_score: landlordFatigue,
    tax_pain_score: taxPain,
    equity_unlock_score: equityUnlock,
    debt_pressure_score: debtPressure,
    repair_burden_score: repairBurden,
    offer_aggression_score: offerAggression,
    owner_situation_primary: primarySituation,
    owner_situation_scores: ownerSituationScores,
    recommended_conversation_angle: conversationAngle,
    recommended_offer_stack: recommendedOfferStack,
    data_confidence: dataConfidence,
    evidence: {
      ratios_used: {
        ...roundedRatios,
        formula_notes: {
          housing_burden_ratio:
            '(monthly_loan_payment * 12) / estimated_household_income',
          tax_burden_ratio:
            'annual_property_taxes / estimated_household_income',
          tax_arrears_ratio:
            'past_due_amount / estimated_household_income',
          repair_burden_ratio:
            'estimated_repair_cost / estimated_household_income',
          debt_to_value_ratio: 'total_loan_balance / valuation_mid',
          equity_trapped_ratio:
            'equity_amount / estimated_net_asset_value',
          appreciation_gain_ratio:
            'max(valuation_mid - last_sale_price, 0) / max(last_sale_price, 1)',
        },
      },
      seller_financial_pressure_breakdown: {
        score: sellerFinancialPressure,
        factors: pressureFactors,
      },
      missing_seller_data: dataConfidence,
      owner_situation_scores: ownerSituationScores,
      transaction_probability_reasoning: {
        probability_90: probability90,
        probability_180: probability180,
        probability_365: probability365,
        reliability_multiplier: round(reliability, 4),
        inputs: {
          seller_financial_pressure: sellerFinancialPressure,
          forced_sale_pressure: forcedSalePressure,
          foreclosure_risk: foreclosureRisk,
          landlord_fatigue: landlordFatigue,
          underperforming_asset: underperformingAsset,
          structured_motivation_score: motivationScore,
        },
      },
      forced_sale_foreclosure_risk_reasoning: {
        forced_sale_pressure: {
          score: forcedSalePressure,
          factors: forcedSaleFactors,
        },
        foreclosure_risk: {
          score: foreclosureRisk,
          factors: foreclosureFactors,
        },
      },
      tax_pain_capital_gains_proxy_reasoning: {
        score: taxPain,
        factors: taxPainFactors,
        appreciation_gain_ratio: roundedRatios.appreciation_gain_ratio,
        appreciation_proxy_reliable: appreciationReliable,
        reliability_note: appreciationReliable
          ? 'Positive last sale price supports the appreciation proxy.'
          : 'Last sale price is missing or zero; the formula is retained in evidence but does not add tax-pain points.',
      },
      offer_aggression_reasoning: {
        score: offerAggression,
        raw_score: round(aggressionRaw, 2),
        data_confidence: dataConfidence.score,
        inputs: {
          seller_financial_pressure: sellerFinancialPressure,
          forced_sale_pressure: forcedSalePressure,
          foreclosure_risk: foreclosureRisk,
          transaction_probability_90: probability90,
          equity_unlock: equityUnlock,
        },
      },
      recommended_conversation_strategy: recommendedOfferStack,
      component_breakdowns: {
        landlord_fatigue: landlordFactors,
        tax_pain: taxPainFactors,
        equity_unlock: equityUnlockFactors,
        debt_pressure: debtFactors,
        repair_burden: repairFactors,
      },
      safety_gates: {
        protected_class_assumptions_used: false,
        protected_fields_used: [],
        buying_power_used_for_pressure_or_decision: false,
        phone_type_used_for_pressure_or_decision: false,
        phone_prepaid_used_for_pressure_or_decision: false,
        missing_data_creates_pressure: false,
      },
    },
  };
}

function offerCalculation(subject, valuation, investor, repairs, targetAssignmentFee) {
  if (!valuation.mid) {
    return {
      recommended_cash_offer: null,
      minimum_acceptable_offer: null,
      expected_assignment_fee: null,
      effective_buyer_ceiling: null,
      summary: { method: 'unavailable_without_valuation' },
    };
  }

  const maxArvFactor =
    subject.asset_family === 'commercial'
      ? 0.68
      : subject.asset_family === 'multifamily'
        ? 0.72
        : subject.asset_family === 'land'
          ? 0.62
          : 0.7;
  const valuationCeiling = Math.max(0, valuation.mid * maxArvFactor - repairs.amount);
  const behaviorCeiling = num(investor.mid);
  let effectiveCeiling;
  if (behaviorCeiling && investor.confidence >= 45) {
    effectiveCeiling = Math.min(valuationCeiling, behaviorCeiling);
  } else if (behaviorCeiling) {
    effectiveCeiling = valuationCeiling * 0.75 + behaviorCeiling * 0.25;
  } else {
    effectiveCeiling = valuationCeiling;
  }

  const motivation = distressAndMotivation(subject);
  const confidenceHaircut = ((100 - valuation.confidence) / 100) * 0.06;
  const motivationDiscount = (motivation.score / 100) * 0.035;
  const demandPremium =
    ((investor.buyer_demand_score + investor.liquidity_score) / 200) * 0.015;
  const offerBeforeRound =
    effectiveCeiling * (1 - confidenceHaircut - motivationDiscount + demandPremium) -
    targetAssignmentFee;
  const recommended = Math.max(0, roundMoney(offerBeforeRound));
  const negotiationBand = Math.max(5_000, valuation.mid * 0.03);
  const minimum = Math.max(0, roundMoney(recommended - negotiationBand));
  const expectedFee = Math.max(0, roundMoney(effectiveCeiling - recommended));

  return {
    recommended_cash_offer: recommended,
    minimum_acceptable_offer: minimum,
    expected_assignment_fee: expectedFee,
    effective_buyer_ceiling: roundMoney(effectiveCeiling),
    summary: {
      method: 'repair_adjusted_exit_ceiling_less_assignment_target',
      max_arv_factor: maxArvFactor,
      valuation_based_ceiling: roundMoney(valuationCeiling),
      behavior_based_ceiling: roundMoney(behaviorCeiling),
      effective_buyer_ceiling: roundMoney(effectiveCeiling),
      estimated_repairs: repairs.amount,
      target_assignment_fee: targetAssignmentFee,
      confidence_haircut_percent: round(confidenceHaircut * 100, 2),
      motivation_discount_percent: round(motivationDiscount * 100, 2),
      demand_premium_percent: round(demandPremium * 100, 2),
      motivation,
    },
  };
}

function subjectCompleteness(subject) {
  const relevant = [
    'asset_type',
    'property_class',
    'sqft',
    'units',
    'year_built',
    'effective_year_built',
    'lot_sqft',
    'latitude',
    'longitude',
    'zip',
    'condition',
    'estimated_repairs',
    'estimated_value',
    'equity_percent',
    'loan_balance',
    'ownership_years',
  ].filter((feature) => featurePriority(subject.asset_type, feature) > 0);
  const available = relevant.filter((feature) => hasValue(subject[feature]));
  return {
    score: Math.round((available.length / relevant.length) * 100),
    available,
    missing: relevant.filter((feature) => !hasValue(subject[feature])),
  };
}

function financeCompleteness(subject) {
  const fields = [
    'equity_percent',
    'loan_balance',
    'ownership_years',
    'absentee_owner',
    'tax_delinquent',
    'active_lien',
    'motivation_score',
    'distress_score',
    'listing_price',
    'market_status',
  ];
  const available = fields.filter((field) => hasValue(subject[field]));
  return {
    score: Math.round((available.length / fields.length) * 100),
    available,
    missing: fields.filter((field) => !hasValue(subject[field])),
  };
}

function acquisitionOpportunityScore({
  subject,
  valuation,
  investor,
  offer,
  creative,
  targetAssignmentFee,
}) {
  const motivation = distressAndMotivation(subject);
  const marginScore = clamp(
    (num(offer.expected_assignment_fee, 0) / Math.max(targetAssignmentFee, 1)) * 100,
  );
  const equityScore =
    subject.equity_percent !== null
      ? subject.equity_percent >= 45
        ? 100
        : subject.equity_percent >= 20
          ? 72
          : creative.subject_to_score
      : Math.max(creative.subject_to_score, creative.seller_finance_score) * 0.7;
  const strategyOptionality = Math.max(
    creative.subject_to_score,
    creative.seller_finance_score,
    creative.lease_option_score,
    creative.novation_score,
  );
  const components = {
    assignment_margin: round(marginScore * 2.5, 1),
    buyer_demand: round(investor.buyer_demand_score * 1.5, 1),
    liquidity: round(investor.liquidity_score, 1),
    distress_motivation: round(motivation.score * 1.5, 1),
    equity_finance: round(clamp(equityScore), 1),
    valuation_strength: round(valuation.confidence * 1.5, 1),
    strategy_optionality: round(strategyOptionality, 1),
  };
  const total = Object.values(components).reduce((sum, value) => sum + value, 0);
  return {
    score: Math.round(clamp(total, 0, 1000)),
    components,
    motivation,
  };
}

function determineDecisionTier({
  valuation,
  investor,
  offer,
  creative,
  aos,
  confidence,
  compCount,
  targetAssignmentFee,
}) {
  const hardGateChecks = {
    confidence_at_least_85: confidence >= 85,
    comp_count_at_least_4: compCount >= 4,
    valuation_confidence_at_least_80: valuation.confidence >= 80,
    assignment_fee_meets_target:
      num(offer.expected_assignment_fee, 0) >= targetAssignmentFee,
    recommended_offer_available: num(offer.recommended_cash_offer, 0) > 0,
    aos_at_least_780: aos.score >= 780,
  };
  const hardGatePassed = Object.values(hardGateChecks).every(Boolean);
  let tier;
  const reasons = [];

  if (hardGatePassed) {
    tier = DECISION_TIERS.AUTO_HARD_OFFER;
    reasons.push('all_auto_hard_offer_gates_passed');
  } else if (
    creative.best_creative_score >= 68 &&
    (
      num(offer.expected_assignment_fee, 0) < targetAssignmentFee ||
      creative.best_creative_score >= 80
    ) &&
    confidence >= 50
  ) {
    tier = DECISION_TIERS.CREATIVE_TERMS;
    reasons.push(`${creative.best_creative_strategy.toLowerCase()}_is_strongest_viable_path`);
  } else if (
    confidence >= 68 &&
    compCount >= 3 &&
    valuation.confidence >= 65 &&
    num(offer.expected_assignment_fee, 0) >= targetAssignmentFee * 0.75 &&
    aos.score >= 600
  ) {
    tier = DECISION_TIERS.AUTO_RANGE_OFFER;
    reasons.push('valuation_and_margin_support_range_but_hard_offer_gates_failed');
  } else if (aos.score < 430 || investor.buyer_demand_score < 25) {
    tier = DECISION_TIERS.NURTURE;
    reasons.push('opportunity_or_buyer_demand_below_active_offer_threshold');
  } else {
    tier = DECISION_TIERS.REVIEW_REQUIRED;
    reasons.push('insufficient_confidence_or_market_support_for_automation');
  }

  for (const [gate, passed] of Object.entries(hardGateChecks)) {
    if (!passed) reasons.push(`hard_gate_failed:${gate}`);
  }
  return { tier, reasons, hard_gate_checks: hardGateChecks };
}

function scoreRowFromDecision(propertyId, decision, now = new Date()) {
  return {
    property_id: clean(propertyId),
    valuation_low: decision.valuation.low,
    valuation_mid: decision.valuation.mid,
    valuation_high: decision.valuation.high,
    valuation_confidence: decision.valuation.confidence,
    comp_count: decision.selected_comps.length,
    weighted_comp_score: decision.valuation.weighted_comp_score,
    investor_ceiling_low: decision.investor.low,
    investor_ceiling_mid: decision.investor.mid,
    investor_ceiling_high: decision.investor.high,
    buyer_demand_score: decision.investor.buyer_demand_score,
    liquidity_score: decision.investor.liquidity_score,
    estimated_repairs: decision.repairs.amount,
    recommended_cash_offer: decision.offer.recommended_cash_offer,
    minimum_acceptable_offer: decision.offer.minimum_acceptable_offer,
    expected_assignment_fee: decision.offer.expected_assignment_fee,
    subject_to_score: decision.creative.subject_to_score,
    seller_finance_score: decision.creative.seller_finance_score,
    lease_option_score: decision.creative.lease_option_score,
    novation_score: decision.creative.novation_score,
    best_strategy: decision.best_strategy,
    aos_score: decision.aos.score,
    confidence: decision.confidence,
    decision_tier: decision.decision.tier,
    seller_financial_pressure_score:
      decision.owner_situation.seller_financial_pressure_score,
    forced_sale_pressure_score:
      decision.owner_situation.forced_sale_pressure_score,
    foreclosure_risk_score: decision.owner_situation.foreclosure_risk_score,
    transaction_probability_90:
      decision.owner_situation.transaction_probability_90,
    transaction_probability_180:
      decision.owner_situation.transaction_probability_180,
    transaction_probability_365:
      decision.owner_situation.transaction_probability_365,
    landlord_fatigue_score: decision.owner_situation.landlord_fatigue_score,
    tax_pain_score: decision.owner_situation.tax_pain_score,
    equity_unlock_score: decision.owner_situation.equity_unlock_score,
    debt_pressure_score: decision.owner_situation.debt_pressure_score,
    repair_burden_score: decision.owner_situation.repair_burden_score,
    offer_aggression_score: decision.owner_situation.offer_aggression_score,
    owner_situation_primary: decision.owner_situation.owner_situation_primary,
    owner_situation_scores: decision.owner_situation.owner_situation_scores,
    recommended_conversation_angle:
      decision.owner_situation.recommended_conversation_angle,
    recommended_offer_stack:
      decision.owner_situation.recommended_offer_stack,
    evidence: decision.evidence,
    computed_at: now.toISOString(),
  };
}

export function calculateAcquisitionDecision({
  subject: rawSubject,
  comps: rawComps = [],
  buyerPurchases = [],
  now = new Date(),
  targetAssignmentFee = DEFAULT_TARGET_ASSIGNMENT_FEE,
} = {}) {
  const subject =
    rawSubject?.asset_family
      ? { ...rawSubject }
      : normalizePropertyFeatures(rawSubject, { source: 'properties', now });
  const scored = rawComps.map((comp) =>
    scoreComparable(subject, comp, {
      source: comp.source,
      distance_miles: comp.distance_miles,
      now,
    }),
  );
  const eligibilityRejected = scored.filter((comp) => !comp.eligible);
  const qualityRejected = scored
    .filter((comp) => comp.eligible && (comp.comp_score < 30 || !comp.adjusted_price))
    .map((comp) => ({
      ...comp,
      eligible: false,
      reasons: [comp.adjusted_price ? 'comp_score_below_30' : 'missing_adjusted_price'],
    }));
  const initiallySelected = scored
    .filter((comp) => comp.eligible && comp.comp_score >= 30 && comp.adjusted_price)
    .sort((a, b) => b.weight - a.weight);
  const outliers = removeOutliers(initiallySelected);
  const selected = outliers.selected
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_SELECTED_COMPS);
  const excessRejected = outliers.selected
    .slice(MAX_SELECTED_COMPS)
    .map((comp) => ({ ...comp, reasons: ['outside_top_comp_limit'] }));
  const rejected = [
    ...eligibilityRejected,
    ...qualityRejected,
    ...outliers.rejected,
    ...excessRejected,
  ];
  const valuation = calculateValuation(subject, selected);
  if (!selected.length && !rawComps.length) {
    valuation.calculation.comp_status = 'no_comps_found';
    valuation.calculation.reason = 'no_comps_found';
  }
  const repairs = repairEstimate(subject);
  const investor = calculateInvestorCeiling(subject, valuation, buyerPurchases, now);
  const creative = creativeFinanceScores(subject, valuation);
  const offer = offerCalculation(
    subject,
    valuation,
    investor,
    repairs,
    targetAssignmentFee,
  );
  const aos = acquisitionOpportunityScore({
    subject,
    valuation,
    investor,
    offer,
    creative,
    targetAssignmentFee,
  });
  const subjectData = subjectCompleteness(subject);
  const financeData = financeCompleteness(subject);
  const uncappedConfidence = clamp(
    valuation.confidence * 0.45 +
      subjectData.score * 0.2 +
      investor.confidence * 0.2 +
      financeData.score * 0.15,
  );
  const confidenceCap = selected.length ? 100 : 45;
  const confidence = Math.round(Math.min(uncappedConfidence, confidenceCap));
  const decision = determineDecisionTier({
    valuation,
    investor,
    offer,
    creative,
    aos,
    confidence,
    compCount: selected.length,
    targetAssignmentFee,
  });
  const cashViability =
    num(offer.expected_assignment_fee, 0) >= targetAssignmentFee * 0.75 &&
    valuation.confidence >= 60;
  const bestStrategy =
    creative.best_creative_score >= 68 && !cashViability
      ? creative.best_creative_strategy
      : 'CASH_ASSIGNMENT';
  const ownerSituation = calculateOwnerSituationPhase2({
    subject,
    valuation,
    creative,
    offer,
    overallConfidence: confidence,
  });
  const ownerContextLoading = subject.raw?.owner_context_loading ?? {
    attempted: false,
    loaded: false,
    missing_optional_owner_fields: [],
    skipped_optional_sources: [],
    sources: {},
  };

  const publicSelected = selected.map((comp) => ({
    id: comp.comp.source_id,
    comp_id: comp.comp.source_id,
    property_id: comp.comp.property_id,
    address: comp.comp.address,
    source: comp.comp.sale_source,
    sale_price: comp.comp.sale_price,
    sale_date: comp.comp.sale_date,
    sold_date: comp.comp.sale_date,
    distance_miles: comp.comp.distance_miles,
    adjusted_price: comp.adjusted_price,
    adjusted_value: comp.adjusted_price,
    comp_score: comp.comp_score,
    score: comp.comp_score,
    comp_confidence: comp.comp_confidence,
    data_completeness: comp.data_completeness,
    weight: comp.weight,
    price_adjustments: comp.price_adjustments,
    feature_match_breakdown: comp.feature_match_breakdown,
    match_breakdown: comp.feature_match_breakdown,
  }));
  const publicRejected = rejected.map((comp) => ({
    id: comp.comp?.source_id ?? null,
    comp_id: comp.comp?.source_id ?? null,
    property_id: comp.comp?.property_id ?? null,
    address: comp.comp?.address ?? null,
    source: comp.comp?.sale_source ?? null,
    sale_price: comp.comp?.sale_price ?? null,
    sale_date: comp.comp?.sale_date ?? null,
    sold_date: comp.comp?.sale_date ?? null,
    distance_miles: comp.comp?.distance_miles ?? null,
    reason: comp.reasons?.[0] ?? 'rejected',
    reasons: comp.reasons ?? [],
    comp_score: comp.comp_score ?? null,
    score: comp.comp_score ?? null,
    adjusted_price: comp.adjusted_price ?? null,
    adjusted_value: comp.adjusted_price ?? null,
    match_breakdown: comp.feature_match_breakdown ?? null,
  }));
  const compDataStatus =
    rawComps.length === 0
      ? 'no_comps_found'
      : selected.length === 0
        ? 'no_eligible_comps_found'
        : 'comps_selected';
  const evidence = {
    engine: {
      name: 'acquisition_decision_engine',
      version: '2.0.0',
      deterministic: true,
      computed_at: now.toISOString(),
      target_assignment_fee: targetAssignmentFee,
    },
    subject: {
      property_id: subject.property_id,
      address: subject.address,
      market: subject.market,
      asset_type: subject.asset_type,
      asset_family: subject.asset_family,
      normalized_features: Object.fromEntries(
        Object.entries(subject).filter(([key]) => key !== 'raw'),
      ),
    },
    selected_comps: publicSelected,
    rejected_comps: publicRejected,
    comp_data_status: {
      status: compDataStatus,
      no_comps_found: rawComps.length === 0,
      no_eligible_comps_found: selected.length === 0,
      raw_candidate_count: rawComps.length,
      eligible_candidate_count: scored.filter((comp) => comp.eligible).length,
      selected_comp_count: selected.length,
      rejected_comp_count: rejected.length,
      message:
        compDataStatus === 'no_comps_found'
          ? 'No comps found; fallback valuation and confidence cap applied.'
          : compDataStatus === 'no_eligible_comps_found'
            ? 'No eligible comps found after validation; fallback valuation and confidence cap applied.'
            : `${selected.length} comps selected for weighted valuation.`,
    },
    valuation_calculation_summary: valuation.calculation,
    outlier_method: {
      method: outliers.method,
      median: outliers.median ?? null,
      mad: outliers.mad ?? null,
      allowed_deviation: outliers.allowed_deviation ?? null,
    },
    investor_ceiling_summary: {
      ...investor.summary,
      confidence: investor.confidence,
      low: investor.low,
      mid: investor.mid,
      high: investor.high,
      buyer_demand_score: investor.buyer_demand_score,
      liquidity_score: investor.liquidity_score,
      sample_purchases: investor.purchases.slice(0, 20).map((purchase) => ({
        id: purchase.source_id,
        buyer_key: purchase.buyer_key,
        buyer_type: purchase.buyer_type,
        purchase_price: purchase.sale_price,
        adjusted_price: purchase.adjusted_price,
        purchase_date: purchase.sale_date,
        distance_miles: round(purchase.distance_miles, 2),
        cash_investor_proxy: purchase.cash_investor_proxy,
      })),
    },
    repair_estimate: repairs,
    offer_calculation: offer.summary,
    creative_finance_reasoning: creative.reasoning,
    seller_financial_pressure_breakdown:
      ownerSituation.evidence.seller_financial_pressure_breakdown,
    ratios_used: ownerSituation.evidence.ratios_used,
    missing_seller_data: ownerSituation.evidence.missing_seller_data,
    owner_situation_scores: ownerSituation.evidence.owner_situation_scores,
    transaction_probability_reasoning:
      ownerSituation.evidence.transaction_probability_reasoning,
    forced_sale_foreclosure_risk_reasoning:
      ownerSituation.evidence.forced_sale_foreclosure_risk_reasoning,
    tax_pain_capital_gains_proxy_reasoning:
      ownerSituation.evidence.tax_pain_capital_gains_proxy_reasoning,
    offer_aggression_reasoning:
      ownerSituation.evidence.offer_aggression_reasoning,
    recommended_conversation_strategy:
      ownerSituation.evidence.recommended_conversation_strategy,
    owner_context_loading: ownerContextLoading,
    owner_situation_component_breakdowns:
      ownerSituation.evidence.component_breakdowns,
    aos_breakdown: aos,
    confidence_breakdown: {
      overall: confidence,
      uncapped_overall: round(uncappedConfidence, 1),
      confidence_cap: confidenceCap,
      cap_reason: selected.length ? null : 'no_eligible_comps_found',
      valuation_confidence: valuation.confidence,
      subject_data_completeness: subjectData,
      buyer_behavior_confidence: investor.confidence,
      finance_distress_completeness: financeData,
      formula:
        '45% valuation + 20% subject completeness + 20% buyer behavior + 15% finance/distress completeness',
    },
    decision_tier_reasoning: decision,
    safeguards: {
      sends_messages: false,
      writes_queue_tables: false,
      writes_only: [SCORE_TABLE],
      ...ownerSituation.evidence.safety_gates,
    },
  };

  return {
    subject,
    selected_comps: selected,
    rejected_comps: rejected,
    valuation,
    repairs,
    investor,
    creative,
    offer,
    aos,
    owner_situation: ownerSituation,
    confidence,
    decision,
    best_strategy: bestStrategy,
    evidence,
  };
}

function isOptionalSourceMissing(error) {
  return ['42P01', 'PGRST205'].includes(clean(error?.code));
}

function isMissingColumnError(error) {
  return ['42703', 'PGRST204'].includes(clean(error?.code));
}

function selectedColumns(select) {
  return clean(select).split(',').map(clean).filter(Boolean);
}

function missingColumnName(error) {
  const message = [
    error?.message,
    error?.details,
    error?.hint,
  ].map(clean).filter(Boolean).join(' ');
  const patterns = [
    /could not find the ['"]([^'"]+)['"] column/i,
    /column ['"]?(?:[a-z0-9_]+\.)?([a-z0-9_]+)['"]? does not exist/i,
    /column ['"]([^'"]+)['"]/i,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) return clean(match[1]);
  }
  return null;
}

function skippedOptionalSource(source, reason) {
  return {
    data: [],
    report: {
      source,
      status: 'skipped',
      loaded: false,
      row_count: 0,
      missing_fields: [],
      skipped_reason: reason,
      attempts: 0,
    },
  };
}

async function optionalEnrichmentQuery({
  source,
  select,
  buildQuery,
}) {
  let columns = selectedColumns(select);
  const missingFields = [];
  let attempts = 0;

  while (columns.length > 0) {
    attempts += 1;
    const result = await buildQuery(columns.join(','), columns);
    if (!result?.error) {
      const data = result?.data ?? [];
      return {
        data,
        report: {
          source,
          status: 'loaded',
          loaded: true,
          row_count: data.length,
          missing_fields: missingFields,
          skipped_reason: null,
          attempts,
        },
      };
    }

    const error = result.error;
    if (isOptionalSourceMissing(error)) {
      return {
        data: [],
        report: {
          source,
          status: 'skipped',
          loaded: false,
          row_count: 0,
          missing_fields: missingFields,
          skipped_reason: `source_unavailable:${clean(error.code) || 'unknown'}`,
          attempts,
        },
      };
    }
    if (!isMissingColumnError(error)) throw error;

    const missingColumn = missingColumnName(error);
    if (!missingColumn || !columns.includes(missingColumn)) {
      return {
        data: [],
        report: {
          source,
          status: 'skipped',
          loaded: false,
          row_count: 0,
          missing_fields: missingFields,
          skipped_reason: missingColumn
            ? `missing_query_column:${missingColumn}`
            : `missing_optional_column_unresolved:${clean(error.code) || 'unknown'}`,
          attempts,
        },
      };
    }

    columns = columns.filter((column) => column !== missingColumn);
    missingFields.push(`${source}.${missingColumn}`);
  }

  return {
    data: [],
    report: {
      source,
      status: 'skipped',
      loaded: false,
      row_count: 0,
      missing_fields: missingFields,
      skipped_reason: 'no_selectable_columns',
      attempts,
    },
  };
}

async function optionalQuery(queryPromise) {
  const result = await queryPromise;
  if (result?.error && !isOptionalSourceMissing(result.error)) throw result.error;
  return result?.error ? [] : result?.data ?? [];
}

function prospectContextScore(row = {}) {
  return [
    row.est_household_income,
    row.net_asset_value,
    row.buying_power,
    row.owner_type_guess,
    row.seller_tags_text,
  ].filter(hasValue).length;
}

function phoneLinkedToProspect(row = {}, prospectId) {
  if (!prospectId) return false;
  const linked = row.linked_prospect_ids_json;
  if (Array.isArray(linked)) return linked.map(clean).includes(clean(prospectId));
  if (linked && typeof linked === 'object') return Boolean(linked[prospectId]);
  return false;
}

export async function loadSubjectProperty(propertyId, deps = {}) {
  const { data, error } = await db(deps)
    .from('properties')
    .select(SUBJECT_SELECT)
    .eq('property_id', clean(propertyId))
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const masterOwnerId = clean(data.master_owner_id);
  const [contactResult, masterOwnerResult, prospectResult, phoneResult] = await Promise.all([
    optionalEnrichmentQuery({
      source: 'acquisition_contacts',
      select: ACQUISITION_CONTACT_SELECT,
      buildQuery: (select, columns) => {
        let query = db(deps)
          .from('acquisition_contacts')
          .select(select)
          .eq('property_id', clean(propertyId));
        if (columns.includes('updated_at')) {
          query = query.order('updated_at', { ascending: false });
        }
        return query.limit(1);
      },
    }),
    masterOwnerId
      ? optionalEnrichmentQuery({
          source: 'master_owners',
          select: MASTER_OWNER_SELECT,
          buildQuery: (select) =>
            db(deps)
              .from('master_owners')
              .select(select)
              .eq('master_owner_id', masterOwnerId)
              .limit(1),
        })
      : Promise.resolve(
          skippedOptionalSource('master_owners', 'master_owner_id_missing'),
        ),
    masterOwnerId
      ? optionalEnrichmentQuery({
          source: 'prospects',
          select: PROSPECT_SELECT,
          buildQuery: (select, columns) => {
            let query = db(deps)
              .from('prospects')
              .select(select)
              .eq('master_owner_id', masterOwnerId);
            if (columns.includes('prospect_id')) {
              query = query.order('prospect_id', { ascending: true });
            }
            return query.limit(25);
          },
        })
      : Promise.resolve(
          skippedOptionalSource('prospects', 'master_owner_id_missing'),
        ),
    masterOwnerId
      ? optionalEnrichmentQuery({
          source: 'phones',
          select: PHONE_CONTEXT_SELECT,
          buildQuery: (select, columns) => {
            let query = db(deps)
              .from('phones')
              .select(select)
              .eq('master_owner_id', masterOwnerId);
            if (columns.includes('sort_rank')) {
              query = query.order('sort_rank', { ascending: true });
            } else if (columns.includes('phone_id')) {
              query = query.order('phone_id', { ascending: true });
            }
            return query.limit(25);
          },
        })
      : Promise.resolve(
          skippedOptionalSource('phones', 'master_owner_id_missing'),
        ),
  ]);
  const contacts = contactResult.data;
  const masterOwners = masterOwnerResult.data;
  const prospects = prospectResult.data;
  const phones = phoneResult.data;
  const contact = contacts[0] ?? null;
  const masterOwner = masterOwners[0] ?? null;
  const primaryProspect = [...prospects].sort(
    (left, right) =>
      prospectContextScore(right) - prospectContextScore(left) ||
      clean(left.prospect_id).localeCompare(clean(right.prospect_id)),
  )[0] ?? null;
  const primaryPhone =
    phones.find((phone) => phoneLinkedToProspect(phone, primaryProspect?.prospect_id)) ??
    phones[0] ??
    null;
  const sourceReports = [
    contactResult.report,
    masterOwnerResult.report,
    prospectResult.report,
    phoneResult.report,
  ];
  const missingOptionalOwnerFields = [
    ...new Set(sourceReports.flatMap((report) => report.missing_fields)),
  ];
  const skippedOptionalSources = sourceReports
    .filter((report) => report.status === 'skipped')
    .map((report) => ({
      source: report.source,
      reason: report.skipped_reason,
    }));
  const ownerContextLoading = {
    attempted: true,
    loaded: Boolean(contact || masterOwner || primaryProspect || primaryPhone),
    missing_optional_owner_fields: missingOptionalOwnerFields,
    skipped_optional_sources: skippedOptionalSources,
    sources: Object.fromEntries(
      sourceReports.map((report) => [report.source, report]),
    ),
  };
  return {
    ...data,
    owner_type_guess: first(
      data.owner_type_guess,
      masterOwner?.owner_type_guess,
      primaryProspect?.owner_type_guess,
    ),
    owner_location: first(data.owner_location, masterOwner?.owner_location_text),
    estimated_household_income: primaryProspect?.est_household_income ?? null,
    estimated_net_asset_value: primaryProspect?.net_asset_value ?? null,
    buying_power: primaryProspect?.buying_power ?? null,
    master_financial_pressure_score:
      masterOwner?.financial_pressure_score ?? null,
    master_urgency_score: masterOwner?.urgency_score ?? null,
    portfolio_total_value: masterOwner?.portfolio_total_value ?? null,
    portfolio_total_equity: masterOwner?.portfolio_total_equity ?? null,
    portfolio_total_loan_balance:
      masterOwner?.portfolio_total_loan_balance ?? null,
    portfolio_total_loan_payment:
      masterOwner?.portfolio_total_loan_payment ?? null,
    portfolio_total_tax_amount:
      masterOwner?.portfolio_total_tax_amount ?? null,
    portfolio_total_units: masterOwner?.portfolio_total_units ?? null,
    owner_property_count: first(
      masterOwner?.property_count,
      primaryProspect?.property_count,
    ),
    portfolio_tax_delinquent_count:
      masterOwner?.tax_delinquent_count ?? null,
    portfolio_oldest_tax_delinquent_year:
      masterOwner?.oldest_tax_delinquent_year ?? null,
    portfolio_active_lien_count: masterOwner?.active_lien_count ?? null,
    master_owner_seller_tags_text: masterOwner?.seller_tags_text ?? null,
    master_owner_seller_tags_json: masterOwner?.seller_tags_json ?? null,
    prospect_seller_tags_text: primaryProspect?.seller_tags_text ?? null,
    prospect_seller_tags_json: primaryProspect?.seller_tags_json ?? null,
    phone_type: first(primaryPhone?.phone_type, data.phone_type),
    phone_activity_status: first(
      primaryPhone?.activity_status,
      data.activity_status,
    ),
    seller_asking_price: first(contact?.seller_asking_price, data.mls_current_listing_price),
    acquisition_contact: contact,
    owner_context_loading: ownerContextLoading,
    owner_context: {
      master_owner: masterOwner,
      primary_prospect: primaryProspect,
      primary_phone: primaryPhone,
      prospect_count: prospects.length,
      phone_count: phones.length,
    },
  };
}

function compRadius(subject) {
  return eligibilityLimits(subject).radius;
}

export async function loadComparableProperties(rawSubject, deps = {}) {
  const now = deps.now ?? new Date();
  const subject =
    rawSubject?.asset_family
      ? rawSubject
      : normalizePropertyFeatures(rawSubject, { source: 'properties', now });
  const rpcResult = await db(deps).rpc('get_comp_candidates_for_subject', {
    p_subject_property_id: subject.property_id,
    p_radius_miles: compRadius(subject),
    p_months_back: eligibilityLimits(subject).months,
    p_limit: 100,
  });
  if (rpcResult.error && !isOptionalSourceMissing(rpcResult.error)) {
    throw rpcResult.error;
  }
  const rpcRows = rpcResult.error ? [] : rpcResult.data ?? [];
  const compIds = rpcRows.map((row) => row.comp_id).filter(Boolean);
  const rpcDetailRows = compIds.length
    ? await optionalQuery(
        db(deps)
          .from('v_recent_sold_comps')
          .select(RPC_COMP_DETAIL_SELECT)
          .in('id', compIds),
      )
    : [];
  let soldRows = [];
  if (!rpcRows.length) {
    let fallbackQuery = db(deps)
      .from('recently_sold_properties')
      .select(SOLD_COMP_SELECT)
      .order('sale_date', { ascending: false })
      .limit(100);
    if (subject.zip) fallbackQuery = fallbackQuery.eq('property_address_zip', subject.zip);
    else if (subject.market) fallbackQuery = fallbackQuery.eq('market', subject.market);
    else if (subject.state) {
      fallbackQuery = fallbackQuery.eq('property_address_state', subject.state);
    }
    soldRows = await optionalQuery(fallbackQuery);
  }
  const rpcDetailsById = new Map(rpcDetailRows.map((row) => [clean(row.id), row]));
  const baseComps = rpcRows.length
    ? rpcRows.map((row) => ({
        ...row,
        ...(rpcDetailsById.get(clean(row.comp_id)) ?? {}),
        id: row.comp_id,
        address: row.address,
        distance_miles: row.distance_miles,
        source: 'v_recent_sold_comps',
      }))
    : soldRows.map((row) => ({
        ...row,
        distance_miles: haversineMiles(
          subject.latitude,
          subject.longitude,
          row.latitude,
          row.longitude,
        ),
        source: 'recently_sold_properties_fallback',
      }));

  let advancedQuery = db(deps)
    .from('buyer_comp_properties_v2')
    .select(ADVANCED_COMP_SELECT)
    .limit(150);
  if (subject.zip) advancedQuery = advancedQuery.eq('property_address_zip', subject.zip);
  else if (subject.market) advancedQuery = advancedQuery.eq('market', subject.market);
  const advancedRows = await optionalQuery(advancedQuery);
  const advancedComps = advancedRows.map((row) => ({
    ...row,
    source: 'buyer_comp_properties_v2',
    distance_miles: haversineMiles(
      subject.latitude,
      subject.longitude,
      row.latitude,
      row.longitude,
    ),
  }));

  const deduped = new Map();
  for (const comp of [...advancedComps, ...baseComps]) {
    const key = [
      clean(comp.property_id || comp.id || comp.comp_id),
      lower(comp.property_address_full || comp.address),
      clean(comp.mls_sold_date || comp.sale_date),
      clean(comp.mls_sold_price || comp.sale_price),
    ].join('|');
    if (!deduped.has(key) || comp.source === 'buyer_comp_properties_v2') {
      deduped.set(key, comp);
    }
  }
  return [...deduped.values()];
}

export async function loadBuyerPurchases(rawSubject, deps = {}) {
  const subject =
    rawSubject?.asset_family
      ? rawSubject
      : normalizePropertyFeatures(rawSubject, {
          source: 'properties',
          now: deps.now,
        });
  let query = db(deps)
    .from('buyer_purchase_events_v2')
    .select(BUYER_PURCHASE_SELECT)
    .order('purchase_date', { ascending: false })
    .limit(250);
  if (subject.zip) query = query.eq('property_zip', subject.zip);
  else if (subject.market) query = query.eq('market', subject.market);
  else if (subject.state) query = query.eq('property_state', subject.state);
  return optionalQuery(query);
}

export async function persistAcquisitionScore(row, deps = {}) {
  const { data, error } = await db(deps)
    .from(SCORE_TABLE)
    .upsert(row, { onConflict: 'property_id' })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function scoreProperty(propertyId, deps = {}) {
  const normalizedId = clean(propertyId);
  if (!normalizedId) {
    return { ok: false, status: 400, error: 'property_id_required' };
  }
  const now = deps.now ?? new Date();
  const subjectLoader = deps.loadSubjectProperty ?? loadSubjectProperty;
  const compLoader = deps.loadComparableProperties ?? loadComparableProperties;
  const buyerLoader = deps.loadBuyerPurchases ?? loadBuyerPurchases;
  const persister = deps.persistAcquisitionScore ?? persistAcquisitionScore;
  const rawSubject = await subjectLoader(normalizedId, deps);
  if (!rawSubject) {
    return { ok: false, status: 404, error: 'property_not_found' };
  }
  const subject = normalizePropertyFeatures(rawSubject, {
    source: 'properties',
    now,
  });
  const [comps, buyerPurchases] = await Promise.all([
    compLoader(subject, deps),
    buyerLoader(subject, deps),
  ]);
  const targetAssignmentFee = Math.max(
    0,
    num(
      deps.targetAssignmentFee ??
        process.env.ACQUISITION_TARGET_ASSIGNMENT_FEE,
      DEFAULT_TARGET_ASSIGNMENT_FEE,
    ),
  );
  const decision = calculateAcquisitionDecision({
    subject,
    comps,
    buyerPurchases,
    now,
    targetAssignmentFee,
  });
  const row = scoreRowFromDecision(normalizedId, decision, now);
  const score = await persister(row, deps);
  return {
    ok: true,
    score,
    evidence: score?.evidence ?? row.evidence,
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length || 1) }, () => worker()),
  );
  return results;
}

export async function scoreBatch(
  { limit = 100, market = null, only_missing = true } = {},
  deps = {},
) {
  const safeLimit = Math.min(500, Math.max(1, Math.trunc(num(limit, 100))));
  const loadBatch = deps.loadBatchProperties ?? loadBatchProperties;
  const rows = await loadBatch(
    { limit: safeLimit, market, only_missing },
    deps,
  );
  const results = await mapWithConcurrency(
    rows.slice(0, safeLimit),
    Math.min(5, Math.max(1, num(deps.concurrency, 4))),
    async (property) => {
      try {
        const result = await scoreProperty(property.property_id, deps);
        return {
          property_id: property.property_id,
          ok: result.ok,
          score: result.score ?? null,
          error: result.error ?? null,
        };
      } catch (error) {
        return {
          property_id: property.property_id,
          ok: false,
          score: null,
          error: clean(error?.message) || 'score_property_failed',
        };
      }
    },
  );
  const successful = results.filter((result) => result.ok);
  const failed = results.filter((result) => !result.ok);
  return {
    ok: true,
    processed_count: results.length,
    success_count: successful.length,
    failed_count: failed.length,
    sample_rows: results.slice(0, 10).map((result) => result.score ?? result),
    failures: failed.slice(0, 20),
  };
}

export async function loadBatchProperties(
  { limit = 100, market = null, only_missing = true } = {},
  deps = {},
) {
  const safeLimit = Math.min(500, Math.max(1, Math.trunc(num(limit, 100))));
  let query = db(deps)
    .from('properties')
    .select('property_id,property_address_full,market,updated_at')
    .order('updated_at', { ascending: false })
    .limit(Math.min(2_000, Math.max(safeLimit * 10, safeLimit)));
  if (clean(market)) query = query.eq('market', clean(market));
  const { data, error } = await query;
  if (error) throw error;
  const candidates = data ?? [];
  if (!only_missing || !candidates.length) return candidates.slice(0, safeLimit);

  const candidateIds = candidates.map((row) => clean(row.property_id)).filter(Boolean);
  const scoredRows = await optionalQuery(
    db(deps)
      .from(SCORE_TABLE)
      .select('property_id')
      .in('property_id', candidateIds),
  );
  const scoredIds = new Set(
    scoredRows.map((row) => clean(row.property_id)).filter(Boolean),
  );
  return candidates
    .filter((row) => !scoredIds.has(clean(row.property_id)))
    .slice(0, safeLimit);
}

export {
  DECISION_TIERS,
  DEFAULT_TARGET_ASSIGNMENT_FEE,
  SCORE_TABLE,
};

export default {
  calculateAcquisitionDecision,
  loadBatchProperties,
  loadBuyerPurchases,
  loadComparableProperties,
  loadSubjectProperty,
  normalizePropertyFeatures,
  persistAcquisitionScore,
  scoreBatch,
  scoreComparable,
  scoreProperty,
};
