const clean = (value) => {
  if (value === undefined || value === null) return "";
  const next = String(value).trim();
  return next;
};

const isActive = (value) => {
  if (value === undefined || value === null || value === "") return false;
  if (value === "all") return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
};

export function parseAdvancedFiltersParam(params = {}) {
  const raw = params.advanced ?? params.advanced_filters ?? params.filters_advanced;
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  try {
    const decoded = typeof raw === "string" ? raw : String(raw);
    return JSON.parse(decoded);
  } catch {
    return {};
  }
}

export function hasActiveAdvancedFilters(filters = {}) {
  return Object.entries(filters).some(([key, value]) => {
    if (!isActive(value)) return false;
    if (key === "absenteeOwner" && value === false) return true;
    if (key === "corporateOwner" && value === false) return true;
    if (key === "hasSellerReply" && value === false) return true;
    return true;
  });
}

const COLUMN_MAP = {
  canonical_inbox_threads: {
    market: "market",
    city: "property_address_city",
    state: "property_state",
    zip: "property_zip",
    propertyType: "property_type",
    ownerType: null,
    stage: "seller_stage",
    direction: "latest_message_direction",
    language: null,
    intent: "detected_intent",
    status: "conversation_status",
    deliveryStatus: "delivery_status",
    ownerName: "owner_name",
    phoneNumber: "seller_phone",
    bedsMin: null,
    bathsMin: null,
    sqftMin: null,
    equityPercentMin: null,
    estimatedValueMin: "estimated_value",
    aiScoreMin: null,
    activityDateFrom: "latest_message_at",
    lastInboundDateFrom: "last_inbound_at",
    lastOutboundDateFrom: "last_outbound_at",
    touchCountMin: "message_count",
  },
  v_inbox_threads_live_v2: {
    market: "market",
    city: "property_address_city",
    state: "property_state",
    zip: "property_zip",
    propertyType: "property_type",
    ownerType: "filter_owner_type",
    stage: "universal_stage",
    direction: "latest_message_direction",
    language: "filter_language",
    intent: "detected_intent",
    status: "universal_status",
    deliveryStatus: "delivery_status",
    ownerName: "owner_name",
    phoneNumber: "seller_phone",
    bedsMin: "total_bedrooms",
    bathsMin: "total_baths",
    sqftMin: "building_square_feet",
    equityPercentMin: "equity_percent",
    estimatedValueMin: "estimated_value",
    aiScoreMin: "final_acquisition_score",
    activityDateFrom: "latest_message_at",
    lastInboundDateFrom: "last_inbound_at",
    lastOutboundDateFrom: "last_outbound_at",
    touchCountMin: "message_count",
  },
  v_inbox_enriched: {
    market: "filter_market",
    city: "filter_city",
    state: "filter_state",
    zip: "filter_zip",
    propertyType: "filter_property_type",
    ownerType: "filter_owner_type",
    stage: "filter_stage",
    direction: "latest_direction",
    language: "filter_language",
    intent: "filter_intent",
    status: "filter_status",
    deliveryStatus: "delivery_status",
    ownerName: "owner_display_name",
    phoneNumber: "best_phone",
    bedsMin: "total_bedrooms",
    bathsMin: "total_baths",
    sqftMin: "building_square_feet",
    equityPercentMin: "equity_percent",
    estimatedValueMin: "estimated_value",
    aiScoreMin: "final_acquisition_score",
    activityDateFrom: "latest_message_at",
    lastInboundDateFrom: "last_inbound_at",
    lastOutboundDateFrom: "last_outbound_at",
    touchCountMin: "message_count",
    ownershipYearsMin: "ownership_years",
    yearBuiltMin: "year_built",
    unitsMin: "total_units",
    equityAmountMin: "equity_amount",
    mortgageBalanceMin: "total_loan_balance",
    mailingCity: "mailing_city",
    mailingState: "mailing_state",
  },
};

function resolveColumn(sourceName, key) {
  const map = COLUMN_MAP[sourceName] || COLUMN_MAP.v_inbox_enriched;
  return map[key] || null;
}

function applyEq(query, column, value) {
  if (!column || !isActive(value)) return query;
  if (typeof query.eq === "function") return query.eq(column, value);
  return query;
}

function applyGte(query, column, value) {
  if (!column || value === undefined || value === null || value === "") return query;
  if (typeof query.gte === "function") return query.gte(column, value);
  return query;
}

function applyLte(query, column, value) {
  if (!column || value === undefined || value === null || value === "") return query;
  if (typeof query.lte === "function") return query.lte(column, value);
  return query;
}

function applyIlike(query, column, value) {
  if (!column || !isActive(value)) return query;
  if (typeof query.ilike === "function") return query.ilike(column, `%${clean(value)}%`);
  return query;
}

export function applyLiveInboxAdvancedFilters(query, filters = {}, sourceName = "canonical_inbox_threads") {
  if (!filters || !hasActiveAdvancedFilters(filters)) return query;
  let q = query;
  const col = (key) => resolveColumn(sourceName, key);

  q = applyEq(q, col("market"), filters.market);
  q = applyEq(q, col("city"), filters.city);
  q = applyEq(q, col("state"), filters.state);
  q = applyEq(q, col("zip"), filters.zip);
  q = applyEq(q, col("propertyType"), filters.propertyType);
  q = applyEq(q, col("ownerType"), filters.ownerType);
  q = applyEq(q, col("stage"), filters.stage);
  q = applyEq(q, col("intent"), filters.intent);
  q = applyEq(q, col("status"), filters.status);
  q = applyEq(q, col("language"), filters.language);
  q = applyEq(q, col("deliveryStatus"), filters.deliveryStatus);

  q = applyGte(q, col("bedsMin"), filters.bedsMin);
  q = applyLte(q, col("bedsMax"), filters.bedsMax);
  q = applyGte(q, col("bathsMin"), filters.bathsMin);
  q = applyLte(q, col("bathsMax"), filters.bathsMax);
  q = applyGte(q, col("sqftMin"), filters.sqftMin);
  q = applyLte(q, col("sqftMax"), filters.sqftMax);
  q = applyGte(q, col("unitsMin"), filters.unitsMin);
  q = applyLte(q, col("unitsMax"), filters.unitsMax);
  q = applyGte(q, col("yearBuiltMin"), filters.yearBuiltMin);
  q = applyLte(q, col("yearBuiltMax"), filters.yearBuiltMax);
  q = applyGte(q, col("estimatedValueMin"), filters.estimatedValueMin);
  q = applyLte(q, col("estimatedValueMax"), filters.estimatedValueMax);
  q = applyGte(q, col("equityPercentMin"), filters.equityPercentMin);
  q = applyLte(q, col("equityPercentMax"), filters.equityPercentMax);
  q = applyGte(q, col("equityAmountMin"), filters.equityAmountMin);
  q = applyLte(q, col("equityAmountMax"), filters.equityAmountMax);
  q = applyGte(q, col("mortgageBalanceMin"), filters.mortgageBalanceMin);
  q = applyLte(q, col("mortgageBalanceMax"), filters.mortgageBalanceMax);
  q = applyGte(q, col("ownershipYearsMin"), filters.ownershipYearsMin);
  q = applyLte(q, col("ownershipYearsMax"), filters.ownershipYearsMax);
  q = applyGte(q, col("aiScoreMin"), filters.aiScoreMin);
  q = applyGte(q, col("touchCountMin"), filters.touchCountMin);
  q = applyLte(q, col("touchCountMax"), filters.touchCountMax);

  q = applyGte(q, col("activityDateFrom"), filters.activityDateFrom);
  q = applyLte(q, col("activityDateTo"), filters.activityDateTo);
  q = applyGte(q, col("lastInboundDateFrom"), filters.lastInboundDateFrom);
  q = applyLte(q, col("lastInboundDateTo"), filters.lastInboundDateTo);
  q = applyGte(q, col("lastOutboundDateFrom"), filters.lastOutboundDateFrom);
  q = applyLte(q, col("lastOutboundDateTo"), filters.lastOutboundDateTo);
  q = applyGte(q, col("lastSaleDateFrom"), filters.lastSaleDateFrom);
  q = applyLte(q, col("lastSaleDateTo"), filters.lastSaleDateTo);

  q = applyIlike(q, col("ownerName"), filters.ownerName);
  q = applyIlike(q, col("phoneNumber"), filters.phoneNumber);
  q = applyIlike(q, col("mailingCity"), filters.mailingCity);
  q = applyIlike(q, col("mailingState"), filters.mailingState);

  if (isActive(filters.propertyCondition) && typeof q.ilike === "function") {
    q = q.ilike(sourceName === "v_inbox_enriched" ? "filter_property_condition" : "property_condition", `%${clean(filters.propertyCondition)}%`);
  }

  if (filters.direction === "inbound" && typeof q.eq === "function") {
    q = q.eq(col("direction") || "latest_message_direction", "inbound");
  }
  if (filters.direction === "outbound" && typeof q.eq === "function") {
    q = q.eq(col("direction") || "latest_message_direction", "outbound");
  }

  if (filters.highEquity === true && typeof q.eq === "function") {
    q = q.eq(sourceName === "v_inbox_enriched" ? "filter_high_equity" : "filter_high_equity", true);
  }
  if (filters.absenteeOwner === true && typeof q.eq === "function") {
    q = q.eq(sourceName === "v_inbox_enriched" ? "filter_absentee_owner" : "filter_absentee_owner", true);
  }
  if (filters.corporateOwner === true && typeof q.eq === "function") {
    q = q.eq(sourceName === "v_inbox_enriched" ? "filter_corporate_owner" : "filter_corporate_owner", true);
  }
  if (filters.taxDelinquent === true && typeof q.eq === "function") {
    q = q.eq("filter_tax_delinquent", true);
  }
  if (filters.activeLien === true && typeof q.eq === "function") {
    q = q.eq("filter_active_lien", true);
  }
  if (filters.suppressed === true && typeof q.or === "function") {
    q = q.or("is_suppressed.eq.true,opt_out.eq.true,suppression_status.eq.suppressed");
  }
  if (isActive(filters.suppressionReason) && typeof q.ilike === "function") {
    q = q.ilike("suppression_reason", `%${clean(filters.suppressionReason)}%`);
  }
  if (filters.hasSellerReply === true && typeof q.gt === "function") {
    q = q.gt("inbound_count", 0);
  }
  if (filters.hasSellerReply === false && typeof q.eq === "function") {
    q = q.eq("inbound_count", 0);
  }

  if (isActive(filters.addressSearch) && typeof q.or === "function") {
    const term = `%${clean(filters.addressSearch)}%`;
    q = q.or([
      `property_address_full.ilike.${term}`,
      `display_address.ilike.${term}`,
      `owner_name.ilike.${term}`,
      `seller_phone.ilike.${term}`,
    ].join(","));
  }

  return q;
}

export function shouldPreferEnrichedSource(filters = {}) {
  if (!hasActiveAdvancedFilters(filters)) return false;
  const enrichedKeys = [
    "equityPercentMin", "equityPercentMax", "equityAmountMin", "bedsMin", "bathsMin", "sqftMin",
    "unitsMin", "ownershipYearsMin", "yearBuiltMin", "taxDelinquent", "activeLien", "highEquity",
    "absenteeOwner", "corporateOwner", "mailingCity", "mailingState", "mortgageBalanceMin",
  ];
  return enrichedKeys.some((key) => isActive(filters[key]));
}