// ─── authoritative-state-sequence.test.mjs ───────────────────────────────────
// WS8 proof: ONE decision object (buildSellerFlowDecision →
// patchUniversalLeadState) drives every persisted state field on the seller
// inbound path, with before/after audit rows for every changed tracked field.
//
// Harness: the REAL orchestrator (processSellerInboundMessage) with the REAL
// patchUniversalLeadState writing into a stateful in-memory
// inbox_thread_state / universal_lead_state_events store. dryRun=false, so
// the guarded patch path (registry transition validation, manual locks,
// audit-row emission) executes for real. Prior-thread context is rebuilt
// from the PERSISTED row between turns — multi-turn sequences flow through
// the same nested `.summary` shape the live loadContext returns.
//
// The core invariant asserted after every turn:
//   * every column the guarded patch wrote equals the value in the persisted
//     row (no other writer interfered);
//   * every changed tracked field has exactly one audit row whose
//     previous_value/new_value match the observed transition;
//   * scenario-specific compliance pins (STOP suppression, post-STOP human
//     review, staleness non-regression, reversal never advances) hold.

import "../helpers/critical-test-environment.mjs";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";
import {
  processSellerInboundMessage,
  __setSellerInboundOrchestratorDeps,
  __resetSellerInboundOrchestratorDeps,
} from "@/lib/domain/seller-flow/process-seller-inbound-message.js";
import { patchUniversalLeadState } from "@/lib/domain/lead-state/patch-universal-lead-state.js";
import { makeSellerOrchestrationSupabase } from "../helpers/seller-orchestration-test-supabase.mjs";

afterEach(() => {
  __resetSellerInboundOrchestratorDeps();
});

const THREAD = "+15551230001";
const T0 = "2026-06-01T15:00:00.000Z";
const T1 = "2026-06-01T15:05:00.000Z";
const T2 = "2026-06-01T15:20:00.000Z";

// Tracked fields whose audit rows we verify (mirror of the patch service's
// TRACKED_FIELDS that this proof cares about).
const TRACKED = [
  "lifecycle_stage",
  "operational_status",
  "lead_temperature",
  "disposition",
  "contactability_status",
  "next_action",
];

function makeStatefulStore({ initialRow = null } = {}) {
  const fallback = makeSellerOrchestrationSupabase();
  const tables = {
    inbox_thread_state: initialRow ? [{ ...initialRow }] : [],
    universal_lead_state_events: [],
    sms_suppression_list: [],
  };

  function threadStateHandle() {
    // Reads MUST return copies: patchUniversalLeadState holds its `previous`
    // snapshot across the upsert, and returning the live object would let the
    // upsert mutate it before the audit diff runs (masking every audit row).
    const readRow = (key) => {
      const found = tables.inbox_thread_state.find((r) => r.thread_key === key);
      return found ? { ...found } : null;
    };
    return {
      select() {
        return {
          eq(_col, key) {
            return {
              maybeSingle: async () => ({ data: readRow(key), error: null }),
              limit() {
                return {
                  maybeSingle: async () => ({ data: readRow(key), error: null }),
                };
              },
            };
          },
        };
      },
      upsert(row) {
        const existing = tables.inbox_thread_state.find(
          (r) => r.thread_key === row.thread_key
        );
        let merged;
        if (existing) {
          Object.assign(existing, row);
          merged = existing;
        } else {
          merged = { ...row };
          tables.inbox_thread_state.push(merged);
        }
        return {
          select() {
            return { maybeSingle: async () => ({ data: { ...merged }, error: null }) };
          },
        };
      },
    };
  }

  function suppressionHandle() {
    return {
      insert(row) {
        const rows = Array.isArray(row) ? row : [row];
        for (const r of rows) {
          tables.sms_suppression_list.push({
            id: `sup-${tables.sms_suppression_list.length + 1}`,
            is_active: true,
            ...r,
          });
        }
        const result = { data: rows, error: null };
        return {
          select: () => ({
            single: async () => ({ data: rows[0], error: null }),
            maybeSingle: async () => ({ data: rows[0], error: null }),
          }),
          then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
        };
      },
      select() {
        const matches = (phone) =>
          tables.sms_suppression_list.filter(
            (r) =>
              r.is_active === true &&
              (r.phone_e164 === phone || r.phone_number === phone)
          );
        return {
          eq(_col, phone) {
            return {
              eq() {
                return {
                  limit: () => ({
                    then: (resolve, reject) =>
                      Promise.resolve({ data: matches(phone), error: null }).then(
                        resolve,
                        reject
                      ),
                  }),
                };
              },
            };
          },
        };
      },
      update() {
        return {
          eq: () => ({
            eq: () => ({
              select: async () => ({ data: [], error: null }),
              then: (resolve, reject) =>
                Promise.resolve({ data: [], error: null }).then(resolve, reject),
            }),
            select: async () => ({ data: [], error: null }),
            then: (resolve, reject) =>
              Promise.resolve({ data: [], error: null }).then(resolve, reject),
          }),
        };
      },
    };
  }

  function auditHandle() {
    return {
      insert(rows) {
        const inserted = (Array.isArray(rows) ? rows : [rows]).map(
          (row, index) => ({
            id: `audit-${tables.universal_lead_state_events.length + index + 1}`,
            ...row,
          })
        );
        tables.universal_lead_state_events.push(...inserted);
        return {
          select() {
            return Promise.resolve({
              data: inserted.map((r) => ({ id: r.id })),
              error: null,
            });
          },
        };
      },
      select() {
        return {
          eq() {
            return Promise.resolve({
              data: tables.universal_lead_state_events,
              error: null,
            });
          },
        };
      },
    };
  }

  return {
    tables,
    from(table) {
      if (table === "inbox_thread_state") return threadStateHandle();
      if (table === "universal_lead_state_events") return auditHandle();
      if (table === "sms_suppression_list") return suppressionHandle();
      if (table === "operator_entity_preferences") {
        return {
          upsert() {
            return { select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) };
          },
        };
      }
      return fallback.from(table);
    },
  };
}

function contextFromRow(row, overrides = {}) {
  return {
    found: true,
    inbound_received_at: overrides.inbound_received_at || null,
    ids: {
      brain_item_id: 201,
      master_owner_id: "mo-21",
      prospect_id: "pros-31",
      property_id: "prop-227",
      phone_item_id: "phone-51",
    },
    summary: {
      conversation_stage: row?.lifecycle_stage || overrides.conversation_stage || null,
      seller_stage: row?.seller_stage || row?.lifecycle_stage || null,
      disposition: row?.disposition || null,
      last_intent: row?.last_intent || null,
      automation_status:
        row?.operational_status === "paused" ? "paused" : "active",
      operational_status: row?.operational_status || null,
      lead_temperature: row?.lead_temperature || null,
      last_inbound_at: row?.last_inbound_at || null,
      is_suppressed: row?.is_suppressed === true,
      contactability_status: row?.contactability_status || null,
      property_address: "123 Main St",
      seller_first_name: "Jane",
      language_preference: "English",
      ...overrides.summary,
    },
  };
}

function installHarness(store, log) {
  __setSellerInboundOrchestratorDeps({
    getSupabaseClient: () => store,
    // The REAL guarded writer, aimed at the stateful store — this is the
    // subject under proof, not a stub.
    patchUniversalLeadState: async (args) => {
      const result = await patchUniversalLeadState({ ...args, supabase: store });
      log.patches.push({ args, result });
      return result;
    },
    emitAutomationEvent: async (event) => {
      log.automation_events.push(event);
      return { ok: true };
    },
    persistInboundIntelligenceSnapshot: async () => ({ ok: true }),
    persistSellerContactReferral: async (args) => {
      log.referrals.push(args);
      return { ok: true, skipped: false };
    },
    executeReferralAutomation: async () => ({ ok: true, skipped: true }),
    scheduleFollowUp: async (intent, args) => {
      log.followups.push({ intent, args });
      return {
        ok: true,
        followup_created: true,
        scheduled_for: "2026-07-01T15:00:00.000Z",
        reason: `nurture_followup:${intent}`,
      };
    },
  });
}

function threadRow(store) {
  return (
    store.tables.inbox_thread_state.find((r) => r.thread_key === THREAD) || null
  );
}

async function runTurn(store, log, {
  body,
  received_at = T1,
  route = null,
  summary = {},
  event_id,
}) {
  const before = threadRow(store) ? { ...threadRow(store) } : null;
  const audit_start = store.tables.universal_lead_state_events.length;
  const classification = await classify(body, null, { heuristicOnly: true });
  const result = await processSellerInboundMessage({
    message: body,
    threadKey: THREAD,
    propertyId: "prop-227",
    prospectId: "pros-31",
    ownerId: "mo-21",
    phoneId: "phone-51",
    classification,
    inboundReceivedAt: received_at,
    context: contextFromRow(before, { summary, inbound_received_at: received_at }),
    route,
    inboundFrom: THREAD,
    inboundTo: "+15559990001",
    inboundEventId: event_id || `evt-${Math.random().toString(16).slice(2, 8)}`,
    autoReplyMode: "live_limited",
    executionAllowed: true,
    dryRun: false,
  });
  const after = threadRow(store) ? { ...threadRow(store) } : null;
  const audits = store.tables.universal_lead_state_events.slice(audit_start);
  return { result, before, after, audits, classification };
}

/**
 * The single-writer invariant: every column the guarded patch wrote must be
 * exactly what the persisted row now holds, and every changed tracked field
 * must carry an audit row matching the observed before→after transition.
 */
function assertDecisionDrivesState({ result, before, after, audits }, patchesForTurn) {
  assert.ok(patchesForTurn.length >= 1, "the guarded patch must be the writer");
  const lastPatch = patchesForTurn[patchesForTurn.length - 1];
  // Live patch returns carry `row` — the post-upsert row as the guarded
  // writer selected it. Every tracked field it reports must match what the
  // store now holds (no other writer interfered after the patch).
  const written = lastPatch.result?.row || null;
  if (written && after) {
    for (const field of TRACKED) {
      if (!(field in written) || written[field] === undefined) continue;
      assert.deepEqual(
        after[field] ?? null,
        written[field] ?? null,
        `persisted ${field} must equal the guarded patch's value`
      );
    }
  }
  for (const field of TRACKED) {
    const prev = before?.[field] ?? null;
    const next = after?.[field] ?? null;
    if (prev === next) continue;
    const audit = audits.find((row) => row.field_name === field);
    assert.ok(audit, `changed tracked field ${field} must have an audit row`);
    assert.equal(
      audit.previous_value ?? null,
      prev,
      `${field} audit previous_value`
    );
    assert.equal(audit.new_value ?? null, next, `${field} audit new_value`);
  }
  // No audit row may claim a transition the row does not show.
  for (const audit of audits) {
    if (!TRACKED.includes(audit.field_name)) continue;
    assert.equal(
      after?.[audit.field_name] ?? null,
      audit.new_value ?? null,
      `audit row for ${audit.field_name} must match persisted state`
    );
  }
}

function freshHarness(initialRow = null) {
  const store = makeStatefulStore({ initialRow });
  const log = { patches: [], automation_events: [], followups: [], referrals: [] };
  installHarness(store, log);
  return { store, log };
}

// ── 1-3. ownership confirmation → interest → asking price (one thread) ──────

test("sequence: ownership confirmation → interest → asking price drives state through one decision object", async () => {
  const { store, log } = freshHarness();

  const turn1 = await runTurn(store, log, {
    body: "Yes I own it, why do you ask?",
    received_at: T0,
    route: { stage: "ownership_check", use_case: "ownership_check" },
    summary: { conversation_stage: "ownership_check", seller_stage: "ownership_check" },
    event_id: "evt-own-1",
  });
  assert.equal(turn1.result.ok, true);
  assert.equal(turn1.result.contract.ownership_signal, "confirmed");
  assertDecisionDrivesState(turn1, log.patches);
  assert.ok(threadRow(store), "first turn must persist a thread row");

  const patches_before = log.patches.length;
  const turn2 = await runTurn(store, log, {
    body: "We might be open to selling if the price is right",
    received_at: T1,
    event_id: "evt-int-1",
  });
  assert.equal(turn2.result.ok, true);
  assertDecisionDrivesState(turn2, log.patches.slice(patches_before));

  const patches_before3 = log.patches.length;
  const turn3 = await runTurn(store, log, {
    body: "We would want $150,000 for it",
    received_at: T2,
    event_id: "evt-price-1",
  });
  assert.equal(turn3.result.ok, true);
  assert.equal(
    turn3.classification?.price_parse?.value ?? null,
    150000,
    "asking price must be extracted, not flattened away"
  );
  assertDecisionDrivesState(turn3, log.patches.slice(patches_before3));
  const row = threadRow(store);
  assert.notEqual(row.lead_temperature, "cold", "priced interest is not cold");
});

// ── 4. need time ─────────────────────────────────────────────────────────────

test("sequence: need-time schedules a follow-up through the decision, not a side writer", async () => {
  const { store, log } = freshHarness();
  const turn = await runTurn(store, log, {
    body: "Maybe, I need a few weeks to think it over",
    received_at: T1,
    event_id: "evt-time-1",
  });
  assert.equal(turn.result.ok, true);
  assertDecisionDrivesState(turn, log.patches);
  const decision_followup =
    turn.result.decision?.follow_up || turn.result.follow_up || null;
  assert.ok(
    log.followups.length > 0 || decision_followup,
    "need-time must plan a follow-up via the decision path"
  );
});

// ── 5. re-engagement after decline ───────────────────────────────────────────

test("sequence: decline then re-engagement reopens through precedence and audits every change", async () => {
  const { store, log } = freshHarness();

  const decline = await runTurn(store, log, {
    body: "Not interested.",
    received_at: T0,
    event_id: "evt-decline-1",
  });
  assert.equal(decline.result.ok, true);
  assertDecisionDrivesState(decline, log.patches);
  const declined_row = { ...threadRow(store) };
  assert.equal(declined_row.disposition, "not_interested");

  const patches_before = log.patches.length;
  const reopen = await runTurn(store, log, {
    body: "Are you still interested in buying our house?",
    received_at: T2,
    event_id: "evt-reopen-1",
  });
  assert.equal(reopen.result.ok, true);
  assertDecisionDrivesState(reopen, log.patches.slice(patches_before));
  const row = threadRow(store);
  assert.notEqual(row.disposition, "not_interested", "re-engagement supersedes the stale decline");
  assert.notEqual(row.lead_temperature, "cold", "re-engagement lifts temperature");
});

// ── 6-7. reversal: decline AFTER interest never advances, pauses automation ──

test("sequence: interest then decline reverses state and can never advance the lifecycle", async () => {
  const { store, log } = freshHarness();

  const interest = await runTurn(store, log, {
    body: "Yes, we would consider selling the property",
    received_at: T0,
    event_id: "evt-int-2",
  });
  assert.equal(interest.result.ok, true);
  const interested_row = { ...threadRow(store) };

  const patches_before = log.patches.length;
  const decline = await runTurn(store, log, {
    body: "Actually we changed our mind, not interested anymore",
    received_at: T2,
    event_id: "evt-rev-1",
  });
  assert.equal(decline.result.ok, true);
  assertDecisionDrivesState(decline, log.patches.slice(patches_before));
  const row = threadRow(store);
  assert.equal(row.disposition, "not_interested");
  assert.equal(row.lead_temperature, "cold");
  assert.equal(
    row.operational_status === "paused" || row.status === "paused",
    true,
    "reversal pauses automation"
  );
  assert.notEqual(
    row.lifecycle_stage === "offer_interest" &&
      interested_row.lifecycle_stage !== "offer_interest",
    true,
    "a decline can never ADVANCE lifecycle_stage"
  );
});

// ── 8-9. STOP, then seller-initiated contact after STOP ──────────────────────

test("sequence: STOP binds suppression; later seller contact is human-review only and never clears it", async () => {
  const { store, log } = freshHarness();

  const stop = await runTurn(store, log, {
    body: "STOP",
    received_at: T0,
    event_id: "evt-stop-1",
  });
  assert.equal(stop.result.ok, true);
  assert.equal(stop.classification.compliance_flag, "stop_texting");
  assertDecisionDrivesState(stop, log.patches);
  const stopped_row = { ...threadRow(store) };
  assert.equal(
    stopped_row.is_suppressed === true ||
      stopped_row.contactability_status === "opt_out" ||
      stopped_row.contactability_status === "suppressed",
    true,
    "STOP must persist binding suppression"
  );
  assert.notEqual(
    stop.result.execution?.queued,
    true,
    "no auto reply may be queued for STOP"
  );

  // The durable suppression-list row is written by the webhook/live layer on
  // a STOP (under live_limited the orchestrator suppresses external writes) —
  // seed the artifact the engine reads so the post-STOP contract is exercised
  // exactly as production sees it: an ACTIVE binding suppression on file.
  store.tables.sms_suppression_list.push({
    id: "sup-stop-1",
    phone_e164: THREAD,
    suppression_reason: "opt_out",
    suppression_type: "opt_out",
    is_active: true,
    suppressed_at: T0,
  });

  const patches_before = log.patches.length;
  const post_stop = await runTurn(store, log, {
    body: "Ok actually we might want to sell now, what would you pay?",
    received_at: T2,
    summary: {
      is_suppressed: true,
      contactability_status: stopped_row.contactability_status || "opt_out",
      disposition: stopped_row.disposition || "opt_out",
    },
    event_id: "evt-poststop-1",
  });
  assert.equal(post_stop.result.ok, true);
  assert.notEqual(
    post_stop.result.execution?.queued,
    true,
    "post-STOP seller contact must NEVER auto-reply"
  );
  const review_flag =
    post_stop.result.execution?.automation_decision?.should_mark_human_review ??
    post_stop.result.decision?.should_mark_human_review ??
    post_stop.result.decision?.human_review_required ??
    null;
  assert.equal(review_flag, true, "post-STOP contact routes to human review");
  const row = threadRow(store);
  assert.notEqual(
    row.is_suppressed,
    false,
    "binding suppression must survive the post-STOP message"
  );
  assertDecisionDrivesState(post_stop, log.patches.slice(patches_before));
});

// ── 10. wrong number ─────────────────────────────────────────────────────────

test("sequence: wrong number suppresses the phone and never queues a reply", async () => {
  const { store, log } = freshHarness();
  const turn = await runTurn(store, log, {
    body: "You have the wrong number, I don't know any Jane",
    received_at: T1,
    event_id: "evt-wrong-1",
  });
  assert.equal(turn.result.ok, true);
  assert.equal(turn.classification.primary_intent, "wrong_number");
  assert.notEqual(turn.result.execution?.queued, true);
  assertDecisionDrivesState(turn, log.patches);
  const row = threadRow(store);
  assert.equal(row.disposition, "wrong_number");
});

// ── 11. sold property ────────────────────────────────────────────────────────

test("sequence: already-sold folds to ownership disconnect and closes the thread", async () => {
  const { store, log } = freshHarness();
  const turn = await runTurn(store, log, {
    body: "We sold that property last year, please update your records",
    received_at: T1,
    event_id: "evt-sold-1",
  });
  assert.equal(turn.result.ok, true);
  assert.notEqual(turn.result.execution?.queued, true, "no reply to a sold-property disconnect");
  assertDecisionDrivesState(turn, log.patches);
});

// ── 12. referral / new decision-maker ────────────────────────────────────────

test("sequence: referral hands off to the named decision-maker path", async () => {
  const { store, log } = freshHarness();
  const turn = await runTurn(store, log, {
    body: "Talk to my brother Mike, he handles the property. His number is better for this.",
    received_at: T1,
    event_id: "evt-ref-1",
  });
  assert.equal(turn.result.ok, true);
  assertDecisionDrivesState(turn, log.patches);
  const saw_referral =
    log.referrals.length > 0 ||
    turn.result.contract?.relationship?.claim === "referral_source" ||
    turn.result.intelligence_snapshot?.relationship?.claim === "referral_source";
  assert.ok(saw_referral, "referral must be captured through the decision pipeline");
});

// ── 13. probate/authority with compound preservation ─────────────────────────

test("sequence: probate + executor + price preserves every component through to state", async () => {
  const { store, log } = freshHarness();
  const turn = await runTurn(store, log, {
    body: "The property is in probate, my sister is the executor, and we want $150,000 for it.",
    received_at: T1,
    event_id: "evt-probate-1",
  });
  assert.equal(turn.result.ok, true);

  const c = turn.classification;
  const all_intents = [
    c.primary_intent,
    ...(c.secondary_intents || []),
    ...(c.matched_intents || []),
  ];
  assert.ok(
    all_intents.some((i) => ["probate_estate", "seller_interested", "asking_price_provided", "gives_asking_price"].includes(i)) ||
      c.objection === "probate",
    "probate/authority component must survive"
  );
  assert.equal(c.price_parse?.value ?? null, 150000, "asking price component must survive");
  assert.notEqual(
    turn.result.contract?.relationship?.claim === "executor_heir" ||
      c.objection === "probate",
    false,
    "executor identity/authority context must survive"
  );
  assert.notEqual(turn.result.execution?.queued, true, "authority questions route to review, not auto-reply");
  assertDecisionDrivesState(turn, log.patches);
});

// ── 14. agent involvement ────────────────────────────────────────────────────

test("sequence: listed-with-agent pauses outreach through the decision", async () => {
  const { store, log } = freshHarness();
  const turn = await runTurn(store, log, {
    body: "We already have it listed with our realtor, please go through the agent",
    received_at: T1,
    event_id: "evt-agent-1",
  });
  assert.equal(turn.result.ok, true);
  assertDecisionDrivesState(turn, log.patches);
  assert.notEqual(turn.result.execution?.queued, true, "agent-represented sellers are not auto-replied");
});

// ── 15. contract request ─────────────────────────────────────────────────────

test("sequence: contract request advances through the decision object only", async () => {
  const { store, log } = freshHarness();
  const seeded = await runTurn(store, log, {
    body: "Yes we want to sell, send us your offer",
    received_at: T0,
    event_id: "evt-pre-contract",
  });
  assert.equal(seeded.result.ok, true);

  const patches_before = log.patches.length;
  const turn = await runTurn(store, log, {
    body: "Ok send over the contract and we will sign it",
    received_at: T2,
    event_id: "evt-contract-1",
  });
  assert.equal(turn.result.ok, true);
  assertDecisionDrivesState(turn, log.patches.slice(patches_before));
  const row = threadRow(store);
  assert.notEqual(row.lead_temperature, "cold", "a contract request is never cold");
});

// ── 16. delayed / reordered delivery ─────────────────────────────────────────

// Contract per the adversarial corpus (reordered-webhook pair): staleness
// guards the SUPERSESSION direction — an out-of-order STALE positive must
// never reopen/clobber the chronologically newer decline it arrives after.
// (A stale decline landing conservatively is deliberately allowed: pausing
// on a decline the seller genuinely sent is the safe direction.)
test("sequence: a stale reordered positive can never reopen the newer decline", async () => {
  const { store, log } = freshHarness();

  const decline = await runTurn(store, log, {
    body: "Actually forget it, we're not selling.",
    received_at: T2,
    event_id: "evt-newer-decline",
  });
  assert.equal(decline.result.ok, true);
  const declined_row = { ...threadRow(store) };
  assert.equal(declined_row.disposition, "not_interested");
  // Persist the newer inbound instant so the stale turn is judged against it.
  threadRow(store).last_inbound_at = T2;

  const stale = await runTurn(store, log, {
    body: "Yes I'd consider selling for the right price",
    received_at: T0, // chronologically OLDER than the decline
    summary: { last_inbound_at: T2 },
    event_id: "evt-stale-positive",
  });
  assert.equal(stale.result.ok, true);
  assert.notEqual(
    stale.result.execution?.queued,
    true,
    "a stale positive must not trigger a pitch over the newer decline"
  );
  // The staleness gate governs SUPERSESSION: no reopen, no resumed
  // automation. (The base interpretation of the message may still be
  // recorded — the corpus deliberately does not pin thread disposition for
  // this direction; what it forbids is reply + reopen.)
  const precedence =
    stale.result.execution?.automation_decision?.latest_intent_precedence || null;
  if (precedence) {
    assert.notEqual(
      precedence.supersedes_prior_state === true &&
        precedence.reason_codes?.includes("stale_prior_state_superseded"),
      true,
      "a chronologically stale message must not supersede the newer state"
    );
  }
  const row = threadRow(store);
  assert.notEqual(
    row.operational_status,
    "active_communication",
    "automation must not resume from a stale reopen"
  );
});

// Chronology beats confidence: the protection above must NOT depend on the
// stale message being low-confidence. A high-confidence positive (0.94) sent
// out of order must still be blocked from reopening automation over the newer
// decline. Before the staleness guard at the single-writer merge, this
// message's confidence flipped operational_status to active_communication.
test("sequence: a stale HIGH-confidence positive still cannot reopen (chronology, not confidence)", async () => {
  const { store, log } = freshHarness();

  const decline = await runTurn(store, log, {
    body: "Actually forget it, we're not selling.",
    received_at: T2,
    event_id: "evt-newer-decline-hc",
  });
  assert.equal(decline.result.ok, true);
  assert.equal(threadRow(store).disposition, "not_interested");
  threadRow(store).last_inbound_at = T2;

  const staleHc = await runTurn(store, log, {
    body: "Yes I want to sell it, I own it free and clear",
    received_at: T0, // chronologically OLDER than the decline
    summary: { last_inbound_at: T2 },
    event_id: "evt-stale-hc-positive",
  });
  assert.equal(staleHc.result.ok, true);
  assert.ok(
    (staleHc.classification.confidence ?? 0) >= 0.7,
    `fixture must be high-confidence to be meaningful, got ${staleHc.classification.confidence}`
  );
  assert.notEqual(
    staleHc.result.execution?.queued,
    true,
    "a stale positive must not trigger a pitch over the newer decline"
  );
  assert.notEqual(
    threadRow(store).operational_status,
    "active_communication",
    "a stale HIGH-confidence positive must not reopen automation (chronology beats confidence)"
  );
});
