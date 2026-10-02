/**
 * IC8 FAIRNESS LINT -- FINAL policy (owner decision 2026-10-01, counsel
 * approved; supersedes the earlier tiered drafts).
 *
 * Every source column is classified, and every feature declares the class its
 * lineage requires (the declaration must EQUAL the requirement, so a flag can
 * neither be forgotten nor overstated):
 *
 *   permitted           ordinary inputs.
 *   conversation_only   message text, message/template language. Only
 *                       conversation_understanding families.
 *   personal_attribute  gender, marital status, owner language / best_language,
 *                       agent_persona, age / age band, household income (and
 *                       the modeled-wealth attributes of the same vendor
 *                       family), education, occupation. ALLOWED as inputs in
 *                       targeting_response families (who to contact, when,
 *                       which message, reply likelihood), in every promotion
 *                       state, and as experiment arms/strata for those
 *                       families. Any model using one ships a fairness report
 *                       (fairness/group-audit.js); the model registry requires
 *                       it for promotion.
 *   prohibited          everywhere, never definable: identity fields (names,
 *                       phone numbers, area codes, emails, blobs that embed
 *                       them), neighbourhood demographic composition, the
 *                       legacy opaque composite scores. Protected
 *                       characteristics the owner did not address (race /
 *                       ethnicity, religion, national origin, disability,
 *                       familial status, veteran status, sexual orientation,
 *                       dates of death/divorce) stay prohibited under the
 *                       brief's stricter-reading rule. School district is a
 *                       PROPERTY/geography fact and is permitted (IC 8.1).
 *
 * Per-model feature contracts (IC 8.1): every family also declares the
 * feature GROUPS it may consume (first-text reply: prospect, property, market,
 * contact, campaign, investor; valuation: property, market, transaction, comp,
 * public_record, seller_provided; buyer: buyer, company, purchase, market,
 * property_relationship). Offer / negotiation families remain undefined.
 *
 * The lint is name-based and conservative: an unknown `*_name` column is a
 * person's name until it is allowlisted here.
 */

export const FAIRNESS_CLASSES = Object.freeze(["permitted", "conversation_only", "personal_attribute", "prohibited"]);
/** Classes a feature can be defined with (prohibited never can). */
export const DEFINABLE_FAIRNESS_CLASSES = Object.freeze(["permitted", "conversation_only", "personal_attribute"]);
const CLASS_RANK = Object.freeze({ permitted: 0, conversation_only: 1, personal_attribute: 2, prohibited: 3 });

/** The owner's canonical input universe (architecture §3.2b). */
export const FEATURE_DOMAINS = Object.freeze([
  "property",
  "ownership_prospect",
  "financial_title",
  "company_relationship",
  "operational",
]);

/** Family types defined so far (offer / negotiation come later, with the owner). */
export const FAMILY_TYPES = Object.freeze([
  "targeting_response",
  "conversation_understanding",
  "campaign_allocation",
  "delivery_risk",
  "valuation",
  "buyer_selection",
]);

/** Feature groups: the vocabulary of the per-model feature contracts (IC 8.1). */
export const FEATURE_GROUPS = Object.freeze([
  "prospect",
  "property",
  "market",
  "contact",
  "campaign",
  "investor",
  "transaction",
  "comp",
  "public_record",
  "seller_provided",
  "buyer",
  "company",
  "purchase",
  "property_relationship",
  "conversation",
]);

/**
 * The group of a feature: its explicit `group` declaration, else derived
 * deterministically from its declarations (pinned by a test, so a change here
 * is visible).
 */
export function featureGroupOf(def) {
  if (def.group) return def.group;
  if (def.lineage?.group === "market_investor_activity") return "investor";
  if (def.fairnessClass === "conversation_only") return "conversation";
  if (def.statedFact) return "seller_provided";
  if (def.domain === "financial_title") return "public_record";
  if (def.domain === "company_relationship") return "company";
  if (def.domain === "ownership_prospect") return def.scope === "property" ? "public_record" : "prospect";
  if (def.scope === "market") return "market";
  if (def.domain === "property") return "property";
  if (def.scope === "seller") return "contact";
  return "campaign";
}
/** personal_attribute inputs are granted to these family types. */
export const PERSONAL_ATTRIBUTE_FAMILY_TYPES = Object.freeze(["targeting_response"]);

/** Tables whose rows describe a PERSON: a bare `language` column here is the person's language. */
export const PERSON_TABLES = Object.freeze([
  "prospects",
  "master_owners",
  "phones",
  "campaign_target_graph",
  "owner",
  "seller.owner",
  "owners",
  "contacts",
]);

/** Tables whose rows describe a PROPERTY: income-like columns here are property economics. */
export const PROPERTY_TABLES = Object.freeze(["properties", "property", "seller.property", "v_recent_sold_comps"]);

const NON_PERSON_NAME_RE =
  /(^|_)(market|county|city|state|template|campaign|stage|use_case|metric|feature|subdivision|zip|file|bucket|schema|table|column|event|field|school_district)_name$/;
const PERSONA_RE = /persona|agent_family|agent_name|agent_display/;

/**
 * Rules evaluated against every identifier token of a source. `effect` is
 * "prohibited" or the fairness class the token requires. `test(token, ctx)`
 * sees the lowercase token and `{ table }`.
 */
export const SOURCE_RULES = Object.freeze([
  // ── prohibited: identity ───────────────────────────────────────────────
  {
    id: "person_name",
    effect: "prohibited",
    category: "identity",
    test: (t) =>
      (/(^|_)names?$/.test(t) && !NON_PERSON_NAME_RE.test(t) && !PERSONA_RE.test(t)) ||
      /surname|given_name|middle_initial|generational_suffix|(^|_)cnam(_|$)/.test(t),
  },
  {
    id: "phone_area_code",
    effect: "prohibited",
    category: "identity",
    keyAllowed: true,
    test: (t) =>
      /phone|(^|_)e_?164(_|$)|canonical_e164|area_?code|(^|_)npa(_|$)|(^|_)nxx(_|$)|msisdn|textgrid_number|our_number|thread_key|caller_?id/.test(t),
  },
  { id: "email", effect: "prohibited", category: "identity", test: (t) => /e_?mail/.test(t) },
  // Blobs that embed names/phones verbatim. (Addresses are PII but not a
  // protected attribute: a feature may COMPARE a mailing and a property
  // address, e.g. absentee; the dataset PII guard keeps addresses out of rows.)
  { id: "embedded_identity", effect: "prohibited", category: "identity", test: (t) => /personalization|template_variables|candidate_snapshot/.test(t) },
  // ── prohibited: protected characteristics the owner did not reverse ────
  {
    id: "protected_characteristic",
    effect: "prohibited",
    category: "protected",
    test: (t) =>
      /(^|_)race(_|$)|ethnic|hispanic|religio|national_origin|nationality|citizenship|disabilit|handicap|familial|family_status|household_size|household_type|in_owner_family|intra_family|children|(^|_)kids(_|$)|pregnan|veteran|military|sexual_orientation|divorce|date_of_death|deceased/.test(
        t,
      ),
  },
  // ── prohibited: neighbourhood demographic composition ──────────────────
  {
    id: "demographic_composition",
    effect: "prohibited",
    category: "demographic_composition",
    test: (t) =>
      /census|(^|_)acs(_|$)|acs_|b11001|b19013|demographic|(^|_)tract(_|$)|block_group|median_household_income|neighbo(u)?rhood_(income|race|composition)/.test(
        t,
      ),
  },
  // ── prohibited: legacy opaque scores (the retired interpretation layer) ─
  {
    id: "legacy_score",
    effect: "prohibited",
    category: "legacy_score",
    test: (t) =>
      /final_acquisition_score|acquisition_score|(^|_)priority_score|priority_tier|motivation_score|structured_motivation|(^|_)ai_score|deal_strength|transaction_probability|(^|_)probability_?(90|180|365)(_|$)|tag_distress|distress_score|urgency_score|financial_pressure|contactability_score|offer_aggression|(^|_)lead_score|ai_confidence|acquisition_brain_shadow|linkage_score/.test(
        t,
      ),
  },
  // ── personal_attribute ─────────────────────────────────────────────────
  { id: "gender_sex", effect: "personal_attribute", category: "personal_attribute", test: (t) => /gender|(^|_)sex(_|$)/.test(t) },
  { id: "marital_status", effect: "personal_attribute", category: "personal_attribute", test: (t) => /marital/.test(t) },
  {
    id: "person_language",
    effect: "personal_attribute",
    category: "personal_attribute",
    test: (t, ctx) =>
      /best_language|language_preference|preferred_language|owner_language|linked_languages|requested_language|spoken_language/.test(t) ||
      (/^(language|lang)$/.test(t) && isPersonTable(ctx.table)),
  },
  { id: "agent_persona", effect: "personal_attribute", category: "personal_attribute", test: (t) => PERSONA_RE.test(t) },
  {
    id: "age",
    effect: "personal_attribute",
    category: "age",
    test: (t) => /(^|_)age(_|$)|age_bucket|age_band|age_range|(^|_)mob(_|$)|month_of_birth|birth|(^|_)dob(_|$)|senior/.test(t),
  },
  {
    id: "modeled_income",
    effect: "personal_attribute",
    category: "modeled_income",
    test: (t, ctx) =>
      /household_income|net_asset|net_worth|buying_power|wealth|credit_tier|credit_score|spender_type|consumer_type|investment_type/.test(t) ||
      (/income/.test(t) && !isPropertyTable(ctx.table)),
  },
  { id: "education", effect: "personal_attribute", category: "education", test: (t) => /education/.test(t) },
  { id: "occupation", effect: "personal_attribute", category: "occupation", test: (t) => /occupation|employment/.test(t) },
  // ── conversation_only ──────────────────────────────────────────────────
  {
    id: "message_text",
    effect: "conversation_only",
    category: "message_text",
    test: (t) =>
      /^(text|body)$/.test(t) ||
      /message_body|message_text|rendered_message|latest_message|message_preview|transcript|ai_output|raw_text|template_text/.test(t),
  },
  {
    id: "message_language",
    effect: "conversation_only",
    category: "message_language",
    test: (t, ctx) =>
      (/^(language|lang)$/.test(t) && !isPersonTable(ctx.table)) ||
      /detected_language|message_language|template_language|selected_template_language|candidate_languages/.test(t),
  },
]);

function isPersonTable(table) {
  const value = String(table || "").toLowerCase();
  return PERSON_TABLES.includes(value) || PERSON_TABLES.includes(value.split(".").pop());
}

function isPropertyTable(table) {
  return PROPERTY_TABLES.includes(String(table || "").toLowerCase());
}

export class FairnessLintError extends Error {
  constructor(message, violations = []) {
    super(message);
    this.name = "FairnessLintError";
    this.code = "FAIRNESS_LINT";
    this.violations = violations;
  }
}

/**
 * Split a lineage source into its table and identifier tokens.
 *   "send_queue.sent_at|created_at"      -> table send_queue, tokens [send_queue, sent_at, created_at]
 *   "seller.property_sale.event_date"    -> table seller.property_sale
 *   "properties.state→tz"                -> tokens [properties, state, tz]
 */
export function tokenizeSource(source) {
  const raw = String(source ?? "").trim();
  const segments = raw
    .toLowerCase()
    .split(/[|,\s→>()[\]{}*:=+/]+|->/)
    .filter(Boolean);
  const tokens = new Set();
  let table = null;
  for (const segment of segments) {
    const parts = segment.split(".").filter(Boolean);
    if (!table && parts.length >= 2) {
      table = ["seller", "public", "comp_private", "intelligence"].includes(parts[0]) ? `${parts[0]}.${parts[1]}` : parts[0];
      if (table.startsWith("public.")) table = table.slice("public.".length);
    }
    for (const part of parts) tokens.add(part);
  }
  if (!table && segments.length) table = segments[0].split(".")[0] || null;
  return { raw, table, tokens: [...tokens] };
}

/** Classify one source: every rule hit on every token. */
export function classifySource(source) {
  const { raw, table, tokens } = tokenizeSource(source);
  const findings = [];
  for (const token of tokens) {
    for (const rule of SOURCE_RULES) {
      if (rule.test(token, { table })) {
        findings.push({ source: raw, table, token, rule: rule.id, effect: rule.effect, category: rule.category, keyAllowed: rule.keyAllowed === true });
      }
    }
  }
  return { source: raw, table, tokens, findings };
}

/** The fairness class a set of sources requires ("prohibited" wins). */
export function requiredFairnessClass(sources = []) {
  let required = "permitted";
  for (const source of sources) {
    for (const finding of classifySource(source).findings) {
      if (CLASS_RANK[finding.effect] > CLASS_RANK[required]) required = finding.effect;
    }
  }
  return required;
}

/**
 * Lint a feature's declared lineage. Returns violations (empty = clean).
 *   sources: value-bearing columns (fully linted)
 *   keys:    join keys used only to locate rows; may be phone/thread keys
 *            (how sends and replies join), never any other sensitive field
 */
export function lintFeatureSources({ sources = [], keys = [], fairnessClass = "permitted" } = {}) {
  const violations = [];
  let required = "permitted";
  const drivers = [];
  for (const source of sources) {
    for (const finding of classifySource(source).findings) {
      if (finding.effect === "prohibited") {
        violations.push({ ...finding, violation: "prohibited_source" });
      } else if (CLASS_RANK[finding.effect] >= CLASS_RANK[required]) {
        if (CLASS_RANK[finding.effect] > CLASS_RANK[required]) drivers.length = 0;
        required = finding.effect;
        drivers.push(finding);
      }
    }
  }
  for (const key of keys) {
    for (const finding of classifySource(key).findings) {
      if (!finding.keyAllowed) violations.push({ ...finding, violation: "sensitive_join_key" });
    }
  }
  if (fairnessClass === "prohibited") {
    violations.push({ violation: "prohibited_class_not_definable", declared: fairnessClass, required, source: null, token: null, rule: null });
  } else if (!violations.some((v) => v.violation === "prohibited_source") && fairnessClass !== required) {
    violations.push({
      violation: "fairness_class_mismatch",
      declared: fairnessClass,
      required,
      source: drivers[0]?.source ?? null,
      token: drivers[0]?.token ?? null,
      rule: drivers[0]?.rule ?? null,
    });
  }
  return violations;
}

export function lintFeatureDefinition(def) {
  return lintFeatureSources({
    sources: def?.lineage?.sources || [],
    keys: def?.lineage?.keys || [],
    fairnessClass: def?.fairnessClass,
  });
}

export function formatViolations(violations) {
  return violations
    .map((v) => {
      if (v.violation === "fairness_class_mismatch") return `fairness_class_mismatch (declared ${v.declared}, lineage requires ${v.required}${v.token ? ` via ${v.token}` : ""})`;
      return `${v.violation}${v.token ? ` (${v.token} in "${v.source}", rule ${v.rule})` : ""}`;
    })
    .join("; ");
}

// ── Model-family policies ─────────────────────────────────────────────────

/**
 * A family declares its type and the fairness classes its inputs may use.
 * The registry rejects any feature set that violates the declaration.
 */
export function defineFamilyPolicy({ family, familyType, allowedFairnessClasses = ["permitted"], allowedGroups = null, description = null } = {}) {
  const problems = [];
  const groups = allowedGroups === null ? null : [...new Set(allowedGroups)];
  for (const g of groups || []) if (!FEATURE_GROUPS.includes(g)) problems.push(`unknown feature group ${g}`);
  if (!/^[a-z][a-z0-9_]*$/.test(String(family || ""))) problems.push("family must be snake_case");
  if (!FAMILY_TYPES.includes(familyType)) problems.push(`familyType must be one of ${FAMILY_TYPES.join(", ")} (others are not defined in this phase)`);
  const classes = [...new Set(allowedFairnessClasses)];
  for (const value of classes) {
    if (!DEFINABLE_FAIRNESS_CLASSES.includes(value)) problems.push(`fairness class ${value} cannot be allowed`);
  }
  if (!classes.includes("permitted")) problems.push("every family allows permitted features");
  if (classes.includes("conversation_only") && familyType !== "conversation_understanding") {
    problems.push("conversation_only features are allowed ONLY in conversation_understanding families");
  }
  if (classes.includes("personal_attribute") && !PERSONAL_ATTRIBUTE_FAMILY_TYPES.includes(familyType)) {
    problems.push("personal_attribute inputs are granted to targeting_response families");
  }
  if (problems.length) {
    throw new FairnessLintError(`invalid family policy ${family}: ${problems.join("; ")}`, problems.map((p) => ({ violation: p })));
  }
  return Object.freeze({ family, familyType, allowedFairnessClasses: Object.freeze(classes), allowedGroups: groups ? Object.freeze(groups) : null, description });
}

/** Validate a feature set (array of feature definitions) for a family policy. */
export function lintFeatureSetForFamily(features, policy) {
  const violations = [];
  if (!policy) return [{ violation: "family_policy_missing" }];
  for (const def of features) {
    const id = `${def.key}@${def.version}`;
    for (const finding of lintFeatureDefinition(def)) violations.push({ feature: id, ...finding });
    if (!policy.allowedFairnessClasses.includes(def.fairnessClass)) {
      violations.push({ feature: id, violation: "fairness_class_not_allowed_for_family", fairnessClass: def.fairnessClass, familyType: policy.familyType });
    }
    if (policy.allowedGroups && !policy.allowedGroups.includes(featureGroupOf(def))) {
      violations.push({ feature: id, violation: "feature_group_not_in_family_contract", group: featureGroupOf(def) });
    }
  }
  return violations;
}

/** Families known at v1. The code is the source of truth; the DB mirrors it. */
export const DEFAULT_FAMILY_POLICIES = Object.freeze({
  seller_first_touch_reply: defineFamilyPolicy({
    family: "seller_first_touch_reply",
    familyType: "targeting_response",
    allowedFairnessClasses: ["permitted", "personal_attribute"],
    // IC 8.1 contract plus public_record: the 2026-10-01 decision already put recorded
    // sale/mortgage facts (ownership duration, recorded mortgage count) in this model.
    allowedGroups: ["prospect", "property", "market", "contact", "campaign", "investor", "public_record"],
    description: "First-text reply. Models using personal_attribute inputs ship a fairness report.",
  }),
  send_carrier_filtering: defineFamilyPolicy({ family: "send_carrier_filtering", familyType: "delivery_risk" }),
  send_opt_out_risk: defineFamilyPolicy({ family: "send_opt_out_risk", familyType: "delivery_risk" }),
  conversation_understanding: defineFamilyPolicy({
    family: "conversation_understanding",
    familyType: "conversation_understanding",
    allowedFairnessClasses: ["permitted", "conversation_only"],
  }),
  campaign_controller: defineFamilyPolicy({ family: "campaign_controller", familyType: "campaign_allocation" }),
  comp_valuation: defineFamilyPolicy({
    family: "comp_valuation",
    familyType: "valuation",
    allowedGroups: ["property", "market", "transaction", "comp", "public_record", "seller_provided"],
    description: "Valuation / comp similarity / micro-market. Property, market, transaction, comp, public-record and seller-provided property facts only.",
  }),
  buyer_match: defineFamilyPolicy({
    family: "buyer_match",
    familyType: "buyer_selection",
    allowedGroups: ["buyer", "company", "purchase", "market", "property_relationship"],
    description: "Buyer selection: buyer, company, purchase, market and property-relationship facts.",
  }),
});
