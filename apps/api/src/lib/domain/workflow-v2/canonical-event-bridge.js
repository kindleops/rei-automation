// Workflow V2 — the canonical acquisition event bridge.
//
// WHY THIS FILE EXISTS. Measured on production 2026-09-15: the workflow library
// subscribed a `trigger.*` vocabulary of which ZERO events had ever been
// emitted, while acquisition emitted ~10,000 events into `automation_events`
// under entirely different names. Two namespaces, no overlap, so not one
// published workflow could ever be entered.
//
// The fix is ONE explicit translation layer, not a second event stream. This
// module does not emit anything: it maps a canonical event type to a trigger
// KIND, and maps a definition's stored trigger_type to the same kind space.
// Matching then happens on kind. No duplicate `trigger.*` events are
// manufactured to satisfy old names, and no stored definition is rewritten.
//
// THE CANONICAL BUS is `automation_events`. It already carries, as first-class
// columns, every identity the brief requires: dedupe_key (100% populated on
// every event type measured), conversation_thread_id (~100%), property_id,
// prospect_id, master_owner_id, source, created_at. `workflow_events` is
// Workflow V2's own inbox downstream of it.
//
// CONTAINMENT. Building this bridge does NOT arm anything. `matchDefinitions`
// (execution-service.js) still requires `status = 'active'`, and the 14 real
// workflows are `published`. That gate is structural and is the reason this can
// be wired before production activation — the bridge can deliver a canonical
// event to the matcher and the matcher will still select nothing.

/**
 * The trigger kinds. Deliberately small, and every one of them is grounded in
 * an event that either already flows in production or is produced by the
 * workflow scheduler itself. Nothing aspirational.
 */
export const TRIGGER_KINDS = Object.freeze({
  OPPORTUNITY_CREATED: 'opportunity_created',
  STAGE_ENTERED: 'stage_entered',
  OPPORTUNITY_STATUS_CHANGED: 'opportunity_status_changed',
  INBOUND_REPLY: 'inbound_reply',
  OWNERSHIP_CONFIRMED: 'ownership_confirmed',
  INTEREST_CONFIRMED: 'interest_confirmed',
  ASKING_PRICE_CAPTURED: 'asking_price_captured',
  UNDERWRITING_UPDATED: 'underwriting_updated',
  OFFER_SENT: 'offer_sent',
  MESSAGE_FAILED: 'message_failed',
  HUMAN_REVIEW_REQUESTED: 'human_review_requested',
  SUPPRESSION_APPLIED: 'suppression_applied',
  NOT_INTERESTED: 'not_interested',
  FOLLOW_UP_DUE: 'follow_up_due',
  MANUAL_ENROLLMENT: 'manual_enrollment',
  /**
   * FIXTURE ONLY. Exists so the runtime can be proven end-to-end without a
   * test workflow being able to enroll a real seller.
   *
   * The alternative was to point the proof workflow at a real trigger kind such
   * as `ownership_confirmed` — but enrollment happens before any guard node
   * runs, so a live OWNER_CONFIRMED (249 in production) would have enrolled an
   * actual seller into a test workflow. Production emits no event that maps
   * here, so the proof exercises the real bridge, the real matcher, the real
   * runner and the real scheduler while remaining structurally unable to touch
   * production subjects.
   */
  TEST_RUNTIME_PROOF: 'test_runtime_proof',
  /** FIXTURE ONLY — the human-review hold proof, kept separate so a single
   *  proof event cannot match two fixtures and muddy the "exactly one run"
   *  assertion. */
  TEST_RUNTIME_PROOF_REVIEW: 'test_runtime_proof_review',
});

const KIND_VALUES = new Set(Object.values(TRIGGER_KINDS));

/**
 * Canonical production event type -> trigger kind.
 *
 * Every entry is an event type observed in production with a count, so this map
 * cannot drift into wishful thinking. Counts as of 2026-09-15 in comments.
 *
 * Deliberately NOT mapped, and reported rather than guessed:
 *   - `classification_completed` — no authoritative canonical event means
 *     "classification finished". The acquisition_brain_shadow_* events are
 *     SHADOW output, not authority, and AUTOMATION_NEEDS_REVIEW /
 *     AUTOMATION_BLOCKED are orchestrator outcomes rather than a completion
 *     signal. Two definitions subscribe it and stay unreachable until a real
 *     event is identified. Remapping them to something adjacent would change
 *     what those workflows mean.
 *   - `FOLLOWUP_SCHEDULED` — "scheduled" is not "due". The due signal is
 *     produced by the workflow scheduled-task worker, below.
 *   - RECOVERY_*, acquisition_brain_shadow_* — repair and shadow telemetry, not
 *     acquisition transitions. Subscribing them would make workflows fire on
 *     bookkeeping.
 */
export const CANONICAL_EVENT_TO_KIND = Object.freeze({
  // Pipeline / opportunity transitions (opportunity-workflow-bridge.js)
  opportunity_created: TRIGGER_KINDS.OPPORTUNITY_CREATED,              // 47
  opportunity_stage_changed: TRIGGER_KINDS.STAGE_ENTERED,              // 25
  stage_changed: TRIGGER_KINDS.STAGE_ENTERED,                          // 25 (acquisition_opportunity)
  opportunity_status_changed: TRIGGER_KINDS.OPPORTUNITY_STATUS_CHANGED, // 1

  // Seller conversation (textgrid_inbound / seller_inbound_orchestrator)
  inbound_message_received: TRIGGER_KINDS.INBOUND_REPLY,               // 1340
  seller_replied: TRIGGER_KINDS.INBOUND_REPLY,
  inbound_sms: TRIGGER_KINDS.INBOUND_REPLY,
  inbound_sms_received: TRIGGER_KINDS.INBOUND_REPLY,

  OWNER_CONFIRMED: TRIGGER_KINDS.OWNERSHIP_CONFIRMED,                  // 249
  OFFER_INTEREST_CONFIRMED: TRIGGER_KINDS.INTEREST_CONFIRMED,          // 40
  SELLER_ASKING_PRICE_CAPTURED: TRIGGER_KINDS.ASKING_PRICE_CAPTURED,   // 62
  asking_price_captured: TRIGGER_KINDS.ASKING_PRICE_CAPTURED,          // 9
  SELLER_NOT_INTERESTED: TRIGGER_KINDS.NOT_INTERESTED,                 // 362
  HUMAN_REVIEW_REQUESTED: TRIGGER_KINDS.HUMAN_REVIEW_REQUESTED,        // 79
  SUPPRESSION_APPLIED: TRIGGER_KINDS.SUPPRESSION_APPLIED,              // 46

  // Underwriting / offer (seller_negotiation_engine)
  underwriting_completed: TRIGGER_KINDS.UNDERWRITING_UPDATED,          // 14
  underwriting_recalculated: TRIGGER_KINDS.UNDERWRITING_UPDATED,       // 7
  offer_queued: TRIGGER_KINDS.OFFER_SENT,                              // 32

  // Delivery (send_queue_processor)
  queue_item_failed: TRIGGER_KINDS.MESSAGE_FAILED,                     // 46

  // Produced by the workflow scheduled-task worker itself.
  workflow_follow_up_due: TRIGGER_KINDS.FOLLOW_UP_DUE,

  // Fixture-only. Never emitted by acquisition — see TEST_RUNTIME_PROOF.
  TEST_WORKFLOW_RUNTIME_PROOF: TRIGGER_KINDS.TEST_RUNTIME_PROOF,
  TEST_WORKFLOW_REVIEW_PROOF: TRIGGER_KINDS.TEST_RUNTIME_PROOF_REVIEW,
});

/**
 * A definition's STORED trigger_type -> trigger kind.
 *
 * This is the compatibility half (§4): stored definitions keep their historical
 * `trigger.*` strings and still resolve, so nothing has to be rewritten to be
 * reachable. Newly saved definitions should use the kind vocabulary directly,
 * which is why every kind also maps to itself below.
 */
export const DEFINITION_TRIGGER_TO_KIND = Object.freeze({
  'trigger.inbound_message_received': TRIGGER_KINDS.INBOUND_REPLY,
  'trigger.pipeline_stage_changed': TRIGGER_KINDS.STAGE_ENTERED,
  'trigger.ownership_confirmed': TRIGGER_KINDS.OWNERSHIP_CONFIRMED,
  'trigger.interest_confirmed': TRIGGER_KINDS.INTEREST_CONFIRMED,
  'trigger.asking_price_extracted': TRIGGER_KINDS.ASKING_PRICE_CAPTURED,
  'trigger.underwriting_fact_updated': TRIGGER_KINDS.UNDERWRITING_UPDATED,
  'trigger.offer_sent': TRIGGER_KINDS.OFFER_SENT,
  'trigger.message_failed': TRIGGER_KINDS.MESSAGE_FAILED,
  'trigger.follow_up_due': TRIGGER_KINDS.FOLLOW_UP_DUE,
  'trigger.manual_enrollment': TRIGGER_KINDS.MANUAL_ENROLLMENT,
  // The two test fixtures predate the namespace entirely.
  lead_entered_workflow: TRIGGER_KINDS.MANUAL_ENROLLMENT,
  // Every kind is its own trigger_type, so a definition saved with the
  // canonical vocabulary needs no translation.
  ...Object.fromEntries(Object.values(TRIGGER_KINDS).map((kind) => [kind, kind])),
});

/**
 * `trigger.classification_completed` is intentionally absent above. Recorded
 * here so the gap is reportable rather than merely missing, and so a health
 * check can name the affected definitions.
 */
export const UNMAPPED_DEFINITION_TRIGGERS = Object.freeze([
  'trigger.classification_completed',
]);

function clean(value) {
  return String(value ?? '').trim();
}

/** The trigger kind a canonical event should be matched as, or null. */
export function triggerKindForCanonicalEvent(eventType) {
  const key = clean(eventType);
  if (!key) return null;
  return CANONICAL_EVENT_TO_KIND[key] ?? null;
}

/** The trigger kind a stored definition subscribes, or null if unresolvable. */
export function triggerKindForDefinitionTrigger(triggerType) {
  const key = clean(triggerType);
  if (!key) return null;
  return DEFINITION_TRIGGER_TO_KIND[key] ?? null;
}

export function isTriggerKind(value) {
  return KIND_VALUES.has(clean(value));
}

/**
 * The stored trigger_types that resolve to a given kind — including the legacy
 * spellings. This is what lets the matcher keep querying `trigger_type` (an
 * indexed column) instead of scanning every definition to translate it.
 */
export function definitionTriggersForKind(kind) {
  const target = clean(kind);
  if (!target) return [];
  return Object.entries(DEFINITION_TRIGGER_TO_KIND)
    .filter(([, mapped]) => mapped === target)
    .map(([triggerType]) => triggerType);
}

/**
 * The CANONICAL event types that feed a given trigger kind.
 *
 * The inverse of CANONICAL_EVENT_TO_KIND, and the basis for the only honest
 * answer to "has this workflow's trigger ever fired?". A published workflow
 * subscribing `trigger.inbound_message_received` is fed by
 * `inbound_message_received` (1340 occurrences); counting its own legacy name
 * would report 0 forever.
 */
export function canonicalEventTypesForKind(kind) {
  const target = clean(kind);
  if (!target) return [];
  return Object.entries(CANONICAL_EVENT_TO_KIND)
    .filter(([, mapped]) => mapped === target)
    .map(([eventType]) => eventType);
}

/**
 * Can the bridge ever deliver anything to this stored trigger_type?
 *
 * Two separate ways to answer no, and they mean different things:
 *   - the trigger_type resolves to no kind at all (unknown vocabulary)
 *   - it resolves to a kind that no canonical event type maps to
 * Both leave the workflow unreachable, but only the second is a wiring gap.
 */
export function describeTriggerBridge(triggerType) {
  const raw = clean(triggerType);
  const kind = triggerKindForDefinitionTrigger(raw);
  if (!kind) {
    return { trigger_kind: null, bridge_connected: false, reason: 'unrecognised_trigger_type', canonical_event_types: [] };
  }
  const canonicalTypes = canonicalEventTypesForKind(kind);
  if (!canonicalTypes.length) {
    return { trigger_kind: kind, bridge_connected: false, reason: 'no_canonical_event_maps_to_kind', canonical_event_types: [] };
  }
  return { trigger_kind: kind, bridge_connected: true, reason: null, canonical_event_types: canonicalTypes };
}

/**
 * Normalize a canonical `automation_events` row into the shape the workflow
 * event inbox expects, preserving the canonical event's own identity.
 *
 * `canonical_event_id` and `canonical_dedupe_key` are carried through
 * deliberately: idempotency has to key off the ORIGINAL event, not off a key
 * this bridge invents, otherwise the same acquisition event arriving twice
 * through two paths would look like two events.
 */
export function canonicalEventToWorkflowEvent(automationEvent = {}) {
  const eventType = clean(automationEvent.event_type);
  const kind = triggerKindForCanonicalEvent(eventType);
  if (!kind) return { ok: false, reason: 'unmapped_canonical_event', event_type: eventType };

  // conversation_thread_id is the subject acquisition actually keys on, and is
  // populated on essentially every event type measured. The others are
  // fallbacks for event types that predate it.
  const subjectId = clean(automationEvent.conversation_thread_id)
    || clean(automationEvent.payload?.thread_key)
    || clean(automationEvent.payload?.opportunity_id)
    || clean(automationEvent.property_id);
  if (!subjectId) return { ok: false, reason: 'canonical_event_has_no_subject', event_type: eventType };

  const canonicalId = clean(automationEvent.id) || null;
  const canonicalDedupe = clean(automationEvent.dedupe_key) || null;

  return {
    ok: true,
    trigger_kind: kind,
    event: {
      // The matcher sees the KIND, so a definition subscribing either the legacy
      // or the canonical spelling resolves to the same thing.
      event_type: kind,
      subject_type: 'opportunity',
      subject_id: subjectId,
      // Derived from the canonical event's own identity. Falls back to the id
      // only when a source emitted no dedupe key, and never to a random value —
      // a random key would silently disable duplicate suppression.
      dedupe_key: canonicalDedupe
        ? `wf-bridge:${kind}:${canonicalDedupe}`
        : canonicalId
          ? `wf-bridge:${kind}:id:${canonicalId}`
          : null,
      context: {
        // Producer payload FIRST, provenance second. The payload is producer
        // data and must not be able to overwrite the audit trail — a payload
        // carrying its own `canonical_event_id` would otherwise spoof which
        // event a run came from, and idempotency and audit both read these.
        ...(automationEvent.payload && typeof automationEvent.payload === 'object'
          ? automationEvent.payload
          : {}),
        canonical_event_id: canonicalId,
        canonical_event_type: eventType,
        canonical_dedupe_key: canonicalDedupe,
        canonical_source: clean(automationEvent.source) || null,
        canonical_occurred_at: automationEvent.created_at ?? null,
        trigger_kind: kind,
        thread_key: clean(automationEvent.conversation_thread_id) || null,
        property_id: clean(automationEvent.property_id) || null,
        prospect_id: clean(automationEvent.prospect_id) || null,
        master_owner_id: clean(automationEvent.master_owner_id) || null,
      },
    },
  };
}
