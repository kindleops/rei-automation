import test from "node:test";
import assert from "node:assert/strict";

import {
  loadFus2Templates,
  selectFus2Template,
  buildRecipientPlan,
  FUS2_OPERATOR_LABEL,
} from "@/lib/domain/inbox/fus2-follow-up-service.js";

// The 15 approved variants, shaped exactly as sms_templates returns them.
const FUS2 = Array.from({ length: 15 }, (_, i) => ({
  id: `uuid-${i + 1}`,
  template_id: `lc-reengage-agent-en-${String(i + 1).padStart(3, "0")}`,
  template_name: `reengagement_S6B_English_lc_reengage_agent_${String(i + 1).padStart(3, "0")}`,
  template_body: i % 3 === 0
    ? "Hey {{seller_first_name}}, this is {{agent_name}}. Just following up on {{property_address}}. Would you be open to talking numbers on it?"
    : i % 3 === 1
      ? "Hey {{seller_first_name}}, {{agent_name}} here. Wanted to circle back on {{property_address}} and see if you'd consider a proposal."
      : "Hi {{seller_first_name}}, it's {{agent_name}}. Touching base again about {{property_address}}. Would you consider an offer?",
  variables: ["seller_first_name", "agent_name", "property_address"],
  language: "English",
  agent_persona: i % 2 === 0 ? "Investor Direct" : "Warm Professional",
  stage_code: "FUS2",
  is_active: true,
  is_follow_up: true,
  metadata: { template_family: "bulk_conversation_restart", rotation_group: "agent_reintro_property_cta_v1", follow_up_stage: "FUS2" },
}));

const NOW = new Date("2026-09-07T18:00:00Z"); // 1:00 PM CT — inside the window

// ── PROOF 1 + 2: the canonical FUS2 query ───────────────────────────────────

test("PROOF 1/2: FUS2 templates load from sms_templates under all four predicates", async () => {
  const seen = {};
  const supabase = {
    from(table) {
      seen.table = table;
      const q = {
        select: () => q,
        eq: (col, val) => { seen[col] = val; return q; },
        then: (res) => Promise.resolve({ data: FUS2, error: null }).then(res),
      };
      return q;
    },
  };
  const result = await loadFus2Templates({ supabase });
  assert.equal(result.ok, true);
  assert.equal(seen.table, "sms_templates", "must read sms_templates directly");
  // All four canonical predicates, so the pool can never widen to the whole library.
  assert.equal(seen.stage_code, "FUS2");
  assert.equal(seen.is_active, true);
  assert.equal(seen.is_follow_up, true);
  assert.equal(seen["metadata->>template_family"], "bulk_conversation_restart");
  assert.equal(result.templates.length, 15);
});

test("the operator label never exposes the internal code", () => {
  assert.equal(FUS2_OPERATOR_LABEL, "Conversation Restart");
  assert.ok(!/FUS2/i.test(FUS2_OPERATOR_LABEL));
});

// ── PROOF 3: rotation across recipients ─────────────────────────────────────

test("PROOF 3: at least 3 distinct variants are chosen across recipients", () => {
  // Each seller has a different history, which is what rotation keys off.
  const histories = [
    [], ["lc-reengage-agent-en-001"],
    ["lc-reengage-agent-en-001", "lc-reengage-agent-en-002"],
    ["lc-reengage-agent-en-001", "lc-reengage-agent-en-002", "lc-reengage-agent-en-003"],
    ["lc-reengage-agent-en-004"],
  ];
  const picked = histories.map(
    (used) => selectFus2Template({ templates: FUS2, usedTemplateIds: used }).template.template_id,
  );
  const distinct = new Set(picked);
  assert.ok(distinct.size >= 3, `expected >=3 distinct variants, got ${distinct.size}: ${[...distinct]}`);
});

test("anti-repeat never re-picks a variant this seller already received", () => {
  const used = ["lc-reengage-agent-en-001", "lc-reengage-agent-en-002"];
  const chosen = selectFus2Template({ templates: FUS2, usedTemplateIds: used });
  assert.ok(!used.includes(chosen.template.template_id));
  assert.equal(chosen.rotation_reason, "unused_variant_preferred");
  assert.equal(chosen.exhausted, false);
});

test("exhausted rotation falls back to a ranked variant, not to nothing", () => {
  const allUsed = FUS2.map((t) => t.template_id);
  const chosen = selectFus2Template({ templates: FUS2, usedTemplateIds: allUsed });
  assert.equal(chosen.ok, true);
  assert.ok(chosen.template, "must still return a template");
  assert.equal(chosen.exhausted, true);
  assert.equal(chosen.rotation_reason, "all_variants_used_least_recent");
});

test("selection never mutates approved copy", () => {
  const before = FUS2.map((t) => t.template_body);
  selectFus2Template({ templates: FUS2, usedTemplateIds: [] });
  assert.deepEqual(FUS2.map((t) => t.template_body), before);
});

// ── PROOF 4/5/6: personalization through the canonical path ─────────────────

const thread = (over = {}) => ({
  thread_key: "+15551230001",
  seller_first_name: "Sarah",
  property_address: "123 Main St",
  timezone: "Central",
  ...over,
});

test("PROOF 4/5/6: all three variables resolve via the canonical renderer", () => {
  const plan = buildRecipientPlan({
    thread: thread(), template: FUS2[0], agentName: "Ryan", now: NOW,
  });
  assert.equal(plan.eligible, true, plan.reason || "");
  assert.match(plan.message_body, /Sarah/);        // seller_first_name
  assert.match(plan.message_body, /Ryan/);         // agent_name
  assert.match(plan.message_body, /123 Main St/);  // property_address
  assert.ok(!plan.message_body.includes("{{"), "no unresolved tokens");
});

test("the agent re-introduction language is preserved verbatim", () => {
  const p = buildRecipientPlan({ thread: thread(), template: FUS2[0], agentName: "Ryan", now: NOW });
  assert.match(p.message_body, /this is Ryan/);
  const p2 = buildRecipientPlan({ thread: thread(), template: FUS2[1], agentName: "Ryan", now: NOW });
  assert.match(p2.message_body, /Ryan here/);
});

// ── PROOF 7: malformed copy is blocked BEFORE the queue ─────────────────────

test("PROOF 7: a missing variable makes the recipient ineligible, never malformed", () => {
  const cases = [
    { over: { seller_first_name: "" }, missing: "seller_first_name" },
    { over: { property_address: "" }, missing: "property_address" },
  ];
  for (const { over, missing } of cases) {
    const plan = buildRecipientPlan({ thread: thread(over), template: FUS2[0], agentName: "Ryan", now: NOW });
    assert.equal(plan.eligible, false, `${missing} must block eligibility`);
    assert.equal(plan.message_body, undefined, "no partial copy may be produced");
  }
  // Missing agent name likewise.
  const noAgent = buildRecipientPlan({ thread: thread(), template: FUS2[0], agentName: null, now: NOW });
  assert.equal(noAgent.eligible, false);
});

test("the 'Hey , this is .' shape can never be produced", () => {
  const plan = buildRecipientPlan({
    thread: thread({ seller_first_name: "", property_address: "" }),
    template: FUS2[0], agentName: "", now: NOW,
  });
  assert.equal(plan.eligible, false);
  assert.ok(!plan.message_body, "must not render at all");
});

// ── PROOF 9: per-recipient timezone resolution ──────────────────────────────

test("PROOF 9: each recipient gets an individually resolved send time", () => {
  const zones = [
    { tz: "Central", iana: "America/Chicago" },
    { tz: "Eastern", iana: "America/New_York" },
    { tz: "Pacific", iana: "America/Los_Angeles" },
  ];
  const plans = zones.map(({ tz }) =>
    buildRecipientPlan({ thread: thread({ timezone: tz }), template: FUS2[0], agentName: "Ryan", now: NOW }),
  );
  plans.forEach((p, i) => {
    assert.equal(p.eligible, true);
    assert.equal(p.schedule.timezone_iana, zones[i].iana);
    assert.equal(typeof p.schedule.local_send_hour, "number");
  });
  // A bulk selection must NOT collapse to one wall clock across timezones.
  const localHours = new Set(plans.map((p) => p.schedule.local_send_hour));
  assert.ok(localHours.size > 1, `all zones resolved to the same local hour: ${[...localHours]}`);
});

test("a quiet-hours recipient is shifted, not sent at 3am", () => {
  const quiet = new Date("2026-09-08T08:30:00Z"); // 3:30 AM CT
  const plan = buildRecipientPlan({
    thread: thread({ timezone: "Central" }), template: FUS2[0], agentName: "Ryan", now: quiet,
  });
  assert.equal(plan.eligible, true);
  assert.equal(plan.schedule.deferred, true);
  assert.equal(plan.schedule.local_send_hour, 8);
});

// ── PROOF 10: lineage ───────────────────────────────────────────────────────

test("PROOF 10: the chosen template_id rides on the plan for attribution", () => {
  const plan = buildRecipientPlan({ thread: thread(), template: FUS2[4], agentName: "Ryan", now: NOW });
  assert.equal(plan.template_id, "lc-reengage-agent-en-005");
  assert.equal(plan.template_name, FUS2[4].template_name);
});

// ── PROOF 8 + 15: bulk scheduling routes through the canonical path ─────────

import { buildBulkFollowUpPlan } from "@/lib/domain/inbox/bulk-follow-up-plan.js";
import { runInboxAction } from "@/lib/cockpit/cockpit-service.js";

// Two DEAD canaries in different timezones. Reserved-range numbers; nothing
// here can reach a real handset, and containment refuses the send regardless.
const CANARY_A = "+15555550100"; // Central
const CANARY_B = "+15555550101"; // Pacific

function planSupabase() {
  const table = (rows) => {
    const q = {
      select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q,
      then: (res) => Promise.resolve({ data: rows, error: null }).then(res),
    };
    return q;
  };
  return {
    from(name) {
      if (name === "sms_templates") return table(FUS2);
      if (name === "canonical_inbox_threads") {
        return table([
          { thread_key: CANARY_A, prospect_first_name: "Sarah", property_address_full: "123 Main St" },
          { thread_key: CANARY_B, prospect_first_name: "Marcus", property_address_full: "456 Oak Ave" },
        ]);
      }
      if (name === "inbox_thread_state") {
        return table([
          { thread_key: CANARY_A, master_owner_id: "mo-a" },
          { thread_key: CANARY_B, master_owner_id: "mo-b" },
        ]);
      }
      if (name === "master_owners") {
        // The assignment of record: agent_persona is a FULL name; the canonical
        // personalizer reduces it to a first name.
        return table([
          { master_owner_id: "mo-a", agent_persona: "Michael Hargrove", agent_family: "Corporate" },
          { master_owner_id: "mo-b", agent_persona: "Helen Crawford", agent_family: "General" },
        ]);
      }
      if (name === "send_queue") {
        return table([
          { thread_key: CANARY_A, template_id: "lc-reengage-agent-en-001", timezone: "Central", contact_window: "9AM-8PM CT", agent_name: "Scott", sms_agent_id: "agent-scott", created_at: "2026-08-01T12:00:00Z" },
          { thread_key: CANARY_B, template_id: null, timezone: "Pacific", contact_window: "9AM-8PM PT", agent_name: "Scott", sms_agent_id: "agent-scott", created_at: "2026-08-01T12:00:00Z" },
        ]);
      }
      return table([]);
    },
  };
}

test("PROOF 8: a bulk selection produces one schedulable plan per recipient", async () => {
  const plan = await buildBulkFollowUpPlan(
    { threadKeys: [CANARY_A, CANARY_B], now: NOW },
    { supabase: planSupabase() },
  );
  assert.equal(plan.ok, true, plan.error || "");
  assert.equal(plan.label, "Conversation Restart");
  assert.equal(plan.selected_count, 2);
  assert.equal(plan.eligible_count, 2, JSON.stringify(plan.recipients.map((r) => r.reason)));
  for (const r of plan.recipients) {
    assert.ok(r.message_body, "each eligible recipient carries rendered copy");
    assert.ok(r.template_id, "each carries template lineage");
    assert.ok(r.schedule.scheduled_for_utc, "each carries its OWN resolved time");
  }
});

test("PROOF 9 (bulk): the two canaries resolve to different local instants", async () => {
  const plan = await buildBulkFollowUpPlan(
    { threadKeys: [CANARY_A, CANARY_B], now: NOW },
    { supabase: planSupabase() },
  );
  const [a, b] = plan.recipients;
  assert.equal(a.schedule.timezone_iana, "America/Chicago");
  assert.equal(b.schedule.timezone_iana, "America/Los_Angeles");
  // Same UTC instant would mean the batch collapsed to one wall clock.
  assert.notEqual(a.schedule.local_send_hour, b.schedule.local_send_hour);
});

test("anti-repeat applies per seller in a bulk run", async () => {
  const plan = await buildBulkFollowUpPlan(
    { threadKeys: [CANARY_A, CANARY_B], now: NOW },
    { supabase: planSupabase() },
  );
  const a = plan.recipients.find((r) => r.thread_key === CANARY_A);
  // Canary A already received -001, so it must not be chosen again.
  assert.notEqual(a.template_id, "lc-reengage-agent-en-001");
  assert.equal(a.rotation_reason, "unused_variant_preferred");
});

test("PROOF 15: containment refuses every bulk recipient and writes nothing", async () => {
  const writes = [];
  const recorder = {
    from: (t) => {
      const q = {
        select: () => q, eq: () => q, gt: () => q, not: () => q, order: () => q, limit: () => q,
        maybeSingle: async () => ({ data: null, error: null }),
        insert: (p) => { writes.push({ t, op: "insert", p }); return q; },
        update: (p) => { writes.push({ t, op: "update", p }); return q; },
        upsert: (p) => { writes.push({ t, op: "upsert", p }); return q; },
      };
      return q;
    },
  };

  for (const canary of [CANARY_A, CANARY_B]) {
    const result = await runInboxAction({
      action: "schedule-reply",
      supabase: recorder,
      // Mirrors production exactly: outbound transport is ENABLED and the queue
      // runner is on, so nothing earlier can mask the result -- the refusal has
      // to come from followup_automation_mode = internal_only itself.
      getFlags: async () => ({
        queue_runner_enabled: true,
        outbound_sms_enabled: true,
        auto_reply_enabled: false,
        followup_enabled: false,
      }),
      payload: {
        thread_key: canary,
        to_phone_number: canary,
        from_phone_number: "+15555550111",
        message_body: "Hey Sarah, this is Ryan. Just following up on 123 Main St.",
        scheduled_for: "2026-09-08T18:30:00Z",
        template_id: "lc-reengage-agent-en-002",
        dry_run: false,
      },
    });
    assert.equal(result.ok, false, `${canary} must be refused`);
    assert.equal(result.reason, "followup_disabled");
  }
  assert.equal(writes.length, 0, `containment breach: ${JSON.stringify(writes)}`);
});


// ── ASSIGNED AGENT ──────────────────────────────────────────────────────────

test("{{agent_name}} is the agent ASSIGNED TO THAT SELLER, per recipient", async () => {
  const plan = await buildBulkFollowUpPlan(
    { threadKeys: [CANARY_A, CANARY_B], now: NOW },
    { supabase: planSupabase() },
  );
  const a = plan.recipients.find((r) => r.thread_key === CANARY_A);
  const b = plan.recipients.find((r) => r.thread_key === CANARY_B);

  assert.equal(a.assigned_agent_name, "Michael Hargrove");
  assert.equal(b.assigned_agent_name, "Helen Crawford");
  // Each seller's copy is signed by THEIR OWN agent.
  assert.match(a.message_body, /Michael/);
  assert.match(b.message_body, /Helen/);
  // And never by the other seller's agent.
  assert.ok(!/Helen/.test(a.message_body), "seller A must not be signed by Helen");
  assert.ok(!/Michael/.test(b.message_body), "seller B must not be signed by Michael");
});

test("no batch-level agent name can override a seller's assigned agent", async () => {
  // The override parameter no longer exists; passing one must change nothing.
  const plan = await buildBulkFollowUpPlan(
    { threadKeys: [CANARY_A], agentName: "Ryan", now: NOW },
    { supabase: planSupabase() },
  );
  const a = plan.recipients[0];
  assert.equal(a.assigned_agent_name, "Michael Hargrove");
  assert.match(a.message_body, /Michael/);
  assert.ok(!/Ryan/.test(a.message_body), "a batch name must never speak for a seller");
});

test("a seller with no assigned agent is NEED REVIEW, never signed by someone else", async () => {
  const noAgent = {
    from(name) {
      const t = (rows) => {
        const q = { select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q,
          then: (r) => Promise.resolve({ data: rows, error: null }).then(r) };
        return q;
      };
      if (name === "sms_templates") return t(FUS2);
      if (name === "canonical_inbox_threads") return t([{ thread_key: CANARY_A, prospect_first_name: "Sarah", property_address_full: "123 Main St" }]);
      if (name === "send_queue") return t([{ thread_key: CANARY_A, timezone: "Central", agent_name: null, created_at: "2026-08-01T12:00:00Z" }]);
      return t([]);
    },
  };
  const plan = await buildBulkFollowUpPlan({ threadKeys: [CANARY_A], now: NOW }, { supabase: noAgent });
  const a = plan.recipients[0];
  assert.equal(a.eligible, false, "unassigned seller must not be scheduled");
  assert.equal(a.message_body, undefined, "no copy may be rendered");
  assert.equal(plan.needs_review_count, 1);
});


test("the assigned agent comes from master_owners, not from who texted last", async () => {
  // Queue history says "Scott" for both threads; the master-owner assignment
  // says Michael Hargrove / Helen Crawford. The assignment must win.
  const plan = await buildBulkFollowUpPlan(
    { threadKeys: [CANARY_A, CANARY_B], now: NOW },
    { supabase: planSupabase() },
  );
  for (const r of plan.recipients) {
    assert.ok(!/Scott/.test(r.message_body), "queue history must not override the assignment");
  }
  assert.match(plan.recipients.find((r) => r.thread_key === CANARY_A).message_body, /Michael/);
  assert.match(plan.recipients.find((r) => r.thread_key === CANARY_B).message_body, /Helen/);
});

test("a full agent_persona renders as a first name", async () => {
  const plan = await buildBulkFollowUpPlan(
    { threadKeys: [CANARY_A], now: NOW },
    { supabase: planSupabase() },
  );
  const body = plan.recipients[0].message_body;
  assert.match(body, /this is Michael\.|Michael here|it's Michael/);
  assert.ok(!/Hargrove/.test(body), "surname must not appear in seller-facing copy");
});
