/** @typedef {'eq'|'neq'|'contains'|'gte'|'lte'|'between'|'empty'|'not_empty'|'any'|'all'|'exclude'} FilterOp */

export const HYDRATED_INBOX_SOURCE = "inbox_command_center_v";

export const INBOX_FILTER_GROUPS = [
  { id: "conversation", label: "Inbox & Conversation", icon: "inbox" },
  { id: "property", label: "Property", icon: "home" },
  { id: "financials", label: "Financials", icon: "dollar" },
  { id: "condition", label: "Condition", icon: "tool" },
  { id: "distress", label: "Distress & Flags", icon: "alert" },
  { id: "prospect", label: "Prospect", icon: "user" },
  { id: "owner", label: "Owner & Portfolio", icon: "briefcase" },
  { id: "phone", label: "Phone & Delivery", icon: "phone" },
  { id: "email", label: "Email & Eligibility", icon: "mail" },
];

export const INBOX_FILTER_FIELDS = [
  // Conversation
  { key: "inboxCategory", group: "conversation", label: "Inbox Category", type: "select", column: "inbox_category", optionsKey: "inbox_categories" },
  { key: "stage", group: "conversation", label: "Stage", type: "select", column: "stage", optionsKey: "stages" },
  { key: "status", group: "conversation", label: "Universal Status", type: "select", column: "status", optionsKey: "statuses" },
  { key: "intent", group: "conversation", label: "Detected Intent", type: "select", column: "ui_intent", optionsKey: "intents" },
  { key: "leadTemperature", group: "conversation", label: "Lead Temperature", type: "select", column: "priority_bucket", optionsKey: "temperatures" },
  { key: "isRead", group: "conversation", label: "Read Status", type: "tri", column: "is_read" },
  { key: "isStarred", group: "conversation", label: "Starred", type: "tri", column: "is_starred" },
  { key: "isPinned", group: "conversation", label: "Pinned", type: "tri", column: "is_pinned" },
  { key: "isArchived", group: "conversation", label: "Archived", type: "tri", column: "is_archived" },
  { key: "isSuppressed", group: "conversation", label: "Suppressed", type: "tri", column: "is_suppressed" },
  { key: "direction", group: "conversation", label: "Latest Direction", type: "select", column: "latest_direction", optionsKey: "directions" },
  { key: "deliveryStatus", group: "conversation", label: "Delivery Status", type: "select", column: "latest_delivery_status", optionsKey: "delivery_statuses" },
  { key: "automationStatus", group: "conversation", label: "Automation Status", type: "select", column: "automation_status", optionsKey: "automation_statuses" },
  { key: "messageCountMin", group: "conversation", label: "Message Count", type: "numberRange", column: "message_count" },
  { key: "inboundCountMin", group: "conversation", label: "Inbound Count", type: "numberRange", column: "inbound_count" },
  { key: "outboundCountMin", group: "conversation", label: "Outbound Count", type: "numberRange", column: "outbound_count" },
  { key: "activityDateFrom", group: "conversation", label: "Last Activity", type: "dateRange", column: "latest_message_at" },
  { key: "lastInboundDateFrom", group: "conversation", label: "Last Inbound", type: "dateRange", column: "last_inbound_at" },
  { key: "lastOutboundDateFrom", group: "conversation", label: "Last Outbound", type: "dateRange", column: "last_outbound_at" },
  { key: "followUpAtFrom", group: "conversation", label: "Follow-Up Date", type: "dateRange", column: "follow_up_at" },
  { key: "hasSellerReply", group: "conversation", label: "Has Replied", type: "tri", column: "inbound_count", derived: "gt0" },

  // Property
  { key: "addressSearch", group: "property", label: "Address Search", type: "text", columns: ["property_address_full", "event_property_address", "city"] },
  { key: "city", group: "property", label: "City", type: "select", column: "city", optionsKey: "cities" },
  { key: "state", group: "property", label: "State", type: "select", column: "state", optionsKey: "states" },
  { key: "zip", group: "property", label: "ZIP", type: "text", column: "zip" },
  { key: "county", group: "property", label: "County", type: "select", column: "property_county_name", optionsKey: "counties" },
  { key: "market", group: "property", label: "Market", type: "select", column: "market", optionsKey: "markets" },
  { key: "marketRegion", group: "property", label: "Market Region", type: "select", column: "market_region", optionsKey: "market_regions" },
  { key: "propertyType", group: "property", label: "Property Type", type: "select", column: "property_type", optionsKey: "property_types" },
  { key: "propertyClass", group: "property", label: "Property Class", type: "select", column: "property_class", optionsKey: "property_classes" },
  { key: "unitsMin", group: "property", label: "Units", type: "numberRange", column: "units_count" },
  { key: "bedsMin", group: "property", label: "Bedrooms", type: "numberRange", column: "total_bedrooms" },
  { key: "bathsMin", group: "property", label: "Bathrooms", type: "numberRange", column: "total_baths" },
  { key: "sqftMin", group: "property", label: "Building Sq Ft", type: "numberRange", column: "building_square_feet" },
  { key: "lotSqftMin", group: "property", label: "Lot Sq Ft", type: "numberRange", column: "lot_square_feet" },
  { key: "lotAcreageMin", group: "property", label: "Lot Acreage", type: "numberRange", column: "lot_acreage" },
  { key: "yearBuiltMin", group: "property", label: "Year Built", type: "numberRange", column: "year_built" },
  { key: "effectiveYearBuiltMin", group: "property", label: "Effective Year Built", type: "numberRange", column: "effective_year_built" },
  { key: "ownershipYearsMin", group: "property", label: "Ownership Years", type: "numberRange", column: "ownership_years" },
  { key: "lastSaleDateFrom", group: "property", label: "Last Sale Date", type: "dateRange", column: "sale_date" },
  { key: "lastSalePriceMin", group: "property", label: "Last Sale Price", type: "numberRange", column: "sale_price" },
  { key: "assessedValueMin", group: "property", label: "Assessed Value", type: "numberRange", column: "assd_total_value" },
  { key: "estimatedValueMin", group: "property", label: "Estimated Value", type: "numberRange", column: "estimated_value" },
  { key: "arvMin", group: "property", label: "ARV", type: "numberRange", column: "calculated_total_value" },
  { key: "cashOfferMin", group: "property", label: "Cash Offer", type: "numberRange", column: "cash_offer" },

  // Financials
  { key: "equityAmountMin", group: "financials", label: "Equity Amount", type: "numberRange", column: "equity_amount" },
  { key: "equityPercentMin", group: "financials", label: "Equity %", type: "numberRange", column: "equity_percent" },
  { key: "totalLoanAmtMin", group: "financials", label: "Total Loan Amount", type: "numberRange", column: "total_loan_amt" },
  { key: "mortgageBalanceMin", group: "financials", label: "Loan Balance", type: "numberRange", column: "total_loan_balance" },
  { key: "loanPaymentMin", group: "financials", label: "Loan Payment", type: "numberRange", column: "total_loan_payment" },
  { key: "taxAmtMin", group: "financials", label: "Tax Amount", type: "numberRange", column: "tax_amt" },
  { key: "pastDueAmountMin", group: "financials", label: "Past Due Amount", type: "numberRange", column: "past_due_amount" },
  { key: "repairCostMin", group: "financials", label: "Estimated Repair Cost", type: "numberRange", column: "estimated_repair_cost" },
  { key: "aiScoreMin", group: "financials", label: "AI Score", type: "numberRange", column: "ai_score" },
  { key: "finalAcquisitionScoreMin", group: "financials", label: "Final Acquisition Score", type: "numberRange", column: "final_acquisition_score" },
  { key: "dealStrengthScoreMin", group: "financials", label: "Deal Strength Score", type: "numberRange", column: "deal_strength_score" },
  { key: "priorityScoreMin", group: "financials", label: "Priority Score", type: "numberRange", column: "priority_score" },

  // Condition
  { key: "buildingCondition", group: "condition", label: "Building Condition", type: "select", column: "building_condition", optionsKey: "building_conditions" },
  { key: "buildingQuality", group: "condition", label: "Building Quality", type: "select", column: "building_quality", optionsKey: "building_qualities" },
  { key: "rehabLevel", group: "condition", label: "Rehab Level", type: "select", column: "rehab_level", optionsKey: "rehab_levels" },
  { key: "constructionType", group: "condition", label: "Construction Type", type: "select", column: "construction_type", optionsKey: "construction_types" },
  { key: "style", group: "condition", label: "Style", type: "select", column: "style", optionsKey: "styles" },
  { key: "storiesMin", group: "condition", label: "Stories", type: "numberRange", column: "stories" },
  { key: "basement", group: "condition", label: "Basement", type: "select", column: "basement", optionsKey: "basements" },
  { key: "garage", group: "condition", label: "Garage", type: "select", column: "garage", optionsKey: "garages" },
  { key: "airConditioning", group: "condition", label: "Air Conditioning", type: "select", column: "air_conditioning", optionsKey: "air_conditionings" },
  { key: "heatingType", group: "condition", label: "Heating Type", type: "select", column: "heating_type", optionsKey: "heating_types" },
  { key: "roofType", group: "condition", label: "Roof Type", type: "select", column: "roof_type", optionsKey: "roof_types" },
  { key: "pool", group: "condition", label: "Pool", type: "select", column: "pool", optionsKey: "pools" },
  { key: "zoning", group: "condition", label: "Zoning", type: "select", column: "zoning", optionsKey: "zonings" },
  { key: "floodZone", group: "condition", label: "Flood Zone", type: "select", column: "flood_zone", optionsKey: "flood_zones" },

  // Distress & flags
  { key: "propertyFlags", group: "distress", label: "Property Flags", type: "flags", columns: ["property_flags_text", "property_flags_json"] },
  { key: "taxDelinquent", group: "distress", label: "Tax Delinquent", type: "tri", column: "property_tax_delinquent" },
  { key: "activeLien", group: "distress", label: "Active Lien", type: "tri", column: "property_active_lien" },

  // Prospect
  { key: "prospectAgeMin", group: "prospect", label: "Prospect Age", type: "numberRange", column: "prospect_age" },
  { key: "gender", group: "prospect", label: "Gender", type: "select", column: "gender", optionsKey: "genders" },
  { key: "maritalStatus", group: "prospect", label: "Marital Status", type: "select", column: "marital_status", optionsKey: "marital_statuses" },
  { key: "education", group: "prospect", label: "Education", type: "select", column: "education_model", optionsKey: "educations" },
  { key: "occupationGroup", group: "prospect", label: "Occupation Group", type: "select", column: "occupation_group", optionsKey: "occupation_groups" },
  { key: "occupation", group: "prospect", label: "Occupation", type: "select", column: "occupation", optionsKey: "occupations" },
  { key: "householdIncome", group: "prospect", label: "Household Income", type: "select", column: "est_household_income", optionsKey: "household_incomes" },
  { key: "netAssetValue", group: "prospect", label: "Net Asset Value", type: "select", column: "net_asset_value", optionsKey: "net_asset_values" },
  { key: "buyingPowerMin", group: "prospect", label: "Buying Power", type: "numberRange", column: "buying_power" },
  { key: "language", group: "prospect", label: "Language", type: "select", column: "best_language", optionsKey: "languages" },
  { key: "likelyOwner", group: "prospect", label: "Likely Owner", type: "tri", column: "likely_owner" },
  { key: "likelyRenting", group: "prospect", label: "Likely Renting", type: "tri", column: "likely_renting" },
  { key: "prospectContactScoreMin", group: "prospect", label: "Contact Score", type: "numberRange", column: "prospect_contact_score" },
  { key: "prospectPhoneScoreMin", group: "prospect", label: "Phone Score", type: "numberRange", column: "prospect_phone_score" },
  { key: "personFlags", group: "prospect", label: "Person Flags", type: "flags", columns: ["person_flags_text", "person_flags_json"] },
  { key: "smsEligible", group: "prospect", label: "SMS Eligible", type: "tri", column: "sms_eligible" },
  { key: "emailEligible", group: "prospect", label: "Email Eligible", type: "tri", column: "email_eligible" },

  // Owner
  { key: "ownerName", group: "owner", label: "Owner Name", type: "text", column: "owner_display_name" },
  { key: "ownerType", group: "owner", label: "Owner Type", type: "select", column: "owner_type_guess", optionsKey: "owner_types" },
  { key: "corporateOwner", group: "owner", label: "Corporate Owner", type: "tri", column: "is_corporate_owner" },
  { key: "absenteeOwner", group: "owner", label: "Absentee Owner", type: "tri", column: "out_of_state_owner" },
  { key: "ownerMailingSearch", group: "owner", label: "Mailing Address", type: "text", column: "primary_owner_address" },
  { key: "contactabilityScoreMin", group: "owner", label: "Contactability Score", type: "numberRange", column: "contactability_score" },
  { key: "financialPressureScoreMin", group: "owner", label: "Financial Pressure", type: "numberRange", column: "financial_pressure_score" },
  { key: "urgencyScoreMin", group: "owner", label: "Urgency Score", type: "numberRange", column: "urgency_score" },
  { key: "ownerPriorityScoreMin", group: "owner", label: "Owner Priority Score", type: "numberRange", column: "owner_priority_score" },
  { key: "ownerPriorityTier", group: "owner", label: "Priority Tier", type: "select", column: "owner_priority_tier", optionsKey: "priority_tiers" },
  { key: "portfolioValueMin", group: "owner", label: "Portfolio Value", type: "numberRange", column: "portfolio_total_value" },
  { key: "portfolioEquityMin", group: "owner", label: "Portfolio Equity", type: "numberRange", column: "portfolio_total_equity" },
  { key: "portfolioLoanBalanceMin", group: "owner", label: "Portfolio Loan Balance", type: "numberRange", column: "portfolio_total_loan_balance" },
  { key: "portfolioUnitsMin", group: "owner", label: "Portfolio Units", type: "numberRange", column: "portfolio_total_units" },
  { key: "propertyCountMin", group: "owner", label: "Property Count", type: "numberRange", column: "property_count" },
  { key: "taxDelinquentCountMin", group: "owner", label: "Tax Delinquent Count", type: "numberRange", column: "tax_delinquent_count" },
  { key: "activeLienCountMin", group: "owner", label: "Active Lien Count", type: "numberRange", column: "active_lien_count" },

  // Phone
  { key: "phoneNumber", group: "phone", label: "Phone Number", type: "text", columns: ["best_phone", "seller_phone"] },
  { key: "phoneCarrier", group: "phone", label: "Phone Carrier", type: "select", column: "phone_carrier", optionsKey: "phone_carriers" },
  { key: "wrongNumber", group: "phone", label: "Wrong Number", type: "tri", column: "ui_intent", matchValue: "wrong_number" },
  { key: "contactWindow", group: "phone", label: "Contact Window", type: "select", column: "best_contact_window", optionsKey: "contact_windows" },
  { key: "pendingQueueCountMin", group: "phone", label: "Pending Queue Count", type: "numberRange", column: "pending_queue_count" },

  // Email
  { key: "hasEmail", group: "email", label: "Has Email", type: "tri", column: "prospect_best_email", derived: "notEmpty" },
  { key: "emailScoreMin", group: "email", label: "Email Score", type: "numberRange", column: "prospect_email_score" },
];

const FIELD_BY_KEY = Object.fromEntries(INBOX_FILTER_FIELDS.map((f) => [f.key, f]));
const FIELD_BY_OPTIONS_KEY = Object.fromEntries(
  INBOX_FILTER_FIELDS.filter((f) => f.optionsKey).map((f) => [f.optionsKey, f.column]),
);

export function getInboxFilterCatalog() {
  return {
    source: HYDRATED_INBOX_SOURCE,
    groups: INBOX_FILTER_GROUPS,
    fields: INBOX_FILTER_FIELDS,
  };
}

export function resolveFilterColumn(fieldKey) {
  const field = FIELD_BY_KEY[fieldKey];
  if (!field) return null;
  if (field.column) return field.column;
  return null;
}

export function resolveOptionsColumn(optionsKey) {
  return FIELD_BY_OPTIONS_KEY[optionsKey] || optionsKey;
}