import { buildInboxFilterConditions } from "../inbox/inbox-filter-conditions.js";
import { createEmptyExpressionRoot } from "./map-filter-expression.js";

/** Inbox filter keys compiled via direct map registry rules (not inbox_hydrated_scope). */
const DIRECT_HANDLED_KEYS = new Set([
  "market", "city", "state", "zip", "county", "marketRegion", "addressSearch",
  "propertyType", "propertyClass", "propertyCondition", "buildingCondition",
  "unitsMin", "unitsMax", "bedsMin", "bedsMax", "bathsMin", "bathsMax",
  "sqftMin", "sqftMax", "lotSqftMin", "lotSqftMax", "lotAcreageMin", "lotAcreageMax",
  "yearBuiltMin", "yearBuiltMax", "effectiveYearBuiltMin", "effectiveYearBuiltMax",
  "ownershipYearsMin", "ownershipYearsMax",
  "lastSaleDateFrom", "lastSaleDateTo", "lastSalePriceMin", "lastSalePriceMax",
  "assessedValueMin", "assessedValueMax", "estimatedValueMin", "estimatedValueMax",
  "arvMin", "arvMax", "cashOfferMin", "cashOfferMax",
  "equityAmountMin", "equityAmountMax", "equityPercentMin", "equityPercentMax",
  "totalLoanAmtMin", "totalLoanAmtMax", "mortgageBalanceMin", "mortgageBalanceMax",
  "loanPaymentMin", "loanPaymentMax", "taxAmtMin", "taxAmtMax", "repairCostMin", "repairCostMax",
  "aiScoreMin", "aiScoreMax", "finalAcquisitionScoreMin", "finalAcquisitionScoreMax",
  "dealStrengthScoreMin", "dealStrengthScoreMax", "priorityScoreMin", "priorityScoreMax",
  "motivationMin", "motivationMax", "distressScoreMin", "distressScoreMax",
  "buildingQuality", "rehabLevel", "constructionType", "zoning",
  "taxDelinquent", "activeLien", "highEquity", "freeAndClear", "lowEquity", "underwater",
  "propertyFlagsAny", "propertyFlagsAll", "propertyFlagsExclude",
  "ownerName", "ownerNameSearch", "ownerType", "corporateOwner", "absenteeOwner",
  "outOfStateOwner", "corporateMatch", "multiplePropertiesOwned",
  "contactabilityScoreMin", "financialPressureScoreMin", "urgencyScoreMin", "ownerPriorityScoreMin",
  "ownerPriorityTier", "priorityTier",
  "portfolioValueMin", "portfolioEquityMin", "portfolioLoanBalanceMin", "portfolioUnitsMin",
  "propertyCountMin", "taxDelinquentCountMin", "activeLienCountMin",
  "likelyOwner", "likelyRenting", "smsEligible", "emailEligible", "language",
  "personFlagsAny", "personFlagsAll", "personFlagsExclude",
  "hasPhone", "hasEmail", "primaryProspect", "prospectHasPhone", "prospectHasEmail",
  "prospectContactScoreMin", "prospectPhoneScoreMin",
  "phoneCarrier", "contactWindow", "emailScoreMin",
]);

const isActive = (v) => {
  if (v === undefined || v === null || v === "") return false;
  if (v === "all") return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
};

function newId(prefix = "node") {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function rule(fieldKey, operator, value, relationshipMatch) {
  return {
    id: newId("rule"),
    type: "rule",
    fieldKey,
    operator,
    value,
    enabled: true,
    ...(relationshipMatch ? { relationshipMatch } : {}),
  };
}

function group(combinator, children) {
  return {
    id: newId("group"),
    type: "group",
    combinator,
    negated: false,
    enabled: true,
    children: children.filter(Boolean),
  };
}

function triToRule(fieldKey, operator, value, relationshipMatch) {
  if (!value || value === "") return null;
  if (value === "no" || value === false) {
    if (operator === "is_true") return rule(fieldKey, "is_false", true, relationshipMatch);
    if (operator === "has_data") return rule(fieldKey, "has_no_data", true, relationshipMatch);
    return rule(fieldKey, "is_false", true, relationshipMatch);
  }
  if (value === "yes" || value === true) {
    return rule(fieldKey, operator, true, relationshipMatch);
  }
  return null;
}

function buildContactStatusRules(mapStatus) {
  if (!mapStatus || mapStatus === "all") return [];
  if (mapStatus === "uncontacted") {
    return [
      group("OR", [
        rule("property.contact_status", "is_any_of", ["uncontacted", "not_contacted", ""]),
        rule("property.contact_status", "is_blank", true),
      ]),
    ];
  }
  const exclude = group("OR", [
    rule("property.contact_status", "is_any_of", ["uncontacted", "not_contacted", ""]),
  ]);
  exclude.negated = true;
  return [
    group("AND", [
      rule("property.contact_status", "is_not_blank", true),
      exclude,
    ]),
  ];
}

function normalizeInboxPayload(raw = {}) {
  const filters = { ...raw };
  if (raw.outOfStateOwner === "yes") filters.absenteeOwner = true;
  if (raw.outOfStateOwner === "no") filters.absenteeOwner = false;
  if (raw.corporateMatch === "yes") filters.corporateOwner = true;
  if (raw.corporateMatch === "no") filters.corporateOwner = false;
  if (raw.corporateOwner === "yes" || raw.corporateOwner === true) filters.corporateOwner = true;
  if (raw.corporateOwner === "no" || raw.corporateOwner === false) filters.corporateOwner = false;
  if (raw.absenteeOwner === "yes" || raw.absenteeOwner === true) filters.absenteeOwner = true;
  if (raw.absenteeOwner === "no" || raw.absenteeOwner === false) filters.absenteeOwner = false;
  if (raw.buildingCondition) filters.buildingCondition = raw.buildingCondition;
  if (raw.propertyCondition) filters.propertyCondition = raw.propertyCondition;
  if (raw.county) filters.county = raw.county;
  if (raw.marketRegion) filters.marketRegion = raw.marketRegion;
  if (raw.propertyCountMin != null) filters.propertyCountMin = raw.propertyCountMin;
  if (raw.buildingQuality) filters.buildingQuality = raw.buildingQuality;
  if (raw.rehabLevel) filters.rehabLevel = raw.rehabLevel;
  if (raw.constructionType) filters.constructionType = raw.constructionType;
  if (raw.prospectAgeMin != null) filters.prospectAgeMin = raw.prospectAgeMin;
  if (raw.likelyOwner != null) filters.likelyOwner = raw.likelyOwner;
  if (raw.likelyRenting != null) filters.likelyRenting = raw.likelyRenting;
  if (raw.emailEligible != null) filters.emailEligible = raw.emailEligible;
  if (raw.hasEmail != null) filters.hasEmail = raw.hasEmail;
  if (raw.phoneCarrier) filters.phoneCarrier = raw.phoneCarrier;
  if (raw.contactWindow) filters.contactWindow = raw.contactWindow;
  if (raw.lastMessageDirection === "inbound") filters.direction = "inbound";
  if (raw.lastMessageDirection === "outbound") filters.direction = "outbound";
  if (raw.hasSellerReply === "yes") filters.hasSellerReply = true;
  if (raw.hasSellerReply === "no") filters.hasSellerReply = false;
  if (raw.highEquity === true && !filters.equityPercentMin) filters.equityPercentMin = 40;
  if (raw.suppressionReason) filters.isSuppressed = true;
  if (raw.ownerNameSearch) filters.ownerName = raw.ownerNameSearch;
  if (raw.phoneNumberSearch) filters.phoneNumber = raw.phoneNumberSearch;
  if (raw.inboxStatus) filters.status = raw.inboxStatus;
  if (raw.latestIntent) filters.intent = raw.latestIntent;
  if (raw.sellerStage) filters.stage = raw.sellerStage;
  return filters;
}

function buildDirectMapRules(filters) {
  const rules = [];
  const pr = (key, op, val, rel) => rules.push(rule(key, op, val, rel));
  const gte = (key, val, rel) => { if (isActive(val)) pr(key, "greater_than_or_equal", val, rel); };
  const lte = (key, val, rel) => { if (isActive(val)) pr(key, "less_than_or_equal", val, rel); };
  const eq = (key, val, rel) => {
    if (!isActive(val)) return;
    if (Array.isArray(val)) {
      const items = val.map((item) => String(item ?? "").trim()).filter(Boolean);
      if (!items.length) return;
      if (items.length === 1) pr(key, "equals", items[0], rel);
      else pr(key, "is_any_of", items, rel);
      return;
    }
    pr(key, "equals", val, rel);
  };
  const contains = (key, val, rel) => { if (isActive(val)) pr(key, "contains", val, rel); };

  eq("property.market", filters.market);
  contains("property.property_address_city", filters.city);
  eq("property.property_address_state", filters.state);
  contains("property.property_address_zip", filters.zip);
  eq("property.property_address_county_name", filters.county);
  eq("property.market_region", filters.marketRegion);
  contains("property.property_address_full", filters.addressSearch);
  eq("property.property_type", filters.propertyType);
  eq("property.property_class", filters.propertyClass);

  gte("property.units_count", filters.unitsMin);
  lte("property.units_count", filters.unitsMax);
  gte("property.total_bedrooms", filters.bedsMin);
  lte("property.total_bedrooms", filters.bedsMax);
  gte("property.total_baths", filters.bathsMin);
  lte("property.total_baths", filters.bathsMax);
  gte("property.building_square_feet", filters.sqftMin);
  lte("property.building_square_feet", filters.sqftMax);
  gte("property.lot_square_feet", filters.lotSqftMin);
  gte("property.lot_acreage", filters.lotAcreageMin);
  gte("property.year_built", filters.yearBuiltMin);
  lte("property.year_built", filters.yearBuiltMax);
  gte("property.effective_year_built", filters.effectiveYearBuiltMin);
  gte("property.ownership_years", filters.ownershipYearsMin);
  lte("property.ownership_years", filters.ownershipYearsMax);

  if (isActive(filters.lastSaleDateFrom)) pr("property.sale_date", "after", filters.lastSaleDateFrom);
  if (isActive(filters.lastSaleDateTo)) pr("property.sale_date", "before", filters.lastSaleDateTo);
  gte("property.sale_price", filters.lastSalePriceMin);
  gte("property.assd_total_value", filters.assessedValueMin);
  gte("property.estimated_value", filters.estimatedValueMin);
  lte("property.estimated_value", filters.estimatedValueMax);
  gte("property.calculated_total_value", filters.arvMin);
  gte("property.cash_offer", filters.cashOfferMin);

  gte("property.equity_amount", filters.equityAmountMin);
  lte("property.equity_amount", filters.equityAmountMax);
  gte("property.equity_percent", filters.equityPercentMin);
  lte("property.equity_percent", filters.equityPercentMax);
  gte("property.total_loan_balance", filters.mortgageBalanceMin);
  lte("property.total_loan_balance", filters.mortgageBalanceMax);
  gte("property.total_loan_balance", filters.totalLoanAmtMin);
  gte("property.total_loan_payment", filters.loanPaymentMin);
  gte("property.tax_amt", filters.taxAmtMin);
  gte("property.estimated_repair_cost", filters.repairCostMin);

  gte("property.ai_score", filters.aiScoreMin);
  gte("property.final_acquisition_score", filters.finalAcquisitionScoreMin);
  gte("property.deal_strength_score", filters.dealStrengthScoreMin);
  lte("property.deal_strength_score", filters.dealStrengthScoreMax);
  gte("property.structured_motivation_score", filters.motivationMin);
  lte("property.structured_motivation_score", filters.motivationMax);
  gte("property.tag_distress_score", filters.distressScoreMin);
  lte("property.tag_distress_score", filters.distressScoreMax);
  gte("master_owner.priority_score", filters.priorityScoreMin);
  lte("master_owner.priority_score", filters.priorityScoreMax);
  lte("property.ai_score", filters.aiScoreMax);
  lte("property.final_acquisition_score", filters.finalAcquisitionScoreMax);
  lte("property.equity_amount", filters.equityAmountMax);
  lte("property.total_loan_balance", filters.totalLoanAmtMax);
  lte("property.total_loan_payment", filters.loanPaymentMax);
  lte("property.tax_amt", filters.taxAmtMax);
  lte("property.estimated_repair_cost", filters.repairCostMax);
  lte("property.sale_price", filters.lastSalePriceMax);
  lte("property.assd_total_value", filters.assessedValueMax);
  lte("property.calculated_total_value", filters.arvMax);
  lte("property.cash_offer", filters.cashOfferMax);
  lte("property.lot_square_feet", filters.lotSqftMax);
  lte("property.lot_acreage", filters.lotAcreageMax);
  lte("property.effective_year_built", filters.effectiveYearBuiltMax);

  eq("property.building_condition", filters.buildingCondition || filters.propertyCondition);
  eq("property.building_quality", filters.buildingQuality);
  eq("property.rehab_level", filters.rehabLevel);
  eq("property.construction_type", filters.constructionType);
  eq("property.zoning", filters.zoning);

  const taxRule = triToRule("property.tax_delinquent", "is_true", filters.taxDelinquent);
  if (taxRule) rules.push(taxRule);
  const lienRule = triToRule("property.active_lien", "is_true", filters.activeLien);
  if (lienRule) rules.push(lienRule);

  if (filters.freeAndClear) pr("property.equity_percent", "greater_than_or_equal", 95);
  if (filters.lowEquity) pr("property.equity_percent", "less_than_or_equal", 20);
  if (filters.underwater) pr("property.equity_percent", "less_than", 0);

  if (Array.isArray(filters.propertyFlagsAny) && filters.propertyFlagsAny.length) {
    pr("property.property_flags_json", "contains_any", filters.propertyFlagsAny);
  }
  if (Array.isArray(filters.propertyFlagsAll) && filters.propertyFlagsAll.length) {
    pr("property.property_flags_json", "contains_all", filters.propertyFlagsAll);
  }
  if (Array.isArray(filters.propertyFlagsExclude) && filters.propertyFlagsExclude.length) {
    pr("property.property_flags_json", "contains_none", filters.propertyFlagsExclude);
  }

  contains("master_owner.display_name", filters.ownerName);
  eq("master_owner.owner_type_guess", filters.ownerType);
  const corpRule = triToRule("property.is_corporate_owner", "is_true", filters.corporateOwner);
  if (corpRule) rules.push(corpRule);
  const absenteeRule = triToRule("property.out_of_state_owner", "is_true", filters.absenteeOwner);
  if (absenteeRule) rules.push(absenteeRule);

  gte("master_owner.contactability_score", filters.contactabilityScoreMin);
  gte("master_owner.financial_pressure_score", filters.financialPressureScoreMin);
  gte("master_owner.urgency_score", filters.urgencyScoreMin);
  gte("master_owner.priority_score", filters.ownerPriorityScoreMin);
  eq("master_owner.priority_tier", filters.ownerPriorityTier || filters.priorityTier);
  gte("master_owner.portfolio_total_value", filters.portfolioValueMin);
  gte("master_owner.portfolio_total_equity", filters.portfolioEquityMin);
  gte("master_owner.portfolio_total_loan_balance", filters.portfolioLoanBalanceMin);
  gte("master_owner.portfolio_total_units", filters.portfolioUnitsMin);
  gte("master_owner.property_count", filters.propertyCountMin);
  gte("master_owner.tax_delinquent_count", filters.taxDelinquentCountMin);
  gte("master_owner.active_lien_count", filters.activeLienCountMin);

  const likelyOwner = triToRule("prospect.likely_owner", "is_true", filters.likelyOwner, "any_linked");
  if (likelyOwner) rules.push(likelyOwner);
  const likelyRent = triToRule("prospect.likely_renting", "is_true", filters.likelyRenting, "any_linked");
  if (likelyRent) rules.push(likelyRent);
  const smsRule = triToRule("prospect.sms_eligible", "is_true", filters.smsEligible, "any_linked");
  if (smsRule) rules.push(smsRule);
  const emailElig = triToRule("prospect.email_eligible", "is_true", filters.emailEligible, "any_linked");
  if (emailElig) rules.push(emailElig);
  eq("prospect.best_language", filters.language, "any_linked");
  gte("prospect.contact_score_final", filters.prospectContactScoreMin, "any_linked");
  gte("prospect.phone_score_final", filters.prospectPhoneScoreMin, "any_linked");
  gte("prospect.email_score_final", filters.emailScoreMin, "any_linked");

  if (Array.isArray(filters.personFlagsAny) && filters.personFlagsAny.length) {
    pr("prospect.person_flags_json", "contains_any", filters.personFlagsAny, "any_linked");
  }
  if (Array.isArray(filters.personFlagsAll) && filters.personFlagsAll.length) {
    pr("prospect.person_flags_json", "contains_all", filters.personFlagsAll, "any_linked");
  }
  if (Array.isArray(filters.personFlagsExclude) && filters.personFlagsExclude.length) {
    pr("prospect.person_flags_json", "contains_none", filters.personFlagsExclude, "any_linked");
  }

  const hasPhone = triToRule("prospect.has_phone", "has_data", filters.hasPhone, "any_linked");
  if (hasPhone) rules.push(hasPhone);
  const hasEmail = triToRule("prospect.has_email", "has_data", filters.hasEmail, "any_linked");
  if (hasEmail) rules.push(hasEmail);
  const primary = triToRule("prospect.is_primary_prospect", "is_true", filters.primaryProspect, "any_linked");
  if (primary) rules.push(primary);

  eq("phone.phone_owner", filters.phoneCarrier, "any_linked");
  eq("phone.contact_window", filters.contactWindow, "any_linked");

  return rules;
}

function pickInboxScopePayload(filters) {
  const out = {};
  for (const [key, value] of Object.entries(filters)) {
    if (!isActive(value)) continue;
    if (key === "mapStatus") continue;
    if (DIRECT_HANDLED_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function hasInboxScopeFilters(filters) {
  return Object.keys(pickInboxScopePayload(filters)).length > 0;
}

/**
 * @param {Record<string, unknown>} serializedInboxFilters
 * @param {{ mapStatus?: string }} [options]
 */
export function buildMapFilterExpressionFromInboxFilters(serializedInboxFilters = {}, options = {}) {
  const filters = normalizeInboxPayload(serializedInboxFilters);
  const mapStatus = options.mapStatus || filters.mapStatus || "all";

  const children = [
    ...buildContactStatusRules(mapStatus),
    ...buildDirectMapRules(filters),
  ];

  const scopePayload = pickInboxScopePayload(filters);
  if (hasInboxScopeFilters(scopePayload)) {
    const conditions = buildInboxFilterConditions(scopePayload);
    if (conditions.length > 0) {
      children.push(rule("property.inbox_hydrated_scope", "matches_conditions", conditions));
    }
  }

  if (!children.length) return createEmptyExpressionRoot();
  if (children.length === 1 && children[0].type === "group") return children[0];
  return group("AND", children);
}

export function countMappableInboxFilterKeys(serialized = {}) {
  const filters = normalizeInboxPayload(serialized);
  let count = 0;
  for (const [key, value] of Object.entries(filters)) {
    if (isActive(value)) count += 1;
  }
  if (serialized.mapStatus && serialized.mapStatus !== "all") count += 1;
  return count;
}