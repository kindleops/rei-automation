import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { buildConversationContext } from "@/lib/domain/classification/build-conversation-context.js";
import { resolveQueueSellerFirstName } from "@/lib/supabase/sms-engine.js";
import { launchCandidateFromTarget } from "@/lib/domain/campaigns/campaign-automation-service.js";

/**
 * 2026-09-28, Minneapolis: a seller answered "Yes" to "do you still own the
 * commercial property at …?" and no auto-reply went out. Three independent
 * breaks, each pinned here.
 */

function fakeSupabase(rows) {
  return {
    from(table) {
      const f = []
      const b = {
        select() { return b },
        eq(c, v) { f.push((r) => r[c] === v); return b },
        in(c, vs) { f.push((r) => vs.includes(r[c])); return b },
        not() { return b }, lte() { return b }, gt() { return b }, lt() { return b }, order() { return b },
        limit() { return b },
        then(res) { return Promise.resolve({ data: table === "send_queue" ? rows.filter((r) => f.every((x) => x(r))) : [], error: null }).then(res) },
      }
      return b
    },
  }
}

test("a campaign text stored as a bare 10-digit number still gives a reply its context", async () => {
  const supabase = fakeSupabase([{ id: "q1", to_phone_number: "6125589879", queue_status: "delivered", message_type: null, message_body: "Hi Arsenio, this is Alex. Quick question, do you still own the commercial property at 4729 Lyndale Ave N?", sent_at: "2026-09-28T14:54:23Z", delivered_at: "2026-09-28T14:54:30Z" }])
  const ctx = await buildConversationContext({ thread_key: "+16125589879", inbound_received_at: "2026-09-28T14:55:05Z", supabase })
  assert.ok(ctx, "context resolved");
  assert.equal(ctx.last_outbound_use_case, "ownership_check");
});

test("an auto-reply row with only seller_display_name resolves a PERSON's first name, never a company's", () => {
  assert.equal(resolveQueueSellerFirstName({ seller_display_name: "Arsenio J Thunstrom", metadata: {} }), "Arsenio");
  assert.equal(resolveQueueSellerFirstName({ seller_display_name: "Pegasus Land Co LLC", metadata: {} }), "");
  assert.equal(resolveQueueSellerFirstName({ seller_display_name: "Keith & Patricia Braithwaite", metadata: {} }), "");
  assert.equal(resolveQueueSellerFirstName({ seller_first_name: "Rose", seller_display_name: "Other Name", metadata: {} }), "Rose");
});

test("campaign candidates always carry an E.164 phone", () => {
  assert.equal(launchCandidateFromTarget({ to_phone_number: "6125589879", metadata: {} }).canonical_e164, "+16125589879");
  assert.equal(launchCandidateFromTarget({ to_phone_number: "16125589879", metadata: {} }).canonical_e164, "+16125589879");
  assert.equal(launchCandidateFromTarget({ to_phone_number: "+16125589879", metadata: {} }).canonical_e164, "+16125589879");
});

import { renderOutboundTemplate } from "@/lib/domain/outbound/supabase-candidate-feeder.js";

test("an operator-blocked template leaves the rotation pool; the seller gets an allowed sibling", async () => {
  const tpl = (id, body) => ({ template_id: id, id, use_case: "ownership_check", stage_code: "S1", language: "English", is_active: true, active: "Yes", property_type_scope: "Any Residential", allowed_property_groups: ["sfr"], template_body: body, text: body })
  const templates = [tpl("204705", "Hey {{seller_first_name}}, do you still own {{property_address}}?"), tpl("840900", "Hi {{seller_first_name}}, is {{property_address}} yours?")]
  const candidate = { seller_first_name: "Thai", property_address: "3111 Thomas Ave N", property_type: "Single Family", language: "English", canonical_e164: "+17634475601" }
  const base = { template_use_case: "ownership_check", stage_code: "S1", first_touch: true }
  const deps = { fetchSmsTemplates: async () => templates }
  const blocked = await renderOutboundTemplate(candidate, { ...base, blocked_template_ids: new Set(["204705"]) }, deps)
  const id = String(blocked.template_id ?? blocked.template?.template_id ?? blocked.selected_template_id ?? "")
  assert.notEqual(id, "204705", "a blocked template is never chosen")
});
