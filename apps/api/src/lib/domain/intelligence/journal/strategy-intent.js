/**
 * IC8 STRATEGY INTENT (architecture §5.3). Pure.
 *
 * deriveStrategyIntent(orchestrationResult | queueRow) answers "which strategy
 * did we choose, at which layer, from which candidates" in the brief's
 * taxonomy, using ONLY structured fields that production already writes:
 *   - a send_queue row (H2 hook, or the offline reconstructor): source,
 *     use_case_template, template_id, metadata.{automation_decision_snapshot,
 *     template_snapshot, automation_provenance, template_rotation_*, intent,
 *     followup_reason, operator_action_id};
 *   - the in-scope objects at the H1 hook: transition, negotiation
 *     (strategy_decision), next_best_action, response_strategy, execution
 *     (base_decision, selected_template, queue_row_id), decision.
 * It never infers a strategy from message text. A value with no mapping is
 * reported as unmapped (STRATEGY_LABEL_UNMAPPED), never guessed.
 *
 * Mapping: the code audit's §3.3 table, confirmed by the architecture, plus the
 * IC8.1 owner-approved additions (strategy_label_map@2). Every addition was
 * mapped from its producer contract, its realising template use case and its
 * stage, never from its name alone; the evidence per value is in
 * tmp/ic8/reports/strategy-label-mapping.md. `mapped_value` always carries the
 * raw production value, so a coarse label never loses the original.
 */

export const STRATEGY_LABEL_MAP_VERSION = "strategy_label_map@2";
export const STRATEGY_INTENT_VERSION = "ic8_strategy_intent@1";

export const STRATEGY_LABELS = Object.freeze([
  "ownership_check",
  "offer_interest",
  "asking_price",
  "condition",
  "timeline",
  "clarification",
  "objection_response",
  "rapport",
  "price_anchor",
  "offer_present",
  "follow_up",
  "closing_coordination",
  "hand_off",
]);

export const STRATEGY_LAYERS = Object.freeze([
  "negotiation_router",
  "v2_response_strategy",
  "lifecycle_resolver",
  "intent_profile",
  "clarifier",
  "campaign_objective",
  "followup_policy",
  "operator",
]);

/** Existing production values -> brief taxonomy (code audit §3.3). */
export const STRATEGY_LABEL_MAP = Object.freeze({
  ownership_check: Object.freeze(["ownership_check", "verify_ownership"]),
  offer_interest: Object.freeze(["consider_selling", "discover_seller_interest", "proposal_interest"]),
  asking_price: Object.freeze(["seller_asking_price", "discover_asking_price", "best_price_request"]),
  clarification: Object.freeze([
    "asking_price_follow_up",
    "clarify_asking_price",
    "safe_clarifier",
    "clarify_identity",
    "clarify_authority",
    "clarify_required_signer",
  ]),
  condition: Object.freeze([
    "condition_probe",
    "condition_discovery",
    "occupancy_probe",
    // @2: NBA objective whose V2 use case is condition_probe (S4).
    "discover_condition",
    // @2: occupancy follows occupancy_probe into `condition` (same S4 family;
    // the live condition_probe copy itself asks "vacant or occupied?").
    "discover_occupancy",
    "occupancy_discovery",
    // @2: condition-family use cases in the condition_discovery contract and
    // the valuation-evidence condition question (all S4 / S4B).
    "price_high_condition_probe",
    "repair_clarification",
    "ask_condition_clarifier",
  ]),
  timeline: Object.freeze(["ask_timeline", "discover_timeline"]),
  objection_response: Object.freeze([
    "justify_price",
    "handle_price_objection",
    "identity_response",
    "who_is_this",
    "handle_trust_concern",
    "text_only_redirect",
  ]),
  rapport: Object.freeze(["flexibility_probe", "discover_motivation"]),
  price_anchor: Object.freeze(["comp_anchor", "repair_anchor", "expectation_reset"]),
  offer_present: Object.freeze([
    "initial_offer",
    "conditional_offer",
    "counter_offer",
    "final_authorized_offer",
    "offer_reveal_cash",
    "accept_seller_terms",
    "novation_probe",
    "seller_finance_probe",
    "structured_terms_review",
    // @2: NBA objective realised as offer_reveal_cash (S5A, monetary).
    "prepare_offer",
    // @2: NBA objective for an outstanding offer, realised as counter_offer (S5).
    "negotiate",
    // @2: router strategy whose contract is offer_reveal_cash / initial_offer.
    "direct_purchase",
  ]),
  follow_up: Object.freeze([
    "stage_no_reply",
    "future_nurture",
    "follow_up_later",
    // @2: operator bulk follow-up use case (inbox_bulk_follow_up).
    "reengagement",
  ]),
  closing_coordination: Object.freeze(["contract_information_request", "collect_contract_facts", "contract_next_step"]),
  hand_off: Object.freeze([
    "human_review",
    // @2: the producer's ONLY output is HUMAN_REVIEW with no template family.
    "handle_agent_involvement",
  ]),
});

/**
 * Values that are intentionally NOT strategies and stay unmapped (@2). They
 * mean "send nothing" (suppression / no reply owed) or "operator typed it";
 * mapping them would invent a strategy that was never chosen.
 */
export const STRATEGY_INTENTIONALLY_UNMAPPED = Object.freeze({
  suppress: "NBA objective: suppression/opt-out wins; nothing is sent (STRATEGY_NO_OUTBOUND).",
  no_reply: "NBA objective: no reply is owed; nothing is sent (STRATEGY_NO_OUTBOUND).",
  manual_reply: "operator free-typed reply; strategy unknown (STRATEGY_OPERATOR_UNSPECIFIED).",
  inbox_manual_send_now: "operator free-typed send-now; strategy unknown (STRATEGY_OPERATOR_UNSPECIFIED).",
});
/** Prefix rules (code audit: `nurture_<intent>` -> follow_up). */
export const STRATEGY_PREFIX_MAP = Object.freeze([Object.freeze({ prefix: "nurture_", label: "follow_up" })]);

const VALUE_TO_LABEL = new Map();
for (const [label, values] of Object.entries(STRATEGY_LABEL_MAP)) for (const value of values) VALUE_TO_LABEL.set(value, label);

const LAYER_REASON = Object.freeze({
  negotiation_router: "STRATEGY_LAYER_NEGOTIATION_ROUTER",
  v2_response_strategy: "STRATEGY_LAYER_V2_RESPONSE_STRATEGY",
  lifecycle_resolver: "STRATEGY_LAYER_LIFECYCLE_RESOLVER",
  intent_profile: "STRATEGY_LAYER_INTENT_PROFILE",
  clarifier: "STRATEGY_LAYER_CLARIFIER",
  campaign_objective: "STRATEGY_LAYER_CAMPAIGN_OBJECTIVE",
  followup_policy: "STRATEGY_LAYER_FOLLOWUP_POLICY",
  operator: "STRATEGY_LAYER_OPERATOR",
});

const CAMPAIGN_SOURCES = new Set(["campaign_launch_execution", "enqueue_campaign_target_one"]);
const OPERATOR_SOURCES = new Set(["inbox", "inbox_bulk_follow_up", "manual", "operator"]);
const FOLLOWUP_SOURCES = new Set(["seller_inbound_orchestrator", "seller_followup_scheduler"]);
const OPERATOR_USE_CASES = new Set(["manual_reply", "inbox_manual_send_now"]);
const CODE_RE = /^[a-z0-9][a-z0-9_:.-]{0,79}$/i;

const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();
const obj = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

/** Map one recorded value to the taxonomy, or null. */
export function mapStrategyLabel(value) {
  const v = lower(value);
  if (!v) return null;
  if (VALUE_TO_LABEL.has(v)) return VALUE_TO_LABEL.get(v);
  for (const rule of STRATEGY_PREFIX_MAP) if (v.startsWith(rule.prefix) && v.length > rule.prefix.length) return rule.label;
  return null;
}

/** First candidate value that maps; returns { label, mappedFrom, value }. */
function firstMapped(candidates) {
  for (const [field, value] of candidates) {
    const label = mapStrategyLabel(value);
    if (label) return { label, mappedFrom: field, value: lower(value) };
  }
  return { label: null, mappedFrom: null, value: null };
}

/** Structured production identifiers only (codes, never prose). */
function sourceCodes(entries) {
  const out = {};
  for (const [key, value] of entries) {
    const v = clean(value);
    if (v && CODE_RE.test(v)) out[key] = v;
  }
  return out;
}

function versionsFrom(entries) {
  const out = {};
  for (const [key, value] of entries) {
    const v = clean(value);
    if (v) out[key] = v.slice(0, 120);
  }
  return out;
}

function stringList(value, limit = 60) {
  return Array.isArray(value) ? value.map((v) => clean(v)).filter(Boolean).slice(0, limit) : [];
}

function looksLikeQueueRow(input) {
  if (!input || typeof input !== "object") return false;
  if ("transition" in input || "next_best_action" in input || "response_strategy" in input || "execution" in input) return false;
  return "use_case_template" in input || "queue_status" in input || "metadata" in input || "message_type" in input;
}

function finish({ label, mappedFrom, layer, candidates, chosenUseCase, templateId, propensity = null, extraReasons = [], fingerprint, versions, source, reconstructed, codes, value }) {
  const reasonCodes = [];
  if (layer) reasonCodes.push(LAYER_REASON[layer]);
  else reasonCodes.push("STRATEGY_LAYER_UNKNOWN");
  for (const code of extraReasons) if (!reasonCodes.includes(code)) reasonCodes.push(code);
  if (!label && !extraReasons.includes("STRATEGY_OPERATOR_UNSPECIFIED") && !extraReasons.includes("STRATEGY_NO_OUTBOUND")) {
    reasonCodes.push("STRATEGY_LABEL_UNMAPPED");
  }
  if (reconstructed) reasonCodes.push("STRATEGY_RECONSTRUCTED");
  return {
    strategy_label: label,
    label_map_version: STRATEGY_LABEL_MAP_VERSION,
    intent_version: STRATEGY_INTENT_VERSION,
    layer,
    mapped_from: mappedFrom,
    mapped_value: value,
    candidates,
    chosen_use_case: chosenUseCase || null,
    template_id: templateId || null,
    propensity,
    reason_codes: reasonCodes,
    policy_fingerprint: fingerprint || null,
    versions,
    source,
    reconstructed: Boolean(reconstructed),
    source_codes: codes,
  };
}

function fromQueueRow(row, { reconstructed = false } = {}) {
  const md = obj(row.metadata);
  const snapshot = obj(md.automation_decision_snapshot);
  const provenance = obj(md.automation_provenance);
  const templateSnapshot = obj(md.template_snapshot);
  const selectedSnapshot = obj(md.selected_template_snapshot);
  const source = lower(row.source || md.source);
  const useCase = lower(
    row.use_case_template || md.template_use_case || templateSnapshot.template_use_case || selectedSnapshot.use_case || provenance.template_use_case,
  );
  const templateId = clean(row.template_id || md.selected_template_id || templateSnapshot.template_id || selectedSnapshot.template_id) || null;
  const rotationIds = stringList(md.template_rotation_candidate_ids, 200);
  const poolSize = Number(md.template_rotation_pool_size || rotationIds.length || 0);

  let layer = null;
  let mapped;
  let candidates = [];
  let propensity = null;
  const extra = [];
  if (source === "auto_reply" || Object.keys(snapshot).length > 0) {
    if (lower(snapshot.template_authority) === "lifecycle_resolver") layer = "lifecycle_resolver";
    else if (clean(snapshot.negotiation_strategy)) layer = "negotiation_router";
    else if (snapshot.clarifier_dispatch) layer = "clarifier";
    else layer = "intent_profile";
    const byLayer = {
      negotiation_router: [["negotiation_strategy", snapshot.negotiation_strategy], ["use_case", useCase]],
      lifecycle_resolver: [["required_template_use_case", snapshot.required_template_use_case], ["use_case", useCase]],
      clarifier: [["clarifier", "safe_clarifier"], ["use_case", useCase]],
      intent_profile: [["use_case", useCase], ["required_template_use_case", snapshot.required_template_use_case], ["route_hint", snapshot.route_hint]],
    };
    mapped = firstMapped(byLayer[layer]);
    candidates = stringList(md.allowed_template_stages || snapshot.allowed_template_stages);
  } else if (FOLLOWUP_SOURCES.has(source) || useCase.startsWith("nurture_") || clean(md.followup_reason)) {
    layer = "followup_policy";
    mapped = firstMapped([["use_case", useCase], ["intent", md.intent ? `nurture_${lower(md.intent)}` : null]]);
  } else if (OPERATOR_SOURCES.has(source) || clean(md.operator_action_id) || md.operator_override === true) {
    layer = "operator";
    mapped = OPERATOR_USE_CASES.has(useCase) ? { label: null, mappedFrom: null, value: null } : firstMapped([["use_case", useCase]]);
    if (!mapped.label) extra.push("STRATEGY_OPERATOR_UNSPECIFIED");
  } else if (CAMPAIGN_SOURCES.has(source) || clean(row.campaign_id) || rotationIds.length || clean(md.campaign_mode)) {
    layer = "campaign_objective";
    mapped = firstMapped([["use_case", useCase], ["message_type", row.message_type]]);
  } else {
    mapped = firstMapped([["use_case", useCase]]);
  }
  if (rotationIds.length) {
    candidates = rotationIds;
    if (templateId && rotationIds.includes(templateId) && poolSize > 0) {
      propensity = 1 / poolSize;
      extra.push("STRATEGY_TEMPLATE_ROTATION_LOGGED");
    }
  }
  return finish({
    ...mapped,
    layer,
    candidates,
    chosenUseCase: useCase,
    templateId,
    propensity,
    extraReasons: extra,
    fingerprint: clean(md.policy_fingerprint || snapshot.policy_fingerprint) || null,
    versions: versionsFrom([
      ["classifier", obj(md.classification_snapshot).classifier_version],
      ["template_version", provenance.template_version_id],
    ]),
    source: "queue_row",
    reconstructed,
    codes: sourceCodes([
      ["send_source", source],
      ["route_hint", snapshot.route_hint],
      ["next_action", snapshot.next_action || provenance.next_action],
      ["audit_reason", snapshot.audit_reason],
      ["template_authority", snapshot.template_authority],
      ["template_authority_reason", snapshot.template_authority_reason],
      ["followup_reason", md.followup_reason],
      ["template_selection_reason", md.template_selection_reason],
    ]),
  });
}

function fromOrchestration(result) {
  const execution = obj(result.execution);
  const base = obj(execution.base_decision || execution.decision);
  const negotiation = obj(result.negotiation);
  const strategy = obj(negotiation.strategy_decision || result.strategy_decision);
  const nba = obj(result.next_best_action);
  const rs = obj(result.response_strategy);
  const decision = obj(result.decision);
  const transition = obj(result.transition);
  const selected = obj(execution.selected_template);
  const queued = Boolean(clean(execution.queue_row_id) || execution.queued === true || result.queued === true);
  const useCase = lower(selected.use_case || base.required_template_use_case || rs.template_use_case || strategy.template_use_case);
  const review =
    !queued &&
    Boolean(base.should_mark_human_review || rs.human_review_required || strategy.review_required || decision.should_mark_human_review);

  let layer;
  let mapped;
  const extra = [];
  if (review) {
    layer = strategy.review_required ? "negotiation_router" : rs.human_review_required ? "v2_response_strategy" : "intent_profile";
    mapped = { label: "hand_off", mappedFrom: "review", value: "human_review" };
    extra.push("STRATEGY_HAND_OFF");
  } else if (!queued) {
    layer = clean(rs.objective) ? "v2_response_strategy" : null;
    // the would-have strategy of a turn that queued nothing
    mapped = firstMapped([["objective", rs.objective], ["objective", nba.objective]]);
    extra.push("STRATEGY_NO_OUTBOUND");
  } else if (lower(base.template_authority) === "lifecycle_resolver") {
    layer = clean(rs.template_use_case) && lower(rs.template_use_case) === useCase ? "v2_response_strategy" : "lifecycle_resolver";
    mapped =
      layer === "v2_response_strategy"
        ? firstMapped([["objective", rs.objective], ["use_case", useCase]])
        : firstMapped([["use_case", useCase], ["required_template_use_case", base.required_template_use_case]]);
  } else if (clean(base.negotiation_strategy)) {
    layer = "negotiation_router";
    mapped = firstMapped([["negotiation_strategy", base.negotiation_strategy], ["strategy", strategy.strategy], ["use_case", useCase]]);
  } else if (base.clarifier_dispatch) {
    layer = "clarifier";
    mapped = firstMapped([["clarifier", "safe_clarifier"], ["use_case", useCase]]);
  } else {
    layer = "intent_profile";
    mapped = firstMapped([["use_case", useCase], ["route_hint", base.route_hint]]);
  }
  const candidates = stringList(strategy.allowed_template_use_cases).length
    ? stringList(strategy.allowed_template_use_cases)
    : stringList(base.allowed_template_stages);
  return finish({
    ...mapped,
    layer,
    candidates,
    chosenUseCase: queued ? useCase : null,
    templateId: clean(selected.template_id || selected.id) || null,
    extraReasons: extra,
    fingerprint: clean(result.policy_fingerprint) || null,
    versions: versionsFrom([
      ["nba", nba.version],
      ["response", rs.version],
      ["resolver", transition.version || transition.resolver_version],
      ["negotiation", strategy.version || negotiation.version],
      ["classifier", obj(result.classification).classifier_version],
    ]),
    source: "orchestration",
    reconstructed: false,
    codes: sourceCodes([
      ["strategy_reason", strategy.reason_code],
      ["nba_objective", nba.objective],
      ["nba_reason", nba.reason_code],
      ["response_reason", rs.reason_code],
      ["audit_reason", base.audit_reason],
      ["route_hint", base.route_hint],
      ["next_action", transition.next_action || base.next_action],
    ]),
  });
}

/**
 * @param input  a send_queue row, or the H1 orchestration objects
 * @param opts   { reconstructed } -- true for the offline zero-touch reconstructor
 */
export function deriveStrategyIntent(input, { reconstructed = false } = {}) {
  if (!input || typeof input !== "object") {
    return finish({ label: null, mappedFrom: null, value: null, layer: null, candidates: [], extraReasons: [], versions: {}, source: "unknown", reconstructed, codes: {} });
  }
  return looksLikeQueueRow(input) ? fromQueueRow(input, { reconstructed }) : fromOrchestration(input);
}
