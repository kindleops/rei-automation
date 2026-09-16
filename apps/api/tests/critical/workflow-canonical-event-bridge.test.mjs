import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_EVENT_TO_KIND,
  DEFINITION_TRIGGER_TO_KIND,
  TRIGGER_KINDS,
  UNMAPPED_DEFINITION_TRIGGERS,
  canonicalEventToWorkflowEvent,
  canonicalEventTypesForKind,
  definitionTriggersForKind,
  describeTriggerBridge,
  isTriggerKind,
  triggerKindForCanonicalEvent,
  triggerKindForDefinitionTrigger,
} from '../../src/lib/domain/workflow-v2/canonical-event-bridge.js';
import { resolveMatchableTriggerTypes } from '../../src/lib/domain/workflow-v2/execution-service.js';

/**
 * WORKFLOW-STUDIO-MOBILE-LOCK-1B §2/§3/§5 — the canonical event bridge.
 *
 * THE DEFECT. Acquisition emits into `automation_events`; Workflow V2 reads
 * `workflow_events`. The two vocabularies did not overlap at a single point, so
 * not one published workflow could ever be entered. Measured 2026-09-15:
 *
 *   inbound_message_received      1340   the library subscribed
 *   SELLER_NOT_INTERESTED          362   `trigger.inbound_message_received`
 *   OWNER_CONFIRMED                249   and siblings, of which ZERO had ever
 *   HUMAN_REVIEW_REQUESTED          79   been emitted
 *   ...
 *
 * One translation layer maps both sides into a shared kind space. These tests
 * pin the mapping against event types that genuinely occur in production, so it
 * cannot drift into wishful thinking, and pin the two ways it must refuse.
 */

// ───────────────────────────────────────── the production mapping

/** Every entry is an event type observed in production, with its count. */
const OBSERVED = [
  ['inbound_message_received', 1340, TRIGGER_KINDS.INBOUND_REPLY],
  ['SELLER_NOT_INTERESTED', 362, TRIGGER_KINDS.NOT_INTERESTED],
  ['OWNER_CONFIRMED', 249, TRIGGER_KINDS.OWNERSHIP_CONFIRMED],
  ['HUMAN_REVIEW_REQUESTED', 79, TRIGGER_KINDS.HUMAN_REVIEW_REQUESTED],
  ['SELLER_ASKING_PRICE_CAPTURED', 62, TRIGGER_KINDS.ASKING_PRICE_CAPTURED],
  ['SUPPRESSION_APPLIED', 46, TRIGGER_KINDS.SUPPRESSION_APPLIED],
  ['queue_item_failed', 46, TRIGGER_KINDS.MESSAGE_FAILED],
  ['OFFER_INTEREST_CONFIRMED', 40, TRIGGER_KINDS.INTEREST_CONFIRMED],
  ['offer_queued', 32, TRIGGER_KINDS.OFFER_SENT],
  ['stage_changed', 25, TRIGGER_KINDS.STAGE_ENTERED],
  ['underwriting_completed', 14, TRIGGER_KINDS.UNDERWRITING_UPDATED],
  ['opportunity_created', 47, TRIGGER_KINDS.OPPORTUNITY_CREATED],
];

test('every canonical event observed in production resolves to a trigger kind', () => {
  for (const [eventType, count, expected] of OBSERVED) {
    assert.equal(
      triggerKindForCanonicalEvent(eventType), expected,
      `${eventType} (${count} occurrences) must resolve to ${expected}`,
    );
  }
});

test('every mapped kind is a declared kind, with no typos', () => {
  for (const [eventType, kind] of Object.entries(CANONICAL_EVENT_TO_KIND)) {
    assert.ok(isTriggerKind(kind), `${eventType} maps to an undeclared kind: ${kind}`);
  }
  for (const [triggerType, kind] of Object.entries(DEFINITION_TRIGGER_TO_KIND)) {
    assert.ok(isTriggerKind(kind), `${triggerType} maps to an undeclared kind: ${kind}`);
  }
});

/**
 * Repair bookkeeping and shadow telemetry are the highest-volume rows on the
 * bus (RECOVERY_NEXT_ACTION_RESTORED alone is 4,676). Subscribing them would
 * make workflows fire on housekeeping, so they must NOT resolve.
 */
test('bookkeeping and shadow telemetry are not triggers', () => {
  for (const eventType of [
    'RECOVERY_NEXT_ACTION_RESTORED',
    'RECOVERY_STALE_FOLLOWUP_CANCELLED',
    'acquisition_brain_shadow_decision',
    'acquisition_brain_shadow_fact_state',
    'queue_item_sent',
    'FOLLOWUP_SCHEDULED',
  ]) {
    assert.equal(triggerKindForCanonicalEvent(eventType), null, eventType);
  }
});

/** "Scheduled" is not "due" — the due signal comes from the worker. */
test('a scheduled follow-up is not mistaken for a due follow-up', () => {
  assert.equal(triggerKindForCanonicalEvent('FOLLOWUP_SCHEDULED'), null);
  assert.equal(triggerKindForCanonicalEvent('workflow_follow_up_due'), TRIGGER_KINDS.FOLLOW_UP_DUE);
});

// ───────────────────────────────────────── legacy compatibility (§4)

test('the legacy trigger namespace still resolves, so no definition needs rewriting', () => {
  const legacy = {
    'trigger.inbound_message_received': TRIGGER_KINDS.INBOUND_REPLY,
    'trigger.pipeline_stage_changed': TRIGGER_KINDS.STAGE_ENTERED,
    'trigger.ownership_confirmed': TRIGGER_KINDS.OWNERSHIP_CONFIRMED,
    'trigger.interest_confirmed': TRIGGER_KINDS.INTEREST_CONFIRMED,
    'trigger.asking_price_extracted': TRIGGER_KINDS.ASKING_PRICE_CAPTURED,
    'trigger.underwriting_fact_updated': TRIGGER_KINDS.UNDERWRITING_UPDATED,
    'trigger.offer_sent': TRIGGER_KINDS.OFFER_SENT,
    'trigger.message_failed': TRIGGER_KINDS.MESSAGE_FAILED,
    'trigger.manual_enrollment': TRIGGER_KINDS.MANUAL_ENROLLMENT,
    lead_entered_workflow: TRIGGER_KINDS.MANUAL_ENROLLMENT,
  };
  for (const [triggerType, kind] of Object.entries(legacy)) {
    assert.equal(triggerKindForDefinitionTrigger(triggerType), kind, triggerType);
  }
});

test('a definition saved with the canonical vocabulary needs no translation', () => {
  for (const kind of Object.values(TRIGGER_KINDS)) {
    assert.equal(triggerKindForDefinitionTrigger(kind), kind, kind);
  }
});

/**
 * The deliberate gap, asserted so it stays visible. No authoritative canonical
 * event means "classification finished"; the shadow events are not authority
 * and AUTOMATION_NEEDS_REVIEW is an outcome. Two definitions subscribe this and
 * remain unreachable on purpose — remapping them would change what they mean.
 */
test('trigger.classification_completed is unmapped, and declared as such', () => {
  assert.equal(triggerKindForDefinitionTrigger('trigger.classification_completed'), null);
  assert.ok(UNMAPPED_DEFINITION_TRIGGERS.includes('trigger.classification_completed'));
  const bridge = describeTriggerBridge('trigger.classification_completed');
  assert.equal(bridge.bridge_connected, false);
  assert.equal(bridge.reason, 'unrecognised_trigger_type');
});

// ───────────────────────────────────────── the matcher

test('the matcher resolves both spellings of a trigger to the same set', () => {
  const fromCanonical = resolveMatchableTriggerTypes('inbound_message_received');
  const fromLegacy = resolveMatchableTriggerTypes('trigger.inbound_message_received');
  for (const set of [fromCanonical, fromLegacy]) {
    assert.ok(set.includes('trigger.inbound_message_received'), JSON.stringify(set));
    assert.ok(set.includes('inbound_reply'), JSON.stringify(set));
  }
});

/** Backward compatibility: anything that matched before must still match. */
test('an unrecognised event type falls back to an exact match', () => {
  assert.deepEqual(resolveMatchableTriggerTypes('RECOVERY_NEXT_ACTION_RESTORED'), ['RECOVERY_NEXT_ACTION_RESTORED']);
  assert.deepEqual(resolveMatchableTriggerTypes('trigger.classification_completed'), ['trigger.classification_completed']);
  assert.deepEqual(resolveMatchableTriggerTypes(''), []);
});

test('definitionTriggersForKind and canonicalEventTypesForKind are inverses of the maps', () => {
  assert.ok(definitionTriggersForKind(TRIGGER_KINDS.INBOUND_REPLY).includes('trigger.inbound_message_received'));
  const canonical = canonicalEventTypesForKind(TRIGGER_KINDS.INBOUND_REPLY);
  assert.ok(canonical.includes('inbound_message_received'), JSON.stringify(canonical));
  assert.deepEqual(canonicalEventTypesForKind('not_a_kind'), []);
});

/**
 * Manual enrollment resolves to a kind but nothing on the bus produces it. That
 * is operator-initiated by design, and is a different answer from a broken
 * trigger — the surface has to be able to tell them apart.
 */
test('a kind no acquisition event feeds is reported distinctly from a broken trigger', () => {
  const manual = describeTriggerBridge('trigger.manual_enrollment');
  assert.equal(manual.trigger_kind, TRIGGER_KINDS.MANUAL_ENROLLMENT);
  assert.equal(manual.bridge_connected, false);
  assert.equal(manual.reason, 'no_canonical_event_maps_to_kind');

  const connected = describeTriggerBridge('trigger.inbound_message_received');
  assert.equal(connected.bridge_connected, true);
  assert.equal(connected.reason, null);
  assert.ok(connected.canonical_event_types.includes('inbound_message_received'));
});

// ───────────────────────────────────────── normalization and identity (§5)

const automationRow = (over = {}) => ({
  id: 'ae-1',
  event_type: 'OWNER_CONFIRMED',
  dedupe_key: 'owner-confirmed:thread-1:abc',
  source: 'seller_inbound_orchestrator',
  conversation_thread_id: '+15551234567',
  property_id: 'p-1',
  prospect_id: null,
  master_owner_id: 'mo-1',
  payload: { stage: 'ownership_confirmation' },
  created_at: '2026-09-15T00:00:00.000Z',
  ...over,
});

test('a canonical event becomes a workflow event keyed on the CANONICAL identity', () => {
  const mapped = canonicalEventToWorkflowEvent(automationRow());
  assert.equal(mapped.ok, true);
  assert.equal(mapped.trigger_kind, TRIGGER_KINDS.OWNERSHIP_CONFIRMED);
  assert.equal(mapped.event.event_type, TRIGGER_KINDS.OWNERSHIP_CONFIRMED, 'the matcher sees the kind');
  assert.equal(mapped.event.subject_id, '+15551234567');
  assert.equal(mapped.event.subject_type, 'opportunity');
  // Idempotency must key off the ORIGINAL event, or the same acquisition event
  // arriving by two paths would look like two events.
  assert.equal(mapped.event.dedupe_key, 'wf-bridge:ownership_confirmed:owner-confirmed:thread-1:abc');
  assert.equal(mapped.event.context.canonical_event_id, 'ae-1');
  assert.equal(mapped.event.context.canonical_event_type, 'OWNER_CONFIRMED');
  assert.equal(mapped.event.context.canonical_dedupe_key, 'owner-confirmed:thread-1:abc');
  assert.equal(mapped.event.context.canonical_source, 'seller_inbound_orchestrator');
});

test('the same canonical event always produces the same dedupe key', () => {
  const a = canonicalEventToWorkflowEvent(automationRow());
  const b = canonicalEventToWorkflowEvent(automationRow());
  assert.equal(a.event.dedupe_key, b.event.dedupe_key);
});

/** A random fallback would silently disable duplicate suppression entirely. */
test('a canonical event with no dedupe key falls back to its id, never to a random value', () => {
  const mapped = canonicalEventToWorkflowEvent(automationRow({ dedupe_key: null }));
  assert.equal(mapped.event.dedupe_key, 'wf-bridge:ownership_confirmed:id:ae-1');
  const again = canonicalEventToWorkflowEvent(automationRow({ dedupe_key: null }));
  assert.equal(mapped.event.dedupe_key, again.event.dedupe_key);

  const neither = canonicalEventToWorkflowEvent(automationRow({ dedupe_key: null, id: null }));
  assert.equal(neither.event.dedupe_key, null, 'no identity means no key, not a made-up one');
});

/**
 * Provenance is audit data and is read for idempotency, so producer payload
 * must not be able to overwrite it. The first version of the bridge spread the
 * payload LAST, which meant an event carrying its own `canonical_event_id`
 * could claim to have come from a different event.
 */
test('producer payload cannot overwrite canonical provenance', () => {
  const mapped = canonicalEventToWorkflowEvent(automationRow({
    payload: {
      stage: 'x',
      canonical_event_id: 'spoofed',
      canonical_dedupe_key: 'spoofed',
      trigger_kind: 'spoofed',
    },
  }));
  assert.equal(mapped.event.context.stage, 'x', 'real payload fields still come through');
  assert.equal(mapped.event.context.canonical_event_id, 'ae-1');
  assert.equal(mapped.event.context.canonical_dedupe_key, 'owner-confirmed:thread-1:abc');
  assert.equal(mapped.event.context.trigger_kind, TRIGGER_KINDS.OWNERSHIP_CONFIRMED);
});

test('an unmapped canonical event is refused with a reason, not silently dropped', () => {
  const mapped = canonicalEventToWorkflowEvent(automationRow({ event_type: 'RECOVERY_NEXT_ACTION_RESTORED' }));
  assert.equal(mapped.ok, false);
  assert.equal(mapped.reason, 'unmapped_canonical_event');
});

test('a canonical event with no subject is refused', () => {
  const mapped = canonicalEventToWorkflowEvent(automationRow({
    conversation_thread_id: null, property_id: null, payload: {},
  }));
  assert.equal(mapped.ok, false);
  assert.equal(mapped.reason, 'canonical_event_has_no_subject');
});

test('the subject falls back through thread key, opportunity id, then property', () => {
  assert.equal(
    canonicalEventToWorkflowEvent(automationRow({ conversation_thread_id: null, payload: { thread_key: 'tk' } })).event.subject_id,
    'tk',
  );
  assert.equal(
    canonicalEventToWorkflowEvent(automationRow({ conversation_thread_id: null, payload: { opportunity_id: 'opp' } })).event.subject_id,
    'opp',
  );
  assert.equal(
    canonicalEventToWorkflowEvent(automationRow({ conversation_thread_id: null, payload: {} })).event.subject_id,
    'p-1',
  );
});

/**
 * §1 CONTAINMENT. The fixture kinds exist so the runtime can be proven without
 * a test workflow being able to enroll a real seller. If acquisition ever
 * emitted an event mapping to one of them, that guarantee would be gone.
 */
test('no production event type maps to a fixture-only trigger kind', () => {
  const fixtureKinds = new Set([TRIGGER_KINDS.TEST_RUNTIME_PROOF, TRIGGER_KINDS.TEST_RUNTIME_PROOF_REVIEW]);
  const producers = Object.entries(CANONICAL_EVENT_TO_KIND)
    .filter(([, kind]) => fixtureKinds.has(kind))
    .map(([eventType]) => eventType);
  assert.deepEqual(
    producers.sort(),
    ['TEST_WORKFLOW_REVIEW_PROOF', 'TEST_WORKFLOW_RUNTIME_PROOF'],
    'only the explicitly test-owned event types may feed a fixture kind',
  );
});
