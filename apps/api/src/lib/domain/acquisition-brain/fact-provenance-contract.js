// ─── acquisition-brain/fact-provenance-contract.js ─────────────────────────
// Canonical multi-label fact + provenance schema for Acquisition Brain (PR B).
// Pure helpers — not authoritative for outbound. No LLM. JSON-serializable only.

export const FACT_CONTRACT_VERSION = "acquisition_brain_fact_contract_v1";

/** Claimed/verified continuum + authoritative system evidence. */
export const CLAIM_STATUS = Object.freeze({
  AUTHORITATIVE: "authoritative",
  VERIFIED: "verified",
  CLAIMED: "claimed",
  INFERRED: "inferred",
  CORRECTED: "corrected",
  CONFLICTED: "conflicted",
});

/**
 * Canonical fact-type registry. All emission/extraction must use these keys.
 */
export const FACT_TYPES = Object.freeze({
  // Identity / relationship
  OWNERSHIP_CONFIRMED: "ownership_confirmed",
  OWNERSHIP_DENIED: "ownership_denied",
  OWNERSHIP_RELATION: "ownership_relation",
  FAMILY_MEMBER: "family_member",
  TENANT_RENTER: "tenant_renter",
  PROPERTY_MANAGER: "property_manager",
  AGENT_REALTOR: "agent_realtor",
  BUSINESS_OFFICE: "business_office",
  WRONG_NUMBER: "wrong_number",
  NEVER_OWNED: "never_owned",
  SOLD_PROPERTY: "sold_property",

  // Interest
  PROPOSAL_INTEREST_CONFIRMED: "proposal_interest_confirmed",
  CONDITIONAL_INTEREST: "conditional_interest",
  SELLER_REQUESTS_PROPOSAL: "seller_requests_proposal",
  NOT_INTERESTED: "not_interested",
  FOLLOW_UP_LATER: "follow_up_later",
  TRUST_QUESTION: "trust_question",
  CREDIBILITY_QUESTION: "credibility_question",

  // Price / terms
  ASKING_PRICE: "asking_price",
  ASKING_PRICE_RANGE: "asking_price_range",
  PRICE_FIRMNESS: "price_firmness",
  PRICE_FLEXIBILITY: "price_flexibility",
  SELLER_COUNTER: "seller_counter",
  CREATIVE_TERMS_INTEREST: "creative_terms_interest",
  MORTGAGE_BALANCE_CLAIM: "mortgage_balance_claim",
  LIEN_CLAIM: "lien_claim",

  // Property
  OCCUPANCY: "occupancy",
  CONDITION_SUMMARY: "condition_summary",
  REPAIR_ITEM: "repair_item",
  ROOF_CONDITION: "roof_condition",
  FOUNDATION_CONDITION: "foundation_condition",
  HVAC_CONDITION: "HVAC_condition",
  PLUMBING_CONDITION: "plumbing_condition",
  ELECTRICAL_CONDITION: "electrical_condition",
  INTERIOR_CONDITION: "interior_condition",
  EXTERIOR_CONDITION: "exterior_condition",
  DAMAGE: "damage",
  RENOVATION_STATUS: "renovation_status",
  TENANT_STATUS: "tenant_status",

  // Timeline / motivation
  DESIRED_TIMELINE: "desired_timeline",
  URGENCY: "urgency",
  REASON_FOR_CONSIDERING: "reason_for_considering",
  RELOCATION: "relocation",
  INHERITED_PROPERTY: "inherited_property",
  VACANT_PROPERTY: "vacant_property",
  TIRED_LANDLORD: "tired_landlord",
  TAX_ISSUE_CLAIM: "tax_issue_claim",
  FORECLOSURE_CLAIM: "foreclosure_claim",

  // Authority
  AUTHORITY_TYPE: "authority_type",
  CAN_EXECUTE_ALONE: "can_execute_alone",
  SPOUSE_REQUIRED: "spouse_required",
  CO_OWNER_REQUIRED: "co_owner_required",
  LLC_AUTHORITY_REQUIRED: "LLC_authority_required",
  TRUST_AUTHORITY_REQUIRED: "trust_authority_required",
  EXECUTOR_AUTHORITY_REQUIRED: "executor_authority_required",
  PROBATE_DETECTED: "probate_detected",
  HEIRSHIP_DETECTED: "heirship_detected",
  POWER_OF_ATTORNEY_CLAIM: "power_of_attorney_claim",
  SIGNER_COUNT_CLAIM: "signer_count_claim",

  // Listing / transaction
  LISTED_WITH_AGENT: "listed_with_agent",
  AGENT_INVOLVED: "agent_involved",
  COMPETING_PROPOSAL: "competing_proposal",
  CONTRACT_REQUESTED: "contract_requested",
  CONTRACT_SIGNED_CLAIM: "contract_signed_claim",
  UNDER_CONTRACT_CLAIM: "under_contract_claim",
  ESCROW_OPEN_CLAIM: "escrow_open_claim",
  CLOSING_CLAIM: "closing_claim",

  // Communication / compliance
  LANGUAGE: "language",
  PREFERRED_CONTACT_TIME: "preferred_contact_time",
  CONTACT_INSTRUCTION: "contact_instruction",
  OPT_OUT: "opt_out",
  HOSTILITY: "hostility",
  LEGAL_THREAT: "legal_threat",
  UNCERTAINTY: "uncertainty",
  HUMAN_REVIEW_REQUIRED: "human_review_required",

  // Legacy aliases kept for earlier PR B tests / adapters
  PROPOSAL_INTEREST: "proposal_interest_confirmed",
  CONDITION: "condition_summary",
  REPAIR: "repair_item",
  TIMELINE: "desired_timeline",
  MOTIVATION: "reason_for_considering",
  OBJECTION: "not_interested",
  LISTING_AGENT: "listed_with_agent",
  AUTHORITY_SIGNER: "authority_type",
  HOSTILE_LEGAL: "hostility",
  TRANSACTION_CLAIM: "under_contract_claim",
  CO_OWNER: "co_owner_required",
  ENTITY_TYPE: "authority_type",
});

export const FACT_TYPE_SET = new Set(Object.values(FACT_TYPES));

/**
 * Precedence bands (additive scores):
 *   authoritative event  +1000
 *   verified explicit    +100
 *   claimed explicit     +40
 *   high-conf inferred   +10  (+ conf * 10 if conf >= 0.85)
 *   low-conf inferred    + conf * 10
 *   recency tie-break    + up to 1
 */
export const PRECEDENCE_BANDS = Object.freeze({
  AUTHORITATIVE: 1000,
  VERIFIED: 100,
  CORRECTED: 80,
  CLAIMED: 40,
  INFERRED: 10,
  CONFLICTED: 5,
});

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function nowIso(input = null) {
  if (input == null || input === "") return new Date().toISOString();
  if (typeof input === "string") return new Date(input).toISOString();
  if (typeof input === "number") return new Date(input).toISOString();
  return new Date().toISOString();
}

/** Deep JSON-safe clone; strips non-JSON values. */
export function toJsonSafe(value, depth = 0) {
  if (depth > 12) return null;
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === "string" || t === "boolean") return value;
  if (t === "number") return Number.isFinite(value) ? value : null;
  if (t === "bigint") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((v) => toJsonSafe(v, depth + 1)).filter((v) => v !== undefined);
  }
  if (t === "object") {
    if (value instanceof Map || value instanceof Set || typeof value === "function") {
      return null;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "function" || typeof v === "symbol") continue;
      const safe = toJsonSafe(v, depth + 1);
      if (safe !== undefined) out[k] = safe;
    }
    return out;
  }
  return null;
}

function makeFactId(fact_type, source_message_id, suffix = "") {
  const base = `${fact_type}:${clean(source_message_id) || "unknown"}`;
  const suf = clean(suffix).slice(0, 48).replace(/\s+/g, "_");
  return suf ? `${base}:${suf}` : base;
}

function findEvidenceSpan(message, phrase) {
  const text = String(message || "");
  const p = String(phrase || "");
  if (!text || !p) return { text: text.slice(0, 80), start: 0, end: Math.min(80, text.length) };
  const idx = text.toLowerCase().indexOf(p.toLowerCase());
  if (idx < 0) return { text: p.slice(0, 80), start: null, end: null };
  return { text: text.slice(idx, idx + p.length), start: idx, end: idx + p.length };
}

/**
 * Build a single provenanced fact (JSON-serializable, frozen).
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
  authoritative_event_id = null,
  authoritative_event_type = null,
} = {}) {
  const ts = nowIso(source_timestamp);
  const safe_value = toJsonSafe(value);
  const safe_norm = toJsonSafe(normalized_value ?? value);
  const safe_span = evidence_span
    ? toJsonSafe({
        start: evidence_span.start ?? null,
        end: evidence_span.end ?? null,
        text: evidence_span.text != null ? String(evidence_span.text).slice(0, 200) : null,
      })
    : null;

  return toJsonSafe({
    fact_id:
      fact_id ||
      makeFactId(
        fact_type,
        source_message_id,
        typeof safe_norm === "object" ? JSON.stringify(safe_norm).slice(0, 40) : String(safe_norm ?? "")
      ),
    fact_type: clean(fact_type),
    value: safe_value,
    normalized_value: safe_norm,
    confidence: Number(confidence) || 0,
    evidence_span: safe_span,
    source_message_id: source_message_id ? String(source_message_id) : null,
    source_timestamp: ts,
    classifier_version: String(classifier_version || FACT_CONTRACT_VERSION),
    claimed_or_verified: clean(claimed_or_verified) || CLAIM_STATUS.CLAIMED,
    first_observed_at: first_observed_at ? nowIso(first_observed_at) : ts,
    last_confirmed_at: last_confirmed_at ? nowIso(last_confirmed_at) : ts,
    supersedes_fact_id: supersedes_fact_id || null,
    conflicts_with_fact_ids: [...(conflicts_with_fact_ids || [])].map(String),
    active: active !== false,
    human_override: human_override ? toJsonSafe(human_override) : null,
    authoritative_event_id: authoritative_event_id || null,
    authoritative_event_type: authoritative_event_type || null,
  });
}

export function factPrecedenceScore(fact) {
  if (!fact || fact.active === false) return -1;
  let score = Number(fact.confidence) || 0;
  switch (fact.claimed_or_verified) {
    case CLAIM_STATUS.AUTHORITATIVE:
      score += PRECEDENCE_BANDS.AUTHORITATIVE;
      break;
    case CLAIM_STATUS.VERIFIED:
      score += PRECEDENCE_BANDS.VERIFIED;
      break;
    case CLAIM_STATUS.CORRECTED:
      score += PRECEDENCE_BANDS.CORRECTED;
      break;
    case CLAIM_STATUS.CLAIMED:
      score += PRECEDENCE_BANDS.CLAIMED;
      break;
    case CLAIM_STATUS.INFERRED: {
      const c = Number(fact.confidence) || 0;
      score += c >= 0.85 ? PRECEDENCE_BANDS.INFERRED + c * 10 : c * 10;
      break;
    }
    case CLAIM_STATUS.CONFLICTED:
      score += PRECEDENCE_BANDS.CONFLICTED;
      break;
    default:
      break;
  }
  if (fact.human_override?.active === true) score += 500;
  const t = Date.parse(fact.last_confirmed_at || fact.source_timestamp || 0) || 0;
  score += Math.min(t / 1e13, 1);
  return score;
}

/**
 * Immutable human override — cannot be silently reversed by weaker text facts.
 */
export function applyHumanOverride(fact, override = {}) {
  if (!fact) return null;
  return createProvenancedFact({
    ...fact,
    value: override.value !== undefined ? override.value : fact.value,
    normalized_value:
      override.normalized_value !== undefined
        ? override.normalized_value
        : fact.normalized_value,
    claimed_or_verified: CLAIM_STATUS.VERIFIED,
    human_override: {
      active: true,
      overridden_at: nowIso(override.overridden_at),
      overridden_by: override.overridden_by || "operator",
      reason: override.reason || "human_override",
      prior_value: fact.value,
      prior_status: fact.claimed_or_verified,
    },
    last_confirmed_at: nowIso(),
    confidence: 1,
  });
}

/**
 * Merge incoming fact into bag. Deterministic; does not mutate inputs.
 */
export function mergeFactIntoState(existing_facts = [], incoming) {
  const list = Array.isArray(existing_facts) ? existing_facts.map((f) => toJsonSafe(f)) : [];
  if (!incoming?.fact_type) return list;
  const next = toJsonSafe(incoming);

  // Human override immutability
  const active_override = list.find(
    (f) =>
      f.fact_type === next.fact_type &&
      f.active !== false &&
      f.human_override?.active === true
  );
  if (active_override && next.claimed_or_verified !== CLAIM_STATUS.AUTHORITATIVE) {
    return list.concat([
      {
        ...next,
        active: false,
        claimed_or_verified: CLAIM_STATUS.CONFLICTED,
        conflicts_with_fact_ids: [active_override.fact_id],
      },
    ]);
  }

  // Terminal facts
  if (
    next.fact_type === FACT_TYPES.OPT_OUT ||
    next.fact_type === FACT_TYPES.WRONG_NUMBER ||
    next.fact_type === FACT_TYPES.SOLD_PROPERTY ||
    next.fact_type === FACT_TYPES.NEVER_OWNED
  ) {
    return [
      ...list.map((f) =>
        f.fact_type === next.fact_type ? { ...f, active: false } : f
      ),
      {
        ...next,
        claimed_or_verified:
          next.claimed_or_verified === CLAIM_STATUS.AUTHORITATIVE
            ? CLAIM_STATUS.AUTHORITATIVE
            : CLAIM_STATUS.VERIFIED,
        active: true,
      },
    ];
  }

  // Ownership denied cannot be overwritten by generic ownership_confirmed yeah
  if (next.fact_type === FACT_TYPES.OWNERSHIP_CONFIRMED) {
    const denied = list.find(
      (f) =>
        f.active !== false &&
        (f.fact_type === FACT_TYPES.OWNERSHIP_DENIED ||
          f.fact_type === FACT_TYPES.WRONG_NUMBER ||
          f.fact_type === FACT_TYPES.NEVER_OWNED ||
          f.fact_type === FACT_TYPES.SOLD_PROPERTY)
    );
    if (denied && factPrecedenceScore(next) < factPrecedenceScore(denied) + 50) {
      return list.concat([
        {
          ...next,
          active: false,
          claimed_or_verified: CLAIM_STATUS.CONFLICTED,
          conflicts_with_fact_ids: [denied.fact_id],
        },
      ]);
    }
  }

  // Transaction claims from seller text stay claimed (never verified here)
  const transaction_types = new Set([
    FACT_TYPES.UNDER_CONTRACT_CLAIM,
    FACT_TYPES.ESCROW_OPEN_CLAIM,
    FACT_TYPES.CLOSING_CLAIM,
    FACT_TYPES.CONTRACT_SIGNED_CLAIM,
  ]);
  if (
    transaction_types.has(next.fact_type) &&
    next.claimed_or_verified !== CLAIM_STATUS.AUTHORITATIVE
  ) {
    next.claimed_or_verified = CLAIM_STATUS.CLAIMED;
  }

  // Authoritative event beats seller claim of same type family
  if (next.claimed_or_verified === CLAIM_STATUS.AUTHORITATIVE) {
    const related = list.filter(
      (f) =>
        f.active !== false &&
        (f.fact_type === next.fact_type ||
          (transaction_types.has(f.fact_type) && transaction_types.has(next.fact_type)))
    );
    return [
      ...list.map((f) =>
        related.some((r) => r.fact_id === f.fact_id)
          ? {
              ...f,
              active: false,
              supersedes_fact_id: f.supersedes_fact_id,
            }
          : f
      ),
      {
        ...next,
        supersedes_fact_id: related[0]?.fact_id || null,
        active: true,
      },
    ];
  }

  const same_type = list.filter(
    (f) => f.fact_type === next.fact_type && f.active !== false
  );
  if (!same_type.length) return list.concat([next]);

  const best = same_type.reduce((a, b) =>
    factPrecedenceScore(a) >= factPrecedenceScore(b) ? a : b
  );

  const values_differ =
    JSON.stringify(best.normalized_value) !== JSON.stringify(next.normalized_value);

  // Same value / source → confirm only, avoid duplicate active
  if (
    !values_differ &&
    best.source_message_id &&
    best.source_message_id === next.source_message_id
  ) {
    return list.map((f) =>
      f.fact_id === best.fact_id
        ? {
            ...f,
            last_confirmed_at: next.source_timestamp || f.last_confirmed_at,
            confidence: Math.max(f.confidence, next.confidence),
          }
        : f
    );
  }

  if (values_differ && factPrecedenceScore(next) > factPrecedenceScore(best)) {
    return list
      .map((f) => {
        if (f.fact_id === best.fact_id) {
          return {
            ...f,
            active: false,
            conflicts_with_fact_ids: [
              ...new Set([...(f.conflicts_with_fact_ids || []), next.fact_id]),
            ],
          };
        }
        return f;
      })
      .concat([
        {
          ...next,
          supersedes_fact_id: best.fact_id,
          claimed_or_verified:
            next.claimed_or_verified === CLAIM_STATUS.INFERRED
              ? CLAIM_STATUS.CORRECTED
              : next.claimed_or_verified,
          first_observed_at: best.first_observed_at || next.first_observed_at,
        },
      ]);
  }

  if (factPrecedenceScore(next) <= factPrecedenceScore(best)) {
    if (values_differ) {
      return list
        .map((f) =>
          f.fact_id === best.fact_id
            ? {
                ...f,
                conflicts_with_fact_ids: [
                  ...new Set([...(f.conflicts_with_fact_ids || []), next.fact_id]),
                ],
              }
            : f
        )
        .concat([
          {
            ...next,
            active: false,
            claimed_or_verified: CLAIM_STATUS.CONFLICTED,
            conflicts_with_fact_ids: [best.fact_id],
          },
        ]);
    }
    return list.map((f) =>
      f.fact_id === best.fact_id
        ? {
            ...f,
            last_confirmed_at: next.source_timestamp || f.last_confirmed_at,
            confidence: Math.max(f.confidence, next.confidence),
          }
        : f
    );
  }

  return list
    .map((f) => (f.fact_id === best.fact_id ? { ...f, active: false } : f))
    .concat([{ ...next, supersedes_fact_id: best.fact_id }]);
}

export function resolveActiveFacts(facts = []) {
  const by_type = new Map();
  for (const f of facts || []) {
    if (!f?.fact_type || f.active === false) continue;
    const cur = by_type.get(f.fact_type);
    if (!cur || factPrecedenceScore(f) > factPrecedenceScore(cur)) {
      by_type.set(f.fact_type, f);
    }
  }
  // Stable key order
  const keys = [...by_type.keys()].sort();
  const out = {};
  for (const k of keys) out[k] = by_type.get(k);
  return out;
}

export function sortFactsDeterministically(facts = []) {
  return [...(facts || [])].sort((a, b) => {
    const ta = String(a.fact_type || "");
    const tb = String(b.fact_type || "");
    if (ta !== tb) return ta.localeCompare(tb);
    const sa = factPrecedenceScore(b) - factPrecedenceScore(a);
    if (sa !== 0) return sa;
    return String(a.fact_id || "").localeCompare(String(b.fact_id || ""));
  });
}

/**
 * Adapter boundary: classify.js output → canonical multi-label contract.
 * Inputs: message text + classification object (primary_intent, confidence, language, seller_state).
 * Does not call classify, persist, or advance stages.
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
  const lt = lower(text);
  const primary = lower(c.primary_intent || c.detected_intent || "unclear");
  const conf = Number(c.confidence ?? 0.9) || 0.9;
  const ts = nowIso(source_timestamp);
  const mid = source_message_id ? String(source_message_id) : null;
  const seller = c.seller_state && typeof c.seller_state === "object" ? c.seller_state : {};

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

  // Compliance
  if (primary === "opt_out" || /^stop\b|unsubscribe|remove me/.test(lt)) {
    push({
      fact_type: FACT_TYPES.OPT_OUT,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.VERIFIED,
      evidence_span: findEvidenceSpan(text, text.slice(0, 20)),
    });
  }
  if (primary === "wrong_number" || /wrong number|not me|wrong person/.test(lt)) {
    push({
      fact_type: FACT_TYPES.WRONG_NUMBER,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.VERIFIED,
      evidence_span: findEvidenceSpan(text, "wrong"),
    });
  }
  if (primary === "hostile_or_legal" || /sue|lawyer|attorney|fcc|harass/.test(lt)) {
    push({
      fact_type: FACT_TYPES.HOSTILITY,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
      evidence_span: findEvidenceSpan(text, text.slice(0, 40)),
    });
    if (/sue|lawyer|attorney|fcc/.test(lt)) {
      push({
        fact_type: FACT_TYPES.LEGAL_THREAT,
        value: true,
        normalized_value: true,
        claimed_or_verified: CLAIM_STATUS.CLAIMED,
      });
    }
  }

  // Ownership
  if (
    primary === "ownership_confirmed" ||
    primary === "asks_offer" ||
    seller.ownership_confirmed === true ||
    /^(yeah|yes|yep|i do|si|sí)\b/.test(lt)
  ) {
    push({
      fact_type: FACT_TYPES.OWNERSHIP_CONFIRMED,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
      evidence_span: findEvidenceSpan(text, text.split(/[.,!?]/)[0] || text.slice(0, 20)),
    });
  }
  if (primary === "not_interested" || /not interested|no thanks|no vendo/.test(lt)) {
    push({
      fact_type: FACT_TYPES.NOT_INTERESTED,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
    push({
      fact_type: FACT_TYPES.OWNERSHIP_DENIED,
      value: "not_interested",
      normalized_value: "not_interested",
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
    objections.push("not_interested");
  }
  if (/never owned|don't own|do not own/.test(lt)) {
    push({
      fact_type: FACT_TYPES.NEVER_OWNED,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
  }
  if (/already sold|i sold it|we sold/.test(lt)) {
    push({
      fact_type: FACT_TYPES.SOLD_PROPERTY,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
  }

  // Proposal interest
  if (
    primary === "asks_offer" ||
    /what'?s the proposal|send (me )?(a |the )?proposal|how much (can|would|will)|make (me )?an offer/.test(
      lt
    )
  ) {
    push({
      fact_type: FACT_TYPES.SELLER_REQUESTS_PROPOSAL,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
      evidence_span: findEvidenceSpan(text, "proposal") || findEvidenceSpan(text, "offer"),
    });
    push({
      fact_type: FACT_TYPES.PROPOSAL_INTEREST_CONFIRMED,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
    if (primary === "asks_offer") secondary.push("ownership_confirmed");
  }
  if (/maybe|depends|if the price|might/.test(lt)) {
    push({
      fact_type: FACT_TYPES.CONDITIONAL_INTEREST,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
  }
  if (/who is this|how did you get|where did you get/.test(lt)) {
    push({
      fact_type: FACT_TYPES.CREDIBILITY_QUESTION,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
  }

  // Asking price
  const around = /around|about|approx|roughly|at least|up to|between/.test(lt);
  const range = text.match(
    /(?:between\s+)?\$?\s*(\d{2,3})\s*k\s*(?:-|to|and)\s*\$?\s*(\d{2,3})\s*k/i
  );
  const single_k = text.match(/\$?\s*(\d{2,3})\s*k\b/i);
  const single_full = text.match(/\$\s*([\d,]+)|(\d{5,7})\b/);
  if (range) {
    const lo = Number(range[1]) * 1000;
    const hi = Number(range[2]) * 1000;
    push({
      fact_type: FACT_TYPES.ASKING_PRICE_RANGE,
      value: { min: lo, max: hi, qualifier: around ? "around" : null },
      normalized_value: { min: lo, max: hi },
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
      evidence_span: findEvidenceSpan(text, range[0]),
    });
  } else if (primary === "asking_price_provided" || single_k || single_full) {
    let amount = null;
    let span = text.slice(0, 40);
    if (single_k) {
      amount = Number(single_k[1]) * 1000;
      span = single_k[0];
    } else if (single_full) {
      amount = Number((single_full[1] || single_full[2] || "").replace(/,/g, ""));
      span = single_full[0];
    }
    if (amount != null) {
      push({
        fact_type: FACT_TYPES.ASKING_PRICE,
        value: amount,
        normalized_value: amount,
        claimed_or_verified: CLAIM_STATUS.CLAIMED,
        evidence_span: findEvidenceSpan(text, span),
      });
      if (around) {
        push({
          fact_type: FACT_TYPES.PRICE_FLEXIBILITY,
          value: "approx",
          normalized_value: "approx",
          claimed_or_verified: CLAIM_STATUS.INFERRED,
        });
      }
    }
  }
  if (/owe about|mortgage|still owe|loan balance/.test(lt)) {
    const m = text.match(/(?:owe|balance)\s*(?:about\s*)?\$?\s*([\d,]+|\d+\s*k)/i);
    push({
      fact_type: FACT_TYPES.MORTGAGE_BALANCE_CLAIM,
      value: m?.[1] || true,
      normalized_value: m?.[1] || true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
  }

  // Condition
  if (/roof|hvac|foundation|plumbing|electrical|needs work|repairs?|damage/.test(lt)) {
    const repairs = [];
    if (/roof/.test(lt)) {
      repairs.push("roof");
      push({
        fact_type: FACT_TYPES.ROOF_CONDITION,
        value: "needs_repair",
        normalized_value: "needs_repair",
        claimed_or_verified: CLAIM_STATUS.CLAIMED,
        evidence_span: findEvidenceSpan(text, "roof"),
      });
    }
    if (/hvac/.test(lt)) {
      repairs.push("hvac");
      push({
        fact_type: FACT_TYPES.HVAC_CONDITION,
        value: "needs_repair",
        normalized_value: "needs_repair",
        claimed_or_verified: CLAIM_STATUS.CLAIMED,
        evidence_span: findEvidenceSpan(text, "HVAC") || findEvidenceSpan(text, "hvac"),
      });
    }
    if (/foundation/.test(lt)) repairs.push("foundation");
    if (/plumbing/.test(lt)) repairs.push("plumbing");
    if (/electrical/.test(lt)) repairs.push("electrical");
    push({
      fact_type: FACT_TYPES.CONDITION_SUMMARY,
      value: { repairs, summary: text.slice(0, 200) },
      normalized_value: { repairs },
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
      evidence_span: { text: text.slice(0, 100), start: 0, end: Math.min(100, text.length) },
    });
    for (const item of repairs) {
      push({
        fact_type: FACT_TYPES.REPAIR_ITEM,
        value: item,
        normalized_value: item,
        claimed_or_verified: CLAIM_STATUS.CLAIMED,
        fact_id: makeFactId(FACT_TYPES.REPAIR_ITEM, mid, item),
      });
    }
  }
  if (/vacant|empty/.test(lt)) {
    push({
      fact_type: FACT_TYPES.OCCUPANCY,
      value: "vacant",
      normalized_value: "vacant",
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
    push({
      fact_type: FACT_TYPES.VACANT_PROPERTY,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
  }
  if (/tenant|renter|occupied|leased/.test(lt)) {
    push({
      fact_type: FACT_TYPES.OCCUPANCY,
      value: "occupied",
      normalized_value: "occupied",
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
    if (/tenant|renter/.test(lt)) {
      push({
        fact_type: FACT_TYPES.TENANT_RENTER,
        value: true,
        normalized_value: true,
        claimed_or_verified: CLAIM_STATUS.CLAIMED,
      });
    }
  }

  // Timeline
  if (/asap|soon|this month|next month|30 days|60 days|quick/.test(lt)) {
    push({
      fact_type: FACT_TYPES.DESIRED_TIMELINE,
      value: text.match(/asap|soon|this month|next month|30 days|60 days|quick/i)?.[0] || true,
      normalized_value: "near_term",
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
    push({
      fact_type: FACT_TYPES.URGENCY,
      value: "elevated",
      normalized_value: "elevated",
      claimed_or_verified: CLAIM_STATUS.INFERRED,
    });
  }

  // Authority / co-owner
  if (/husband|wife|spouse|also owns|on title|co-?owner/.test(lt)) {
    push({
      fact_type: FACT_TYPES.CO_OWNER_REQUIRED,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
      evidence_span: findEvidenceSpan(text, "title") || findEvidenceSpan(text, "husband") || findEvidenceSpan(text, "wife"),
    });
    push({
      fact_type: FACT_TYPES.SPOUSE_REQUIRED,
      value: /husband|wife|spouse/.test(lt),
      normalized_value: /husband|wife|spouse/.test(lt),
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
    push({
      fact_type: FACT_TYPES.CAN_EXECUTE_ALONE,
      value: false,
      normalized_value: false,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
  }
  if (/brother|sister|mom|dad|family|my (son|daughter)/.test(lt)) {
    push({
      fact_type: FACT_TYPES.FAMILY_MEMBER,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
    push({
      fact_type: FACT_TYPES.OWNERSHIP_RELATION,
      value: "family_member",
      normalized_value: "family_member",
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
  }
  if (/actually.*owns|my brother owns|not me,/.test(lt)) {
    push({
      fact_type: FACT_TYPES.OWNERSHIP_RELATION,
      value: "family_member",
      normalized_value: "family_member",
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
      confidence: Math.max(conf, 0.92),
    });
    push({
      fact_type: FACT_TYPES.CAN_EXECUTE_ALONE,
      value: false,
      normalized_value: false,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
  }
  if (/probate|passed away|executor|estate|heir/.test(lt)) {
    push({
      fact_type: FACT_TYPES.PROBATE_DETECTED,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
    if (/executor/.test(lt)) {
      push({
        fact_type: FACT_TYPES.EXECUTOR_AUTHORITY_REQUIRED,
        value: true,
        normalized_value: true,
        claimed_or_verified: CLAIM_STATUS.CLAIMED,
      });
    }
    if (/heir/.test(lt)) {
      push({
        fact_type: FACT_TYPES.HEIRSHIP_DETECTED,
        value: true,
        normalized_value: true,
        claimed_or_verified: CLAIM_STATUS.CLAIMED,
      });
    }
    push({
      fact_type: FACT_TYPES.OWNERSHIP_RELATION,
      value: "estate",
      normalized_value: "estate",
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
    push({
      fact_type: FACT_TYPES.HUMAN_REVIEW_REQUIRED,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.INFERRED,
    });
  }
  if (/\bllc\b/.test(lt)) {
    push({
      fact_type: FACT_TYPES.LLC_AUTHORITY_REQUIRED,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
    push({
      fact_type: FACT_TYPES.AUTHORITY_TYPE,
      value: "llc",
      normalized_value: "llc",
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
  }
  if (/\btrust\b/.test(lt)) {
    push({
      fact_type: FACT_TYPES.TRUST_AUTHORITY_REQUIRED,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
    push({
      fact_type: FACT_TYPES.AUTHORITY_TYPE,
      value: "trust",
      normalized_value: "trust",
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
  }
  if (/power of attorney|poa\b/.test(lt)) {
    push({
      fact_type: FACT_TYPES.POWER_OF_ATTORNEY_CLAIM,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
  }

  // Listing / agent
  if (/realtor|listing agent|listed with|my agent/.test(lt)) {
    push({
      fact_type: FACT_TYPES.LISTED_WITH_AGENT,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
    push({
      fact_type: FACT_TYPES.AGENT_INVOLVED,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
  }
  if (/other offer|another buyer|competing/.test(lt)) {
    push({
      fact_type: FACT_TYPES.COMPETING_PROPOSAL,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
  }

  // Contract / transaction claims (claimed only)
  if (/paperwork|send contract|email (me )?the contract|sign(ing)? (the )?contract/.test(lt)) {
    push({
      fact_type: FACT_TYPES.CONTRACT_REQUESTED,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
  }
  if (/under contract|went under contract/.test(lt)) {
    push({
      fact_type: FACT_TYPES.UNDER_CONTRACT_CLAIM,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
  }
  if (/in escrow|escrow open/.test(lt)) {
    push({
      fact_type: FACT_TYPES.ESCROW_OPEN_CLAIM,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
  }
  if (/\bwe closed\b|already closed|closed yesterday|closed last/.test(lt)) {
    push({
      fact_type: FACT_TYPES.CLOSING_CLAIM,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.CLAIMED,
    });
  }

  // Language
  const lang =
    c.language ||
    (/[áéíóúñ¿¡]|\b(sí|hola|gracias|propiedad|precio)\b/.test(lt) ? "Spanish" : "English");
  push({
    fact_type: FACT_TYPES.LANGUAGE,
    value: lang,
    normalized_value: lang,
    claimed_or_verified: CLAIM_STATUS.INFERRED,
  });

  if (primary === "unclear" || text.length < 2) {
    push({
      fact_type: FACT_TYPES.UNCERTAINTY,
      value: true,
      normalized_value: true,
      claimed_or_verified: CLAIM_STATUS.INFERRED,
    });
  }

  const sorted = sortFactsDeterministically(facts);
  const active = resolveActiveFacts(sorted);

  const has = (type) => Boolean(active[type]?.normalized_value || active[type]?.value === true);
  const has_own = has(FACT_TYPES.OWNERSHIP_CONFIRMED);
  const has_prop =
    has(FACT_TYPES.SELLER_REQUESTS_PROPOSAL) || has(FACT_TYPES.PROPOSAL_INTEREST_CONFIRMED);
  const has_price =
    has(FACT_TYPES.ASKING_PRICE) || has(FACT_TYPES.ASKING_PRICE_RANGE);
  const has_condition = has(FACT_TYPES.CONDITION_SUMMARY) || has(FACT_TYPES.REPAIR_ITEM);

  let recommended_stage = "ownership_check";
  let recommended_next_action = "request_ownership";
  if (has(FACT_TYPES.OPT_OUT)) {
    recommended_stage = "terminal";
    recommended_next_action = "opt_out";
  } else if (has(FACT_TYPES.WRONG_NUMBER) || has(FACT_TYPES.NEVER_OWNED) || has(FACT_TYPES.SOLD_PROPERTY)) {
    recommended_stage = "terminal";
    recommended_next_action = "suppress";
  } else if (has_own && has_prop && has_price && has_condition) {
    recommended_stage = "property_condition";
    recommended_next_action = "prepare_proposal_review";
  } else if (has_own && has_prop && has_price) {
    recommended_stage = "property_condition";
    recommended_next_action = "request_condition";
  } else if (has_own && has_prop) {
    recommended_stage = "asking_price";
    recommended_next_action = "request_asking_price";
  } else if (has_own) {
    recommended_stage = "interest_proposal";
    recommended_next_action = "confirm_interest";
  }

  return toJsonSafe({
    primary_intent: primary || "unclear",
    secondary_intents: secondary,
    facts: sorted,
    ownership_relation: active[FACT_TYPES.OWNERSHIP_RELATION]?.normalized_value || null,
    ownership_confidence: has_own ? conf : 0,
    proposal_interest: has_prop,
    asking_price: active[FACT_TYPES.ASKING_PRICE]?.normalized_value ?? null,
    asking_price_currency: "USD",
    asking_price_qualifier: active[FACT_TYPES.PRICE_FLEXIBILITY]?.normalized_value || null,
    condition_facts: active[FACT_TYPES.CONDITION_SUMMARY]?.normalized_value || null,
    timeline: active[FACT_TYPES.DESIRED_TIMELINE]?.value || null,
    occupancy: active[FACT_TYPES.OCCUPANCY]?.normalized_value || null,
    motivation_indicators: [],
    objections,
    listing_agent_involvement: has(FACT_TYPES.LISTED_WITH_AGENT),
    authority_signers: {
      can_execute_alone: active[FACT_TYPES.CAN_EXECUTE_ALONE]?.normalized_value,
      spouse_required: has(FACT_TYPES.SPOUSE_REQUIRED),
      co_owner_required: has(FACT_TYPES.CO_OWNER_REQUIRED),
      authority_type: active[FACT_TYPES.AUTHORITY_TYPE]?.normalized_value || null,
    },
    language: active[FACT_TYPES.LANGUAGE]?.normalized_value || lang,
    contact_instructions: active[FACT_TYPES.CONTACT_INSTRUCTION]?.value || null,
    opt_out: has(FACT_TYPES.OPT_OUT),
    wrong_number: has(FACT_TYPES.WRONG_NUMBER),
    hostility_legal: has(FACT_TYPES.HOSTILITY) || has(FACT_TYPES.LEGAL_THREAT),
    uncertainty: has(FACT_TYPES.UNCERTAINTY),
    recommended_stage,
    recommended_next_action,
    human_review_required:
      has(FACT_TYPES.HUMAN_REVIEW_REQUIRED) ||
      has(FACT_TYPES.HOSTILITY) ||
      has(FACT_TYPES.PROBATE_DETECTED) ||
      has(FACT_TYPES.LLC_AUTHORITY_REQUIRED) ||
      has(FACT_TYPES.TRUST_AUTHORITY_REQUIRED),
    classifier_version,
    contract_version: FACT_CONTRACT_VERSION,
  });
}

/**
 * Apply an authoritative system event to fact state (e.g. closing confirmed).
 */
export function applyAuthoritativeEvent(existing_facts = [], event = {}) {
  const type = clean(event.event_type || event.type);
  const id = clean(event.event_id || event.id) || null;
  const map = {
    closing_confirmed: FACT_TYPES.CLOSING_CLAIM,
    funds_disbursement_confirmed: FACT_TYPES.CLOSING_CLAIM,
    title_escrow_opened: FACT_TYPES.ESCROW_OPEN_CLAIM,
    assignment_or_purchase_contract_executed: FACT_TYPES.CONTRACT_SIGNED_CLAIM,
    under_contract_with_buyer: FACT_TYPES.UNDER_CONTRACT_CLAIM,
  };
  const fact_type = map[type] || event.fact_type;
  if (!fact_type) return existing_facts;
  const incoming = createProvenancedFact({
    fact_type,
    value: true,
    normalized_value: true,
    confidence: 1,
    claimed_or_verified: CLAIM_STATUS.AUTHORITATIVE,
    authoritative_event_id: id,
    authoritative_event_type: type,
    source_message_id: event.source_message_id || null,
    source_timestamp: event.timestamp || null,
    evidence_span: { text: `authoritative:${type}`, start: null, end: null },
  });
  return mergeFactIntoState(existing_facts, incoming);
}

export default {
  FACT_CONTRACT_VERSION,
  CLAIM_STATUS,
  FACT_TYPES,
  FACT_TYPE_SET,
  PRECEDENCE_BANDS,
  toJsonSafe,
  createProvenancedFact,
  factPrecedenceScore,
  applyHumanOverride,
  mergeFactIntoState,
  resolveActiveFacts,
  sortFactsDeterministically,
  buildClassifierResultContract,
  applyAuthoritativeEvent,
};
