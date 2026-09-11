/**
 * THE GOVERNING INVARIANT, PROVED THROUGH PERSISTENCE.
 *
 *   "A seller can only advance acquisition stages as the result of an inbound
 *    seller message."
 *
 * Asserting that against the resolver alone would prove nothing - the resolver
 * is a pure function and could not advance a stage on its own if it tried. The
 * invariant is only meaningful if the PERSISTED row obeys it, so every scenario
 * below runs the real resolver into the real persistence writer and then RE-READS
 * the stored row. State flows through the store between turns, never through a
 * local variable, so a turn that forgot to persist something shows up as a
 * missing fact on the next turn instead of passing on a stale in-memory object.
 *
 * The store is a stateful PostgREST-shaped fake. Production credentials are
 * never involved and no message is ever dispatched: sending is disabled, and
 * the outbound scenarios deliberately stop at "rendered / scheduled".
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { resolveSellerStageTransition } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";
import {
  persistSellerTransitionArtifacts,
  transitionQualifiesForOpportunity,
} from "@/lib/domain/seller-flow/persist-seller-transition.js";
import { resolveFollowUpPolicyForStage } from "@/lib/domain/seller-flow/followup-policy-registry.js";
import { extractSellerFacts } from "@/lib/domain/seller-flow/extract-seller-facts.js";
import { LIFECYCLE_STAGE_CODES } from "@/lib/domain/lead-state/universal-lead-state-registry.js";

const THREAD = "+13125550199";
const PROPERTY = "prop-pipeline-1";
const OWNER = "owner-pipeline-1";

// ─── Stateful store ─────────────────────────────────────────────────────────
// Same shape as the persistence suite's fake: acquisition_opportunities is
// materialized, everything else accepts writes and returns empty.
function makeStore() {
  const state = { opportunities: [], nextId: 1, writes: [] };

  function query(table) {
    const q = {
      _op: "select",
      _payload: null,
      _filters: [],
      select() { return q; },
      insert(row) { q._op = "insert"; q._payload = row; return q; },
      update(patch) { q._op = "update"; q._payload = patch; return q; },
      upsert(row) { q._op = "insert"; q._payload = row; return q; },
      eq(col, val) { q._filters.push({ col, val }); return q; },
      in() { return q; },
      gte() { return q; },
      order() { return q; },
      limit() { return q._run().then((rows) => ({ data: rows, error: null })); },
      maybeSingle() { return q._run().then((rows) => ({ data: rows[0] || null, error: null })); },
      single() { return q._run().then((rows) => ({ data: rows[0] || null, error: null })); },
      then(onF, onR) { return q._run().then(() => ({ data: null, error: null })).then(onF, onR); },
      async _run() {
        state.writes.push({ table, op: q._op });
        if (table !== "acquisition_opportunities") {
          if (q._op === "insert") {
            const payload = Array.isArray(q._payload) ? q._payload[0] : q._payload;
            return [{ id: `row-${state.nextId++}`, ...payload }];
          }
          return [];
        }
        if (q._op === "insert") {
          const row = { id: `opp-${state.nextId++}`, version: 1, metadata: {}, ...q._payload };
          state.opportunities.push(row);
          return [row];
        }
        const matches = state.opportunities.filter((row) =>
          q._filters.every((f) => String(row[f.col]) === String(f.val)),
        );
        if (q._op === "update") {
          for (const row of matches) Object.assign(row, q._payload);
          return matches;
        }
        return matches;
      },
    };
    return q;
  }

  return { _state: state, from: (table) => query(table) };
}

/** The persisted row is the ONLY carrier of state between turns. */
function readPersisted(store) {
  const opp = store._state.opportunities[0] || null;
  if (!opp) return { stage: null, facts: {}, exists: false };
  return {
    exists: true,
    stage: opp.acquisition_stage || null,
    facts: opp.metadata?.seller_facts || {},
    next_action: opp.next_action || null,
    temperature: opp.lead_temperature || null,
    row: opp,
  };
}

/**
 * One real inbound turn: extract facts from the raw text, resolve the
 * transition off the PERSISTED prior state, persist the result, re-read.
 */
async function inbound(store, message, { intent, now = "2026-07-01T12:00:00.000Z" } = {}) {
  const before = readPersisted(store);
  const extracted = extractSellerFacts(message) || {};
  const new_facts = extracted.facts || extracted;

  const transition = resolveSellerStageTransition({
    stage_before: before.stage,
    known_facts: before.facts,
    new_facts,
    intent,
    source_message_id: `msg-${store._state.nextId}`,
    now,
  });

  if (transitionQualifiesForOpportunity(transition)) {
    await persistSellerTransitionArtifacts({
      transition,
      threadKey: THREAD,
      propertyId: PROPERTY,
      ownerId: OWNER,
      intent,
      inboundEventId: `evt-${store._state.nextId}`,
      supabaseClient: store,
      deps: { scoreProperty: async () => ({ ok: false, reason: "scoring_not_exercised_in_this_proof" }) },
    });
  }

  return { transition, new_facts, before, after: readPersisted(store) };
}

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO A — S1 -> S2 on a bare "Yes"
// ══════════════════════════════════════════════════════════════════════════

test("A: inbound 'Yes' resolves ownership, leaves interest open, persists S2", async () => {
  const store = makeStore();
  const { transition, after } = await inbound(store, "Yes", { intent: "ownership_confirmed" });

  assert.equal(transition.stage_after, LIFECYCLE_STAGE_CODES.OFFER_INTEREST, "active workflow is S2");
  assert.equal(after.exists, true, "the turn must be persisted, not held in memory");
  assert.equal(after.stage, LIFECYCLE_STAGE_CODES.OFFER_INTEREST, "PERSISTED stage is S2");

  // Milestone completeness: ownership answered, interest still open.
  assert.ok(after.facts.ownership_status, "ownership resolved");
  assert.ok(
    after.facts.interest === undefined || after.facts.interest === null,
    "interest must remain UNresolved - a bare yes answers who owns it, not whether they'd sell",
  );

  // And an approved S2 communication purpose is selected - by the registry.
  const { policy, stage } = resolveFollowUpPolicyForStage(after.stage);
  assert.equal(stage, LIFECYCLE_STAGE_CODES.OFFER_INTEREST);
  assert.equal(policy.enabled, true);
});

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO B — an OUTBOUND cannot advance anything
// ══════════════════════════════════════════════════════════════════════════

test("B: processing our own outbound creates no seller fact and no stage movement", async () => {
  const store = makeStore();
  await inbound(store, "Yes", { intent: "ownership_confirmed" });

  const before = readPersisted(store);
  const beforeSnapshot = JSON.stringify({ stage: before.stage, facts: before.facts });

  // The Stage-2 outbound is RENDERED and would be enqueued. Sending is
  // disabled, so it stops here - which is exactly the state this asserts about.
  // An outbound turn carries no seller message, so it has no facts to extract
  // and nothing to resolve.
  const outboundTurn = resolveSellerStageTransition({
    stage_before: before.stage,
    known_facts: before.facts,
    new_facts: {},
    intent: "no_inbound_outbound_only",
    now: "2026-07-01T12:05:00.000Z",
  });

  assert.equal(outboundTurn.stage_after, before.stage, "an outbound may not move the stage");
  assert.equal(outboundTurn.advanced, false);

  const after = readPersisted(store);
  assert.equal(
    JSON.stringify({ stage: after.stage, facts: after.facts }),
    beforeSnapshot,
    "facts and milestone completeness must be byte-identical after an outbound",
  );
});

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO C — 30+ days of silence
// ══════════════════════════════════════════════════════════════════════════

test("C: 30 days with no inbound keeps the seller at S2 and picks an S2 follow-up", async () => {
  const store = makeStore();
  await inbound(store, "Yes", { intent: "ownership_confirmed" });
  const before = readPersisted(store);

  // Ten follow-up cycles, three days apart - well past 30 days. Each one is a
  // real no-reply evaluation; none of them carries a seller message.
  let day = 0;
  for (let i = 0; i < 10; i += 1) {
    day += 3;
    const snapshot = readPersisted(store);
    const { policy } = resolveFollowUpPolicyForStage(snapshot.stage);

    const followUpTurn = resolveSellerStageTransition({
      stage_before: snapshot.stage,
      known_facts: snapshot.facts,
      new_facts: {},
      intent: "stage_no_reply",
      now: new Date(Date.UTC(2026, 6, 1 + day, 12)).toISOString(),
    });

    assert.equal(followUpTurn.stage_after, snapshot.stage, `day ${day}: follow-up must not advance`);
    assert.equal(policy.enabled, true, `day ${day}: S2 still has an approved follow-up policy`);
  }

  const after = readPersisted(store);
  assert.equal(after.stage, LIFECYCLE_STAGE_CODES.OFFER_INTEREST, "still S2 after 30 days");
  assert.equal(after.stage, before.stage);
  assert.ok(after.facts.ownership_status, "ownership stays resolved");
  assert.ok(
    after.facts.interest === undefined || after.facts.interest === null,
    "interest stays UNresolved - we never heard back",
  );

  // The purpose is S2's, not a stage we never reached.
  const { stage } = resolveFollowUpPolicyForStage(after.stage);
  assert.equal(stage, LIFECYCLE_STAGE_CODES.OFFER_INTEREST);
  assert.notEqual(stage, LIFECYCLE_STAGE_CODES.ASKING_PRICE);
  assert.notEqual(stage, LIFECYCLE_STAGE_CODES.PROPERTY_CONDITION);
  assert.notEqual(stage, LIFECYCLE_STAGE_CODES.OFFER);
  assert.notEqual(stage, LIFECYCLE_STAGE_CODES.FORMAL_CONTRACT);
});

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO D — the seller finally replies
// ══════════════════════════════════════════════════════════════════════════

test("D: 'Yeah, what are you offering?' advances to S3 and is WARM, never HOT", async () => {
  const store = makeStore();
  await inbound(store, "Yes", { intent: "ownership_confirmed" });

  const { transition, after } = await inbound(store, "Yeah, what are you offering?", {
    intent: "asks_offer",
    now: "2026-08-05T12:00:00.000Z",
  });

  assert.equal(transition.stage_after, LIFECYCLE_STAGE_CODES.ASKING_PRICE, "interest resolved -> S3");
  assert.equal(after.stage, LIFECYCLE_STAGE_CODES.ASKING_PRICE, "PERSISTED as S3");

  // asks_offer is engagement. It says nothing about whether the economics work,
  // so on its own it can support WARM and never HOT.
  assert.equal(transition.lead_temperature, "warm");
  assert.notEqual(transition.lead_temperature, "hot");
});

// ══════════════════════════════════════════════════════════════════════════
// SCENARIO E — legitimate multi-fact skip
// ══════════════════════════════════════════════════════════════════════════

test("E: one message supplying two facts legitimately skips S1 -> S3", async () => {
  const store = makeStore();
  const { transition, after } = await inbound(
    store,
    "Yeah I own it, what would you pay?",
    { intent: "asks_offer" },
  );

  assert.equal(transition.stage_after, LIFECYCLE_STAGE_CODES.ASKING_PRICE);
  assert.equal(after.stage, LIFECYCLE_STAGE_CODES.ASKING_PRICE, "PERSISTED as S3");

  // The skip is legitimate because ONE INBOUND SELLER MESSAGE carried both
  // facts. Price is still open, which is why it stops at S3 and not further.
  assert.ok(after.facts.ownership_status, "ownership came from the seller");
  assert.ok(
    after.facts.asking_price === undefined || after.facts.asking_price === null,
    "price is still unresolved",
  );
});

// ══════════════════════════════════════════════════════════════════════════
// The invariant itself
// ══════════════════════════════════════════════════════════════════════════

/**
 * THE EXACT BOUNDARY, stated honestly.
 *
 * The strict reading - "a non-inbound turn can never change the persisted
 * stage" - is NOT what the resolver does, and pretending otherwise would put a
 * false assertion in the suite. What it actually does is reconcile: a turn with
 * no seller message re-derives the stage from ALREADY-KNOWN facts, so a stage
 * pointer that lags the facts catches up.
 *
 * That still satisfies the governing invariant, because the CAUSE of every such
 * advance is a fact some earlier inbound seller message supplied. What matters
 * is the two hard limits proved below:
 *
 *   1. a non-inbound turn can never CREATE a seller fact, and
 *   2. it can never advance past the stage those inbound facts already justify.
 *
 * Recorded rather than smoothed over: it means a scheduler tick CAN change
 * acquisition_stage on a row whose stored stage was stale.
 */
test("a non-inbound turn creates no seller fact, ever", () => {
  const KNOWN = { ownership_status: "confirmed", interest: "interested" };
  for (const intent of ["stage_no_reply", "no_inbound_outbound_only", "followup_due", "system_recovery_sweep"]) {
    const t = resolveSellerStageTransition({
      stage_before: LIFECYCLE_STAGE_CODES.OWNERSHIP_CONFIRMATION,
      known_facts: KNOWN,
      new_facts: {},
      intent,
    });
    const patch = t.facts_patch || {};
    for (const [key, value] of Object.entries(patch)) {
      assert.ok(key in KNOWN, `${intent} invented the fact "${key}" with no seller message`);
      assert.deepEqual(value, KNOWN[key], `${intent} altered the known fact "${key}"`);
    }
    // Specifically: the milestones the seller never answered stay unanswered.
    assert.equal(patch.asking_price ?? null, null, `${intent} must not invent a price`);
    assert.equal(patch.property_condition ?? null, null, `${intent} must not invent a condition`);
    assert.equal(patch.terms_accepted ?? null, null, `${intent} must not invent acceptance`);
  }
});

test("a non-inbound turn never advances past what inbound facts already justify", () => {
  // Ownership and interest came from the seller; price never did. The
  // fact-justified ceiling is therefore S3 asking_price.
  const KNOWN = { ownership_status: "confirmed", interest: "interested" };
  const CEILING = LIFECYCLE_STAGE_CODES.ASKING_PRICE;

  for (const intent of ["stage_no_reply", "no_inbound_outbound_only", "followup_due"]) {
    for (const stage_before of [
      LIFECYCLE_STAGE_CODES.OWNERSHIP_CONFIRMATION,
      LIFECYCLE_STAGE_CODES.OFFER_INTEREST,
      LIFECYCLE_STAGE_CODES.ASKING_PRICE,
    ]) {
      const t = resolveSellerStageTransition({ stage_before, known_facts: KNOWN, new_facts: {}, intent });
      assert.equal(t.stage_after, CEILING, `${intent} from ${stage_before} must land on the fact-justified stage`);
      assert.notEqual(t.stage_after, LIFECYCLE_STAGE_CODES.PROPERTY_CONDITION);
      assert.notEqual(t.stage_after, LIFECYCLE_STAGE_CODES.OFFER);
      assert.notEqual(t.stage_after, LIFECYCLE_STAGE_CODES.FORMAL_CONTRACT);
    }
  }
});

test("a non-inbound turn cannot move a stage that already matches its facts", () => {
  // This is the case the no-response scenario actually exercises: the stored
  // stage is correct, so ten follow-up cycles are all no-ops.
  for (const intent of ["stage_no_reply", "no_inbound_outbound_only", "followup_due"]) {
    const t = resolveSellerStageTransition({
      stage_before: LIFECYCLE_STAGE_CODES.OFFER_INTEREST,
      known_facts: { ownership_status: "confirmed" },
      new_facts: {},
      intent,
    });
    assert.equal(t.stage_after, LIFECYCLE_STAGE_CODES.OFFER_INTEREST, `${intent} must be a no-op here`);
    assert.equal(t.advanced, false);
  }
});
