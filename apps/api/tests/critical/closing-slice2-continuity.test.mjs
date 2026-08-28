import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveSellerSignerEmail,
  resolveAndPersistSignerEmail,
  isTrustworthyGraphEmail,
  isPlausibleEmail,
  GRAPH_MIN_SCORE,
  SIGNER_EMAIL_SOURCES,
} from "@/lib/domain/closings/resolve-seller-signer-email.js";
import {
  advanceClosingWorkflow,
  resolveClosingWorkflowStep,
  buildMilestoneKey,
  CLOSING_EVENTS,
} from "@/lib/domain/closings/advance-closing-workflow.js";
import { buildEnvelopeInputFromClosingCase } from "@/lib/domain/closings/create-docusign-envelope-from-closing-case.js";
import {
  LOCAL_TEMPLATE_CANDIDATES,
  verifyLocalAutoReplyApproval,
} from "@/lib/domain/templates/local-template-registry.js";
import { LOCAL_NEGOTIATION_AUTO_REPLY_USE_CASES } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";

// Slice 2: signer email, signed-contract progression, closing workflow, and
// seller closing communication — all on the Supabase-native substrate, all
// dormant (no live send anywhere in this file).

const LONG_DASH = /[—–]/;

const CASE = {
  closing_case_id: "closing:opp-1",
  opportunity_id: "opp-1",
  master_owner_id: "owner-1",
  thread_key: "+15550100999",
  property_address: "123 Main St, Austin TX",
  seller_contract_price: 250000,
  signer_email: null,
  signer_name: "Jane Seller",
  contract_status: "draft",
  closing_status: "not_scheduled",
  provenance: {},
};

// Minimal Supabase stub covering emails / closing_cases / closing_milestones.
function makeSupabase({ emails = [], cases = [CASE], milestones = [] } = {}) {
  const state = { emails: [...emails], cases: cases.map((c) => ({ ...c })), milestones: [...milestones] };
  function from(name) {
    const q = { f: {} };
    const api = {
      select: () => api,
      eq(col, val) { q.f[col] = val; return api; },
      order: () => api,
      limit: async () => ({ data: rows(), error: null }),
      async maybeSingle() { return { data: rows()[0] || null, error: null }; },
      insert(row) {
        if (name === "closing_milestones") {
          if (state.milestones.some((m) => m.idempotency_key === row.idempotency_key)) {
            return Promise.resolve({ error: { code: "23505", message: "duplicate key" } });
          }
          state.milestones.push({ ...row });
        }
        return Promise.resolve({ error: null });
      },
      update(patch) {
        const u = {
          eq(col, val) { q.f[col] = val; return u; },
          then(resolve) {
            const t = rows()[0];
            if (t) Object.assign(t, patch);
            return Promise.resolve({ error: null }).then(resolve);
          },
        };
        return u;
      },
    };
    function rows() {
      const src = name === "emails" ? state.emails : name === "closing_cases" ? state.cases : state.milestones;
      return src.filter((r) => Object.entries(q.f).every(([k, v]) => r[k] === v));
    }
    return api;
  }
  return { from, _state: state };
}

const goodEmail = {
  email_id: "e-1",
  master_owner_id: "owner-1",
  email: "Jane@Example.com",
  email_normalized: "jane@example.com",
  email_role: "Primary",
  email_rank: 1,
  email_score_final: 95,
  is_best_email_for_owner: true,
  email_eligible: true,
};

// ── 1) signer email resolved autonomously from the EXISTING contact graph ────

test("a trustworthy contact-graph email is resolved autonomously, with provenance", async () => {
  const supabase = makeSupabase({ emails: [goodEmail] });
  const r = await resolveSellerSignerEmail({ master_owner_id: "owner-1", supabase });

  assert.equal(r.ok, true);
  assert.equal(r.email, "jane@example.com", "normalized + lowercased");
  assert.equal(r.source, SIGNER_EMAIL_SOURCES.CONTACT_GRAPH);
  assert.equal(r.provenance.table, "emails", "provenance records WHERE it came from");
  assert.equal(r.provenance.email_id, "e-1");
  assert.equal(r.provenance.email_score_final, 95);
  assert.equal(r.provenance.min_score_policy, GRAPH_MIN_SCORE);
});

test("the trust policy rejects business/unknown/secondary/low-score/ineligible emails", () => {
  assert.equal(isTrustworthyGraphEmail(goodEmail), true);
  assert.equal(isTrustworthyGraphEmail({ ...goodEmail, email_role: "Business" }), false, "business is not the signer");
  assert.equal(isTrustworthyGraphEmail({ ...goodEmail, email_role: "Unknown" }), false);
  assert.equal(isTrustworthyGraphEmail({ ...goodEmail, email_role: "Secondary" }), false);
  assert.equal(isTrustworthyGraphEmail({ ...goodEmail, email_score_final: 71 }), false, "below policy floor");
  assert.equal(isTrustworthyGraphEmail({ ...goodEmail, is_best_email_for_owner: false }), false);
  assert.equal(isTrustworthyGraphEmail({ ...goodEmail, email_eligible: false }), false);
  assert.equal(isTrustworthyGraphEmail({ ...goodEmail, email_normalized: "not-an-email" }), false);
  assert.equal(isPlausibleEmail("a@b.co"), true);
  assert.equal(isPlausibleEmail("a b@c.com"), false);
});

test("a seller-provided email is first-party and outranks the graph", async () => {
  const supabase = makeSupabase({ emails: [goodEmail] });
  const r = await resolveSellerSignerEmail({
    master_owner_id: "owner-1",
    seller_provided_email: "Typed@Seller.com",
    supabase,
  });
  assert.equal(r.email, "typed@seller.com");
  assert.equal(r.source, SIGNER_EMAIL_SOURCES.SELLER_PROVIDED);
});

test("NO trustworthy email -> ASK the seller by SMS, never a human-review dependency", async () => {
  const supabase = makeSupabase({ emails: [{ ...goodEmail, email_role: "Business" }] });
  const r = await resolveSellerSignerEmail({ master_owner_id: "owner-1", supabase });

  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_trustworthy_email");
  assert.equal(r.should_request_from_seller, true, "the conversation asks; no human escalation");
  assert.ok(!("human_review" in r), "resolution never emits a review disposition");
});

test("a LOOKUP FAILURE does not ask the seller (absence must be proven, not assumed)", async () => {
  const supabase = {
    from: () => ({
      select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: null, error: { message: "boom" } }) }) }) }),
    }),
  };
  const r = await resolveSellerSignerEmail({ master_owner_id: "owner-1", supabase });
  assert.equal(r.reason, "lookup_failed");
  assert.equal(r.should_request_from_seller, false);
});

test("the resolved email persists onto the closing case with provenance", async () => {
  const supabase = makeSupabase({ emails: [goodEmail] });
  const r = await resolveAndPersistSignerEmail({ closing_case: { ...CASE }, supabase });
  assert.equal(r.ok, true);
  assert.equal(r.persisted, true);
  const stored = supabase._state.cases[0];
  assert.equal(stored.signer_email, "jane@example.com");
  assert.equal(stored.provenance.signer_email.source, SIGNER_EMAIL_SOURCES.CONTACT_GRAPH);
  assert.equal(stored.provenance.signer_email.email_id, "e-1");
});

test("an existing signer email is not overwritten by a graph guess", async () => {
  const supabase = makeSupabase({ emails: [goodEmail], cases: [{ ...CASE, signer_email: "already@bound.com" }] });
  const r = await resolveAndPersistSignerEmail({ closing_case: supabase._state.cases[0], supabase });
  assert.equal(r.persisted, false);
  assert.equal(r.reason, "already_present");
  assert.equal(supabase._state.cases[0].signer_email, "already@bound.com");
});

// ── 2/4) closing workflow: event-driven, idempotent ──────────────────────────

test("workflow advances ONLY on known authoritative events", () => {
  assert.equal(resolveClosingWorkflowStep({ event_type: "made_up" }).ok, false);
  assert.equal(resolveClosingWorkflowStep({ event_type: CLOSING_EVENTS.TITLE_OPENED }).ok, true);
  // Post-signature steps require an external authority; none advance on a timer.
  for (const ev of [CLOSING_EVENTS.TITLE_OPENED, CLOSING_EVENTS.ESCROW_FUNDED, CLOSING_EVENTS.CLOSING_SCHEDULED, CLOSING_EVENTS.CLOSED]) {
    assert.equal(
      resolveClosingWorkflowStep({ event_type: ev }).step.requires_authoritative_source,
      true,
      `${ev} must require an authoritative source (never elapsed time)`
    );
  }
});

test("a fully-executed signature advances the case and records a milestone", async () => {
  const supabase = makeSupabase();
  const r = await advanceClosingWorkflow({
    closing_case: { ...CASE },
    event_type: CLOSING_EVENTS.CONTRACT_FULLY_EXECUTED,
    source_event_id: "evt-1",
    allowExternalEffects: false,
    supabase,
  });
  assert.equal(r.advanced, true);
  assert.equal(r.milestone_type, "contract_fully_executed");
  assert.equal(supabase._state.milestones.length, 1);
  const c = supabase._state.cases[0];
  assert.equal(c.contract_status, "fully_executed");
  assert.equal(c.universal_stage, "under_contract");
  assert.equal(c.closing_status, "title_pending");
});

test("REPLAY records no duplicate milestone, no second state change, no second SMS", async () => {
  const supabase = makeSupabase();
  let queued = 0;
  const args = {
    closing_case: { ...CASE },
    event_type: CLOSING_EVENTS.CONTRACT_FULLY_EXECUTED,
    source_event_id: "evt-9",
    allowExternalEffects: true,
    supabase,
    insertSendQueueRowImpl: async () => { queued += 1; return { ok: true }; },
  };
  const first = await advanceClosingWorkflow(args);
  const second = await advanceClosingWorkflow(args);

  assert.equal(first.advanced, true);
  assert.equal(first.seller_message_queued, true);
  assert.equal(second.advanced, false);
  assert.equal(second.reason, "duplicate_milestone");
  assert.equal(second.seller_message_queued, false);
  assert.equal(supabase._state.milestones.length, 1, "one milestone");
  assert.equal(queued, 1, "exactly one seller SMS across the replay");
});

test("milestone keys are deterministic per (case, type, source event)", () => {
  const a = buildMilestoneKey({ closing_case_id: "c1", milestone_type: "title_opened", source_event_id: "e1" });
  assert.equal(a, buildMilestoneKey({ closing_case_id: "c1", milestone_type: "title_opened", source_event_id: "e1" }));
  assert.notEqual(a, buildMilestoneKey({ closing_case_id: "c1", milestone_type: "title_opened", source_event_id: "e2" }));
});

test("the full post-signature chain advances on authoritative events to CLOSED", async () => {
  const supabase = makeSupabase();
  const seq = [
    [CLOSING_EVENTS.CONTRACT_FULLY_EXECUTED, "title_pending"],
    [CLOSING_EVENTS.TITLE_OPENED, "in_title"],
    [CLOSING_EVENTS.ESCROW_FUNDED, "in_title"],
    [CLOSING_EVENTS.CLOSING_SCHEDULED, "scheduled"],
    [CLOSING_EVENTS.CLOSED, "closed"],
  ];
  for (const [event_type, expected_status] of seq) {
    const r = await advanceClosingWorkflow({
      closing_case_id: CASE.closing_case_id,
      event_type,
      source_event_id: `src-${event_type}`,
      allowExternalEffects: false,
      supabase,
    });
    assert.equal(r.advanced, true, `${event_type} advanced`);
    assert.equal(supabase._state.cases[0].closing_status, expected_status, `${event_type} -> ${expected_status}`);
  }
  assert.equal(supabase._state.cases[0].universal_stage, "closed");
  assert.equal(supabase._state.cases[0].funding_date != null, true, "funding recorded from a real event");
  assert.equal(supabase._state.milestones.length, 5);
});

// ── 5) seller closing communication ──────────────────────────────────────────

test("DORMANT: the closing state still advances but NO seller SMS is queued", async () => {
  const supabase = makeSupabase();
  let queued = 0;
  const r = await advanceClosingWorkflow({
    closing_case: { ...CASE },
    event_type: CLOSING_EVENTS.CONTRACT_FULLY_EXECUTED,
    source_event_id: "evt-dormant",
    allowExternalEffects: false,
    supabase,
    insertSendQueueRowImpl: async () => { queued += 1; return { ok: true }; },
  });
  assert.equal(r.advanced, true, "internal state still reconciles while dormant");
  assert.equal(r.seller_message_queued, false);
  assert.equal(queued, 0, "no outward message while contained");
});

test("closing templates exist, are auto-reply eligible, approved, and dash-free", () => {
  const closing_use_cases = [
    "request_signer_email",
    "contract_sent_notice",
    "contract_signed_confirmation",
    "title_opened_update",
    "closing_scheduled_update",
  ];
  for (const uc of closing_use_cases) {
    const tpl = LOCAL_TEMPLATE_CANDIDATES.find((t) => t.use_case === uc);
    assert.ok(tpl, `${uc} template exists`);
    assert.doesNotMatch(tpl.text, LONG_DASH, `${uc} is em/en-dash free at source`);
    assert.ok(
      LOCAL_NEGOTIATION_AUTO_REPLY_USE_CASES.has(uc),
      `${uc} is auto-reply eligible (conversation continues through closing)`
    );
    const approval = verifyLocalAutoReplyApproval(tpl, { env: { NODE_ENV: "production" } });
    assert.equal(approval.approved, true, `${uc} approval: ${approval.reasons.join(",")}`);
  }
});

// ── Dormant END-TO-END proof ─────────────────────────────────────────────────

test("DORMANT END-TO-END: accepted offer -> case -> email -> envelope ready -> signature -> workflow -> seller SMS", async () => {
  const supabase = makeSupabase({ emails: [goodEmail] });

  // 1. closing case exists from the accepted offer (Slice 1 creator covered
  //    separately); 2. signer email resolved autonomously + persisted.
  const email = await resolveAndPersistSignerEmail({ closing_case: supabase._state.cases[0], supabase });
  assert.equal(email.ok, true);
  const withEmail = supabase._state.cases[0];
  assert.equal(withEmail.signer_email, "jane@example.com");

  // 3. envelope is READY (populated from persisted canonical terms) but dormant.
  const envelope = buildEnvelopeInputFromClosingCase(withEmail, { template_id: "TPL-1" });
  assert.equal(envelope.ok, true, "envelope ready once the email is resolved");
  assert.equal(envelope.input.recipients[0].email, "jane@example.com");
  const tabs = Object.fromEntries(envelope.input.recipients[0].tabs.textTabs.map((t) => [t.tabLabel, t.value]));
  assert.equal(tabs.purchase_price, "250000");

  // 4/5. signature -> fully executed -> workflow advance -> seller SMS earned.
  let queued = [];
  const advanced = await advanceClosingWorkflow({
    closing_case: withEmail,
    event_type: CLOSING_EVENTS.CONTRACT_FULLY_EXECUTED,
    source_event_id: "env-1",
    allowExternalEffects: true,
    supabase,
    insertSendQueueRowImpl: async (row) => { queued.push(row); return { ok: true }; },
  });
  assert.equal(advanced.advanced, true);
  assert.equal(supabase._state.cases[0].contract_status, "fully_executed");
  assert.equal(queued.length, 1, "seller is told the contract is signed");
  assert.equal(queued[0].use_case_template, "contract_signed_confirmation");
  assert.equal(queued[0].metadata.closing_case_id, CASE.closing_case_id);

  // 6. close-ready / closed state reachable on authoritative events.
  for (const ev of [CLOSING_EVENTS.CLOSING_SCHEDULED, CLOSING_EVENTS.CLOSED]) {
    await advanceClosingWorkflow({
      closing_case_id: CASE.closing_case_id,
      event_type: ev,
      source_event_id: `src-${ev}`,
      allowExternalEffects: true,
      supabase,
      insertSendQueueRowImpl: async (row) => { queued.push(row); return { ok: true }; },
    });
  }
  assert.equal(supabase._state.cases[0].universal_stage, "closed", "closed state reached");
  assert.ok(
    queued.some((q) => q.use_case_template === "closing_scheduled_update"),
    "seller is kept informed through closing, not abandoned after signature"
  );
});
