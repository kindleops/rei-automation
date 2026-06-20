import { supabase as defaultSupabase } from "@/lib/supabase/client.js";
import {
  HYDRATED_INBOX_SOURCE,
  resolveFilterColumn,
  resolveOptionsColumn,
  getInboxFilterCatalog,
} from "./inbox-filter-catalog.js";
import { parseAdvancedFiltersParam, hasActiveAdvancedFilters } from "./inbox-advanced-filters.js";

const clean = (v) => String(v ?? "").trim();
const isActive = (v) => {
  if (v === undefined || v === null || v === "") return false;
  if (v === "all") return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
};

const LEGACY_KEY_MAP = {
  bedsMin: "bedsMin", bathsMin: "bathsMin", sqftMin: "sqftMin",
  unitsMin: "unitsMin", yearBuiltMin: "yearBuiltMin",
  estimatedValueMin: "estimatedValueMin", estimatedValueMax: "estimatedValueMax",
  equityPercentMin: "equityPercentMin", equityPercentMax: "equityPercentMax",
  equityAmountMin: "equityAmountMin", mortgageBalanceMin: "mortgageBalanceMin",
  ownershipYearsMin: "ownershipYearsMin", aiScoreMin: "aiScoreMin",
  finalAcquisitionScoreMin: "finalAcquisitionScoreMin", priorityScoreMin: "priorityScoreMin",
  motivationMin: "priorityScoreMin", touchCountMin: "messageCountMin",
  activityDateFrom: "activityDateFrom", activityDateTo: "activityDateTo",
  lastInboundDateFrom: "lastInboundDateFrom", lastOutboundDateFrom: "lastOutboundDateFrom",
  ownerName: "ownerName", phoneNumber: "phoneNumber", addressSearch: "addressSearch",
  ownerNameSearch: "ownerName", phoneNumberSearch: "phoneNumber",
  sellerStage: "stage", inboxStatus: "status", latestIntent: "intent",
  lastMessageDirection: "direction", assignedAgent: "persona",
  outOfStateOwner: "absenteeOwner", corporateMatch: "corporateOwner",
  multiplePropertiesOwned: "propertyCountMin", netAssetValueMin: "netAssetValue",
  suppressionReason: "isSuppressed", highEquity: "equityPercentMin",
  propertyCondition: "buildingCondition", mailingCity: "city", mailingState: "state",
};

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

function parseFlags(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  if (typeof value === "object") {
    return Object.entries(value).filter(([, v]) => v === true || v === "true").map(([k]) => clean(k));
  }
  return String(value).split(/[,|;]+/).map((s) => clean(s)).filter(Boolean);
}

function applyEq(q, col, val) {
  if (!col || !isActive(val)) return q;
  if (Array.isArray(val) && val.length > 1 && typeof q.in === "function") return q.in(col, val);
  if (typeof q.eq === "function") return q.eq(col, Array.isArray(val) ? val[0] : val);
  return q;
}

function applyGte(q, col, val) {
  if (!col || val === undefined || val === null || val === "") return q;
  if (typeof q.gte === "function") return q.gte(col, val);
  return q;
}

function applyLte(q, col, val) {
  if (!col || val === undefined || val === null || val === "") return q;
  if (typeof q.lte === "function") return q.lte(col, val);
  return q;
}

function applyIlike(q, col, val) {
  if (!col || !isActive(val)) return q;
  if (typeof q.ilike === "function") return q.ilike(col, `%${clean(val)}%`);
  return q;
}

function applyTri(q, col, val, field) {
  if (!col || val === undefined || val === null || val === "") return q;
  if (field?.derived === "gt0") {
    if (val === true || val === "yes") return typeof q.gt === "function" ? q.gt(col, 0) : q;
    if (val === false || val === "no") return typeof q.eq === "function" ? q.eq(col, 0) : q;
  }
  if (field?.derived === "notEmpty") {
    if (val === true || val === "yes") return typeof q.not === "function" ? q.not(col, "is", null) : q;
    if (val === false || val === "no") return typeof q.is === "function" ? q.is(col, null) : q;
  }
  if (field?.matchValue) {
    if (val === true || val === "yes") return applyEq(q, col, field.matchValue);
    return q;
  }
  const bool = val === true || val === "yes" ? true : val === false || val === "no" ? false : null;
  if (bool === null) return q;
  if (typeof q.eq === "function") return q.eq(col, bool);
  return q;
}

function applyTextSearch(q, cols, val) {
  if (!isActive(val) || !Array.isArray(cols) || typeof q.or !== "function") return q;
  const term = `%${clean(val)}%`;
  return q.or(cols.map((c) => `${c}.ilike.${term}`).join(","));
}

function applyFlagFilter(q, spec, flagSpec) {
  if (!flagSpec || !isActive(flagSpec.values) && !isActive(flagSpec.exclude)) return q;
  const cols = spec.columns || [];
  const textCol = cols[0];
  if (!textCol) return q;

  const values = Array.isArray(flagSpec.values) ? flagSpec.values : [];
  const exclude = Array.isArray(flagSpec.exclude) ? flagSpec.exclude : [];
  const mode = flagSpec.mode || "any";

  if (values.length > 0 && typeof q.or === "function") {
    const clauses = values.flatMap((flag) => cols.map((c) => `${c}.ilike.%${clean(flag)}%`));
    if (mode === "all") {
      for (const flag of values) {
        q = q.or(cols.map((c) => `${c}.ilike.%${clean(flag)}%`).join(","));
      }
    } else {
      q = q.or(clauses.join(","));
    }
  }
  for (const flag of exclude) {
    for (const c of cols) {
      if (typeof q.not === "function") q = q.not(c, "ilike", `%${clean(flag)}%`);
    }
  }
  return q;
}

export function applyHydratedInboxFilters(query, rawFilters = {}) {
  const filters = normalizeFilters(rawFilters);
  let q = query;

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
  const bucket = clean(filters.inbox_bucket || filters.inboxCategory || filters.bucket);
  const view = clean(filters.view);
  const category = VIEW_TO_CATEGORY[bucket] || VIEW_TO_CATEGORY[view] || (bucket && bucket !== "all" && bucket !== "all_messages" ? bucket : null);
  if (category) q = applyEq(q, "inbox_category", category);

  if (isActive(filters.q) && typeof q.or === "function") {
    const term = `%${clean(filters.q)}%`;
    q = q.or([
      "thread_key", "owner_display_name", "prospect_full_name", "best_phone",
      "property_address_full", "latest_message_body", "market", "city",
    ].map((c) => `${c}.ilike.${term}`).join(","));
  }

  q = applyEq(q, "market", filters.market);
  q = applyEq(q, "state", filters.state);
  q = applyEq(q, "city", filters.city);
  q = applyEq(q, "zip", filters.zip);
  q = applyEq(q, "property_type", filters.propertyType);
  q = applyEq(q, "property_class", filters.propertyClass);
  q = applyEq(q, "owner_type_guess", filters.ownerType);
  q = applyEq(q, "stage", filters.stage);
  q = applyEq(q, "status", filters.status);
  q = applyEq(q, "ui_intent", filters.intent);
  q = applyEq(q, "latest_direction", filters.direction);
  q = applyEq(q, "best_language", filters.language);
  q = applyEq(q, "building_condition", filters.buildingCondition || filters.propertyCondition);
  q = applyEq(q, "inbox_category", filters.view);
  q = applyEq(q, "priority_bucket", filters.leadTemperature);
  q = applyEq(q, "est_household_income", filters.householdIncome);
  q = applyEq(q, "net_asset_value", filters.netAssetValue);
  q = applyEq(q, "occupation_group", filters.occupationGroup);
  q = applyEq(q, "gender", filters.gender);
  q = applyEq(q, "marital_status", filters.maritalStatus);
  q = applyEq(q, "education_model", filters.education);
  q = applyEq(q, "occupation", filters.occupation);
  q = applyEq(q, "owner_priority_tier", filters.ownerPriorityTier || filters.priorityTier);
  q = applyEq(q, "phone_carrier", filters.phoneCarrier);
  q = applyEq(q, "property_county_name", filters.county);
  q = applyEq(q, "market_region", filters.marketRegion);

  q = applyGte(q, "units_count", filters.unitsMin);
  q = applyLte(q, "units_count", filters.unitsMax);
  q = applyGte(q, "total_bedrooms", filters.bedsMin);
  q = applyLte(q, "total_bedrooms", filters.bedsMax);
  q = applyGte(q, "total_baths", filters.bathsMin);
  q = applyLte(q, "total_baths", filters.bathsMax);
  q = applyGte(q, "building_square_feet", filters.sqftMin);
  q = applyLte(q, "building_square_feet", filters.sqftMax);
  q = applyGte(q, "year_built", filters.yearBuiltMin);
  q = applyLte(q, "year_built", filters.yearBuiltMax);
  q = applyGte(q, "effective_year_built", filters.effectiveYearBuiltMin);
  q = applyGte(q, "estimated_value", filters.estimatedValueMin);
  q = applyLte(q, "estimated_value", filters.estimatedValueMax);
  q = applyGte(q, "equity_percent", filters.equityPercentMin);
  q = applyLte(q, "equity_percent", filters.equityPercentMax);
  q = applyGte(q, "equity_amount", filters.equityAmountMin);
  q = applyGte(q, "total_loan_balance", filters.mortgageBalanceMin);
  q = applyGte(q, "total_loan_amt", filters.totalLoanAmtMin);
  q = applyGte(q, "total_loan_payment", filters.loanPaymentMin);
  q = applyGte(q, "tax_amt", filters.taxAmtMin);
  q = applyGte(q, "past_due_amount", filters.pastDueAmountMin);
  q = applyGte(q, "estimated_repair_cost", filters.repairCostMin);
  q = applyGte(q, "ai_score", filters.aiScoreMin);
  q = applyGte(q, "final_acquisition_score", filters.finalAcquisitionScoreMin);
  q = applyGte(q, "deal_strength_score", filters.dealStrengthScoreMin);
  q = applyGte(q, "priority_score", filters.priorityScoreMin || filters.motivationMin);
  q = applyGte(q, "ownership_years", filters.ownershipYearsMin);
  q = applyGte(q, "prospect_age", filters.prospectAgeMin || filters.sellerAgeMin);
  q = applyGte(q, "buying_power", filters.buyingPowerMin);
  q = applyGte(q, "contactability_score", filters.contactabilityScoreMin);
  q = applyGte(q, "financial_pressure_score", filters.financialPressureScoreMin);
  q = applyGte(q, "urgency_score", filters.urgencyScoreMin);
  q = applyGte(q, "owner_priority_score", filters.ownerPriorityScoreMin);
  q = applyGte(q, "portfolio_total_value", filters.portfolioValueMin);
  q = applyGte(q, "portfolio_total_equity", filters.portfolioEquityMin);
  q = applyGte(q, "portfolio_total_loan_balance", filters.portfolioLoanBalanceMin);
  q = applyGte(q, "portfolio_total_units", filters.portfolioUnitsMin);
  q = applyGte(q, "property_count", filters.propertyCountMin);
  q = applyGte(q, "message_count", filters.touchCountMin || filters.messageCountMin);
  q = applyGte(q, "inbound_count", filters.inboundCountMin);
  q = applyGte(q, "outbound_count", filters.outboundCountMin);
  q = applyGte(q, "pending_queue_count", filters.pendingQueueCountMin);
  q = applyGte(q, "cash_offer", filters.cashOfferMin);
  q = applyGte(q, "assd_total_value", filters.assessedValueMin);
  q = applyGte(q, "calculated_total_value", filters.arvMin);
  q = applyGte(q, "sale_price", filters.lastSalePriceMin);
  q = applyGte(q, "lot_square_feet", filters.lotSqftMin);
  q = applyGte(q, "lot_acreage", filters.lotAcreageMin);

  q = applyGte(q, "latest_message_at", filters.activityDateFrom);
  q = applyLte(q, "latest_message_at", filters.activityDateTo);
  q = applyGte(q, "last_inbound_at", filters.lastInboundDateFrom);
  q = applyLte(q, "last_inbound_at", filters.lastInboundDateTo);
  q = applyGte(q, "last_outbound_at", filters.lastOutboundDateFrom);
  q = applyLte(q, "last_outbound_at", filters.lastOutboundDateTo);
  q = applyGte(q, "sale_date", filters.lastSaleDateFrom);
  q = applyLte(q, "sale_date", filters.lastSaleDateTo);
  q = applyGte(q, "follow_up_at", filters.followUpAtFrom);
  q = applyLte(q, "follow_up_at", filters.followUpAtTo);

  q = applyIlike(q, "owner_display_name", filters.ownerName);
  q = applyIlike(q, "best_phone", filters.phoneNumber);
  q = applyIlike(q, "seller_phone", filters.phoneNumber);
  q = applyTextSearch(q, ["property_address_full", "event_property_address", "city", "owner_display_name", "best_phone"], filters.addressSearch);

  const unreadOnly = filters.unreadOnly === true ? false : filters.unreadOnly === false ? true : undefined;
  q = applyTri(q, "is_read", filters.isRead ?? unreadOnly);
  q = applyTri(q, "is_starred", filters.isStarred);
  q = applyTri(q, "is_pinned", filters.isPinned);
  q = applyTri(q, "is_archived", filters.isArchived);
  q = applyTri(q, "is_suppressed", filters.isSuppressed ?? filters.suppressed);
  q = applyTri(q, "property_tax_delinquent", filters.taxDelinquent);
  q = applyTri(q, "property_active_lien", filters.activeLien);
  q = applyTri(q, "is_corporate_owner", filters.corporateOwner);
  q = applyTri(q, "out_of_state_owner", filters.absenteeOwner);
  q = applyTri(q, "likely_owner", filters.likelyOwner);
  q = applyTri(q, "likely_renting", filters.likelyRenting);
  q = applyTri(q, "sms_eligible", filters.smsEligible);
  q = applyTri(q, "email_eligible", filters.emailEligible);
  q = applyTri(q, "inbound_count", filters.hasSellerReply, { derived: "gt0" });
  q = applyTri(q, "prospect_best_email", filters.hasEmail, { derived: "notEmpty" });

  q = applyFlagFilter(q, { columns: ["property_flags_text"] }, filters.propertyFlags);
  q = applyFlagFilter(q, { columns: ["person_flags_text"] }, filters.personFlags);

  return q;
}

export async function countHydratedInboxFilters(filters = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase;
  let q = supabase.from(HYDRATED_INBOX_SOURCE).select("thread_key", { count: "exact", head: true });
  q = applyHydratedInboxFilters(q, filters);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

export async function queryHydratedInboxThreads(params = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase;
  const filters = parseAdvancedFiltersParam(params);
  const limit = Math.min(Math.max(Number(params.limit) || 100, 1), 500);
  const offset = Math.max(Number(params.offset || params.skip) || 0, 0);
  let cursorKeyset = null;
  if (params.cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(String(params.cursor), "base64").toString("utf8"));
      if (parsed?.latest_message_at && parsed?.thread_key) cursorKeyset = parsed;
    } catch { /* offset fallback */ }
  }

  let q = supabase.from(HYDRATED_INBOX_SOURCE).select("*", { count: "exact" });
  q = applyHydratedInboxFilters(q, { ...filters, q: params.q, inbox_bucket: params.filter || params.inbox_bucket });

  if (typeof q.order === "function") {
    q = q.order("latest_message_at", { ascending: false, nullsFirst: false });
    q = q.order("thread_key", { ascending: false });
  }

  if (cursorKeyset && typeof q.or === "function") {
    q = q.or(`latest_message_at.lt.${cursorKeyset.latest_message_at},and(latest_message_at.eq.${cursorKeyset.latest_message_at},thread_key.lt.${cursorKeyset.thread_key})`);
    q = typeof q.limit === "function" ? q.limit(limit + 1) : q;
  } else if (typeof q.range === "function") {
    q = q.range(offset, offset + limit);
  }

  const result = await q;
  if (result.error) throw result.error;
  const rows = result.data || [];
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  return {
    data: pageRows,
    count: result.count ?? pageRows.length,
    hasMore,
    sourceConfig: { name: HYDRATED_INBOX_SOURCE, key: "hydrated" },
  };
}

export async function queryInboxFilterOptions({ field, filters = {}, limit = 250 } = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase;
  const column = resolveOptionsColumn(field) || resolveFilterColumn(field) || field;

  if (field === "property_flags" || field === "propertyFlags") {
    return queryFlagOptions(supabase, "property_flags_text", filters, limit);
  }
  if (field === "person_flags" || field === "personFlags") {
    return queryFlagOptions(supabase, "person_flags_text", filters, limit);
  }

  let q = supabase.from(HYDRATED_INBOX_SOURCE).select(column).not(column, "is", null).neq(column, "").limit(8000);
  q = applyHydratedInboxFilters(q, filters);
  const { data, error } = await q;
  if (error) throw error;

  const counts = new Map();
  for (const row of data || []) {
    const val = clean(row[column]);
    if (!val) continue;
    counts.set(val, (counts.get(val) || 0) + 1);
  }
  const options = [...counts.entries()]
    .map(([value, count]) => ({ value, label: value, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);

  return { field, column, options, totalDistinct: counts.size };
}

async function queryFlagOptions(supabase, column, filters, limit) {
  let q = supabase.from(HYDRATED_INBOX_SOURCE).select(column).not(column, "is", null).neq(column, "").limit(8000);
  q = applyHydratedInboxFilters(q, filters);
  const { data, error } = await q;
  if (error) throw error;
  const counts = new Map();
  for (const row of data || []) {
    for (const flag of parseFlags(row[column])) {
      counts.set(flag, (counts.get(flag) || 0) + 1);
    }
  }
  const options = [...counts.entries()]
    .map(([value, count]) => ({ value, label: value, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
  return { field: column, column, options, totalDistinct: counts.size };
}

export { getInboxFilterCatalog, hasActiveAdvancedFilters, parseAdvancedFiltersParam, HYDRATED_INBOX_SOURCE };