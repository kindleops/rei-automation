// ─── readiness-acceptance-scenarios.test.mjs ────────────────────────────────
// PRODUCTION-READINESS ACCEPTANCE SCENARIO SUITE for the acquisition autopilot
// spine (docs/automation/CANONICAL_AUTOMATION_SPINE.md).
//
// Every scenario drives the REAL canonical modules; only I/O is faked
// (supabase, Podio egress, DocuSign dispatch, system values).
//
//   A. Miami 15-unit multifamily: class → template → ask → valuation authority
//      → bounded offers → single acceptance lock → terms snapshot once →
//      contract eligible but auto-send contained.
//   B. Single-family: class-safe wording (hard filter), SFR valuation method,
//      offer authority from the resolver only.
//   C. Class matrix: duplex/triplex/fourplex/5+ wording isolation; unknown ⇒
//      property-neutral only.
//   D. Opt-out mid-negotiation (S5 STOP): 0.99 classification, suppression
//      latch, no reply, no follow-up, planner refusal, no negotiation outbound.
//   E. Wrong number: terminal, no future seller automation.
//   F. Missing valuation authority: fail closed to review, no numbers, renderer
//      refuses offer placeholders.
//   G. Ask far above max: ceiling-bounded forever; acceptance capped at
//      min(ask, ceiling); within_authority ledger honesty.
//   H. Replay idempotency: burst constituent, follow-up scan, offer execution,
//      acceptance terms snapshot.
//   I. Provider transient failure: transport retry only — no follow-up row, no
//      stage/negotiation mutation.
//   J. Seller non-response: never a provider retry; the follow-up scheduler is
//      the only actor, gated by followup_automation_mode.

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

// ── Canonical modules under test (never mocked) ─────────────────────────────
import {
  PROPERTY_COMMUNICATION_CLASSES as CLS,
  resolvePropertyCommunicationClass,
  isTemplateAllowedForCommunicationClass,
  renderedBodyViolationsForClass,
  forbiddenTemplateFieldsForClass,
} from "@/lib/domain/properties/property-communication-class.js";
import { assignTemplateForTargetFast } from "@/lib/domain/campaigns/campaign-target-template-assignment.js";
import { resolveAskingPriceSignal } from "@/lib/domain/seller-flow/monetary-understanding.js";
import { resolveNegotiationTurn } from "@/lib/domain/seller-flow/process-seller-inbound-message.js";
import { NEGOTIATION_STRATEGIES as S } from "@/lib/domain/seller-flow/negotiation-strategy-router.js";
import {
  resolveValuationAuthority,
  VALUATION_METHODS,
} from "@/lib/domain/underwriting/valuation-authority.js";
import {
  applyNegotiationTurn,
  CONTRACT_READINESS,
} from "@/lib/domain/seller-flow/negotiation-state.js";
import {
  recordAcceptanceTermsSnapshot,
  __setRecordTermsSnapshotTestDeps,
  __resetRecordTermsSnapshotTestDeps,
} from "@/lib/domain/agreements/record-terms-snapshot.js";
import FEATURE_FLAGS from "@/lib/config/feature-flags.js";
import {
  maybeSendContractForSigning,
  __setMaybeSendContractForSigningTestDeps,
  __resetMaybeSendContractForSigningTestDeps,
} from "@/lib/domain/contracts/maybe-send-contract-for-signing.js";
import { detectInboundIntent } from "@/lib/domain/classification/classify.js";
import {
  resolveSellerStageTransition,
  NEXT_ACTIONS,
} from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";
import {
  LIFECYCLE_STAGE_CODES,
  CONTACTABILITY_CODES,
} from "@/lib/domain/lead-state/universal-lead-state-registry.js";
import { COMPLIANCE_TERMINAL_INTENTS } from "@/lib/domain/compliance/canonical-no-contact-states.js";
import { maybeQueueSellerStageReply } from "@/lib/domain/seller-flow/maybe-queue-seller-stage-reply.js";
import { resolveReengagementDecision } from "@/lib/domain/seller-flow/reengagement-planner.js";
import { recoverSellerExecutionGaps } from "@/lib/domain/seller-flow/recover-seller-execution-gaps.js";
import {
  appendConstituent,
  constituentKey,
} from "@/lib/domain/seller-flow/seller-inbound-burst-policy.js";
import {
  buildRetryDecision,
  getRetryPolicy,
} from "@/lib/domain/queue/retry-send-queue.js";
import { evaluateTemplatePlaceholders } from "@/lib/domain/templates/render-template.js";

// ── Test-only I/O fixtures ──────────────────────────────────────────────────
import {
  createPodioItem,
  categoryField,
  numberField,
} from "../helpers/test-helpers.js";

const NOW_ISO = "2026-08-07T12:00:00.000Z";
const NOW = Date.parse(NOW_ISO);
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgoIso = (days) => new Date(NOW - days * DAY_MS).toISOString();

// ── Minimal stateful fake supabase (I/O only — mirrors the proven idiom in
//    reengagement-autopilot.test.mjs; supports the recovery sweeps + the
//    canonical scheduler's dedupe-unique insert) ────────────────────────────
function makeFakeSupabase(seed = {}) {
  const state = {
    send_queue: seed.send_queue || [],
    inbox_thread_state: seed.inbox_thread_state || [],
    acquisition_opportunities: seed.acquisition_opportunities || [],
    message_events: seed.message_events || [],
    sms_suppression_list: seed.sms_suppression_list || [],
    other: [],
  };
  let next_id = 9000;

  function rowsFor(table) {
    return state[table] || state.other;
  }

  function pick(row, col) {
    if (col === "metadata->ade_snapshot") return row.metadata?.ade_snapshot ?? null;
    if (col === "metadata->negotiation_state->>terms_accepted") {
      const v = row.metadata?.negotiation_state?.terms_accepted;
      return v == null ? null : String(v);
    }
    if (col === "metadata->seller_flow_decision") return row.metadata?.seller_flow_decision ?? null;
    return row[col];
  }

  function query(table) {
    const q = {
      _op: "select",
      _payload: null,
      _filters: [],
      _limit: null,
      select: () => q,
      insert(payload) {
        q._op = "insert";
        q._payload = payload;
        return q;
      },
      update(patch) {
        q._op = "update";
        q._payload = patch;
        return q;
      },
      upsert(payload) {
        q._op = "upsert";
        q._payload = payload;
        return q;
      },
      eq(col, val) {
        q._filters.push((r) => String(pick(r, col)) === String(val));
        return q;
      },
      neq(col, val) {
        q._filters.push((r) => String(pick(r, col)) !== String(val));
        return q;
      },
      in(col, vals) {
        q._filters.push((r) => vals.map(String).includes(String(pick(r, col))));
        return q;
      },
      is(col, val) {
        q._filters.push((r) => (val === null ? pick(r, col) == null : pick(r, col) === val));
        return q;
      },
      not(col, _op, val) {
        q._filters.push((r) => !(val === null ? pick(r, col) == null : pick(r, col) === val));
        return q;
      },
      lt(col, val) {
        q._filters.push((r) => String(pick(r, col) ?? "") < String(val));
        return q;
      },
      lte(col, val) {
        q._filters.push((r) => String(pick(r, col) ?? "") <= String(val));
        return q;
      },
      gt(col, val) {
        q._filters.push((r) => String(pick(r, col) ?? "") > String(val));
        return q;
      },
      gte(col, val) {
        q._filters.push((r) => String(pick(r, col) ?? "") >= String(val));
        return q;
      },
      or: () => q,
      ilike: () => q,
      order: () => q,
      limit(n) {
        q._limit = n;
        return q;
      },
      maybeSingle() {
        return q._exec().then(({ data, error }) => ({
          data: Array.isArray(data) ? data[0] || null : data,
          error,
        }));
      },
      single() {
        return q.maybeSingle();
      },
      then(onFulfilled, onRejected) {
        return q._exec().then(onFulfilled, onRejected);
      },
      async _exec() {
        const rows = rowsFor(table);
        if (q._op === "insert" || q._op === "upsert") {
          const payload = Array.isArray(q._payload) ? q._payload[0] : q._payload;
          if (
            table === "send_queue" &&
            payload?.dedupe_key &&
            rows.some((r) => r.dedupe_key === payload.dedupe_key)
          ) {
            return { data: null, error: { code: "23505", message: "duplicate key" } };
          }
          const row = { id: `gen-${(next_id += 1)}`, ...payload };
          rows.push(row);
          return { data: [row], error: null };
        }
        const matches = rows.filter((r) => q._filters.every((f) => f(r)));
        if (q._op === "update") {
          for (const row of matches) Object.assign(row, q._payload);
        }
        const limited = q._limit ? matches.slice(0, q._limit) : matches;
        return { data: limited, error: null };
      },
    };
    return q;
  }

  return { _state: state, from: (table) => query(table) };
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO A — Miami 15-unit multifamily
// ═══════════════════════════════════════════════════════════════════════════

const MIAMI_ADE = Object.freeze({
  valuation_low: 1_300_000,
  valuation_mid: 1_500_000,
  valuation_high: 1_650_000,
  valuation_confidence: 78, // ADE-native 0–100 scale
  comp_count: 5,
  investor_ceiling_mid: 1_200_000,
  investor_ceiling_high: 1_280_000,
  buyer_demand_score: 60,
  liquidity_score: 58,
  estimated_repairs: 150_000,
  recommended_cash_offer: 1_050_000,
  minimum_acceptable_offer: 1_000_000,
  evidence: { engine: { name: "acquisition_decision_engine", version: "2.0.0" } },
});

const MIAMI_CONTEXT = Object.freeze({
  property_type: "Multifamily",
  property_type_scope: "multifamily",
  units_count: 15,
  market_name: "Miami",
});

const MIAMI_FACTS = Object.freeze({
  occupancy_status: "tenant_occupied",
  unit_count: 15,
  rents_summary: "14 of 15 occupied, ~$1,450/mo average",
  asking_price: { value: 1_500_000, confidence: 0.9 },
});

function offerStageTransition(overrides = {}) {
  return {
    stage_before: "offer",
    stage_before_number: 5,
    stage_after: "offer",
    stage_after_number: 5,
    advanced: false,
    review_required: false,
    contactability_patch: null,
    facts_patch: { ...MIAMI_FACTS },
    resolved_at: NOW_ISO,
    next_action: "generate_offer",
    ...overrides,
  };
}

// Template catalog: a 5+ scoped template, a neutral template, and a poisoned
// duplex-worded template hiding behind a neutral scope tag.
const TPL_FIVE_PLUS = {
  id: "tpl-5plus",
  template_id: "tpl-5plus",
  is_active: true,
  use_case: "ownership_check",
  stage_code: "S1",
  language: "English",
  property_type_scope: "5+ Units",
  template_body:
    "Hi {{seller_first_name}}, do you still own the building at {{property_address}}? How many units is it now?",
};
const TPL_NEUTRAL = {
  id: "tpl-neutral",
  template_id: "tpl-neutral",
  is_active: true,
  use_case: "ownership_check",
  stage_code: "S1",
  language: "English",
  property_type_scope: "Any Residential",
  template_body: "Hi {{seller_first_name}}, do you still own {{property_address}}?",
};
const TPL_DUPLEX_POISONED = {
  id: "tpl-duplex-poisoned",
  template_id: "tpl-duplex-poisoned",
  is_active: true,
  use_case: "ownership_check",
  stage_code: "S1",
  language: "English",
  property_type_scope: "Any Residential",
  template_body: "Hi {{seller_first_name}}, is your duplex at {{property_address}} still rented?",
};
const TPL_HOUSE = {
  id: "tpl-house",
  template_id: "tpl-house",
  is_active: true,
  use_case: "ownership_check",
  stage_code: "S1",
  language: "English",
  property_type_scope: "Residential",
  template_body: "Hi {{seller_first_name}}, do you still own the house at {{property_address}}?",
};

const CAMPAIGN = {
  id: "camp-readiness",
  objective: "ownership_check",
  language_policy: "English",
  metadata: { stage_code: "S1", template_use_case: "ownership_check" },
};

function makeCampaignTarget(snapshotOverrides = {}) {
  return {
    id: "target-1",
    master_owner_id: "mo_readiness",
    prospect_id: "prospect-1",
    property_id: "prop-1",
    phone_id: "ph-1",
    to_phone_number: "+13055550100",
    market: "miami",
    state: "FL",
    timezone: "America/New_York",
    language: "English",
    owner_name: "Maria Lopez",
    property_address: "12 Ocean Dr",
    routing_status: "ready",
    target_status: "ready",
    metadata: {
      candidate_snapshot: {
        master_owner_id: "mo_readiness",
        prospect_id: "prospect-1",
        property_id: "prop-1",
        phone_id: "ph-1",
        to_phone_number: "+13055550100",
        market: "miami",
        state: "FL",
        timezone: "America/New_York",
        language: "English",
        seller_first_name: "Maria",
        seller_full_name: "Maria Lopez",
        property_address_full: "12 Ocean Dr, Miami, FL 33139",
        property_city: "Miami",
        property_type: "Multifamily",
        ...snapshotOverrides,
      },
      outreach_snapshot: { never_contacted: true },
    },
  };
}

test("A1: units_count=15 classifies multifamily_5_plus", () => {
  const cls = resolvePropertyCommunicationClass({
    units_count: 15,
    property_type: "Multifamily",
  });
  assert.equal(cls, CLS.MULTIFAMILY_5_PLUS);
});

test("A2: opening template selection is 5+ wording — house/duplex wording is never selectable", () => {
  const result = assignTemplateForTargetFast(makeCampaignTarget({ units_count: 15 }), CAMPAIGN, [
    TPL_FIVE_PLUS,
    TPL_NEUTRAL,
    TPL_DUPLEX_POISONED,
    TPL_HOUSE,
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.template_id, "tpl-5plus", "5+ scoped template must win for a 15-unit asset");
  assert.equal(result.property_communication_class, CLS.MULTIFAMILY_5_PLUS);

  // The selected wording carries no violations for the class…
  assert.deepEqual(
    renderedBodyViolationsForClass(TPL_FIVE_PLUS.template_body, CLS.MULTIFAMILY_5_PLUS),
    []
  );
  // …and duplex wording is a hard filter for the class, not a score.
  const duplexGuard = isTemplateAllowedForCommunicationClass(
    TPL_DUPLEX_POISONED,
    CLS.MULTIFAMILY_5_PLUS
  );
  assert.equal(duplexGuard.allowed, false);
  assert.ok(duplexGuard.violations.some((v) => v.includes("duplex")));
});

const miamiAsk = resolveAskingPriceSignal("I want 1.5 million", {
  sourceMessageId: "msg-a-1",
});

test("A3: 'I want 1.5 million' → ask $1,500,000 and asking_price_per_unit $100,000", () => {
  assert.equal(miamiAsk.asking_price?.value, 1_500_000);
  assert.equal(miamiAsk.needs_clarification, false);

  const turn = resolveNegotiationTurn({
    transition: offerStageTransition(),
    priceSignal: miamiAsk,
    priorState: null,
    adeSnapshot: MIAMI_ADE,
    intent: "asking_price_value",
    classificationConfidence: 0.92,
    contextSummary: MIAMI_CONTEXT,
    sourceMessageId: "msg-a-1",
    knownFacts: {},
    newFacts: MIAMI_FACTS,
  });
  assert.equal(turn.state_preview.current_asking_price, 1_500_000);
  assert.equal(turn.state_preview.units_count, 15);
  assert.equal(turn.state_preview.asking_price_per_unit, 100_000);
});

test("A4: resolveValuationAuthority → multifamily_price_per_unit with low/mid/high + target/initial/maximum", () => {
  const authority = resolveValuationAuthority({
    property: { units_count: 15, property_type: "Multifamily" },
    ade_snapshot: MIAMI_ADE,
    facts: MIAMI_FACTS,
  });
  assert.equal(authority.valuation_method, VALUATION_METHODS.MULTIFAMILY_PRICE_PER_UNIT);
  assert.equal(authority.estimated_value_low, 1_300_000);
  assert.equal(authority.estimated_value_mid, 1_500_000);
  assert.equal(authority.estimated_value_high, 1_650_000);
  assert.equal(authority.target_acquisition_price, 1_050_000);
  assert.equal(authority.initial_offer, 1_000_000);
  assert.equal(authority.maximum_acquisition_price, 1_200_000);
  assert.equal(authority.offer_confidence, 0.78, "confidence normalized to the single 0–1 scale");
  assert.equal(authority.units_count, 15);
  assert.equal(authority.estimated_value_per_unit, 100_000);
  assert.equal(authority.maximum_acquisition_price_per_unit, 80_000);
  assert.equal(authority.calculation_version, "ade_2.0.0/valuation_authority_1.0.0");
});

// Turn 1 (ask arrives) and turn 2 (seller counters down) drive the ladder.
const miamiTurn1 = resolveNegotiationTurn({
  transition: offerStageTransition(),
  priceSignal: miamiAsk,
  priorState: null,
  adeSnapshot: MIAMI_ADE,
  intent: "asking_price_value",
  classificationConfidence: 0.92,
  contextSummary: MIAMI_CONTEXT,
  sourceMessageId: "msg-a-1",
  knownFacts: {},
  newFacts: MIAMI_FACTS,
});

const miamiPriorAfterOffer = {
  ...miamiTurn1.state_preview,
  offers_made: [
    { amount: 1_050_000, strategy: S.CONDITIONAL_OFFER, queue_row_id: "q-a-1", within_authority: true },
  ],
  latest_offer: 1_050_000,
  initial_offer: 1_050_000,
};

const miamiCounter = resolveAskingPriceSignal("I could do 1.35 million", {
  reference: 1_500_000,
  negotiationActive: true,
  sourceMessageId: "msg-a-2",
});

const miamiTurn2 = resolveNegotiationTurn({
  transition: offerStageTransition({
    facts_patch: { ...MIAMI_FACTS, asking_price: { value: 1_350_000 } },
  }),
  priceSignal: miamiCounter,
  priorState: miamiPriorAfterOffer,
  adeSnapshot: MIAMI_ADE,
  intent: "seller_counter",
  classificationConfidence: 0.9,
  contextSummary: MIAMI_CONTEXT,
  sourceMessageId: "msg-a-2",
  knownFacts: MIAMI_FACTS,
  newFacts: {},
});

test("A5: every generated offer is ≤ maximum_acquisition_price", () => {
  const decision = miamiTurn1.strategy_decision;
  assert.ok(decision, "S5 turn must route a strategy");
  assert.ok(
    [S.CONDITIONAL_OFFER, S.INITIAL_OFFER].includes(decision.strategy),
    `expected an offer strategy, got ${decision.strategy}`
  );
  assert.equal(decision.monetary.amount, 1_050_000);
  assert.ok(decision.monetary.amount <= 1_200_000);

  for (const offer of miamiTurn2.state_preview.offers_made) {
    if (offer.amount == null) continue;
    assert.ok(offer.amount <= 1_200_000, `ledgered offer ${offer.amount} must be ≤ maximum`);
  }
});

test("A6: a seller counter produces a bounded ladder step within the ceiling", () => {
  assert.equal(miamiCounter.asking_price?.value, 1_350_000);
  assert.equal(miamiTurn2.concession_inputs.seller_moved_amount, 150_000);
  assert.equal(miamiTurn2.strategy_decision.strategy, S.COUNTER_OFFER);
  const amount = miamiTurn2.strategy_decision.monetary.amount;
  assert.equal(amount, 1_125_000, "step = 50% of remaining floor→ceiling authority");
  assert.ok(amount > 1_050_000 && amount <= 1_200_000);
});

// Acceptance: seller accepts our counter — lock EXACTLY once.
const FULL_CONTRACT_FACTS = Object.freeze({
  signers_identified: true,
  seller_email: "maria@example.com",
  vesting_confirmed: true,
  occupancy_access_confirmed: true,
  closing_timing_preference: "30_days",
});

const miamiPreAccept = {
  ...miamiTurn2.state_preview,
  offers_made: [
    ...miamiPriorAfterOffer.offers_made,
    { amount: 1_125_000, strategy: S.COUNTER_OFFER, queue_row_id: "q-a-2", within_authority: true },
  ],
  latest_offer: 1_125_000,
};

const ACCEPT_AT = "2026-08-07T13:00:00.000Z";
const miamiAccepted = applyNegotiationTurn(miamiPreAccept, {
  engine_decision: { outcome: "seller_accepts_offer" },
  ade_snapshot: MIAMI_ADE,
  contract_facts: FULL_CONTRACT_FACTS,
  source_message_id: "msg-a-3",
  now: ACCEPT_AT,
});

test("A7: acceptance locks terms exactly once; duplicate acceptance is suppressed", () => {
  assert.equal(miamiAccepted.terms_accepted, true);
  assert.equal(miamiAccepted.accepted_price, 1_125_000, "seller accepted OUR latest offer");
  assert.equal(miamiAccepted.terms_accepted_at, ACCEPT_AT);
  assert.equal(miamiAccepted.accepted_terms.basis, "seller_accepted_our_offer");
  assert.equal(miamiAccepted.duplicate_acceptance_suppressed, false);

  const replayed = applyNegotiationTurn(miamiAccepted, {
    engine_decision: { outcome: "seller_accepts_offer" },
    ade_snapshot: MIAMI_ADE,
    source_message_id: "msg-a-3-dup",
    now: "2026-08-07T13:05:00.000Z",
  });
  assert.equal(replayed.duplicate_acceptance_suppressed, true, "second acceptance must be suppressed");
  assert.equal(replayed.accepted_price, 1_125_000, "economics stay locked");
  assert.equal(replayed.terms_accepted_at, ACCEPT_AT, "lock timestamp never moves");
});

test("A8: acceptance-time terms snapshot records exactly once (terms_hash dedupe)", async () => {
  const rows = [];
  const fakeClient = {
    from(table) {
      assert.equal(table, "agreement_terms_snapshots");
      return {
        select: () => ({
          eq: (_col, val) => ({
            limit: () => ({
              maybeSingle: async () => ({
                data: rows.find((r) => r.terms_hash === val) || null,
                error: null,
              }),
            }),
          }),
        }),
        insert: (row) => ({
          select: () => ({
            maybeSingle: async () => {
              if (rows.some((r) => r.terms_hash === row.terms_hash)) {
                return { data: null, error: { code: "23505", message: "duplicate key" } };
              }
              const stored = { id: `snap-${rows.length + 1}`, ...row };
              rows.push(stored);
              return { data: stored, error: null };
            },
          }),
        }),
      };
    },
  };

  __setRecordTermsSnapshotTestDeps({
    hasSupabaseConfig: () => true,
    getClient: () => fakeClient,
    logger: { info() {}, warn() {} },
  });
  try {
    const opportunity = {
      id: "opp-miami-1",
      primary_thread_key: "+13055550100",
      primary_property_id: "prop-1",
      master_owner_id: "mo_readiness",
    };
    const first = await recordAcceptanceTermsSnapshot(miamiAccepted, opportunity);
    assert.equal(first.ok, true);
    assert.equal(first.recorded, true);
    assert.equal(first.deduped, false);
    assert.ok(first.terms_hash);

    const replay = await recordAcceptanceTermsSnapshot(miamiAccepted, opportunity);
    assert.equal(replay.ok, true);
    assert.equal(replay.recorded, false);
    assert.equal(replay.deduped, true);
    assert.equal(replay.reason, "terms_snapshot_already_recorded");
    assert.equal(replay.terms_hash, first.terms_hash);
    assert.equal(rows.length, 1, "exactly one durable snapshot row");
  } finally {
    __resetRecordTermsSnapshotTestDeps();
  }
});

test("A9: contract flow becomes eligible but auto contract send stays contained", async () => {
  // Acceptance + complete contract facts ⇒ the contract lane is READY.
  assert.equal(miamiAccepted.contract_readiness, CONTRACT_READINESS.READY);
  assert.deepEqual(miamiAccepted.unresolved_contract_fields, []);

  // The containment boundary (spine §5): ENABLE_AUTO_CONTRACT_SEND defaults
  // false and MUST be false in this environment. run-deals-autopilot maps
  // flag=false → reason "auto_contract_send_disabled" before any dispatch.
  assert.equal(FEATURE_FLAGS.ENABLE_AUTO_CONTRACT_SEND, false);

  // Real send path with the flag's value as auto_send: a fully sendable
  // contract still produces NO signature dispatch, with an explicit reason.
  const docusignCalls = [];
  __setMaybeSendContractForSigningTestDeps({
    sendContractViaDocusign: async (...args) => {
      docusignCalls.push(args);
      return { ok: true, envelope_id: "should-never-exist" };
    },
    syncPipelineState: async () => ({ ok: true }),
    createMessageEvent: async () => ({ ok: true }),
  });
  try {
    const contract_item = createPodioItem(9001, {
      category: categoryField("Draft"),
    });
    const result = await maybeSendContractForSigning({
      contract: contract_item,
      template_id: "docusign-template-1",
      signers: [{ name: "Maria Lopez", email: "maria@example.com", role_name: "Seller" }],
      auto_send: FEATURE_FLAGS.ENABLE_AUTO_CONTRACT_SEND,
    });
    assert.equal(result.ok, true);
    assert.equal(result.sent, false, "no signature dispatch while contained");
    assert.equal(result.attempted, false);
    assert.equal(result.reason, "auto_send_disabled", "gate reason is explicit");
    assert.equal(result.ready, true, "the contract itself was sendable — only the gate held");
    assert.equal(docusignCalls.length, 0, "DocuSign egress never invoked");
  } finally {
    __resetMaybeSendContractForSigningTestDeps();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO B — Single-family
// ═══════════════════════════════════════════════════════════════════════════

const SFR_ADE = Object.freeze({
  valuation_low: 240_000,
  valuation_mid: 260_000,
  valuation_high: 280_000,
  valuation_confidence: 82,
  comp_count: 6,
  investor_ceiling_mid: 205_000,
  investor_ceiling_high: 215_000,
  buyer_demand_score: 70,
  liquidity_score: 75,
  estimated_repairs: 25_000,
  recommended_cash_offer: 185_000,
  minimum_acceptable_offer: 175_000,
  evidence: { engine: { name: "acquisition_decision_engine", version: "2.0.0" } },
});

test("B1: single-family classifies single_family", () => {
  assert.equal(
    resolvePropertyCommunicationClass({ units_count: 1, property_type: "Single Family" }),
    CLS.SINGLE_FAMILY
  );
});

test("B2: no duplex/triplex/fourplex/unit placeholders or wording are selectable for an SFR", () => {
  // Placeholder-level: every unit-scoped field is forbidden for the class.
  assert.deepEqual(forbiddenTemplateFieldsForClass(CLS.SINGLE_FAMILY), [
    "unit_count",
    "occupied_units",
    "monthly_rents",
    "monthly_expenses",
  ]);
  const unitPlaceholderTemplate = {
    template_body: "Hi {{seller_first_name}}, are all {{unit_count}} units at {{property_address}} rented?",
  };
  assert.equal(
    isTemplateAllowedForCommunicationClass(unitPlaceholderTemplate, CLS.SINGLE_FAMILY).allowed,
    false
  );

  // Wording-level: plex + units wording all hard-blocked.
  for (const wording of ["duplex", "triplex", "fourplex", "all 3 units are rented"]) {
    const violations = renderedBodyViolationsForClass(
      `Is your ${wording} still available?`,
      CLS.SINGLE_FAMILY
    );
    assert.ok(violations.length > 0, `expected wording violation for "${wording}"`);
  }

  // Selection-level: with only class-unsafe templates the target blocks.
  const sfrTarget = makeCampaignTarget({ property_type: "Single Family", units_count: 1 });
  const blocked = assignTemplateForTargetFast(sfrTarget, CAMPAIGN, [TPL_DUPLEX_POISONED]);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.block_reason, "no_template_for_communication_class");

  // With a neutral template available, the SFR lands there — never on wording.
  const routed = assignTemplateForTargetFast(sfrTarget, CAMPAIGN, [TPL_DUPLEX_POISONED, TPL_NEUTRAL]);
  assert.equal(routed.ok, true);
  assert.equal(routed.template_id, "tpl-neutral");
  assert.equal(routed.property_communication_class, CLS.SINGLE_FAMILY);
});

test("B3: unit wording is not RENDERABLE for an SFR even with every variable filled", () => {
  const evaluation = evaluateTemplatePlaceholders({
    template_text: "Hi {{seller_first_name}}, is the duplex at {{property_address}} still rented?",
    use_case: "ownership_check",
    context: {},
    overrides: { seller_first_name: "Sam", property_address: "44 Pine St" },
    property_communication_class: CLS.SINGLE_FAMILY,
  });
  assert.equal(evaluation.ok, false);
  assert.ok(evaluation.safety_violations.class_wording_violations.length > 0);
});

test("B4: SFR valuation method is sfr_comp_ppsf_arv; offer authority comes from the resolver only", () => {
  const authority = resolveValuationAuthority({
    property: { units_count: 1, property_type: "Single Family" },
    ade_snapshot: SFR_ADE,
    facts: {},
  });
  assert.equal(authority.valuation_method, VALUATION_METHODS.SFR_COMP_PPSF_ARV);
  assert.equal(authority.maximum_acquisition_price, 205_000);
  assert.equal(authority.target_acquisition_price, 185_000);
  assert.equal(authority.initial_offer, 175_000);
  assert.equal(authority.estimated_value_per_unit, null, "per-unit fields never fabricated for SFR");
  assert.equal(authority.maximum_acquisition_price_per_unit, null);

  // No engine output ⇒ no numbers from anywhere else (fallbacks retired, G6).
  const absent = resolveValuationAuthority({
    property: { units_count: 1, property_type: "Single Family" },
    ade_snapshot: null,
  });
  assert.equal(absent.valuation_method, VALUATION_METHODS.INSUFFICIENT_DATA);
  assert.deepEqual(absent.reason_codes, ["valuation_authority_absent"]);
  assert.equal(absent.maximum_acquisition_price, null);
  assert.equal(absent.target_acquisition_price, null);
  assert.equal(absent.initial_offer, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO C — Class matrix
// ═══════════════════════════════════════════════════════════════════════════

const PLEX_MATRIX = [
  { cls: CLS.DUPLEX, units: 2, own: "duplex", forbidden: ["triplex", "fourplex", "5+ units"] },
  { cls: CLS.TRIPLEX, units: 3, own: "triplex", forbidden: ["duplex", "fourplex", "5+ units"] },
  { cls: CLS.FOURPLEX, units: 4, own: "fourplex", forbidden: ["duplex", "triplex", "5+ units"] },
  { cls: CLS.MULTIFAMILY_5_PLUS, units: 7, own: "5+ units", forbidden: ["duplex", "triplex", "fourplex"] },
];

for (const { cls, units, own, forbidden } of PLEX_MATRIX) {
  test(`C1: ${cls} (units_count=${units}) may use "${own}" wording but never ${forbidden.join("/")}`, () => {
    assert.equal(resolvePropertyCommunicationClass({ units_count: units }), cls);

    assert.deepEqual(
      renderedBodyViolationsForClass(`Is the ${own} still available?`, cls),
      [],
      `${cls} must accept its own wording`
    );
    for (const wording of forbidden) {
      const violations = renderedBodyViolationsForClass(`Is the ${wording} still available?`, cls);
      assert.ok(violations.length > 0, `${cls} must forbid "${wording}" wording`);
    }
  });
}

test("C2: campaign selection lands each class on class-safe wording only", () => {
  const scoped = (id, scope, wording) => ({
    id,
    template_id: id,
    is_active: true,
    use_case: "ownership_check",
    stage_code: "S1",
    language: "English",
    property_type_scope: scope,
    template_body: `Hi {{seller_first_name}}, is the ${wording} at {{property_address}} still yours?`,
  });
  const TPL_BY_CLASS = {
    [CLS.DUPLEX]: scoped("tpl-duplex", "Duplex", "duplex"),
    [CLS.TRIPLEX]: scoped("tpl-triplex", "Triplex", "triplex"),
    [CLS.FOURPLEX]: scoped("tpl-fourplex", "Fourplex", "fourplex"),
    [CLS.MULTIFAMILY_5_PLUS]: { ...TPL_FIVE_PLUS },
  };
  const fullCatalog = [...Object.values(TPL_BY_CLASS), { ...TPL_NEUTRAL }];

  // NOTE (verified behavior, spine §7/G2): for 2–4 units the scope expansion
  // admits ALL small-multi scopes plus the neutral scopes as candidates; the
  // class wording guard then hard-filters cross-plex wording and deterministic
  // rotation picks among the REMAINING SAFE set (own wording + neutral). The
  // guarantee under acceptance is class-SAFETY of whatever is selected, not
  // that the class-specific template always beats neutral wording.
  const expectations = [
    [2, CLS.DUPLEX],
    [3, CLS.TRIPLEX],
    [4, CLS.FOURPLEX],
    [7, CLS.MULTIFAMILY_5_PLUS],
  ];
  for (const [units, expected_class] of expectations) {
    const result = assignTemplateForTargetFast(
      makeCampaignTarget({ units_count: units }),
      CAMPAIGN,
      fullCatalog
    );
    assert.equal(result.ok, true, `units=${units}: ${JSON.stringify(result)}`);
    assert.equal(result.property_communication_class, expected_class);

    const safe_ids = new Set([TPL_BY_CLASS[expected_class].template_id, "tpl-neutral"]);
    assert.ok(
      safe_ids.has(result.template_id),
      `units=${units} selected ${result.template_id}; only ${[...safe_ids].join("/")} are class-safe`
    );
    const selected = fullCatalog.find((t) => t.template_id === result.template_id);
    assert.deepEqual(
      renderedBodyViolationsForClass(selected.template_body, expected_class),
      [],
      `units=${units}: selected wording must carry zero class violations`
    );

    // Own-class wording IS reachable: with cross-class templates only, the
    // hard filter leaves exactly the class's own template.
    const ownOnly = assignTemplateForTargetFast(
      makeCampaignTarget({ units_count: units }),
      CAMPAIGN,
      Object.values(TPL_BY_CLASS)
    );
    assert.equal(ownOnly.ok, true, `units=${units} own-only: ${JSON.stringify(ownOnly)}`);
    assert.equal(
      ownOnly.template_id,
      TPL_BY_CLASS[expected_class].template_id,
      `units=${units}: cross-class templates are hard-filtered, own wording remains selectable`
    );
  }
});

test("C3: unknown class gets property-neutral wording only", () => {
  // Generic multifamily label without units ⇒ unknown.
  assert.equal(
    resolvePropertyCommunicationClass({ property_type: "Multifamily" }),
    CLS.UNKNOWN
  );

  // All unit/plex wording is forbidden for unknown.
  for (const wording of ["duplex", "triplex", "fourplex", "5+ units", "the units"]) {
    const violations = renderedBodyViolationsForClass(`About ${wording} on the property`, CLS.UNKNOWN);
    assert.ok(violations.length > 0, `unknown must forbid "${wording}"`);
  }
  assert.deepEqual(renderedBodyViolationsForClass("Do you still own the property?", CLS.UNKNOWN), []);

  // Selection: only the neutral template is reachable.
  const result = assignTemplateForTargetFast(makeCampaignTarget({}), CAMPAIGN, [
    TPL_DUPLEX_POISONED,
    TPL_FIVE_PLUS,
    TPL_NEUTRAL,
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.template_id, "tpl-neutral");
  assert.equal(result.property_communication_class, CLS.UNKNOWN);
});

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO D — Opt-out mid-negotiation (S5 thread sends STOP)
// ═══════════════════════════════════════════════════════════════════════════

const stopClassification = detectInboundIntent("STOP");

test("D1: STOP classifies opt_out at confidence 0.99", () => {
  assert.equal(stopClassification.primary_intent, "opt_out");
  assert.equal(stopClassification.confidence, 0.99);
});

const optOutTransition = resolveSellerStageTransition({
  stage_before: LIFECYCLE_STAGE_CODES.OFFER, // S5, mid-negotiation
  known_facts: { ...MIAMI_FACTS },
  new_facts: {},
  intent: "opt_out",
  classification_confidence: stopClassification.confidence,
  contactability: CONTACTABILITY_CODES.CONTACTABLE,
  automation_mode: "full_auto",
  source_message_id: "msg-d-stop",
  now: NOW_ISO,
});

test("D2: suppression latches — contactability opted_out, automation blocked, follow-ups cancelled", () => {
  assert.deepEqual(optOutTransition.contactability_patch, {
    contactability_status: CONTACTABILITY_CODES.OPTED_OUT,
  });
  assert.equal(optOutTransition.next_action, NEXT_ACTIONS.NO_ACTION_CONTACT_BLOCKED);
  assert.equal(optOutTransition.stage_after, LIFECYCLE_STAGE_CODES.OFFER, "no stage movement");
  assert.equal(optOutTransition.advanced, false);
  assert.equal(optOutTransition.reasoning_code, "HOLD_OPT_OUT_SUPPRESS");
  assert.deepEqual(optOutTransition.workflow_event_types, ["AUTOMATION_BLOCKED"]);
  // NO follow-up scheduled — and pending ones are cancelled.
  assert.equal(optOutTransition.follow_up.create, false);
  assert.equal(optOutTransition.follow_up.cancel, true);
  // Registry-level latch: opt_out is a compliance-terminal intent.
  assert.ok(COMPLIANCE_TERMINAL_INTENTS.has("opt_out"));
});

test("D3: NO reply is queued for an opt-out", async () => {
  const queue_calls = [];
  const result = await maybeQueueSellerStageReply({
    inbound_from: "+13055550100",
    context: {
      found: true,
      ids: { phone_item_id: 1, brain_item_id: 2, master_owner_id: 3 },
      items: {},
      summary: { conversation_stage: "Offer", language_preference: "English" },
      recent: { touch_count: 3, recent_events: [] },
    },
    classification: stopClassification,
    message: "STOP",
    now: NOW_ISO,
    queue_message: async (payload) => {
      queue_calls.push(payload);
      return { ok: true, queue_item_id: 1 };
    },
  });
  assert.equal(result.queued, false);
  assert.equal(queue_calls.length, 0, "queue egress must never be touched");
});

test("D4: negotiation produces no outbound for an opt-out turn", () => {
  const turn = resolveNegotiationTurn({
    transition: optOutTransition,
    priceSignal: null,
    priorState: miamiPriorAfterOffer,
    adeSnapshot: MIAMI_ADE,
    intent: "opt_out",
    classificationConfidence: 0.99,
    contextSummary: MIAMI_CONTEXT,
    sourceMessageId: "msg-d-stop",
  });
  assert.equal(turn, null, "blocking intent short-circuits the negotiation lane");
});

test("D5: reengagement planner refuses an opted-out thread with a stop reason", () => {
  const decision = resolveReengagementDecision({
    now: NOW,
    mode: { mode: "full_live" },
    thread: {
      thread_key: "+13055550100",
      is_suppressed: false,
      is_archived: false,
      contactability_status: "opted_out",
      lifecycle_stage: "offer",
      disposition: "none",
      last_inbound_at: null,
    },
    last_followup: {
      intent: "stage_no_reply",
      sent_at: daysAgoIso(10),
      followup_use_case: "seller_asking_price",
    },
    prior_automated_followups: 1,
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, "contact_blocked:opted_out");
});

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO E — Wrong number
// ═══════════════════════════════════════════════════════════════════════════

const wrongNumberClassification = detectInboundIntent(
  "Wrong number, I don't know this person"
);

test("E1: wrong-number text classifies wrong_number with high confidence", () => {
  assert.equal(wrongNumberClassification.primary_intent, "wrong_number");
  assert.ok(wrongNumberClassification.confidence >= 0.9);
});

test("E2: wrong number is terminal — invalid number, wrong_number disposition, no future automation", () => {
  const transition = resolveSellerStageTransition({
    stage_before: LIFECYCLE_STAGE_CODES.ASKING_PRICE,
    known_facts: {},
    new_facts: {},
    intent: "wrong_number",
    classification_confidence: wrongNumberClassification.confidence,
    contactability: CONTACTABILITY_CODES.CONTACTABLE,
    automation_mode: "full_auto",
    source_message_id: "msg-e-1",
    now: NOW_ISO,
  });
  assert.deepEqual(transition.contactability_patch, {
    contactability_status: CONTACTABILITY_CODES.INVALID_NUMBER,
  });
  assert.equal(transition.disposition, "wrong_number");
  assert.equal(transition.next_action, NEXT_ACTIONS.NO_ACTION_CONTACT_BLOCKED);
  assert.deepEqual(transition.ownership_patch, { ownership_status: "not_owner" });
  assert.equal(transition.follow_up.create, false);
  assert.equal(transition.follow_up.cancel, true);
  assert.equal(transition.evaluate_alternate_contact, true);
  assert.ok(COMPLIANCE_TERMINAL_INTENTS.has("wrong_number"));

  // Negotiation lane refuses the blocking intent outright.
  const turn = resolveNegotiationTurn({
    transition,
    priorState: null,
    adeSnapshot: MIAMI_ADE,
    intent: "wrong_number",
    contextSummary: MIAMI_CONTEXT,
    sourceMessageId: "msg-e-1",
  });
  assert.equal(turn, null);
});

test("E3: reengagement planner refuses a wrong-number thread", () => {
  const decision = resolveReengagementDecision({
    now: NOW,
    mode: { mode: "full_live" },
    thread: {
      thread_key: "+13055550101",
      is_suppressed: false,
      is_archived: false,
      contactability_status: "contactable",
      lifecycle_stage: "asking_price",
      disposition: "wrong_number",
      last_inbound_at: null,
    },
    last_followup: {
      intent: "stage_no_reply",
      sent_at: daysAgoIso(10),
      followup_use_case: "seller_asking_price",
    },
    prior_automated_followups: 1,
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, "terminal_disposition:wrong_number");
});

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO F — Missing valuation authority
// ═══════════════════════════════════════════════════════════════════════════

test("F1: no ade_snapshot ⇒ resolver fails closed (insufficient_data / valuation_authority_absent)", () => {
  const absent = resolveValuationAuthority({
    property: { units_count: 15, property_type: "Multifamily" },
    ade_snapshot: null,
  });
  assert.equal(absent.valuation_method, VALUATION_METHODS.INSUFFICIENT_DATA);
  assert.deepEqual(absent.reason_codes, ["valuation_authority_absent"]);
  assert.equal(absent.target_acquisition_price, null);
  assert.equal(absent.maximum_acquisition_price, null);
  assert.equal(absent.initial_offer, null);
});

test("F2: orchestrator path yields NO numeric offer — review routed, authorized amounts null", () => {
  // Discovery exhausted so the router cannot legitimately probe instead.
  const factsComplete = {
    ...MIAMI_FACTS,
    condition_summary: "renovated 2019, roofs replaced",
    condition_disclosed: true,
  };
  const turn = resolveNegotiationTurn({
    transition: offerStageTransition({ facts_patch: factsComplete }),
    priceSignal: miamiAsk,
    priorState: null,
    adeSnapshot: null,
    intent: "asking_price_value",
    classificationConfidence: 0.92,
    contextSummary: MIAMI_CONTEXT,
    sourceMessageId: "msg-f-1",
    knownFacts: {},
    newFacts: factsComplete,
  });
  assert.equal(turn.zone.zone, "insufficient_confidence");
  assert.equal(turn.zone.reason_code, "NO_PERSISTED_AUTHORITY");
  assert.equal(turn.strategy_decision.strategy, S.HUMAN_REVIEW);
  assert.equal(turn.strategy_decision.review_required, true);
  assert.equal(turn.strategy_decision.review_reason, "valuation_authority_absent");
  assert.equal(turn.strategy_decision.monetary, null, "no number is ever fabricated");
  assert.equal(turn.state_preview.authorized_offer_ceiling, null);
  assert.equal(turn.state_preview.latest_offer, null);
});

test("F3: renderer refuses offer placeholders when no authorized amount exists", () => {
  const evaluation = evaluateTemplatePlaceholders({
    template_text:
      "Hi {{seller_first_name}}, we can offer {{offer_price}} for {{property_address}}.",
    use_case: "offer_reveal_cash",
    context: {},
    overrides: { seller_first_name: "Maria", property_address: "12 Ocean Dr" },
  });
  assert.equal(evaluation.ok, false);
  assert.ok(
    evaluation.missing_required_placeholders.includes("{{offer_price}}"),
    `expected {{offer_price}} required-missing, got ${JSON.stringify(evaluation.missing_required_placeholders)}`
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO G — Seller asks far above max (ask $2M, ceiling $1.24M)
// ═══════════════════════════════════════════════════════════════════════════

const HIGH_ASK_ADE = Object.freeze({
  valuation_low: 1_450_000,
  valuation_mid: 1_600_000,
  valuation_high: 1_700_000,
  valuation_confidence: 80,
  comp_count: 5,
  investor_ceiling_mid: 1_240_000,
  investor_ceiling_high: 1_280_000,
  buyer_demand_score: 55,
  liquidity_score: 55,
  estimated_repairs: 100_000,
  recommended_cash_offer: 1_100_000,
  minimum_acceptable_offer: 1_000_000,
  evidence: { engine: { name: "acquisition_decision_engine", version: "2.0.0" } },
});
const G_CEILING = 1_240_000;

test("G1: no generated amount ever exceeds the ceiling across the whole exchange", () => {
  const asks = [
    ["I want 2 million", "asking_price_value", null],
    ["Could go 1.8 million", "seller_counter", 2_000_000],
    ["Fine, 1.5 million", "seller_counter", 1_800_000],
  ];
  let prior = null;
  const generated = [];
  for (const [text, intent, reference] of asks) {
    const signal = resolveAskingPriceSignal(text, {
      reference: reference ?? undefined,
      negotiationActive: reference != null,
      sourceMessageId: `msg-g-${generated.length}`,
    });
    const turn = resolveNegotiationTurn({
      transition: offerStageTransition({
        facts_patch: { ...MIAMI_FACTS, asking_price: { value: signal.asking_price?.value } },
      }),
      priceSignal: signal,
      priorState: prior,
      adeSnapshot: HIGH_ASK_ADE,
      intent,
      classificationConfidence: 0.9,
      contextSummary: MIAMI_CONTEXT,
      sourceMessageId: `msg-g-${generated.length}`,
      knownFacts: MIAMI_FACTS,
      newFacts: {},
    });
    assert.ok(turn?.strategy_decision, `turn for "${text}" must route a strategy`);
    const amount = turn.strategy_decision.monetary?.amount;
    if (amount != null) {
      generated.push(amount);
      assert.ok(amount <= G_CEILING, `generated ${amount} must be ≤ ceiling ${G_CEILING}`);
    }
    for (const offer of turn.state_preview.offers_made) {
      if (offer.amount == null) continue;
      assert.ok(offer.amount <= G_CEILING, `ledger offer ${offer.amount} must be ≤ ceiling`);
    }
    prior = turn.state_preview;
  }
  assert.equal(prior.authorized_offer_ceiling, G_CEILING, "ceiling comes from the ADE authority");
});

test("G2: acceptance is capped at min(ask, ceiling)", () => {
  const askState = applyNegotiationTurn(null, {
    price_signal: resolveAskingPriceSignal("I want 2 million", { sourceMessageId: "msg-g-a" }),
    ade_snapshot: HIGH_ASK_ADE,
    transition: offerStageTransition(),
    intent: "asking_price_value",
    source_message_id: "msg-g-a",
    now: NOW_ISO,
  });
  assert.equal(askState.current_asking_price, 2_000_000);
  assert.equal(askState.authorized_offer_ceiling, G_CEILING);

  const accepted = applyNegotiationTurn(askState, {
    strategy_decision: { strategy: S.ACCEPT_SELLER_TERMS },
    source_message_id: "msg-g-accept",
    now: "2026-08-07T14:00:00.000Z",
  });
  assert.equal(accepted.terms_accepted, true);
  assert.equal(accepted.accepted_price, G_CEILING, "accepted = min(2,000,000, 1,240,000)");
  assert.equal(accepted.accepted_terms.basis, "we_accepted_seller_ask");
});

test("G3: the offers_made ledger reports within_authority honestly", () => {
  const base = applyNegotiationTurn(null, {
    ade_snapshot: HIGH_ASK_ADE,
    transition: offerStageTransition(),
    now: NOW_ISO,
  });

  const overCeiling = applyNegotiationTurn(base, {
    offer_execution: { queued: true, amount: 1_300_000, queue_row_id: "q-g-over" },
    now: NOW_ISO,
  });
  const overEntry = overCeiling.offers_made.find((o) => o.queue_row_id === "q-g-over");
  assert.ok(overEntry, "authority violation is recorded, never silently dropped");
  assert.equal(overEntry.within_authority, false, "an over-ceiling execution is flagged");

  const withinCeiling = applyNegotiationTurn(base, {
    offer_execution: { queued: true, amount: 1_200_000, queue_row_id: "q-g-within" },
    now: NOW_ISO,
  });
  const withinEntry = withinCeiling.offers_made.find((o) => o.queue_row_id === "q-g-within");
  assert.equal(withinEntry.within_authority, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO H — Replay idempotency
// ═══════════════════════════════════════════════════════════════════════════

test("H1: the same inbound event id is processed once (burst constituent dedupe)", () => {
  const inbound = {
    provider_message_id: "SM_h_1",
    event_id: "evt-h-1",
    body: "I want 1.5 million",
    received_at: NOW_ISO,
    authorized_received_at: NOW_ISO,
  };
  const first = appendConstituent([], inbound);
  assert.equal(first.appended, true);
  assert.equal(first.constituents.length, 1);
  assert.equal(constituentKey(first.constituents[0]), "SM_h_1");

  const replay = appendConstituent(first.constituents, { ...inbound });
  assert.equal(replay.appended, false);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.constituents.length, 1, "same provider id must never process twice");
});

const H_THREAD = "+13125550100";

function dispatchedStageFollowupRow(overrides = {}) {
  return {
    id: "q-followup-1",
    thread_key: H_THREAD,
    to_phone_number: H_THREAD,
    type: "followup",
    queue_status: "delivered",
    sent_at: daysAgoIso(10),
    created_at: daysAgoIso(11),
    use_case_template: "ownership_check",
    master_owner_id: "own_1",
    property_id: "prop_1",
    agent_name: "Jordan",
    metadata: {
      intent: "stage_no_reply",
      followup_use_case: "ownership_check",
      followup_attempt: 1,
      deferred_message_resolution: true,
    },
    ...overrides,
  };
}

function healthyThreadState(overrides = {}) {
  return {
    thread_key: H_THREAD,
    is_suppressed: false,
    is_archived: false,
    contactability_status: "contactable",
    lifecycle_stage: "ownership_confirmation",
    disposition: "none",
    last_inbound_at: null,
    ...overrides,
  };
}

const LIVE_SWEEP_DEPS = { followUpMode: "full_live", getSystemValueImpl: async () => null };

async function runReengagementSweep(supabase, deps = LIVE_SWEEP_DEPS) {
  const result = await recoverSellerExecutionGaps({
    supabaseClient: supabase,
    dryRun: false,
    now: NOW,
    deps,
  });
  return result.sweeps.find((s) => s.gap === "followup_no_response_reengagement");
}

test("H2: the same follow-up scan twice creates exactly one send_queue row (dedupe key)", async () => {
  const supabase = makeFakeSupabase({
    send_queue: [dispatchedStageFollowupRow()],
    inbox_thread_state: [healthyThreadState()],
  });

  const first = await runReengagementSweep(supabase);
  assert.equal(first.repaired, 1, JSON.stringify(first));
  const scheduled = supabase._state.send_queue.filter((r) => r.queue_status === "scheduled");
  assert.equal(scheduled.length, 1);
  assert.equal(
    scheduled[0].dedupe_key,
    `seller_followup:${H_THREAD}:stage_no_reply:attempt_2`
  );
  const afterFirst = supabase._state.send_queue.length;

  const second = await runReengagementSweep(supabase);
  assert.equal(second.repaired, 0);
  assert.equal(second.denied.duplicate_pending_followup, 1, JSON.stringify(second));
  assert.equal(supabase._state.send_queue.length, afterFirst, "no second row on replay");
});

test("H3: replaying the same offer execution appends offers_made once (queue_row_id skip)", () => {
  const base = applyNegotiationTurn(null, {
    ade_snapshot: MIAMI_ADE,
    transition: offerStageTransition(),
    now: NOW_ISO,
  });
  const executed = applyNegotiationTurn(base, {
    offer_execution: {
      queued: true,
      amount: 1_050_000,
      template_use_case: "mf_offer_reveal",
      queue_row_id: "q-h-1",
    },
    now: NOW_ISO,
  });
  assert.equal(executed.offers_made.length, 1);
  assert.equal(executed.negotiation_round, 1);

  const replayed = applyNegotiationTurn(executed, {
    offer_execution: {
      queued: true,
      amount: 1_050_000,
      template_use_case: "mf_offer_reveal",
      queue_row_id: "q-h-1",
    },
    now: "2026-08-07T12:05:00.000Z",
  });
  assert.equal(replayed.offers_made.length, 1, "same queue row must never double-append");
  assert.equal(replayed.negotiation_round, 1, "round counter must not double-count");
  assert.equal(replayed.latest_offer, 1_050_000);
});

// H4 (same acceptance twice ⇒ one terms snapshot) is proven in A7/A8 above:
// the reducer suppresses the duplicate acceptance and the snapshot hook
// dedupes on terms_hash with exactly one durable row.

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO I — Provider transient failure ⇒ transport retry ONLY
// ═══════════════════════════════════════════════════════════════════════════

test("I1: a retryable failure gets a transport retry decision with backoff", () => {
  const item = createPodioItem(501, {
    "queue-status": categoryField("Failed"),
    "failed-reason": categoryField("connection timed out"),
    "retry-count": numberField(0),
    "max-retries": numberField(2),
  });
  const decision = buildRetryDecision(item, { now: NOW_ISO });
  assert.equal(decision.ok, true);
  assert.equal(decision.action, "schedule_retry");
  assert.equal(decision.reason, "retry_scheduled");
  assert.equal(decision.backoff_minutes, 15);
  assert.equal(decision.next_retry_at, "2026-08-07T12:15:00.000Z");
  assert.equal(Boolean(decision.suppression_required), false);
});

test("I2: the retry decision touches ONLY transport queue fields — no follow-up, no stage, no negotiation", () => {
  const item = createPodioItem(502, {
    "queue-status": categoryField("Failed"),
    "failed-reason": categoryField("connection timed out"),
    "retry-count": numberField(1),
    "max-retries": numberField(2),
  });
  const decision = buildRetryDecision(item, { now: NOW_ISO });
  assert.deepEqual(
    Object.keys(decision.update).sort(),
    ["delivery-confirmed", "queue-status", "scheduled-for-local", "scheduled-for-utc"],
    "retry updates are strictly transport-scoped"
  );
  // A transport retry must never masquerade as a follow-up or stage action.
  for (const key of Object.keys(decision)) {
    assert.ok(
      !/followup|follow_up|stage|negotiation/i.test(key),
      `unexpected non-transport key on retry decision: ${key}`
    );
  }
});

test("I3 (FINDING): the canonical 'network error' policy reason is unreachable through the classifier gate", () => {
  // TODO-FINDING (retry-send-queue.js vs canonical-delivery-state.js):
  // RETRY_POLICIES keys "network error" as a retryable reason with a
  // [15, 60, 240]-minute schedule, and RETRY_REASON_ALIASES maps
  // "connection timed out"/"network timeout" ONTO it. But buildRetryDecision
  // consults resolveCanonicalDeliveryState FIRST, and that classifier only
  // recognizes the alias text patterns ("connection timed out", "timeout",
  // …), never the bare policy key itself. A queue row whose failed-reason is
  // the literal "network error" is therefore skipped as
  // `unclassified_delivery_failed` and NEVER retried, even though the policy
  // table declares it retryable. Fail-closed (no retry, no side effects), so
  // it is a dead-policy-key inconsistency rather than a queue hazard — but
  // the two layers disagree about the canonical reason vocabulary.
  // This test pins today's behavior so a fix flips it visibly.
  assert.equal(getRetryPolicy("network error").retryable, true, "policy table says retryable");
  const item = createPodioItem(503, {
    "queue-status": categoryField("Failed"),
    "failed-reason": categoryField("network error"),
    "retry-count": numberField(0),
    "max-retries": numberField(2),
  });
  const decision = buildRetryDecision(item, { now: NOW_ISO });
  assert.equal(decision.ok, false, "…but the classifier gate refuses it");
  assert.equal(decision.action, "skip_unclassified_failure");
  assert.equal(decision.reason, "unclassified_delivery_failed");
});

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO J — Seller non-response ⇒ follow-up lane only, never provider retry
// ═══════════════════════════════════════════════════════════════════════════

test("J1: non-response is not a failure — NO provider retry is generated", () => {
  // A delivered message with no reply is not retryable transport-side.
  const delivered = createPodioItem(601, {
    "queue-status": categoryField("Delivered"),
    "retry-count": numberField(0),
  });
  const decision = buildRetryDecision(delivered, { now: NOW_ISO });
  assert.equal(decision.ok, false);
  assert.equal(decision.action, "skip_not_failed");
  assert.equal(decision.reason, "queue_status_not_failed");

  // And "no response" is not a recognized failure reason either.
  assert.deepEqual(getRetryPolicy(""), {
    retryable: false,
    terminal_reason: "unsupported_failure_reason",
  });
  assert.deepEqual(getRetryPolicy("no response"), {
    retryable: false,
    terminal_reason: "unsupported_failure_reason",
  });
});

test("J2: the reengagement planner is the actor for silence (stage_no_reply, attempt N)", () => {
  const decision = resolveReengagementDecision({
    now: NOW,
    mode: { mode: "full_live" },
    thread: healthyThreadState(),
    last_followup: {
      intent: "stage_no_reply",
      sent_at: daysAgoIso(10),
      followup_use_case: "ownership_check",
    },
    prior_automated_followups: 1,
  });
  assert.equal(decision.eligible, true);
  assert.equal(decision.intent, "stage_no_reply");
  assert.equal(decision.attempt, 2, "silence advances the attempt counter, nothing else");
});

test("J3: the silence lane is gated by followup_automation_mode (deny-by-default)", async () => {
  const supabase = makeFakeSupabase({
    send_queue: [dispatchedStageFollowupRow()],
    inbox_thread_state: [healthyThreadState()],
  });
  // Default mode (no system value set) is disabled ⇒ the sweep is fully inert.
  const sweep = await runReengagementSweep(supabase, { getSystemValueImpl: async () => null });
  assert.equal(sweep.mode, "disabled");
  assert.equal(sweep.skipped, "followup_automation_disabled");
  assert.equal(sweep.repaired, 0);
  assert.equal(supabase._state.send_queue.length, 1, "no rows created while denied");
});
