import { operatorsForDataType } from "./operators.js";
import { JSON_COMPILER_KEYS } from "./json-storage-shapes.js";

export const TABLE_ROW_BASELINES = {
  properties: 124046,
  prospects: 149798,
  master_owners: 102157,
  phones: 121000,
};

export function computeCoveragePercent(populatedRows, totalRows) {
  const total = Number(totalRows) || 0;
  const populated = Number(populatedRows) || 0;
  if (total <= 0) return 0;
  return Math.round((populated / total) * 1000) / 10;
}

/** Columns verified empty — must never appear in the active registry. */
export const EXCLUDED_EMPTY_FIELDS = [
  "properties.normalized_asset_class",
  "properties.asset_type",
  "properties.asset_subtype",
  "properties.normalized_asset_subclass",
  "properties.commercial_category",
  "properties.commercial_subcategory",
  "properties.commercial_property_type",
  "properties.commercial_subtype",
  "properties.property_use",
  "properties.land_use",
  "properties.building_class",
  "properties.stories",
  "properties.commercial_units",
  "properties.storage_units",
  "properties.multifamily_units",
  "properties.strip_center_units",
  "properties.recording_date",
  "properties.arv_estimate",
  "properties.arv_ppsf",
  "properties.rent_estimate",
  "properties.monthly_rent",
  "properties.gross_monthly_income",
  "properties.gross_annual_income",
  "properties.noi_estimate",
  "properties.cap_rate",
  "properties.ppsf",
  "properties.ppu",
  "properties.ppbd",
  "properties.sqft_per_unit",
  "properties.price_off_value",
  "properties.percent_off",
  "properties.potential_spread",
  "properties.past_due_amount",
  "properties.foreclosure_status",
  "properties.foreclosure_stage",
  "properties.preforeclosure_status",
  "properties.preforeclosure_stage",
  "properties.is_preforeclosure",
  "properties.is_foreclosure",
  "properties.is_auction",
  "properties.default_amount",
  "properties.lien_type",
  "properties.lien_recording_date",
  "properties.judgment_amount",
  "properties.renovation_level_classification",
];

/** Sensitive demographic fields — excluded from map filters. */
export const EXCLUDED_SENSITIVE_FIELDS = [
  "prospects.gender",
  "prospects.marital_status",
  "prospects.education",
  "prospects.education_model",
  "prospects.est_household_income",
  "prospects.net_asset_value",
  "prospects.occupation_group",
  "prospects.occupation",
];

/** Legacy alias → canonical registry key (one user-facing concept per alias). */
export const FIELD_ALIASES = {
  "property.saleprice": "property.sale_price",
  "property.total_loan_amt": "property.total_loan_balance",
  "property.uncontacted": "property.contact_status",
  "property.contacted": "property.contact_status",
  "property.no_contact": "property.contact_status",
  "property.new_lead": "property.contact_status",
  "prospects.person_flags_text": "prospect.person_flags_json",
  "prospect.seller_tags_text": "prospect.seller_tags_json",
  "master_owner.seller_tags_text": "master_owner.seller_tags_json",
};

function field(def) {
  const totalRows = def.totalRows ?? TABLE_ROW_BASELINES[def.table] ?? 0;
  const populatedRows = def.populatedRows ?? 0;
  const coveragePercent = computeCoveragePercent(populatedRows, totalRows);
  const dataType = def.dataType;
  return {
    operators: operatorsForDataType(dataType),
    totalRows,
    populatedRows,
    coveragePercent,
    sensitive: false,
    safeToExpose: populatedRows > 0,
    partialCoverage: coveragePercent < 95,
    synonyms: [],
    ...def,
    dataType,
  };
}

const P = TABLE_ROW_BASELINES.properties;
const R = TABLE_ROW_BASELINES.prospects;
const O = TABLE_ROW_BASELINES.master_owners;
const H = TABLE_ROW_BASELINES.phones;

/** @type {import('./active-field-registry.js').RawMapFilterFieldDefinition[]} */
export const RAW_MAP_FILTER_FIELD_DEFINITIONS = [
  // ── 10A Property identity & geography ─────────────────────────────────────
  field({ key: "property.property_id", entity: "property", table: "properties", column: "property_id", label: "Property ID", description: "Canonical property identifier.", category: "Identity & Geography", dataType: "text", populatedRows: P, valueSource: "free_text", synonyms: ["id", "property id"] }),
  field({ key: "property.property_export_id", entity: "property", table: "properties", column: "property_export_id", label: "Property Export ID", description: "External export identifier.", category: "Identity & Geography", dataType: "text", populatedRows: P, valueSource: "free_text" }),
  field({ key: "property.master_owner_id", entity: "property", table: "properties", column: "master_owner_id", label: "Master Owner ID", description: "Linked Master Owner identifier.", category: "Identity & Geography", dataType: "text", populatedRows: 41530, valueSource: "free_text" }),
  field({ key: "property.apn_parcel_id", entity: "property", table: "properties", column: "apn_parcel_id", label: "APN / Parcel ID", description: "Assessor parcel number.", category: "Identity & Geography", dataType: "text", populatedRows: P, valueSource: "free_text", synonyms: ["apn", "parcel"] }),
  field({ key: "property.property_address_full", entity: "property", table: "properties", column: "property_address_full", label: "Full Address", description: "Complete property situs address.", category: "Identity & Geography", dataType: "text", populatedRows: 124046, valueSource: "free_text", synonyms: ["address", "street"] }),
  field({ key: "property.property_address_city", entity: "property", table: "properties", column: "property_address_city", label: "City", description: "Property city.", category: "Identity & Geography", dataType: "text", populatedRows: 124041, valueSource: "distinct", synonyms: ["city"] }),
  field({ key: "property.property_address_county_name", entity: "property", table: "properties", column: "property_address_county_name", label: "County", description: "Property county.", category: "Identity & Geography", dataType: "text", populatedRows: P, valueSource: "distinct", synonyms: ["county"] }),
  field({ key: "property.property_address_state", entity: "property", table: "properties", column: "property_address_state", label: "State", description: "Property state.", category: "Identity & Geography", dataType: "text", populatedRows: P, valueSource: "distinct", synonyms: ["state"] }),
  field({ key: "property.property_address_zip", entity: "property", table: "properties", column: "property_address_zip", label: "ZIP Code", description: "Property ZIP code.", category: "Identity & Geography", dataType: "text", populatedRows: 124025, valueSource: "distinct", synonyms: ["zip", "postal"] }),
  field({ key: "property.market", entity: "property", table: "properties", column: "market", label: "Market", description: "Canonical acquisition market.", category: "Identity & Geography", dataType: "text", populatedRows: 124045, valueSource: "distinct", synonyms: ["market"] }),
  field({ key: "property.market_region", entity: "property", table: "properties", column: "market_region", label: "Market Region", description: "Regional market grouping.", category: "Identity & Geography", dataType: "text", populatedRows: 8075, valueSource: "distinct", synonyms: ["region"] }),
  field({ key: "property.subdivision_name", entity: "property", table: "properties", column: "subdivision_name", label: "Subdivision", description: "Subdivision name.", category: "Identity & Geography", dataType: "text", populatedRows: 103440, valueSource: "distinct", synonyms: ["subdivision"] }),
  field({ key: "property.school_district_name", entity: "property", table: "properties", column: "school_district_name", label: "School District", description: "School district name.", category: "Identity & Geography", dataType: "text", populatedRows: 116203, valueSource: "distinct" }),
  field({ key: "property.situs_census_tract", entity: "property", table: "properties", column: "situs_census_tract", label: "Census Tract", description: "Situs census tract.", category: "Identity & Geography", dataType: "text", populatedRows: 96297, valueSource: "distinct", synonyms: ["census", "tract"] }),
  field({ key: "property.latitude", entity: "property", table: "properties", column: "latitude", label: "Latitude", description: "Property latitude.", category: "Identity & Geography", dataType: "number", populatedRows: P, valueSource: "range" }),
  field({ key: "property.longitude", entity: "property", table: "properties", column: "longitude", label: "Longitude", description: "Property longitude.", category: "Identity & Geography", dataType: "number", populatedRows: P, valueSource: "range" }),

  // ── Geo virtual fields (PostGIS) ────────────────────────────────────────────
  field({ key: "geo.current_viewport", entity: "geo", table: "properties", column: null, label: "Current Viewport", description: "Properties inside the active map viewport bounds.", category: "Geography", dataType: "geo", populatedRows: P, valueSource: "geo", synonyms: ["viewport", "map bounds", "on screen"] }),
  field({ key: "geo.radius_from_point", entity: "geo", table: "properties", column: null, label: "Radius From Point", description: "Properties within radius of a selected location.", category: "Geography", dataType: "geo", populatedRows: P, valueSource: "geo", synonyms: ["radius", "distance", "near"] }),
  field({ key: "geo.drawn_polygon", entity: "geo", table: "properties", column: null, label: "Drawn Polygon", description: "Properties inside a drawn inclusion polygon.", category: "Geography", dataType: "geo", populatedRows: P, valueSource: "geo", synonyms: ["polygon", "draw", "lasso"] }),
  field({ key: "geo.exclusion_polygon", entity: "geo", table: "properties", column: null, label: "Exclusion Polygon", description: "Exclude properties inside a drawn polygon.", category: "Geography", dataType: "geo", populatedRows: P, valueSource: "geo", synonyms: ["exclude", "exclusion"] }),

  // ── 10B Property type ───────────────────────────────────────────────────────
  field({ key: "property.property_type", entity: "property", table: "properties", column: "property_type", label: "Property Type", description: "Canonical asset type classification.", category: "Asset & Use", dataType: "text", populatedRows: P, valueSource: "distinct", synonyms: ["asset type", "apartment", "duplex", "multifamily", "sfr", "storage", "commercial", "land"] }),
  field({ key: "property.property_class", entity: "property", table: "properties", column: "property_class", label: "Property Class", description: "Property class label.", category: "Asset & Use", dataType: "text", populatedRows: P, valueSource: "distinct" }),
  field({ key: "property.units_count", entity: "property", table: "properties", column: "units_count", label: "Units Count", description: "Total unit count for the property.", category: "Asset & Use", dataType: "number", populatedRows: 111167, valueSource: "range", synonyms: ["units", "unit count"] }),
  field({ key: "property.asset_class", entity: "property", table: "properties", column: "asset_class", label: "Asset Class", description: "Enriched asset class (partial coverage).", category: "Enriched Fields", dataType: "text", populatedRows: 8075, valueSource: "distinct" }),

  // ── 10C Physical characteristics ────────────────────────────────────────────
  field({ key: "property.building_square_feet", entity: "property", table: "properties", column: "building_square_feet", label: "Building Square Feet", description: "Total building square footage.", category: "Physical", dataType: "number", populatedRows: P, valueSource: "range", synonyms: ["sqft", "square feet"] }),
  field({ key: "property.year_built", entity: "property", table: "properties", column: "year_built", label: "Year Built", description: "Original year built.", category: "Physical", dataType: "number", populatedRows: 122899, valueSource: "range" }),
  field({ key: "property.effective_year_built", entity: "property", table: "properties", column: "effective_year_built", label: "Effective Year Built", description: "Effective year built.", category: "Physical", dataType: "number", populatedRows: 122899, valueSource: "range" }),
  field({ key: "property.total_baths", entity: "property", table: "properties", column: "total_baths", label: "Total Baths", description: "Total bathrooms.", category: "Physical", dataType: "number", populatedRows: 113044, valueSource: "range", synonyms: ["baths", "bathrooms"] }),
  field({ key: "property.total_bedrooms", entity: "property", table: "properties", column: "total_bedrooms", label: "Total Bedrooms", description: "Total bedrooms.", category: "Physical", dataType: "number", populatedRows: 123559, valueSource: "range", synonyms: ["beds", "bedrooms"] }),
  field({ key: "property.lot_acreage", entity: "property", table: "properties", column: "lot_acreage", label: "Lot Acreage", description: "Lot size in acres.", category: "Physical", dataType: "number", populatedRows: 123977, valueSource: "range", synonyms: ["acres", "lot size"] }),
  field({ key: "property.lot_square_feet", entity: "property", table: "properties", column: "lot_square_feet", label: "Lot Square Feet", description: "Lot size in square feet.", category: "Physical", dataType: "number", populatedRows: 124032, valueSource: "range" }),
  field({ key: "property.building_condition", entity: "property", table: "properties", column: "building_condition", label: "Building Condition", description: "Building condition rating.", category: "Physical", dataType: "text", populatedRows: 116217, valueSource: "distinct" }),
  field({ key: "property.building_quality", entity: "property", table: "properties", column: "building_quality", label: "Building Quality", description: "Building quality rating.", category: "Physical", dataType: "text", populatedRows: 85663, valueSource: "distinct" }),
  field({ key: "property.construction_type", entity: "property", table: "properties", column: "construction_type", label: "Construction Type", description: "Construction type.", category: "Physical", dataType: "text", populatedRows: 88586, valueSource: "distinct" }),
  field({ key: "property.zoning", entity: "property", table: "properties", column: "zoning", label: "Zoning", description: "Zoning classification.", category: "Physical", dataType: "text", populatedRows: 99605, valueSource: "distinct" }),
  field({ key: "property.sum_buildings_nbr", entity: "property", table: "properties", column: "sum_buildings_nbr", label: "Building Count", description: "Number of buildings on parcel.", category: "Physical", dataType: "number", populatedRows: 116152, valueSource: "range" }),
  field({ key: "property.rehab_level", entity: "property", table: "properties", column: "rehab_level", label: "Rehab Level", description: "Estimated rehab level.", category: "Physical", dataType: "text", populatedRows: P, valueSource: "distinct" }),

  // ── 10D Financials ────────────────────────────────────────────────────────
  field({ key: "property.estimated_value", entity: "property", table: "properties", column: "estimated_value", label: "Estimated Value", description: "Estimated property value.", category: "Financials", dataType: "number", populatedRows: 124031, valueSource: "range", synonyms: ["value", "arv", "estimated value"] }),
  field({ key: "property.equity_amount", entity: "property", table: "properties", column: "equity_amount", label: "Equity Amount", description: "Estimated equity dollars.", category: "Financials", dataType: "number", populatedRows: 124031, valueSource: "range", synonyms: ["equity"] }),
  field({ key: "property.equity_percent", entity: "property", table: "properties", column: "equity_percent", label: "Equity Percentage", description: "Estimated equity percentage.", category: "Financials", dataType: "number", populatedRows: P, valueSource: "range", synonyms: ["equity percent", "equity %", "no mortgage", "high equity"] }),
  field({ key: "property.total_loan_balance", entity: "property", table: "properties", column: "total_loan_balance", label: "Current Loan Balance", description: "Total outstanding loan balance.", category: "Financials", dataType: "number", populatedRows: P, valueSource: "range", synonyms: ["loan balance", "mortgage", "debt"] }),
  field({ key: "property.total_loan_payment", entity: "property", table: "properties", column: "total_loan_payment", label: "Current Loan Payment", description: "Total monthly loan payment.", category: "Financials", dataType: "number", populatedRows: P, valueSource: "range" }),
  field({ key: "property.tax_amt", entity: "property", table: "properties", column: "tax_amt", label: "Tax Amount", description: "Annual tax amount.", category: "Financials", dataType: "number", populatedRows: 122536, valueSource: "range", synonyms: ["taxes"] }),
  field({ key: "property.tax_year", entity: "property", table: "properties", column: "tax_year", label: "Tax Year", description: "Tax assessment year.", category: "Financials", dataType: "number", populatedRows: 124020, valueSource: "range" }),
  field({ key: "property.sale_date", entity: "property", table: "properties", column: "sale_date", label: "Last Sale Date", description: "Most recent sale date.", category: "Financials", dataType: "date", populatedRows: 120895, valueSource: "range" }),
  field({ key: "property.sale_price", entity: "property", table: "properties", column: "sale_price", label: "Last Sale Price", description: "Most recent sale price.", category: "Financials", dataType: "number", populatedRows: 120706, valueSource: "range", synonyms: ["sale price", "last sale"] }),
  field({ key: "property.ownership_years", entity: "property", table: "properties", column: "ownership_years", label: "Years Owned", description: "Years of current ownership.", category: "Financials", dataType: "number", populatedRows: 120895, valueSource: "range", synonyms: ["ownership years", "long ownership"] }),
  field({ key: "property.last_sale_doc_type", entity: "property", table: "properties", column: "last_sale_doc_type", label: "Last Sale Document Type", description: "Last sale document type.", category: "Financials", dataType: "text", populatedRows: 120895, valueSource: "distinct" }),
  field({ key: "property.assd_improvement_value", entity: "property", table: "properties", column: "assd_improvement_value", label: "Assessed Improvement Value", description: "Assessed improvement value.", category: "Financials", dataType: "number", populatedRows: 94691, valueSource: "range" }),
  field({ key: "property.assd_land_value", entity: "property", table: "properties", column: "assd_land_value", label: "Assessed Land Value", description: "Assessed land value.", category: "Financials", dataType: "number", populatedRows: 95603, valueSource: "range" }),
  field({ key: "property.assd_total_value", entity: "property", table: "properties", column: "assd_total_value", label: "Assessed Total Value", description: "Assessed total value.", category: "Financials", dataType: "number", populatedRows: 116162, valueSource: "range" }),
  field({ key: "property.assd_year", entity: "property", table: "properties", column: "assd_year", label: "Assessment Year", description: "Assessment year.", category: "Financials", dataType: "number", populatedRows: 116217, valueSource: "range" }),
  field({ key: "property.calculated_improvement_value", entity: "property", table: "properties", column: "calculated_improvement_value", label: "Calculated Improvement Value", description: "Calculated improvement value.", category: "Financials", dataType: "number", populatedRows: 101903, valueSource: "range" }),
  field({ key: "property.calculated_land_value", entity: "property", table: "properties", column: "calculated_land_value", label: "Calculated Land Value", description: "Calculated land value.", category: "Financials", dataType: "number", populatedRows: 102778, valueSource: "range" }),
  field({ key: "property.calculated_total_value", entity: "property", table: "properties", column: "calculated_total_value", label: "Calculated Total Value", description: "Calculated total value.", category: "Financials", dataType: "number", populatedRows: 106209, valueSource: "range" }),
  field({ key: "property.cash_offer", entity: "property", table: "properties", column: "cash_offer", label: "Cash Offer", description: "Estimated cash offer.", category: "Financials", dataType: "number", populatedRows: 124031, valueSource: "range" }),
  field({ key: "property.estimated_repair_cost", entity: "property", table: "properties", column: "estimated_repair_cost", label: "Estimated Repairs", description: "Estimated repair cost.", category: "Financials", dataType: "number", populatedRows: 123977, valueSource: "range", synonyms: ["repairs", "rehab"] }),
  field({ key: "property.estimated_repair_cost_per_sqft", entity: "property", table: "properties", column: "estimated_repair_cost_per_sqft", label: "Repair Cost Per Sqft", description: "Estimated repair cost per square foot.", category: "Financials", dataType: "number", populatedRows: 8006, valueSource: "range" }),

  // ── 10E Signals & scores ────────────────────────────────────────────────────
  field({ key: "property.tax_delinquent", entity: "property", table: "properties", column: "tax_delinquent", label: "Tax Delinquent", description: "Property tax delinquency flag.", category: "Signals", dataType: "boolean", populatedRows: P, valueSource: "boolean", synonyms: ["delinquent", "tax delinquent"] }),
  field({ key: "property.tax_delinquent_year", entity: "property", table: "properties", column: "tax_delinquent_year", label: "Tax Delinquent Year", description: "Tax delinquency year.", category: "Signals", dataType: "number", populatedRows: 22246, valueSource: "range" }),
  field({ key: "property.active_lien", entity: "property", table: "properties", column: "active_lien", label: "Active Lien", description: "Active lien flag.", category: "Signals", dataType: "boolean", populatedRows: P, valueSource: "boolean", synonyms: ["lien"] }),
  field({ key: "property.out_of_state_owner", entity: "property", table: "properties", column: "out_of_state_owner", label: "Out-of-State Owner", description: "Owner mailing address out of state.", category: "Signals", dataType: "boolean", populatedRows: 116217, valueSource: "boolean", synonyms: ["out of state", "absentee"] }),
  field({ key: "property.is_corporate_owner", entity: "property", table: "properties", column: "is_corporate_owner", label: "Corporate Owner", description: "Corporate ownership flag.", category: "Signals", dataType: "boolean", populatedRows: 116217, valueSource: "boolean", synonyms: ["corporate", "llc"] }),
  field({ key: "property.auction_date", entity: "property", table: "properties", column: "auction_date", label: "Auction Date", description: "Scheduled auction date.", category: "Signals", dataType: "date", populatedRows: 236, valueSource: "range", synonyms: ["auction"] }),
  field({ key: "property.seller_tags_json", entity: "property", table: "properties", column: "seller_tags_json", label: "Seller Tags", description: "Seller tag membership.", category: "Signals", dataType: "json_text_array", populatedRows: 8075, valueSource: "distinct", jsonStorageShape: "text_array", jsonCompilerKey: JSON_COMPILER_KEYS.property_tag_array, presenceStrategy: "membership" }),
  field({ key: "property.property_flags_json", entity: "property", table: "properties", column: "property_flags_json", label: "Property Flags", description: "Property flag membership.", category: "Signals", dataType: "json_text_array", populatedRows: P, valueSource: "distinct", jsonStorageShape: "text_array", jsonCompilerKey: JSON_COMPILER_KEYS.property_flag_array, presenceStrategy: "membership" }),
  field({ key: "property.ai_score", entity: "property", table: "properties", column: "ai_score", label: "AI Score", description: "AI acquisition score.", category: "Signals", dataType: "number", populatedRows: 102737, valueSource: "range" }),
  field({ key: "property.structured_motivation_score", entity: "property", table: "properties", column: "structured_motivation_score", label: "Structured Motivation Score", description: "Structured motivation score.", category: "Signals", dataType: "number", populatedRows: 104217, valueSource: "range", synonyms: ["motivation score"] }),
  field({ key: "property.deal_strength_score", entity: "property", table: "properties", column: "deal_strength_score", label: "Deal Strength Score", description: "Deal strength score.", category: "Signals", dataType: "number", populatedRows: 104217, valueSource: "range" }),
  field({ key: "property.tag_distress_score", entity: "property", table: "properties", column: "tag_distress_score", label: "Tag Distress Score", description: "Tag-derived distress score.", category: "Signals", dataType: "number", populatedRows: 104217, valueSource: "range", synonyms: ["distress score"] }),
  field({ key: "property.final_acquisition_score", entity: "property", table: "properties", column: "final_acquisition_score", label: "Final Acquisition Score", description: "Final acquisition score.", category: "Signals", dataType: "number", populatedRows: 104217, valueSource: "range", synonyms: ["acquisition score", "acq score"] }),

  // ── 10F Enriched contact (partial) ──────────────────────────────────────────
  field({ key: "property.contact_status", entity: "property", table: "properties", column: "contact_status", label: "Contact Status", description: "Property-level contact status. Canonical source for contacted vs uncontacted map filters.", category: "Enriched Contact", dataType: "text", populatedRows: 121182, valueSource: "distinct", synonyms: ["uncontacted", "contacted", "no contact", "new lead", "not contacted", "message history", "active thread"] }),
  field({ key: "property.inbox_hydrated_scope", entity: "property", table: "properties", column: null, label: "Inbox Thread Scope", description: "Property has a hydrated inbox thread matching conversation-level filters.", category: "Enriched Contact", dataType: "inbox_scope", populatedRows: P, valueSource: "json", synonyms: ["inbox", "conversation", "thread"] }),
  field({ key: "property.activity_status", entity: "property", table: "properties", column: "activity_status", label: "Activity Status", description: "Property activity status.", category: "Enriched Contact", dataType: "text", populatedRows: 8021, valueSource: "distinct" }),
  field({ key: "property.sms_eligible", entity: "property", table: "properties", column: "sms_eligible", label: "Property SMS Eligible", description: "Property-level SMS eligibility (partial coverage).", category: "Enriched Contact", dataType: "boolean", populatedRows: 8075, valueSource: "boolean" }),
  field({ key: "property.best_phone", entity: "property", table: "properties", column: "best_phone", label: "Best Phone (Property)", description: "Best phone on property record.", category: "Enriched Contact", dataType: "text", populatedRows: 8021, valueSource: "derived_presence", presenceStrategy: "has_data" }),
  field({ key: "property.has_best_phone", entity: "property", table: "properties", column: "best_phone", label: "Has Best Phone (Property)", description: "Property has a populated best phone.", category: "Enriched Contact", dataType: "derived_presence", populatedRows: 8021, valueSource: "derived_presence", presenceStrategy: "has_data", synonyms: ["phone"] }),
  field({ key: "property.phone_type", entity: "property", table: "properties", column: "phone_type", label: "Phone Type", description: "Best phone type.", category: "Enriched Contact", dataType: "text", populatedRows: 8021, valueSource: "distinct" }),
  field({ key: "property.best_phone_score", entity: "property", table: "properties", column: "best_phone_score", label: "Best Phone Score", description: "Best phone confidence score.", category: "Enriched Contact", dataType: "number", populatedRows: 8021, valueSource: "range" }),
  field({ key: "property.best_email", entity: "property", table: "properties", column: "best_email", label: "Best Email (Property)", description: "Best email on property record.", category: "Enriched Contact", dataType: "text", populatedRows: 7482, valueSource: "derived_presence", presenceStrategy: "has_data" }),
  field({ key: "property.has_best_email", entity: "property", table: "properties", column: "best_email", label: "Has Best Email (Property)", description: "Property has a populated best email.", category: "Enriched Contact", dataType: "derived_presence", populatedRows: 7482, valueSource: "derived_presence", presenceStrategy: "has_data", synonyms: ["email"] }),
  field({ key: "property.email_score_final", entity: "property", table: "properties", column: "email_score_final", label: "Email Score", description: "Final email score.", category: "Enriched Contact", dataType: "number", populatedRows: 7482, valueSource: "range" }),
  field({ key: "property.priority_tier", entity: "property", table: "properties", column: "priority_tier", label: "Priority Tier (Property)", description: "Property priority tier.", category: "Enriched Contact", dataType: "text", populatedRows: 8075, valueSource: "distinct" }),
  field({ key: "property.follow_up_cadence", entity: "property", table: "properties", column: "follow_up_cadence", label: "Follow-Up Cadence (Property)", description: "Property follow-up cadence.", category: "Enriched Contact", dataType: "text", populatedRows: 8075, valueSource: "distinct" }),
  field({ key: "property.best_channel", entity: "property", table: "properties", column: "best_channel", label: "Best Channel (Property)", description: "Preferred contact channel.", category: "Enriched Contact", dataType: "text", populatedRows: 8021, valueSource: "distinct" }),
  field({ key: "property.best_language", entity: "property", table: "properties", column: "best_language", label: "Best Language (Property)", description: "Preferred language.", category: "Enriched Contact", dataType: "text", populatedRows: 8021, valueSource: "distinct" }),
  field({ key: "property.timezone", entity: "property", table: "properties", column: "timezone", label: "Time Zone (Property)", description: "Property time zone.", category: "Enriched Contact", dataType: "text", populatedRows: 8075, valueSource: "distinct" }),
  field({ key: "property.contact_window", entity: "property", table: "properties", column: "contact_window", label: "Contact Window (Property)", description: "Preferred contact window.", category: "Enriched Contact", dataType: "text", populatedRows: 8075, valueSource: "distinct" }),

  // ── 11 Prospect identity & relationship ─────────────────────────────────────
  field({ key: "prospect.prospect_id", entity: "prospect", table: "prospects", column: "prospect_id", label: "Prospect ID", description: "Canonical prospect identifier.", category: "Identity & Relationship", dataType: "text", populatedRows: R, valueSource: "free_text" }),
  field({ key: "prospect.canonical_prospect_id", entity: "prospect", table: "prospects", column: "canonical_prospect_id", label: "Canonical Prospect ID", description: "Canonical prospect key.", category: "Identity & Relationship", dataType: "text", populatedRows: R, valueSource: "free_text" }),
  field({ key: "prospect.master_owner_id", entity: "prospect", table: "prospects", column: "master_owner_id", label: "Prospect Master Owner ID", description: "Linked Master Owner.", category: "Identity & Relationship", dataType: "text", populatedRows: R, valueSource: "free_text" }),
  field({ key: "prospect.source_slot", entity: "prospect", table: "prospects", column: "source_slot", label: "Source Slot", description: "Prospect source slot.", category: "Identity & Relationship", dataType: "text", populatedRows: R, valueSource: "distinct" }),
  field({ key: "prospect.full_name", entity: "prospect", table: "prospects", column: "full_name", label: "Prospect Name", description: "Full prospect name search.", category: "Identity & Relationship", dataType: "text", populatedRows: 148801, valueSource: "free_text", synonyms: ["name", "seller name"] }),
  field({ key: "prospect.first_name", entity: "prospect", table: "prospects", column: "first_name", label: "First Name", description: "Prospect first name.", category: "Identity & Relationship", dataType: "text", populatedRows: 148801, valueSource: "free_text" }),
  field({ key: "prospect.is_primary_prospect", entity: "prospect", table: "prospects", column: "is_primary_prospect", label: "Primary Prospect", description: "Primary prospect flag.", category: "Identity & Relationship", dataType: "boolean", populatedRows: R, valueSource: "boolean", synonyms: ["primary"] }),
  field({ key: "prospect.property_count", entity: "prospect", table: "prospects", column: "property_count", label: "Linked Property Count", description: "Number of linked properties.", category: "Identity & Relationship", dataType: "number", populatedRows: R, valueSource: "range" }),
  field({ key: "prospect.linked_property_ids_json", entity: "prospect", table: "prospects", column: "linked_property_ids_json", label: "Linked Property IDs", description: "JSON array of linked property IDs.", category: "Identity & Relationship", dataType: "json_text_array", populatedRows: R, valueSource: "derived_presence", jsonStorageShape: "uuid_array", jsonCompilerKey: JSON_COMPILER_KEYS.owner_uuid_link_array, presenceStrategy: "has_data" }),

  // ── 11B Ownership confidence ───────────────────────────────────────────────
  field({ key: "prospect.likely_owner", entity: "prospect", table: "prospects", column: "likely_owner", label: "Likely Owner", description: "Likely property owner flag.", category: "Ownership Confidence", dataType: "boolean", populatedRows: 142497, valueSource: "boolean", synonyms: ["owner"] }),
  field({ key: "prospect.likely_renting", entity: "prospect", table: "prospects", column: "likely_renting", label: "Likely Renting", description: "Likely renting flag.", category: "Ownership Confidence", dataType: "boolean", populatedRows: 142497, valueSource: "boolean" }),
  field({ key: "prospect.matching_flags", entity: "prospect", table: "prospects", column: "matching_flags", label: "Matching Flags", description: "Matching flag membership.", category: "Ownership Confidence", dataType: "json_text_array", populatedRows: 147275, valueSource: "distinct", jsonStorageShape: "text_array", jsonCompilerKey: JSON_COMPILER_KEYS.prospect_flag_array, presenceStrategy: "membership" }),
  field({ key: "prospect.person_flags_json", entity: "prospect", table: "prospects", column: "person_flags_json", label: "Person Flags", description: "Person flag membership.", category: "Ownership Confidence", dataType: "json_text_array", populatedRows: 148252, valueSource: "distinct", jsonStorageShape: "text_array", jsonCompilerKey: JSON_COMPILER_KEYS.prospect_flag_array, presenceStrategy: "membership" }),
  field({ key: "prospect.rank_position", entity: "prospect", table: "prospects", column: "rank_position", label: "Rank Position", description: "Prospect rank position.", category: "Ownership Confidence", dataType: "number", populatedRows: R, valueSource: "range" }),
  field({ key: "prospect.rank_confidence", entity: "prospect", table: "prospects", column: "rank_confidence", label: "Rank Confidence", description: "Prospect rank confidence.", category: "Ownership Confidence", dataType: "text", populatedRows: R, valueSource: "distinct" }),

  // ── 11C Contact availability ────────────────────────────────────────────────
  field({ key: "prospect.phones_json", entity: "prospect", table: "prospects", column: "phones_json", label: "Phone Records", description: "Structured phone array.", category: "Contact Availability", dataType: "json_object_array", populatedRows: 97351, valueSource: "derived_presence", jsonStorageShape: "object_array", jsonCompilerKey: JSON_COMPILER_KEYS.prospect_contact_array, presenceStrategy: "count" }),
  field({ key: "prospect.emails_json", entity: "prospect", table: "prospects", column: "emails_json", label: "Email Records", description: "Structured email array.", category: "Contact Availability", dataType: "json_object_array", populatedRows: 120863, valueSource: "derived_presence", jsonStorageShape: "object_array", jsonCompilerKey: JSON_COMPILER_KEYS.prospect_contact_array, presenceStrategy: "count" }),
  field({ key: "prospect.has_phone", entity: "prospect", table: "prospects", column: "phones_json", label: "Has Phone", description: "Prospect has at least one phone record.", category: "Contact Availability", dataType: "derived_presence", populatedRows: 97351, valueSource: "derived_presence", presenceStrategy: "has_data", synonyms: ["phone", "has phone"] }),
  field({ key: "prospect.has_no_phone", entity: "prospect", table: "prospects", column: "phones_json", label: "Has No Phone", description: "Prospect has no phone records.", category: "Contact Availability", dataType: "derived_presence", populatedRows: R - 97351, valueSource: "derived_presence", presenceStrategy: "has_no_data" }),
  field({ key: "prospect.phone_count", entity: "prospect", table: "prospects", column: "phones_json", label: "Phone Count", description: "Number of phone records.", category: "Contact Availability", dataType: "derived_presence", populatedRows: 97351, valueSource: "derived_presence", presenceStrategy: "count" }),
  field({ key: "prospect.has_email", entity: "prospect", table: "prospects", column: "emails_json", label: "Has Email", description: "Prospect has at least one email record.", category: "Contact Availability", dataType: "derived_presence", populatedRows: 120863, valueSource: "derived_presence", presenceStrategy: "has_data", synonyms: ["email", "has email"] }),
  field({ key: "prospect.has_no_email", entity: "prospect", table: "prospects", column: "emails_json", label: "Has No Email", description: "Prospect has no email records.", category: "Contact Availability", dataType: "derived_presence", populatedRows: R - 120863, valueSource: "derived_presence", presenceStrategy: "has_no_data" }),
  field({ key: "prospect.email_count", entity: "prospect", table: "prospects", column: "emails_json", label: "Email Count", description: "Number of email records.", category: "Contact Availability", dataType: "derived_presence", populatedRows: 120863, valueSource: "derived_presence", presenceStrategy: "count" }),
  field({ key: "prospect.best_phone", entity: "prospect", table: "prospects", column: "best_phone", label: "Best Phone (Prospect)", description: "Best prospect phone.", category: "Contact Availability", dataType: "text", populatedRows: 97435, valueSource: "derived_presence", presenceStrategy: "has_data" }),
  field({ key: "prospect.best_email", entity: "prospect", table: "prospects", column: "best_email", label: "Best Email (Prospect)", description: "Best prospect email.", category: "Contact Availability", dataType: "text", populatedRows: 120863, valueSource: "derived_presence", presenceStrategy: "has_data" }),
  field({ key: "prospect.raw_contact_score", entity: "prospect", table: "prospects", column: "raw_contact_score", label: "Raw Contact Score", description: "Raw contact score.", category: "Contact Availability", dataType: "number", populatedRows: R, valueSource: "range" }),
  field({ key: "prospect.contact_score_final", entity: "prospect", table: "prospects", column: "contact_score_final", label: "Final Contact Score", description: "Final contact score.", category: "Contact Availability", dataType: "number", populatedRows: R, valueSource: "range", synonyms: ["contact score"] }),
  field({ key: "prospect.raw_phone_score", entity: "prospect", table: "prospects", column: "raw_phone_score", label: "Raw Phone Score", description: "Raw phone score.", category: "Contact Availability", dataType: "number", populatedRows: R, valueSource: "range", synonyms: ["phone score"] }),
  field({ key: "prospect.phone_score_final", entity: "prospect", table: "prospects", column: "phone_score_final", label: "Final Phone Score", description: "Final phone score.", category: "Contact Availability", dataType: "number", populatedRows: R, valueSource: "range" }),
  field({ key: "prospect.email_score_final", entity: "prospect", table: "prospects", column: "email_score_final", label: "Final Email Score", description: "Final email score.", category: "Contact Availability", dataType: "number", populatedRows: R, valueSource: "range" }),
  field({ key: "prospect.sms_eligible", entity: "prospect", table: "prospects", column: "sms_eligible", label: "Prospect SMS Eligible", description: "Prospect SMS eligibility.", category: "Contact Availability", dataType: "boolean", populatedRows: R, valueSource: "boolean", synonyms: ["sms eligible", "sms"] }),
  field({ key: "prospect.email_eligible", entity: "prospect", table: "prospects", column: "email_eligible", label: "Email Eligible", description: "Prospect email eligibility.", category: "Contact Availability", dataType: "boolean", populatedRows: R, valueSource: "boolean" }),

  // ── 11D Routing & prioritization ──────────────────────────────────────────
  field({ key: "prospect.primary_market", entity: "prospect", table: "prospects", column: "primary_market", label: "Primary Market", description: "Prospect primary market.", category: "Routing & Prioritization", dataType: "text", populatedRows: R, valueSource: "distinct" }),
  field({ key: "prospect.timezone", entity: "prospect", table: "prospects", column: "timezone", label: "Time Zone (Prospect)", description: "Prospect time zone.", category: "Routing & Prioritization", dataType: "text", populatedRows: 149644, valueSource: "distinct" }),
  field({ key: "prospect.contact_window", entity: "prospect", table: "prospects", column: "contact_window", label: "Contact Window (Prospect)", description: "Prospect contact window.", category: "Routing & Prioritization", dataType: "text", populatedRows: R, valueSource: "distinct" }),
  field({ key: "prospect.priority_tier", entity: "prospect", table: "prospects", column: "priority_tier", label: "Priority Tier (Prospect)", description: "Prospect priority tier.", category: "Routing & Prioritization", dataType: "text", populatedRows: R, valueSource: "distinct" }),
  field({ key: "prospect.master_owner_priority_score", entity: "prospect", table: "prospects", column: "master_owner_priority_score", label: "Master Owner Priority Score", description: "Linked owner priority score.", category: "Routing & Prioritization", dataType: "number", populatedRows: R, valueSource: "range" }),
  field({ key: "prospect.agent_persona", entity: "prospect", table: "prospects", column: "agent_persona", label: "Agent Persona (Prospect)", description: "Assigned agent persona.", category: "Routing & Prioritization", dataType: "text", populatedRows: R, valueSource: "distinct" }),
  field({ key: "prospect.agent_family", entity: "prospect", table: "prospects", column: "agent_family", label: "Agent Family (Prospect)", description: "Assigned agent family.", category: "Routing & Prioritization", dataType: "text", populatedRows: R, valueSource: "distinct" }),
  field({ key: "prospect.owner_type_guess", entity: "prospect", table: "prospects", column: "owner_type_guess", label: "Owner Type Guess (Prospect)", description: "Prospect owner type guess.", category: "Routing & Prioritization", dataType: "text", populatedRows: R, valueSource: "distinct" }),
  field({ key: "prospect.seller_tags_json", entity: "prospect", table: "prospects", column: "seller_tags_json", label: "Seller Tags (Prospect)", description: "Prospect seller tag membership.", category: "Routing & Prioritization", dataType: "json_text_array", populatedRows: 124804, valueSource: "distinct", jsonStorageShape: "text_array", jsonCompilerKey: JSON_COMPILER_KEYS.property_tag_array, presenceStrategy: "membership" }),

  // ── 12A Master owner identity ─────────────────────────────────────────────
  field({ key: "master_owner.master_owner_id", entity: "master_owner", table: "master_owners", column: "master_owner_id", label: "Master Owner ID", description: "Canonical Master Owner identifier.", category: "Identity & Type", dataType: "text", populatedRows: O, valueSource: "free_text" }),
  field({ key: "master_owner.display_name", entity: "master_owner", table: "master_owners", column: "display_name", label: "Owner Name", description: "Master Owner display name search.", category: "Identity & Type", dataType: "text", populatedRows: 102156, valueSource: "free_text", synonyms: ["owner name"] }),
  field({ key: "master_owner.owner_type_guess", entity: "master_owner", table: "master_owners", column: "owner_type_guess", label: "Owner Type", description: "Owner type classification.", category: "Identity & Type", dataType: "text", populatedRows: O, valueSource: "distinct", synonyms: ["llc", "trust", "institutional", "absentee", "individual"] }),
  field({ key: "master_owner.owner_entity_ids_json", entity: "master_owner", table: "master_owners", column: "owner_entity_ids_json", label: "Linked Entity Count", description: "Owner entity identifier array.", category: "Identity & Type", dataType: "json_text_array", populatedRows: 94102, valueSource: "derived_presence", jsonStorageShape: "uuid_array", jsonCompilerKey: JSON_COMPILER_KEYS.owner_uuid_link_array, presenceStrategy: "count" }),

  // ── 12B Geography ─────────────────────────────────────────────────────────
  field({ key: "master_owner.owner_locations_json", entity: "master_owner", table: "master_owners", column: "owner_locations_json", label: "Owner Locations", description: "Structured owner location records.", category: "Geography", dataType: "json_object_array", populatedRows: 102156, valueSource: "distinct", jsonStorageShape: "location_array", jsonCompilerKey: JSON_COMPILER_KEYS.owner_location_array, presenceStrategy: "membership" }),
  field({ key: "master_owner.markets_json", entity: "master_owner", table: "master_owners", column: "markets_json", label: "Owns In Market", description: "Markets where owner holds properties.", category: "Geography", dataType: "json_text_array", populatedRows: 102156, valueSource: "distinct", jsonStorageShape: "text_array", presenceStrategy: "membership", synonyms: ["portfolio market"] }),
  field({ key: "master_owner.zip_codes_json", entity: "master_owner", table: "master_owners", column: "zip_codes_json", label: "Owns In ZIP", description: "ZIP codes where owner holds properties.", category: "Geography", dataType: "json_text_array", populatedRows: 102143, valueSource: "distinct", jsonStorageShape: "text_array", presenceStrategy: "membership" }),
  field({ key: "master_owner.counties_json", entity: "master_owner", table: "master_owners", column: "counties_json", label: "Owns In County", description: "Counties where owner holds properties.", category: "Geography", dataType: "json_text_array", populatedRows: 102156, valueSource: "distinct", jsonStorageShape: "text_array", presenceStrategy: "membership" }),
  field({ key: "master_owner.routing_market", entity: "master_owner", table: "master_owners", column: "routing_market", label: "Routing Market", description: "Owner routing market.", category: "Geography", dataType: "text", populatedRows: O, valueSource: "distinct" }),
  field({ key: "master_owner.routing_timezone", entity: "master_owner", table: "master_owners", column: "routing_timezone", label: "Routing Time Zone", description: "Owner routing time zone.", category: "Geography", dataType: "text", populatedRows: 102057, valueSource: "distinct" }),

  // ── 12C Contactability ────────────────────────────────────────────────────
  field({ key: "master_owner.joined_prospect_ids_json", entity: "master_owner", table: "master_owners", column: "joined_prospect_ids_json", label: "Linked Prospects", description: "Linked prospect ID array.", category: "Contactability", dataType: "json_text_array", populatedRows: 99412, valueSource: "derived_presence", jsonStorageShape: "uuid_array", jsonCompilerKey: JSON_COMPILER_KEYS.owner_uuid_link_array, presenceStrategy: "count" }),
  field({ key: "master_owner.has_linked_prospect", entity: "master_owner", table: "master_owners", column: "joined_prospect_ids_json", label: "Has Linked Prospect", description: "Owner has at least one linked prospect.", category: "Contactability", dataType: "derived_presence", populatedRows: 99412, valueSource: "derived_presence", presenceStrategy: "has_data" }),
  field({ key: "master_owner.linked_prospect_count", entity: "master_owner", table: "master_owners", column: "joined_prospect_ids_json", label: "Linked Prospect Count", description: "Number of linked prospects.", category: "Contactability", dataType: "derived_presence", populatedRows: 99412, valueSource: "derived_presence", presenceStrategy: "count" }),
  field({ key: "master_owner.joined_phone_ids_json", entity: "master_owner", table: "master_owners", column: "joined_phone_ids_json", label: "Linked Phones", description: "Linked phone ID array.", category: "Contactability", dataType: "json_text_array", populatedRows: 83521, valueSource: "derived_presence", jsonStorageShape: "uuid_array", jsonCompilerKey: JSON_COMPILER_KEYS.owner_uuid_link_array, presenceStrategy: "count" }),
  field({ key: "master_owner.has_linked_phone", entity: "master_owner", table: "master_owners", column: "joined_phone_ids_json", label: "Owner Has Phone", description: "Owner has at least one linked phone.", category: "Contactability", dataType: "derived_presence", populatedRows: 83521, valueSource: "derived_presence", presenceStrategy: "has_data", synonyms: ["owner has phone", "phone"] }),
  field({ key: "master_owner.linked_phone_count", entity: "master_owner", table: "master_owners", column: "joined_phone_ids_json", label: "Linked Phone Count", description: "Number of linked phones.", category: "Contactability", dataType: "derived_presence", populatedRows: 83521, valueSource: "derived_presence", presenceStrategy: "count" }),
  field({ key: "master_owner.joined_email_ids_json", entity: "master_owner", table: "master_owners", column: "joined_email_ids_json", label: "Linked Emails", description: "Linked email ID array.", category: "Contactability", dataType: "json_text_array", populatedRows: 90543, valueSource: "derived_presence", jsonStorageShape: "uuid_array", jsonCompilerKey: JSON_COMPILER_KEYS.owner_uuid_link_array, presenceStrategy: "count" }),
  field({ key: "master_owner.has_linked_email", entity: "master_owner", table: "master_owners", column: "joined_email_ids_json", label: "Owner Has Email", description: "Owner has at least one linked email.", category: "Contactability", dataType: "derived_presence", populatedRows: 90543, valueSource: "derived_presence", presenceStrategy: "has_data", synonyms: ["owner has email", "email"] }),
  field({ key: "master_owner.linked_email_count", entity: "master_owner", table: "master_owners", column: "joined_email_ids_json", label: "Linked Email Count", description: "Number of linked emails.", category: "Contactability", dataType: "derived_presence", populatedRows: 90543, valueSource: "derived_presence", presenceStrategy: "count" }),
  field({ key: "master_owner.best_contact_slot", entity: "master_owner", table: "master_owners", column: "best_contact_slot", label: "Best Contact Slot", description: "Best contact slot.", category: "Contactability", dataType: "text", populatedRows: 99384, valueSource: "distinct" }),
  field({ key: "master_owner.best_channel", entity: "master_owner", table: "master_owners", column: "best_channel", label: "Best Channel (Owner)", description: "Owner best contact channel.", category: "Contactability", dataType: "text", populatedRows: 102102, valueSource: "distinct" }),
  field({ key: "master_owner.best_contact_window", entity: "master_owner", table: "master_owners", column: "best_contact_window", label: "Best Contact Window", description: "Owner best contact window.", category: "Contactability", dataType: "text", populatedRows: O, valueSource: "distinct" }),
  field({ key: "master_owner.best_language", entity: "master_owner", table: "master_owners", column: "best_language", label: "Best Language (Owner)", description: "Owner best language.", category: "Contactability", dataType: "text", populatedRows: 102102, valueSource: "distinct" }),
  field({ key: "master_owner.best_phone_confidence", entity: "master_owner", table: "master_owners", column: "best_phone_confidence", label: "Best Phone Confidence", description: "Owner best phone confidence.", category: "Contactability", dataType: "text", populatedRows: 102102, valueSource: "distinct" }),
  field({ key: "master_owner.contactability_score", entity: "master_owner", table: "master_owners", column: "contactability_score", label: "Contactability Score", description: "Owner contactability score.", category: "Contactability", dataType: "number", populatedRows: O, valueSource: "range" }),

  // ── 12D Priority & pressure ───────────────────────────────────────────────
  field({ key: "master_owner.financial_pressure_score", entity: "master_owner", table: "master_owners", column: "financial_pressure_score", label: "Financial Pressure Score", description: "Owner financial pressure score.", category: "Priority & Pressure", dataType: "number", populatedRows: O, valueSource: "range" }),
  field({ key: "master_owner.urgency_score", entity: "master_owner", table: "master_owners", column: "urgency_score", label: "Urgency Score", description: "Owner urgency score.", category: "Priority & Pressure", dataType: "number", populatedRows: O, valueSource: "range", synonyms: ["urgency"] }),
  field({ key: "master_owner.priority_score", entity: "master_owner", table: "master_owners", column: "priority_score", label: "Priority Score", description: "Owner priority score.", category: "Priority & Pressure", dataType: "number", populatedRows: O, valueSource: "range", synonyms: ["priority"] }),
  field({ key: "master_owner.priority_tier", entity: "master_owner", table: "master_owners", column: "priority_tier", label: "Priority Tier (Owner)", description: "Owner priority tier.", category: "Priority & Pressure", dataType: "text", populatedRows: O, valueSource: "distinct", synonyms: ["tier 1", "tier 2", "tier 3"] }),
  field({ key: "master_owner.follow_up_cadence", entity: "master_owner", table: "master_owners", column: "follow_up_cadence", label: "Follow-Up Cadence (Owner)", description: "Owner follow-up cadence.", category: "Priority & Pressure", dataType: "text", populatedRows: O, valueSource: "distinct" }),

  // ── 12E Portfolio intelligence ────────────────────────────────────────────
  field({ key: "master_owner.portfolio_total_value", entity: "master_owner", table: "master_owners", column: "portfolio_total_value", label: "Portfolio Total Value", description: "Total portfolio value.", category: "Portfolio Intelligence", dataType: "number", populatedRows: 102141, valueSource: "range", synonyms: ["portfolio value"] }),
  field({ key: "master_owner.portfolio_total_equity", entity: "master_owner", table: "master_owners", column: "portfolio_total_equity", label: "Portfolio Total Equity", description: "Total portfolio equity.", category: "Portfolio Intelligence", dataType: "number", populatedRows: 102141, valueSource: "range", synonyms: ["portfolio equity"] }),
  field({ key: "master_owner.portfolio_total_loan_balance", entity: "master_owner", table: "master_owners", column: "portfolio_total_loan_balance", label: "Portfolio Loan Balance", description: "Total portfolio loan balance.", category: "Portfolio Intelligence", dataType: "number", populatedRows: 102156, valueSource: "range" }),
  field({ key: "master_owner.portfolio_total_loan_payment", entity: "master_owner", table: "master_owners", column: "portfolio_total_loan_payment", label: "Portfolio Loan Payment", description: "Total portfolio loan payment.", category: "Portfolio Intelligence", dataType: "number", populatedRows: 102156, valueSource: "range" }),
  field({ key: "master_owner.portfolio_total_tax_amount", entity: "master_owner", table: "master_owners", column: "portfolio_total_tax_amount", label: "Portfolio Tax Amount", description: "Total portfolio tax amount.", category: "Portfolio Intelligence", dataType: "number", populatedRows: 102092, valueSource: "range" }),
  field({ key: "master_owner.portfolio_total_units", entity: "master_owner", table: "master_owners", column: "portfolio_total_units", label: "Portfolio Units", description: "Total units across portfolio.", category: "Portfolio Intelligence", dataType: "number", populatedRows: 101069, valueSource: "range", synonyms: ["portfolio units"] }),
  field({ key: "master_owner.property_count", entity: "master_owner", table: "master_owners", column: "property_count", label: "Owner Property Count", description: "Number of linked properties.", category: "Portfolio Intelligence", dataType: "number", populatedRows: O, valueSource: "range", synonyms: ["portfolio", "portfolio size", "property count"] }),
  field({ key: "master_owner.max_ownership_years", entity: "master_owner", table: "master_owners", column: "max_ownership_years", label: "Maximum Ownership Years", description: "Maximum ownership years across portfolio.", category: "Portfolio Intelligence", dataType: "number", populatedRows: 102125, valueSource: "range" }),

  // ── 12F Distress & tags ───────────────────────────────────────────────────
  field({ key: "master_owner.tax_delinquent_count", entity: "master_owner", table: "master_owners", column: "tax_delinquent_count", label: "Tax-Delinquent Property Count", description: "Count of tax-delinquent properties in portfolio.", category: "Distress & Tags", dataType: "number", populatedRows: O, valueSource: "range", synonyms: ["tax delinquent portfolio"] }),
  field({ key: "master_owner.oldest_tax_delinquent_year", entity: "master_owner", table: "master_owners", column: "oldest_tax_delinquent_year", label: "Oldest Tax-Delinquent Year", description: "Oldest tax delinquency year in portfolio.", category: "Distress & Tags", dataType: "number", populatedRows: 11532, valueSource: "range" }),
  field({ key: "master_owner.active_lien_count", entity: "master_owner", table: "master_owners", column: "active_lien_count", label: "Active Lien Count", description: "Count of active liens across portfolio.", category: "Distress & Tags", dataType: "number", populatedRows: O, valueSource: "range", synonyms: ["active lien portfolio"] }),
  field({ key: "master_owner.seller_tags_json", entity: "master_owner", table: "master_owners", column: "seller_tags_json", label: "Seller Tags (Owner)", description: "Owner seller tag membership.", category: "Distress & Tags", dataType: "json_text_array", populatedRows: 86346, valueSource: "distinct", jsonStorageShape: "text_array", jsonCompilerKey: JSON_COMPILER_KEYS.property_tag_array, presenceStrategy: "membership" }),
  field({ key: "master_owner.last_sale_doc_type", entity: "master_owner", table: "master_owners", column: "last_sale_doc_type", label: "Last Sale Document Type (Owner)", description: "Owner last sale document type.", category: "Distress & Tags", dataType: "text", populatedRows: 99602, valueSource: "distinct" }),

  // ── 12G System routing ────────────────────────────────────────────────────
  field({ key: "master_owner.agent_persona", entity: "master_owner", table: "master_owners", column: "agent_persona", label: "Agent Persona (Owner)", description: "System routing agent persona.", category: "System Routing", dataType: "text", populatedRows: O, valueSource: "distinct" }),
  field({ key: "master_owner.agent_family", entity: "master_owner", table: "master_owners", column: "agent_family", label: "Agent Family (Owner)", description: "System routing agent family.", category: "System Routing", dataType: "text", populatedRows: O, valueSource: "distinct" }),
  field({ key: "master_owner.split_test_cohort", entity: "master_owner", table: "master_owners", column: "split_test_cohort", label: "Split-Test Cohort", description: "System routing split-test cohort.", category: "System Routing", dataType: "text", populatedRows: O, valueSource: "distinct" }),

  // ── 13 Phones — identity & linkage ────────────────────────────────────────
  field({ key: "phone.has_canonical_phone", entity: "phone", table: "phones", column: "canonical_e164", label: "Has Canonical Phone", description: "Phone record has a normalized E.164 number.", category: "Identity & Linkage", dataType: "derived_presence", populatedRows: 118000, valueSource: "derived_presence", presenceStrategy: "has_data", synonyms: ["has phone", "canonical phone"] }),
  field({ key: "phone.phone_type", entity: "phone", table: "phones", column: "phone_type", label: "Phone Type", description: "Line type classification (Mobile, VoIP, etc.).", category: "Identity & Linkage", dataType: "text", populatedRows: H, valueSource: "distinct", synonyms: ["line type", "mobile", "voip"] }),
  field({ key: "phone.is_sms_capable", entity: "phone", table: "phones", column: "phone_type", label: "SMS Capable Line", description: "Phone line type supports SMS (Mobile, VoIP, Wireless).", category: "Identity & Linkage", dataType: "text", populatedRows: H, valueSource: "distinct", synonyms: ["sms capable", "textable"] }),
  field({ key: "phone.is_best_phone_for_owner", entity: "phone", table: "phones", column: "is_best_phone_for_owner", label: "Best Phone for Owner", description: "Marked as best phone for the linked Master Owner.", category: "Identity & Linkage", dataType: "boolean", populatedRows: 45000, valueSource: "boolean", synonyms: ["primary phone", "best phone"] }),
  field({ key: "phone.is_best_phone_for_slot", entity: "phone", table: "phones", column: "is_best_phone_for_slot", label: "Best Phone for Slot", description: "Marked as best phone for its contact slot.", category: "Identity & Linkage", dataType: "boolean", populatedRows: 45000, valueSource: "boolean" }),
  field({ key: "phone.phone_slot", entity: "phone", table: "phones", column: "phone_slot", label: "Phone Slot", description: "Contact slot index for this phone.", category: "Identity & Linkage", dataType: "number", populatedRows: 80000, valueSource: "range" }),

  // ── 13B Phones — status & compliance ──────────────────────────────────────
  field({ key: "phone.activity_status", entity: "phone", table: "phones", column: "activity_status", label: "Activity Status", description: "Phone activity status from Podio/campaign graph.", category: "Status & Compliance", dataType: "text", populatedRows: H, valueSource: "distinct", synonyms: ["status", "active", "inactive"] }),
  field({ key: "phone.phone_contact_status", entity: "phone", table: "phones", column: "phone_contact_status", label: "Contact Status", description: "Phone contact restriction status.", category: "Status & Compliance", dataType: "text", populatedRows: 5000, valueSource: "distinct", synonyms: ["wrong number", "suppressed"] }),
  field({ key: "phone.is_wrong_number", entity: "phone", table: "phones", column: "wrong_number_at", label: "Wrong Number", description: "Phone flagged as wrong number.", category: "Status & Compliance", dataType: "derived_presence", populatedRows: 3000, valueSource: "derived_presence", presenceStrategy: "has_data" }),
  field({ key: "phone.do_not_call", entity: "phone", table: "phones", column: "do_not_call", label: "Do Not Call", description: "Phone is on do-not-call list.", category: "Status & Compliance", dataType: "boolean", populatedRows: 2000, valueSource: "boolean", synonyms: ["dnc"] }),
  field({ key: "phone.phone_owner", entity: "phone", table: "phones", column: "phone_owner", label: "Carrier / Phone Owner", description: "Carrier or line owner label.", category: "Status & Compliance", dataType: "text", populatedRows: 90000, valueSource: "distinct", synonyms: ["carrier", "att", "t-mobile", "verizon"] }),

  // ── 13C Phones — usage & scoring ──────────────────────────────────────────
  field({ key: "phone.usage_12_months", entity: "phone", table: "phones", column: "usage_12_months", label: "Usage (12 Months)", description: "Phone usage signal over 12 months.", category: "Usage & Scoring", dataType: "text", populatedRows: 70000, valueSource: "distinct" }),
  field({ key: "phone.usage_2_months", entity: "phone", table: "phones", column: "usage_2_months", label: "Usage (2 Months)", description: "Phone usage signal over 2 months.", category: "Usage & Scoring", dataType: "text", populatedRows: 70000, valueSource: "distinct" }),
  field({ key: "phone.best_phone_score", entity: "phone", table: "phones", column: "best_phone_score", label: "Best Phone Score", description: "Best phone quality score.", category: "Usage & Scoring", dataType: "number", populatedRows: 90000, valueSource: "range", synonyms: ["phone score"] }),
  field({ key: "phone.contact_score_final", entity: "phone", table: "phones", column: "contact_score_final", label: "Contact Score", description: "Final contact score for this phone.", category: "Usage & Scoring", dataType: "number", populatedRows: H, valueSource: "range", synonyms: ["contact score"] }),
  field({ key: "phone.raw_phone_score", entity: "phone", table: "phones", column: "raw_phone_score", label: "Raw Phone Score", description: "Raw phone quality score.", category: "Usage & Scoring", dataType: "number", populatedRows: H, valueSource: "range" }),
  field({ key: "phone.phone_score_final", entity: "phone", table: "phones", column: "phone_score_final", label: "Final Phone Score", description: "Final phone quality score.", category: "Usage & Scoring", dataType: "number", populatedRows: H, valueSource: "range" }),
  field({ key: "phone.sort_rank", entity: "phone", table: "phones", column: "sort_rank", label: "Sort Rank", description: "Phone sort rank within owner/prospect.", category: "Usage & Scoring", dataType: "number", populatedRows: H, valueSource: "range" }),

  // ── 13D Phones — routing ──────────────────────────────────────────────────
  field({ key: "phone.timezone", entity: "phone", table: "phones", column: "timezone", label: "Time Zone (Phone)", description: "Phone time zone.", category: "Routing", dataType: "text", populatedRows: 100000, valueSource: "distinct" }),
  field({ key: "phone.contact_window", entity: "phone", table: "phones", column: "contact_window", label: "Contact Window (Phone)", description: "Phone contact window.", category: "Routing", dataType: "text", populatedRows: 80000, valueSource: "distinct" }),
  field({ key: "phone.primary_market", entity: "phone", table: "phones", column: "primary_market", label: "Primary Market (Phone)", description: "Phone primary market.", category: "Routing", dataType: "text", populatedRows: 90000, valueSource: "distinct" }),
  field({ key: "phone.linked_languages_json", entity: "phone", table: "phones", column: "linked_languages_json", label: "Linked Languages", description: "Languages linked to this phone.", category: "Routing", dataType: "json_text_array", populatedRows: 50000, valueSource: "distinct", jsonStorageShape: "text_array", presenceStrategy: "membership" }),
  field({ key: "phone.has_linked_prospect", entity: "phone", table: "phones", column: "linked_prospect_ids_json", label: "Has Linked Prospect", description: "Phone has at least one linked prospect.", category: "Routing", dataType: "derived_presence", populatedRows: 95000, valueSource: "derived_presence", presenceStrategy: "has_data" }),
];