// ─── acquisition-brain/fact-provenance-contract.js ─────────────────────────
// Canonical multi-label fact + provenance schema for Acquisition Brain (PR B).
// Pure helpers — not authoritative for outbound until a later authority switch.

export const FACT_CONTRACT_VERSION = "acquisition_brain_fact_contract_v1";

export const CLAIM_STATUS = Object.freeze({
  CLAIMED: "claimed",
  VERIFIED: "verified",
  INFERRED: "inferred",
  CORRECTED: "corrected",
  CONFLICTED: "conflicted",
});

export const FACT_TYPES = Object.freeze({
  OWNERSHIP_CONFIRMED: "ownership_confirmed",
  OWNERSHIP_DENIED: "ownership_denied",
  OWNERSHIP_RELATION: "ownership_relation",
  PROPOSAL_INTEREST: "proposal_interest",
  SELLER_REQUESTS_PROPOSAL: "seller_requests_proposal",
  ASKING_PRICE: "asking_price",
  ASKING_PRICE_RANGE: "asking_price_range",
  CONDITION: "condition",
  REPAIR: "repair",
  OCCUPANCY: "occupancy",
  TIMELINE: "timeline",
  MOTIVATION: "motivation",
  OBJECTION: "objection",
  LISTING_AGENT: "listing_agent",
  AUTHORITY_SIGNER: "authority_signer",
  LANGUAGE: "language",
  CONTACT_INSTRUCTION: "contact_instruction",
  OPT_OUT: "opt_out",
  WRONG_NUMBER: "wrong_number",
  HOSTILE_LEGAL: "hostile_legal",
  UNCERTAINTY: "uncertainty",
  TRANSACTION_CLAIM: "transaction_claim",
  CO_OWNER: "co_owner",
  ENTITY_TYPE: "entity_type",
});

/**
 * @typedef {object} ProvenancedFact
 * @property {string} fact_id
 * @property {string} fact_type
 * @property {*} value
 * @property {*} [normalized_value]
 * @property {number} confidence
 * @property {{ start?: number, end?: number, text?: string }|null} evidence_span
 * @property {string|null} source_message_id
 * @property {string|null} source_timestamp
 * @property {string} classifier_version
 * @property {'claimed'|'verified'|'inferred'|'corrected'|'conflicted'} claimed_or_verified
 * @property {string|null} first_observed_at
 * @property {string|null} last_confirmed_at
 * @property {string|null} supersedes_fact_id
 * @property {string[]} conflicts_with_fact_ids
 * @property {boolean} active
 * @property {object|null} human_override
 */

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function nowIso(input = null) {
  if (input) return new Date(input).toISOString();
  return new Date().toISOString();
}

function makeFactId(fact_type, source_message_id, suffix = "") {
  const base = `${fact_type}:${clean(source_message_id) || "unknown"}`;
  return suffix ? `${base}:${suffix}` : base;
}

/**
 * Build a single provenanced fact record.
 */
export function createProvenancedFact({
  fact_type,
  value,
  normalized_value = null,
  confidence = 0.9,
  evidence_span = null,
  source_message_id = null,
  source_timestamp = null,
  classifier_version = FACT_CONTRACT_VERSION,
  claimed_or_verified = CLAIM_STATUS.CLAIMED,
  first_observed_at = null,
  last_confirmed_at = null,
  supersedes_fact_id = null,
  conflicts_with_fact_ids = [],
  active = true,
  human_override = null,
  fact_id = null,
} = {}) {
  const ts = source_timestamp || nowIso();
  return Object.freeze({
    fact_id: fact_id || makeFactId(fact_type, source_message_id, String(normalized_value ?? value).slice(0, 40)),
    fact_type: clean(fact_type),
    value,
    normalized_value: normalized_value ?? value,
    confidence: Number(confidence) || 0,
    evidence_span: evidence_span || null,
    source_message_id: source_message_id || null,
    source_timestamp: ts,
    classifier_version: classifier_version || FACT_CONTRACT_VERSION,
    claimed_or_verified,
    first_observed_at: first_observed_at || ts,
    last_confirmed_at: last_confirmed_at || ts,
    supersedes_fact_id: supersedes_fact_id || null,
    conflicts_with_fact_ids: Object.freeze([...(conflicts_with_fact_ids || [])]),
    active: active !== false,
    human_override: human_override || null,
  });
}

/**
 * Deterministic fact precedence:
 * verified > claimed > inferred
 * explicit correction supersedes older claim
 * stronger confidence beats weaker inference
 * opt-out / wrong-number terminal
 * weak later message does not erase stronger prior
 */
export function factPrecedenceScore(fact) {
  if (!fact || fact.active === false) return -1;
  let score = Number(fact.confidence) || 0;
  switch (fact.claimed_or_verified) {
    case CLAIM_STATUS.VERIFIED:
      score += 100;
      break;
    case CLAIM_STATUS.CORRECTED:
      score += 80;
      break;
    case CLAIM_STATUS.CLAIMED:
      score += 40;
      break;
    case CLAIM_STATUS.INFERRED:
      score += 10;
      break;
    case CLAIM_STATUS.CONFLICTED:
      score += 5;
      break;
    default:
      break;
  }
  // Recency tie-break
  const t = Date.parse(fact.last_confirmed_at || fact.source_timestamp || 0) || 0;
  score += Math.min(t / 1e13, 1);
  return score;
}

/**
 * Merge a new fact into an existing bag. Returns updated active facts array.
 * Does not mutate inputs.
 */
export function mergeFactIntoState(existing_facts = [], incoming) {
  const list = Array.isArray(existing_facts) ? [...existing_facts] : [];
  if (!incoming?.fact_type) return list;

  // Terminal facts always win and stay
  if (
    incoming.fact_type === FACT_TYPES.OPT_OUT ||
    incoming.fact_type === FACT_TYPES.WRONG_NUMBER
  ) {
    return [
      ...list.map((f) =>
        f.fact_type === incoming.fact_type
          ? { ...f, active: false }
          : f
      ),
      { ...incoming, claimed_or_verified: CLAIM_STATUS.VERIFIED, active: true },
    ];
  }

  // Transaction claims from seller text stay claimed/unverified
  if (incoming.fact_type === FACT_TYPES.TRANSACTION_CLAIM) {
    return [
      ...list,
      {
        ...incoming,
        claimed_or_verified: CLAIM_STATUS.CLAIMED,
        active: true,
      },
    ];
  }

  const same_type = list.filter(
    (f) => f.fact_type === incoming.fact_type && f.active !== false
  );
  if (!same_type.length) {
    return [...list, incoming];
  }

  const best = same_type.reduce((a, b) =>
    factPrecedenceScore(a) >= factPrecedenceScore(b) ? a : b
  );

  // Explicit correction: different normalized value with high confidence
  const values_differ =
    JSON.stringify(best.normalized_value) !== JSON.stringify(incoming.normalized_value);
  if (values_differ && factPrecedenceScore(incoming) > factPrecedenceScore(best)) {
    return list.map((f) => {
      if (f.fact_id === best.fact_id) {
        return {
          ...f,
          active: false,
          conflicts_with_fact_ids: [...(f.conflicts_with_fact_ids || []), incoming.fact_id],
        };
      }
      return f;
    }).concat([
      {
        ...incoming,
        supersedes_fact_id: best.fact_id,
        claimed_or_verified:
          incoming.claimed_or_verified === CLAIM_STATUS.INFERRED
            ? CLAIM_STATUS.CORRECTED
            : incoming.claimed_or_verified,
        first_observed_at: best.first_observed_at || incoming.first_observed_at,
      },
    ]);
  }

  // Weaker incoming does not erase stronger prior
  if (factPrecedenceScore(incoming) <= factPrecedenceScore(best)) {
    if (values_differ) {
      // Record conflict without deactivating strong fact
      return [
        ...list,
        {
          ...incoming,
          active: false,
          claimed_or_verified: CLAIM_STATUS.CONFLICTED,
          conflicts_with_fact_ids: [best.fact_id],
        },
      ].map((f) =>
        f.fact_id === best.fact_id
          ? {
              ...f,
              conflicts_with_fact_ids: [
                ...new Set([...(f.conflicts_with_fact_ids || []), incoming.fact_id]),
              ],
              last_confirmed_at: f.last_confirmed_at,
            }
          : f
      );
    }
    // Same value — refresh confirmation on stronger
    return list.map((f) =>
      f.fact_id === best.fact_id
        ? {
            ...f,
            last_confirmed_at: incoming.source_timestamp || f.last_confirmed_at,
            confidence: Math.max(f.confidence, incoming.confidence),
          }
        : f
    );
  }

  // Incoming stronger same type
  return list
    .map((f) =>
      f.fact_id === best.fact_id
        ? { ...f, active: false, supersedes_fact_id: f.supersedes_fact_id }
        : f
    )
    .concat([{ ...incoming, supersedes_fact_id: best.fact_id }]);
}

/**
 * Extract a provisional multi-label classifier-shaped result from a message
 * without calling an LLM. Wraps/extends classify-compatible fields.
 * Outbound authority is NOT switched.
 */
export function buildClassifierResultContract({
  message = "",
  classification = null,
  source_message_id = null,
  source_timestamp = null,
  classifier_version = FACT_CONTRACT_VERSION,
} = {}) {
  const c = classification && typeof classification === "object" ? classification : {};
  const text = String(message || "");
  const lower_text = lower(text);
  const primary = lower(c.primary_intent || c.detected_intent || "unclear");
  const conf = Number(c.confidence ?? 0.9) || 0.9;
  const ts = source_timestamp || nowIso();
  const mid = source_message_id;

  const secondary = [];
  const facts = [];
  const objections = [];

  const push = (partial) => {
    facts.push(
      createProvenancedFact({
        ...partial,
        source_message_id: mid,
        source_timestamp: ts,
        classifier_version,
        confidence: partial.confidence ?? conf,
      })
    );
  };

  // Opt-out / wrong number / hostile
  if (primary === "opt_out" || /^stop\b|unsubscribe|remove me/.test(lower_text)) {
    push({
      fact_type: FACT_TYPES.OPT_OUT,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.VERIFIED,
      evidence_span: { text: text.slice(0, 40) },
    });
  }
  if (primary === "wrong_number" || /wrong number|not me/.test(lower_text)) {
    push({
      fact_type: FACT_TYPES.WRONG_NUMBER,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.VERIFIED,
      evidence_span: { text: text.slice(0, 40) },
    });
  }
  if (primary === "hostile_or_legal" || /sue|lawyer|fcc|harass/.test(lower_text)) {
    push({
      fact_type: FACT_TYPES.HOSTILE_LEGAL,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
      evidence_span: { text: text.slice(0, 80) },
    });
  }

  // Ownership
  if (
    primary === "ownership_confirmed" ||
    primary === "asks_offer" ||
    /^(yeah|yes|yep|i do)\b/.test(lower_text)
  ) {
    push({
      fact_type: FACT_TYPES.OWNERSHIP_CONFIRMED,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
      evidence_span: { text: text.slice(0, 60) },
    });
  }
  if (primary === "not_interested") {
    push({
      fact_type: FACT_TYPES.OWNERSHIP_DENIED,
      value: "not_interested",
      normalized_value: "not_interested",
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
  }

  // Proposal
  if (
    primary === "asks_offer" ||
    /what'?s the proposal|send (me )?(a |the )?proposal|how much/.test(lower_text)
  ) {
    push({
      fact_type: FACT_TYPES.SELLER_REQUESTS_PROPOSAL,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
      evidence_span: { text: text.slice(0, 80) },
    });
    push({
      fact_type: FACT_TYPES.PROPOSAL_INTEREST,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
    if (primary === "asks_offer") secondary.push("ownership_confirmed");
  }

  // Asking price
  const price_match = text.match(/\$?\s*(\d{2,3})\s*k\b|\$\s*([\d,]+)|(\d{5,7})\b/i);
  if (primary === "asking_price_provided" || price_match) {
    let amount = null;
    if (price_match) {
      if (price_match[1]) amount = Number(price_match[1]) * 1000;
      else if (price_match[2]) amount = Number(price_match[2].replace(/,/g, ""));
      else if (price_match[3]) amount = Number(price_match[3]);
    }
    push({
      fact_type: FACT_TYPES.ASKING_PRICE,
      value: amount,
      normalized_value: amount,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
      evidence_span: { text: price_match?.[0] || text.slice(0, 40) },
    });
  }

  // Condition
  if (/roof|hvac|foundation|plumbing|electrical|needs work|repairs?/.test(lower_text)) {
    const repairs = [];
    if (/roof/.test(lower_text)) repairs.push("roof");
    if (/hvac/.test(lower_text)) repairs.push("hvac");
    if (/foundation/.test(lower_text)) repairs.push("foundation");
    push({
      fact_type: FACT_TYPES.CONDITION,
      value: { repairs, summary: text.slice(0, 200) },
      normalized_value: { repairs },
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
      evidence_span: { text: text.slice(0, 100) },
    });
  }

  // Authority / co-owner
  if (/husband|wife|spouse|also owns|on title|co-?owner/.test(lower_text)) {
    push({
      fact_type: FACT_TYPES.CO_OWNER,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
    push({
      fact_type: FACT_TYPES.AUTHORITY_SIGNER,
      value: { can_execute_alone: false, additional_signers: true },
      normalized_value: { can_execute_alone: false },
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
  }
  if (/brother|sister|mom|dad|family|passed away|probate|executor|estate/.test(lower_text)) {
    push({
      fact_type: FACT_TYPES.OWNERSHIP_RELATION,
      value: /probate|passed away|executor|estate/.test(lower_text)
        ? "estate"
        : "family_member",
      normalized_value: /probate|estate|executor/.test(lower_text)
        ? "estate"
        : "family_member",
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
  }
  if (/\bllc\b/.test(lower_text)) {
    push({
      fact_type: FACT_TYPES.ENTITY_TYPE,
      value: "llc",
      normalized_value: "llc",
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
  }
  if (/\btrust\b/.test(lower_text)) {
    push({
      fact_type: FACT_TYPES.ENTITY_TYPE,
      value: "trust",
      normalized_value: "trust",
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
  }

  // Transaction claims (never verified from text)
  if (/under contract|we closed|already closed|went under contract/.test(lower_text)) {
    push({
      fact_type: FACT_TYPES.TRANSACTION_CLAIM,
      value: /closed/.test(lower_text) ? "closed_claim" : "under_contract_claim",
      normalized_value: /closed/.test(lower_text) ? "closed_claim" : "under_contract_claim",
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
  }

  if (c.language || /[áéíóúñ¿¡]/.test(text)) {
    push({
      fact_type: FACT_TYPES.LANGUAGE,
      value: c.language || "Spanish",
      normalized_value: c.language || "Spanish",
      claimed_or_verified: CLAIM_STATUS.INFERRED,
    });
  }

  // Recommended stage / NBA (hints only — not transport)
  let recommended_stage = "ownership_check";
  let recommended_next_action = "request_ownership";
  const has_own = facts.some(
    (f) => f.fact_type === FACT_TYPES.OWNERSHIP_CONFIRMED && f.value === true
  );
  const has_prop = facts.some(
    (f) =>
      f.fact_type === FACT_TYPES.SELLER_REQUESTS_PROPOSAL ||
      f.fact_type === FACT_TYPES.PROPOSAL_INTEREST
  );
  const has_price = facts.some((f) => f.fact_type === FACT_TYPES.ASKING_PRICE);
  if (facts.some((f) => f.fact_type === FACT_TYPES.OPT_OUT)) {
    recommended_stage = "terminal";
    recommended_next_action = "opt_out";
  } else if (facts.some((f) => f.fact_type === FACT_TYPES.WRONG_NUMBER)) {
    recommended_stage = "terminal";
    recommended_next_action = "suppress";
  } else if (has_own && has_prop) {
    recommended_stage = "asking_price";
    recommended_next_action = "request_asking_price";
  } else if (has_own && has_price) {
    recommended_stage = "property_condition";
    recommended_next_action = "request_condition";
  } else if (has_own) {
    recommended_stage = "interest_proposal";
    recommended_next_action = "confirm_interest";
  }

  return Object.freeze({
    primary_intent: primary || "unclear",
    secondary_intents: Object.freeze(secondary),
    facts: Object.freeze(facts),
    ownership_relation:
      facts.find((f) => f.fact_type === FACT_TYPES.OWNERSHIP_RELATION)?.normalized_value ||
      null,
    ownership_confidence: has_own ? conf : 0,
    proposal_interest: has_prop,
    asking_price: facts.find((f) => f.fact_type === FACT_TYPES.ASKING_PRICE)?.normalized_value ?? null,
    asking_price_currency: "USD",
    asking_price_qualifier: null,
    condition_facts:
      facts.find((f) => f.fact_type === FACT_TYPES.CONDITION)?.normalized_value || null,
    timeline: facts.find((f) => f.fact_type === FACT_TYPES.TIMELINE)?.value || null,
    occupancy: facts.find((f) => f.fact_type === FACT_TYPES.OCCUPANCY)?.value || null,
    motivation_indicators: [],
    objections: Object.freeze(objections),
    listing_agent_involvement: Boolean(
      facts.find((f) => f.fact_type === FACT_TYPES.LISTING_AGENT)
    ),
    authority_signers:
      facts.find((f) => f.fact_type === FACT_TYPES.AUTHORITY_SIGNER)?.normalized_value || null,
    language:
      facts.find((f) => f.fact_type === FACT_TYPES.LANGUAGE)?.normalized_value ||
      c.language ||
      "English",
    contact_instructions: null,
    opt_out: facts.some((f) => f.fact_type === FACT_TYPES.OPT_OUT),
    wrong_number: facts.some((f) => f.fact_type === FACT_TYPES.WRONG_NUMBER),
    hostility_legal: facts.some((f) => f.fact_type === FACT_TYPES.HOSTILE_LEGAL),
    uncertainty: primary === "unclear",
    recommended_stage,
    recommended_next_action,
    human_review_required:
      facts.some((f) => f.fact_type === FACT_TYPES.HOSTILE_LEGAL) ||
      facts.some(
        (f) =>
          f.fact_type === FACT_TYPES.ENTITY_TYPE ||
          f.fact_type === FACT_TYPES.OWNERSHIP_RELATION
      ),
    classifier_version,
    contract_version: FACT_CONTRACT_VERSION,
  });
}

/**
 * Apply precedence across a fact bag and return active-only map by type.
 */
export function resolveActiveFacts(facts = []) {
  const by_type = new Map();
  for (const f of facts) {
    if (!f?.fact_type || f.active === false) continue;
    const cur = by_type.get(f.fact_type);
    if (!cur || factPrecedenceScore(f) > factPrecedenceScore(cur)) {
      by_type.set(f.fact_type, f);
    }
  }
  return Object.freeze(Object.fromEntries(by_type));
}

export default {
  FACT_CONTRACT_VERSION,
  CLAIM_STATUS,
  FACT_TYPES,
  createProvenancedFact,
  factPrecedenceScore,
  mergeFactIntoState,
  buildClassifierResultContract,
  resolveActiveFacts,
};
