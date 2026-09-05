import test from "node:test";
import assert from "node:assert/strict";
import { resolveDeferredQueueMessage } from "@/lib/domain/queue/resolve-deferred-queue-message.js";

// A FUS2 template exactly as stored: operator-safe, NEVER auto-reply-safe,
// but approved for no-reply continuation.
const FUS2 = {
  id: "u1", template_id: "lc-reengage-agent-en-002", language: "English",
  use_case: "reengagement", stage_code: "FUS2",
  template_body: "Hey {{seller_first_name}}, {{agent_name}} here. Wanted to circle back on {{property_address}} and see if you'd consider a proposal.",
  is_active: true, safe_for_auto_reply: false,
  metadata: { template_family: "bulk_conversation_restart", eligible_for_no_reply_followup: true },
};
// A conventional nurture template: auto-reply-safe, no continuation capability.
const NURTURE = {
  id: "u2", template_id: "nurture-unclear-001", language: "English",
  use_case: "nurture_unclear", stage_code: "S6",
  template_body: "Hi {{seller_first_name}}, just checking in on {{property_address}}.",
  is_active: true, safe_for_auto_reply: true, metadata: {},
};

/** Records the filters applied so we can assert on the actual query shape. */
function templateStore(rows) {
  const calls = [];
  return {
    calls,
    from() {
      const f = {};
      const q = {
        select: () => q,
        limit: () => q,
        in: (col, vals) => { f[col] = vals; return q; },
        eq: (col, val) => { f[col] = val; return q; },
        then: (res) => {
          calls.push({ ...f });
          const matched = rows.filter((r) => {
            if (f.is_active !== undefined && r.is_active !== f.is_active) return false;
            if (f.safe_for_auto_reply !== undefined && r.safe_for_auto_reply !== f.safe_for_auto_reply) return false;
            if (f["metadata->>eligible_for_no_reply_followup"] !== undefined) {
              const want = f["metadata->>eligible_for_no_reply_followup"] === "true";
              if (Boolean(r.metadata?.eligible_for_no_reply_followup) !== want) return false;
            }
            if (f.use_case && !f.use_case.includes(r.use_case)) return false;
            if (f.language && !f.language.includes(r.language)) return false;
            return true;
          });
          return Promise.resolve({ data: matched, error: null }).then(res);
        },
      };
      return q;
    },
  };
}

const noReplyRow = (over = {}) => ({
  id: "q1",
  type: "followup",
  message_type: "followup",
  queue_status: "scheduled",
  use_case_template: "reengagement",
  language: "English",
  to_phone_number: "+15555550100",
  seller_first_name: "Sarah",
  agent_name: "Crystal",
  property_address: "123 Main St",
  // deferred_message_resolution is what marks a row for send-time template
  // resolution; intent=stage_no_reply is the canonical no-reply follow-up context.
  metadata: { deferred_message_resolution: true, intent: "stage_no_reply", followup_use_case: "reengagement" },
  ...over,
});

// ── PROOF 4 + 5: the no-reply context CAN select FUS2 ───────────────────────

test("PROOF 4: delivery-triggered no-reply follow-up resolves an approved FUS2 template", async () => {
  const supabase = templateStore([FUS2, NURTURE]);
  const result = await resolveDeferredQueueMessage(noReplyRow(), { supabase });

  assert.equal(result.resolved, true, result.reason || "must resolve");
  assert.equal(result.template_id, "lc-reengage-agent-en-002");
  assert.equal(result.stage_code, "FUS2", "continuation stays in the FUS2 family");
  assert.match(result.message_body, /Sarah/);
  assert.match(result.message_body, /Crystal/);
  assert.ok(!result.message_body.includes("{{"), "no unresolved tokens");
});

test("PROOF 5: the family comes from delivered lineage, not lifecycle stage", async () => {
  // lifecycle_stage is irrelevant here by construction: the row carries the
  // delivered outbound's use case, so a pre-S2 thread still continues in FUS2
  // rather than falling back to an S1 ownership template.
  const supabase = templateStore([FUS2, NURTURE]);
  const result = await resolveDeferredQueueMessage(
    noReplyRow({ metadata: { deferred_message_resolution: true, intent: "stage_no_reply", followup_use_case: "reengagement", lifecycle_stage: "ownership_confirmation" } }),
    { supabase },
  );
  assert.equal(result.resolved, true);
  assert.equal(result.stage_code, "FUS2");
  assert.notEqual(result.use_case, "ownership_check");
});

// ── PROOF 2: the capability must NOT leak into inbound auto-reply ───────────

test("PROOF 2: the capability does NOT make FUS2 eligible for an inbound auto reply", async () => {
  // A nurture row is the inbound-triggered autonomous-reply context. FUS2 is
  // safe_for_auto_reply=false, so it must be invisible here even though it now
  // carries eligible_for_no_reply_followup.
  const supabase = templateStore([FUS2, NURTURE]);
  const result = await resolveDeferredQueueMessage(
    // Inbound-triggered autonomous reply context: intent is a nurture intent,
    // NOT stage_no_reply, so the capability bypass must not apply.
    noReplyRow({ use_case_template: "nurture_unclear",
      metadata: { deferred_message_resolution: true, intent: "unclear" } }),
    { supabase },
  );

  assert.notEqual(result.template_id, "lc-reengage-agent-en-002", "FUS2 leaked into auto-reply selection");

  // And structurally: the auto-reply context never queries the capability.
  const askedForCapability = supabase.calls.some(
    (c) => c["metadata->>eligible_for_no_reply_followup"] !== undefined,
  );
  assert.equal(askedForCapability, false, "capability must not be consulted outside the no-reply context");
});

test("the no-reply context still requires safe_for_auto_reply OR the capability", async () => {
  // A template with neither must never be selected.
  const INELIGIBLE = { ...FUS2, id: "u3", template_id: "unapproved-001",
    safe_for_auto_reply: false, metadata: { template_family: "bulk_conversation_restart" } };
  const supabase = templateStore([INELIGIBLE]);
  const result = await resolveDeferredQueueMessage(noReplyRow(), { supabase });
  assert.equal(result.resolved, false, "an unapproved template must not resolve");
});

test("the bypass is scoped: the no-reply query asks for BOTH gates, auto-reply asks for one", async () => {
  const supabase = templateStore([FUS2, NURTURE]);
  await resolveDeferredQueueMessage(noReplyRow(), { supabase });
  const capabilityQueries = supabase.calls.filter(
    (c) => c["metadata->>eligible_for_no_reply_followup"] !== undefined,
  );
  const autoReplyQueries = supabase.calls.filter((c) => c.safe_for_auto_reply === true);
  assert.equal(capabilityQueries.length, 1, "capability queried exactly once");
  assert.equal(autoReplyQueries.length, 1, "auto-reply-safe still queried (union, not replacement)");
});
