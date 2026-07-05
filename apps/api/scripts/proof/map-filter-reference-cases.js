/** PR2 gate — locked accounting case definitions (expression + metadata). */

function rule(id, fieldKey, operator, value, extra = {}) {
  return { id, type: "rule", fieldKey, operator, value, enabled: true, ...extra };
}

function group(id, combinator, children, extra = {}) {
  return { id, type: "group", combinator, negated: false, enabled: true, children, ...extra };
}

export const EMPTY_EXPRESSION = {
  id: "root",
  type: "group",
  combinator: "AND",
  negated: false,
  enabled: true,
  children: [],
};

export const MAP_FILTER_ACCOUNTING_CASES = [
  { id: "no_filter", label: "No filter", expression: EMPTY_EXPRESSION },
  { id: "sfr", label: "SFR", expression: group("c", "AND", [rule("r", "property.property_type", "equals", "SFR")]) },
  { id: "multifamily_2_4", label: "Multifamily 2-4", expression: group("c", "AND", [rule("r", "property.property_type", "equals", "Multifamily 2-4")]) },
  { id: "multifamily_5_plus", label: "Multifamily 5+", expression: group("c", "AND", [rule("r", "property.property_type", "equals", "Multifamily 5+")]) },
  { id: "commercial", label: "Commercial", expression: group("c", "AND", [rule("r", "property.property_type", "equals", "Commercial")]) },
  { id: "storage_units", label: "Storage Units", expression: group("c", "AND", [rule("r", "property.property_type", "equals", "Storage Units")]) },
  { id: "strip_malls", label: "Strip Malls", expression: group("c", "AND", [rule("r", "property.property_type", "equals", "Strip Malls")]) },
  { id: "land", label: "Land", expression: group("c", "AND", [rule("r", "property.property_type", "equals", "Land")]) },
  { id: "mobile_home_parks", label: "Mobile Home Parks", expression: group("c", "AND", [rule("r", "property.property_type", "equals", "Mobile Home Parks")]) },
  { id: "industrial", label: "Industrial", expression: group("c", "AND", [rule("r", "property.property_type", "equals", "Industrial")]) },
  { id: "equity_50_plus", label: "Equity >= 50%", expression: group("c", "AND", [rule("r", "property.equity_percent", "greater_than_or_equal", 50)]) },
  { id: "tax_delinquent", label: "Tax delinquent", expression: group("c", "AND", [rule("r", "property.tax_delinquent", "is_true", true)]) },
  { id: "active_lien", label: "Active lien", expression: group("c", "AND", [rule("r", "property.active_lien", "is_true", true)]) },
  { id: "out_of_state_owner", label: "Out-of-state owner", expression: group("c", "AND", [rule("r", "property.out_of_state_owner", "is_true", true)]) },
  { id: "prospect_sms_eligible", label: "Prospect SMS eligible", expression: group("c", "AND", [rule("r", "prospect.sms_eligible", "is_true", true)]) },
  { id: "prospect_primary", label: "Prospect primary", expression: group("c", "AND", [rule("r", "prospect.is_primary_prospect", "is_true", true, { relationshipMatch: "primary_only" })]) },
  { id: "owner_tier_1", label: "Owner TIER_1", expression: group("c", "AND", [rule("r", "master_owner.priority_tier", "equals", "TIER_1")]) },
  { id: "owner_property_count_5", label: "Owner property count >= 5", expression: group("c", "AND", [rule("r", "master_owner.property_count", "greater_than_or_equal", 5)]) },
  { id: "owner_portfolio_units_20", label: "Owner portfolio units >= 20", expression: group("c", "AND", [rule("r", "master_owner.portfolio_total_units", "greater_than_or_equal", 20)]) },
  {
    id: "property_prospect_mixed",
    label: "Property + Prospect",
    expression: group("c", "AND", [
      rule("p", "property.property_type", "equals", "SFR"),
      rule("pr", "prospect.sms_eligible", "is_true", true),
    ]),
  },
  {
    id: "property_owner_mixed",
    label: "Property + Master Owner",
    expression: group("c", "AND", [
      rule("p", "property.equity_percent", "greater_than_or_equal", 50),
      rule("o", "master_owner.property_count", "greater_than_or_equal", 3),
    ]),
  },
  {
    id: "nested_mixed_or",
    label: "Nested mixed-entity OR",
    expression: group("root", "AND", [
      group("or1", "OR", [
        rule("mf", "property.property_type", "equals", "Multifamily 5+"),
        rule("sms", "prospect.sms_eligible", "is_true", true),
      ]),
      group("or2", "OR", [
        rule("pc", "master_owner.property_count", "greater_than_or_equal", 5),
        rule("eq", "property.equity_percent", "greater_than_or_equal", 70),
      ]),
    ]),
  },
  {
    id: "negated_relationship",
    label: "Negated relationship",
    expression: group("root", "AND", [
      group("neg", "OR", [rule("r", "prospect.sms_eligible", "is_true", true, { relationshipMatch: "none_linked" })], { negated: true }),
    ]),
  },
  { id: "rel_any_linked", label: "ANY_LINKED", expression: group("c", "AND", [rule("r", "prospect.sms_eligible", "is_true", true, { relationshipMatch: "any_linked" })]) },
  { id: "rel_primary_only", label: "PRIMARY_ONLY", expression: group("c", "AND", [rule("r", "prospect.sms_eligible", "is_true", true, { relationshipMatch: "primary_only" })]) },
  { id: "rel_none_linked", label: "NONE_LINKED", expression: group("c", "AND", [rule("r", "prospect.sms_eligible", "is_true", true, { relationshipMatch: "none_linked" })]) },
  { id: "rel_all_linked", label: "ALL_LINKED", expression: group("c", "AND", [rule("r", "prospect.sms_eligible", "is_true", true, { relationshipMatch: "all_linked" })]) },
];

export const QUERY_PLAN_CASES = [
  { id: "plan_property_type", expression: group("c", "AND", [rule("r", "property.property_type", "equals", "SFR")]) },
  { id: "plan_equity_range", expression: group("c", "AND", [rule("r", "property.equity_percent", "between", [40, 80])]) },
  { id: "plan_prospect_sms", expression: group("c", "AND", [rule("r", "prospect.sms_eligible", "is_true", true)]) },
  { id: "plan_owner_count", expression: group("c", "AND", [rule("r", "master_owner.property_count", "greater_than_or_equal", 5)]) },
  {
    id: "plan_property_prospect",
    expression: group("c", "AND", [
      rule("p", "property.property_type", "equals", "Multifamily 2-4"),
      rule("pr", "prospect.sms_eligible", "is_true", true),
    ]),
  },
  {
    id: "plan_property_owner",
    expression: group("c", "AND", [
      rule("p", "property.equity_percent", "greater_than_or_equal", 50),
      rule("o", "master_owner.property_count", "greater_than_or_equal", 5),
    ]),
  },
  { id: "plan_nested_or", expression: MAP_FILTER_ACCOUNTING_CASES.find((c) => c.id === "nested_mixed_or").expression },
  {
    id: "plan_bounds_cross_entity",
    expression: group("c", "AND", [
      rule("p", "property.market", "equals", "TAMPA"),
      rule("pr", "prospect.sms_eligible", "is_true", true),
    ]),
    bounds: { lat_min: 27.8, lat_max: 28.2, lng_min: -82.6, lng_max: -82.2 },
  },
];