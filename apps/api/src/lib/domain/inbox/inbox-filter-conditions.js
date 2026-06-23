import {
  INBOX_FILTER_FIELDS,
  resolveFilterColumn,
  resolveOptionsColumn,
} from "./inbox-filter-catalog.js";

const clean = (v) => String(v ?? "").trim();

const isActive = (v) => {
  if (v === undefined || v === null || v === "") return false;
  if (v === "all") return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
};

const VIEW_TO_CATEGORY = {
  new_replies: "new_inbound",
  priority: "hot_leads",
  needs_review: "needs_review",
  follow_up: "outbound_active",
  follow_up_due: "outbound_active",
  cold: "cold_no_response",
  cold_no_response: "cold_no_response",
  suppressed: "dnc_opt_out",
  dnc_opt_out: "dnc_opt_out",
  automated: "automated",
  dead: "cold_no_response",
  waiting: "outbound_active",
};

const FILTER_KEY_TO_COLUMNS = {
  market: ["market"],
  city: ["city"],
  state: ["state"],
  zip: ["zip"],
  propertyType: ["property_type"],
  propertyClass: ["property_class"],
  ownerType: ["owner_type_guess"],
  stage: ["stage"],
  status: ["status"],
  intent: ["ui_intent"],
  direction: ["latest_direction"],
  language: ["best_language"],
  buildingCondition: ["building_condition"],
  propertyCondition: ["building_condition"],
  leadTemperature: ["priority_bucket"],
  householdIncome: ["est_household_income"],
  netAssetValue: ["net_asset_value"],
  occupationGroup: ["occupation_group"],
  gender: ["gender"],
  maritalStatus: ["marital_status"],
  education: ["education_model"],
  occupation: ["occupation"],
  ownerPriorityTier: ["owner_priority_tier"],
  priorityTier: ["owner_priority_tier"],
  phoneCarrier: ["phone_carrier"],
  county: ["property_county_name"],
  marketRegion: ["market_region"],
  propertyFlags: ["property_flags_text", "property_flags_json"],
  propertyFlagsAny: ["property_flags_text", "property_flags_json"],
  propertyFlagsAll: ["property_flags_text", "property_flags_json"],
  propertyFlagsExclude: ["property_flags_text", "property_flags_json"],
  personFlags: ["person_flags_text", "person_flags_json"],
  personFlagsAny: ["person_flags_text", "person_flags_json"],
  personFlagsAll: ["person_flags_text", "person_flags_json"],
  personFlagsExclude: ["person_flags_text", "person_flags_json"],
};

const OPTIONS_KEY_TO_FIELD_KEY = Object.fromEntries(
  INBOX_FILTER_FIELDS.filter((f) => f.optionsKey).map((f) => [f.optionsKey, f.key]),
);

export const HYDRATED_FILTER_UNIVERSE = "public.inbox_hydrated_scoped";

export function resolveOptionsFieldSpec(fieldKey) {
  const catalogField = INBOX_FILTER_FIELDS.find((f) => f.key === fieldKey || f.optionsKey === fieldKey);
  if (catalogField?.type === "flags") {
    return {
      kind: catalogField.key === "propertyFlags" ? "property_flags" : "person_flags",
      fieldKey: catalogField.key,
      excludeKeys: [catalogField.key, `${catalogField.key}Any`, `${catalogField.key}All`, `${catalogField.key}Exclude`],
    };
  }
  const optionsKey = catalogField?.optionsKey || fieldKey;
  const mappedFieldKey = OPTIONS_KEY_TO_FIELD_KEY[optionsKey] || catalogField?.key || fieldKey;
  const column = resolveOptionsColumn(optionsKey) || resolveFilterColumn(mappedFieldKey) || catalogField?.column || fieldKey;
  return {
    kind: "column",
    fieldKey: mappedFieldKey,
    column,
    excludeKeys: [mappedFieldKey],
    excludeColumns: FILTER_KEY_TO_COLUMNS[mappedFieldKey] || [column],
  };
}

function normalizeFilters(raw = {}) {
  const out = { ...raw };
  if (raw.outOfStateOwner === "yes") out.absenteeOwner = true;
  if (raw.outOfStateOwner === "no") out.absenteeOwner = false;
  if (raw.corporateMatch === "yes") out.corporateOwner = true;
  if (raw.corporateMatch === "no") out.corporateOwner = false;
  if (raw.lastMessageDirection === "inbound") out.direction = "inbound";
  if (raw.lastMessageDirection === "outbound") out.direction = "outbound";
  if (raw.hasSellerReply === "yes") out.hasSellerReply = true;
  if (raw.hasSellerReply === "no") out.hasSellerReply = false;
  if (raw.highEquity === true && !out.equityPercentMin) out.equityPercentMin = 40;
  if (raw.suppressionReason) out.isSuppressed = true;
  if (raw.propertyFlagsAny) out.propertyFlags = { mode: "any", values: raw.propertyFlagsAny };
  if (raw.propertyFlagsAll) out.propertyFlags = { mode: "all", values: raw.propertyFlagsAll };
  if (raw.propertyFlagsExclude) out.propertyFlags = { ...(out.propertyFlags || {}), exclude: raw.propertyFlagsExclude };
  if (raw.personFlagsAny) out.personFlags = { mode: "any", values: raw.personFlagsAny };
  if (raw.personFlagsAll) out.personFlags = { mode: "all", values: raw.personFlagsAll };
  if (raw.personFlagsExclude) out.personFlags = { ...(out.personFlags || {}), exclude: raw.personFlagsExclude };
  return out;
}

function pushEq(conditions, column, value, excludeColumns) {
  if (!column || !isActive(value) || excludeColumns?.has(column)) return;
  conditions.push({ op: "eq", column, value: Array.isArray(value) ? value[0] : value });
}

function pushGte(conditions, column, value, excludeColumns) {
  if (!column || value === undefined || value === null || value === "" || excludeColumns?.has(column)) return;
  conditions.push({ op: "gte", column, value });
}

function pushLte(conditions, column, value, excludeColumns) {
  if (!column || value === undefined || value === null || value === "" || excludeColumns?.has(column)) return;
  conditions.push({ op: "lte", column, value });
}

function pushIlike(conditions, column, value, excludeColumns) {
  if (!column || !isActive(value) || excludeColumns?.has(column)) return;
  conditions.push({ op: "ilike", column, value: clean(value) });
}

function pushTri(conditions, column, value, excludeColumns, field) {
  if (!column || value === undefined || value === null || value === "" || excludeColumns?.has(column)) return;
  if (field?.derived === "gt0") {
    if (value === true || value === "yes") conditions.push({ op: "gt", column, value: 0 });
    if (value === false || value === "no") conditions.push({ op: "eq", column, value: 0 });
    return;
  }
  if (field?.derived === "notEmpty") {
    if (value === true || value === "yes") conditions.push({ op: "not_is", column, value: null });
    if (value === false || value === "no") conditions.push({ op: "is", column, value: null });
    return;
  }
  if (field?.matchValue) {
    if (value === true || value === "yes") pushEq(conditions, column, field.matchValue, excludeColumns);
    return;
  }
  const bool = value === true || value === "yes" ? true : value === false || value === "no" ? false : null;
  if (bool === null) return;
  conditions.push({ op: "eq", column, value: bool });
}

function pushTextSearch(conditions, columns, value, excludeColumns) {
  if (!isActive(value) || !Array.isArray(columns)) return;
  const activeCols = columns.filter((c) => !excludeColumns?.has(c));
  if (!activeCols.length) return;
  conditions.push({ op: "or_ilike", columns: activeCols, value: clean(value) });
}

function pushFlagFilter(conditions, spec, flagSpec, excludeColumns) {
  if (!flagSpec || (!isActive(flagSpec.values) && !isActive(flagSpec.exclude))) return;
  const cols = (spec.columns || []).filter((c) => !excludeColumns?.has(c));
  if (!cols.length) return;
  const values = Array.isArray(flagSpec.values) ? flagSpec.values.map(clean).filter(Boolean) : [];
  const exclude = Array.isArray(flagSpec.exclude) ? flagSpec.exclude.map(clean).filter(Boolean) : [];
  const mode = flagSpec.mode || "any";
  if (values.length > 0) {
    conditions.push({ op: mode === "all" ? "flag_all" : "flag_any", columns: cols, values });
  }
  for (const flag of exclude) {
    conditions.push({ op: "flag_exclude", columns: cols, values: [flag] });
  }
}

export function buildInboxFilterConditions(rawFilters = {}, { excludeFieldKeys = [], excludeColumns = [] } = {}) {
  const filters = normalizeFilters(rawFilters);
  const excludedCols = new Set(excludeColumns);
  for (const fieldKey of excludeFieldKeys) {
    for (const col of FILTER_KEY_TO_COLUMNS[fieldKey] || []) excludedCols.add(col);
  }

  const conditions = [];
  const bucket = clean(filters.inbox_bucket || filters.inboxCategory || filters.bucket || filters.filter);
  const view = clean(filters.view);
  const category = VIEW_TO_CATEGORY[bucket] || VIEW_TO_CATEGORY[view]
    || (bucket && bucket !== "all" && bucket !== "all_messages" ? bucket : null);
  if (category && !excludedCols.has("inbox_category")) {
    conditions.push({ op: "inbox_category_eq", value: category });
  }

  if (isActive(filters.q)) {
    pushTextSearch(conditions, [
      "thread_key", "owner_display_name", "prospect_full_name", "best_phone",
      "property_address_full", "latest_message_body", "market", "city",
    ], filters.q, excludedCols);
  }

  pushEq(conditions, "market", filters.market, excludedCols);
  pushEq(conditions, "state", filters.state, excludedCols);
  pushEq(conditions, "city", filters.city, excludedCols);
  pushEq(conditions, "zip", filters.zip, excludedCols);
  pushEq(conditions, "property_type", filters.propertyType, excludedCols);
  pushEq(conditions, "property_class", filters.propertyClass, excludedCols);
  pushEq(conditions, "owner_type_guess", filters.ownerType, excludedCols);
  pushEq(conditions, "stage", filters.stage, excludedCols);
  pushEq(conditions, "status", filters.status, excludedCols);
  pushEq(conditions, "ui_intent", filters.intent, excludedCols);
  pushEq(conditions, "latest_direction", filters.direction, excludedCols);
  pushEq(conditions, "best_language", filters.language, excludedCols);
  pushEq(conditions, "building_condition", filters.buildingCondition || filters.propertyCondition, excludedCols);
  pushEq(conditions, "priority_bucket", filters.leadTemperature, excludedCols);
  pushEq(conditions, "est_household_income", filters.householdIncome, excludedCols);
  pushEq(conditions, "net_asset_value", filters.netAssetValue, excludedCols);
  pushEq(conditions, "occupation_group", filters.occupationGroup, excludedCols);
  pushEq(conditions, "gender", filters.gender, excludedCols);
  pushEq(conditions, "marital_status", filters.maritalStatus, excludedCols);
  pushEq(conditions, "education_model", filters.education, excludedCols);
  pushEq(conditions, "occupation", filters.occupation, excludedCols);
  pushEq(conditions, "owner_priority_tier", filters.ownerPriorityTier || filters.priorityTier, excludedCols);
  pushEq(conditions, "phone_carrier", filters.phoneCarrier, excludedCols);
  pushEq(conditions, "property_county_name", filters.county, excludedCols);
  pushEq(conditions, "market_region", filters.marketRegion, excludedCols);

  pushGte(conditions, "units_count", filters.unitsMin, excludedCols);
  pushLte(conditions, "units_count", filters.unitsMax, excludedCols);
  pushGte(conditions, "total_bedrooms", filters.bedsMin, excludedCols);
  pushLte(conditions, "total_bedrooms", filters.bedsMax, excludedCols);
  pushGte(conditions, "total_baths", filters.bathsMin, excludedCols);
  pushLte(conditions, "total_baths", filters.bathsMax, excludedCols);
  pushGte(conditions, "building_square_feet", filters.sqftMin, excludedCols);
  pushLte(conditions, "building_square_feet", filters.sqftMax, excludedCols);
  pushGte(conditions, "year_built", filters.yearBuiltMin, excludedCols);
  pushLte(conditions, "year_built", filters.yearBuiltMax, excludedCols);
  pushGte(conditions, "effective_year_built", filters.effectiveYearBuiltMin, excludedCols);
  pushGte(conditions, "estimated_value", filters.estimatedValueMin, excludedCols);
  pushLte(conditions, "estimated_value", filters.estimatedValueMax, excludedCols);
  pushGte(conditions, "equity_percent", filters.equityPercentMin, excludedCols);
  pushLte(conditions, "equity_percent", filters.equityPercentMax, excludedCols);
  pushGte(conditions, "equity_amount", filters.equityAmountMin, excludedCols);
  pushGte(conditions, "total_loan_balance", filters.mortgageBalanceMin, excludedCols);
  pushGte(conditions, "total_loan_amt", filters.totalLoanAmtMin, excludedCols);
  pushGte(conditions, "total_loan_payment", filters.loanPaymentMin, excludedCols);
  pushGte(conditions, "tax_amt", filters.taxAmtMin, excludedCols);
  pushGte(conditions, "past_due_amount", filters.pastDueAmountMin, excludedCols);
  pushGte(conditions, "estimated_repair_cost", filters.repairCostMin, excludedCols);
  pushGte(conditions, "ai_score", filters.aiScoreMin, excludedCols);
  pushGte(conditions, "final_acquisition_score", filters.finalAcquisitionScoreMin, excludedCols);
  pushGte(conditions, "deal_strength_score", filters.dealStrengthScoreMin, excludedCols);
  pushGte(conditions, "priority_score", filters.priorityScoreMin || filters.motivationMin, excludedCols);
  pushGte(conditions, "ownership_years", filters.ownershipYearsMin, excludedCols);
  pushGte(conditions, "prospect_age", filters.prospectAgeMin || filters.sellerAgeMin, excludedCols);
  pushGte(conditions, "buying_power", filters.buyingPowerMin, excludedCols);
  pushGte(conditions, "contactability_score", filters.contactabilityScoreMin, excludedCols);
  pushGte(conditions, "financial_pressure_score", filters.financialPressureScoreMin, excludedCols);
  pushGte(conditions, "urgency_score", filters.urgencyScoreMin, excludedCols);
  pushGte(conditions, "owner_priority_score", filters.ownerPriorityScoreMin, excludedCols);
  pushGte(conditions, "portfolio_total_value", filters.portfolioValueMin, excludedCols);
  pushGte(conditions, "portfolio_total_equity", filters.portfolioEquityMin, excludedCols);
  pushGte(conditions, "portfolio_total_loan_balance", filters.portfolioLoanBalanceMin, excludedCols);
  pushGte(conditions, "portfolio_total_units", filters.portfolioUnitsMin, excludedCols);
  pushGte(conditions, "property_count", filters.propertyCountMin, excludedCols);
  pushGte(conditions, "message_count", filters.touchCountMin || filters.messageCountMin, excludedCols);
  pushGte(conditions, "inbound_count", filters.inboundCountMin, excludedCols);
  pushGte(conditions, "outbound_count", filters.outboundCountMin, excludedCols);
  pushGte(conditions, "pending_queue_count", filters.pendingQueueCountMin, excludedCols);
  pushGte(conditions, "cash_offer", filters.cashOfferMin, excludedCols);
  pushGte(conditions, "assd_total_value", filters.assessedValueMin, excludedCols);
  pushGte(conditions, "calculated_total_value", filters.arvMin, excludedCols);
  pushGte(conditions, "sale_price", filters.lastSalePriceMin, excludedCols);
  pushGte(conditions, "lot_square_feet", filters.lotSqftMin, excludedCols);
  pushGte(conditions, "lot_acreage", filters.lotAcreageMin, excludedCols);

  pushGte(conditions, "latest_message_at", filters.activityDateFrom, excludedCols);
  pushLte(conditions, "latest_message_at", filters.activityDateTo, excludedCols);
  pushGte(conditions, "last_inbound_at", filters.lastInboundDateFrom, excludedCols);
  pushLte(conditions, "last_inbound_at", filters.lastInboundDateTo, excludedCols);
  pushGte(conditions, "last_outbound_at", filters.lastOutboundDateFrom, excludedCols);
  pushLte(conditions, "last_outbound_at", filters.lastOutboundDateTo, excludedCols);
  pushGte(conditions, "sale_date", filters.lastSaleDateFrom, excludedCols);
  pushLte(conditions, "sale_date", filters.lastSaleDateTo, excludedCols);
  pushGte(conditions, "follow_up_at", filters.followUpAtFrom, excludedCols);
  pushLte(conditions, "follow_up_at", filters.followUpAtTo, excludedCols);

  pushIlike(conditions, "owner_display_name", filters.ownerName, excludedCols);
  pushIlike(conditions, "best_phone", filters.phoneNumber, excludedCols);
  pushIlike(conditions, "seller_phone", filters.phoneNumber, excludedCols);
  pushTextSearch(conditions, ["property_address_full", "event_property_address", "city", "owner_display_name", "best_phone"], filters.addressSearch, excludedCols);

  const unreadOnly = filters.unreadOnly === true ? false : filters.unreadOnly === false ? true : undefined;
  pushTri(conditions, "is_read", filters.isRead ?? unreadOnly, excludedCols);
  pushTri(conditions, "is_starred", filters.isStarred, excludedCols);
  pushTri(conditions, "is_pinned", filters.isPinned, excludedCols);
  pushTri(conditions, "is_archived", filters.isArchived, excludedCols);
  pushTri(conditions, "is_suppressed", filters.isSuppressed ?? filters.suppressed, excludedCols);
  pushTri(conditions, "property_tax_delinquent", filters.taxDelinquent, excludedCols);
  pushTri(conditions, "property_active_lien", filters.activeLien, excludedCols);
  pushTri(conditions, "is_corporate_owner", filters.corporateOwner, excludedCols);
  pushTri(conditions, "out_of_state_owner", filters.absenteeOwner, excludedCols);
  pushTri(conditions, "likely_owner", filters.likelyOwner, excludedCols);
  pushTri(conditions, "likely_renting", filters.likelyRenting, excludedCols);
  pushTri(conditions, "sms_eligible", filters.smsEligible, excludedCols);
  pushTri(conditions, "email_eligible", filters.emailEligible, excludedCols);
  pushTri(conditions, "inbound_count", filters.hasSellerReply, excludedCols, { derived: "gt0" });
  pushTri(conditions, "prospect_best_email", filters.hasEmail, excludedCols, { derived: "notEmpty" });

  if (!excludedCols.has("property_flags_text") && !excludedCols.has("property_flags_json")) {
    pushFlagFilter(conditions, { columns: ["property_flags_text", "property_flags_json"] }, filters.propertyFlags);
  }
  if (!excludedCols.has("person_flags_text") && !excludedCols.has("person_flags_json")) {
    pushFlagFilter(conditions, { columns: ["person_flags_text", "person_flags_json"] }, filters.personFlags);
  }

  return conditions;
}

export function collectPreserveValues(filters = {}, fieldSpec) {
  const values = new Set();
  if (!fieldSpec) return [];
  if (fieldSpec.kind === "column") {
    const raw = filters[fieldSpec.fieldKey];
    if (isActive(raw)) values.add(String(Array.isArray(raw) ? raw[0] : raw));
    return [...values];
  }
  if (fieldSpec.kind === "property_flags") {
    for (const key of ["propertyFlagsAny", "propertyFlagsAll", "propertyFlagsExclude"]) {
      const arr = filters[key];
      if (Array.isArray(arr)) arr.forEach((v) => values.add(clean(v)));
    }
  }
  if (fieldSpec.kind === "person_flags") {
    for (const key of ["personFlagsAny", "personFlagsAll", "personFlagsExclude"]) {
      const arr = filters[key];
      if (Array.isArray(arr)) arr.forEach((v) => values.add(clean(v)));
    }
  }
  return [...values].filter(Boolean);
}