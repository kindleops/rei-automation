/**
 * OWNER RULE (P0 2026-10-19): never fall back to English for a non-English contact.
 *   1. Referral outreach (execute-referral-automation.js): the ownership template is in the
 *      contact's language, or the referral goes to a person (review, no send) — never English.
 *   2. Content-filter rotation (resolve-deferred-queue-message.js resolveRotationTemplate +
 *      sms-engine.js normalizeSendQueueRow / failover): the row's language survives
 *      normalization and is the ONLY rotation language; an unknown language is a hold for a
 *      person (queue_status held, dispatch_hold) — never English copy, never a re-dispatch.
 * No network.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { executeReferralAutomation } from "@/lib/domain/seller-flow/execute-referral-automation.js";
import { resolveInboundRelationship } from "@/lib/domain/seller-flow/resolve-inbound-relationship.js";
import { resolveRotationTemplate } from "@/lib/domain/queue/resolve-deferred-queue-message.js";
import { normalizeSendQueueRow, finalizeSendQueueFailure } from "@/lib/supabase/sms-engine.js";

/** A permissive chainable fake: every read is empty except sms_templates, filtered like PostgREST. */
function fakeSupabase(templates = []) {
  const seen = { template_languages: [] };
  const from = (table) => {
    const st = { table, filters: [] };
    const result = () => {
      if (table !== "sms_templates") return { data: [], error: null };
      let rows = templates.slice();
      for (const [op, col, val] of st.filters) {
        if (op === "eq") rows = rows.filter((r) => r[col] === val);
        if (op === "in") { if (col === "language") seen.template_languages.push(val); rows = rows.filter((r) => val.includes(r[col])); }
      }
      return { data: rows, error: null };
    };
    const chain = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return (res, rej) => Promise.resolve(result()).then(res, rej);
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve({ data: table === "sms_templates" ? result().data[0] ?? null : null, error: null });
        if (prop === "eq") return (c, v) => { st.filters.push(["eq", c, v]); return chain; };
        if (prop === "in") return (c, v) => { st.filters.push(["in", c, v]); return chain; };
        return () => chain;
      },
    });
    return chain;
  };
  return { client: { from, rpc: async () => ({ data: null, error: null }) }, seen };
}

const tpl = (template_id, language, body) => ({
  template_id, id: template_id, language, use_case: "ownership_check", is_active: true, safe_for_auto_reply: true,
  quarantine_state: "active", template_body: body, priority_rank: 1,
});
const ENGLISH = tpl("ref-en", "English", "Hi {{seller_first_name}}, do you own {{property_address}}?");
const SPANISH = tpl("ref-es", "Spanish", "Hola {{seller_first_name}}, ¿es usted dueño de {{property_address}}?");

function relationship(id) {
  return resolveInboundRelationship({
    message: "Never been the owner / His name is Sharon Schwartz / Tel (561)706-4622",
    classification: { primary_intent: "wrong_number", objection: "wrong_number" },
    source_event_id: id, source_thread_key: "+15550002000", source_contact_phone: "+15550002000", property_id: "234334277",
  });
}
const run = (supabaseClient, language_preference, id) => executeReferralAutomation({
  supabaseClient, relationship: relationship(id), execution_allowed: true, source_scope_allowed: true,
  auto_reply_mode: "live_limited", dry_run: true, inboundTo: "+15551234567",
  context: { summary: { property_address: "123 Main St", ...(language_preference ? { language_preference } : {}) } },
});

test("referral: a Spanish contact with only an ENGLISH template goes to a person — no send, never English", async () => {
  const { client, seen } = fakeSupabase([ENGLISH]);
  const r = await run(client, "Spanish", "evt-ref-es-1");
  assert.equal(r.action, "review", JSON.stringify(r));
  assert.equal(r.queued, false);
  assert.equal(r.reason, "no_referral_ownership_template_in_contact_language");
  assert.ok(seen.template_languages.every((ls) => !ls.includes("English")), JSON.stringify(seen.template_languages));
});

test("referral: with a Spanish template a Spanish contact passes template selection on Spanish only (English never queried); an English contact queries English only", async () => {
  // (Selection is the unit under test. The render step after it has its own, pre-existing
  // contract and is not asserted here.)
  const es = fakeSupabase([ENGLISH, SPANISH]);
  const r1 = await run(es.client, "Spanish", "evt-ref-es-2");
  assert.ok(!["no_referral_ownership_template_in_contact_language", "referral_language_unknown"].includes(r1.reason), JSON.stringify(r1));
  assert.deepEqual(es.seen.template_languages, [["Spanish"]]);
  const en = fakeSupabase([ENGLISH, SPANISH]);
  const r2 = await run(en.client, "English", "evt-ref-en-1");
  assert.ok(!["no_referral_ownership_template_in_contact_language", "referral_language_unknown"].includes(r2.reason), JSON.stringify(r2));
  assert.deepEqual(en.seen.template_languages, [["English"]]);
});

test("referral: an UNKNOWN contact language is a hold for a person, never English", async () => {
  const { client } = fakeSupabase([ENGLISH, SPANISH]);
  const r = await run(client, null, "evt-ref-unknown");
  assert.equal(r.action, "review");
  assert.equal(r.queued, false);
  assert.equal(r.reason, "referral_language_unknown");
});

// ── content-filter rotation ─────────────────────────────────────────────────
const rotTpl = (id, language, body) => ({
  template_id: id, template_body: body, use_case: "ownership_check", language, stage_code: "S1", property_type_scope: null,
  allowed_property_groups: null, prohibited_property_groups: null, is_active: true, safe_for_auto_reply: true,
  minimal_fallback: false, fallback_rank: null, quarantine_state: "active",
});
const ROT = [rotTpl("own-en-2", "English", "Hi Ana, do you still own 12 Oak St?"), rotTpl("own-es-2", "Spanish", "Hola Ana, ¿todavía es dueña de 12 Oak St?")];
function rotationSupabase() {
  const { client } = fakeSupabase([]);
  return {
    from(table) {
      if (table !== "sms_templates") return client.from(table);
      const filters = [];
      const chain = {
        select: () => chain, limit: () => chain,
        eq: (c, v) => { filters.push([c, v]); return chain; },
        then: (res, rej) => Promise.resolve({ data: ROT.filter((t) => filters.every(([c, v]) => t[c] === v)), error: null }).then(res, rej),
      };
      return chain;
    },
  };
}
const queueRow = (extra = {}) => ({
  id: "q-1", use_case_template: "ownership_check", template_id: "own-es-1", seller_first_name: "Ana", property_address: "12 Oak St",
  to_phone_number: "+13125550401", metadata: { stage_code: "S1" }, ...extra,
});

test("normalizeSendQueueRow carries the row's language (column, else metadata) — it was dropped before rotation", () => {
  assert.equal(normalizeSendQueueRow(queueRow({ language: "Spanish" })).language, "Spanish");
  assert.equal(normalizeSendQueueRow(queueRow({ metadata: { selected_template_language: "Spanish" } })).language, "Spanish");
  assert.equal(normalizeSendQueueRow(queueRow()).language, null, "an unknown language stays unknown, never English");
});

test("rotation: a SPANISH row rotates only onto Spanish copy, through the normalized row", async () => {
  const r = await resolveRotationTemplate(normalizeSendQueueRow(queueRow({ language: "Spanish" })), { supabase: rotationSupabase(), excludeTemplateIds: ["own-es-1"] });
  assert.equal(r.resolved, true, JSON.stringify(r));
  assert.equal(r.template_id, "own-es-2");
  assert.match(r.message_body, /Hola/);
});

test("rotation: an UNKNOWN row language is a HOLD — never English copy", async () => {
  const r = await resolveRotationTemplate(normalizeSendQueueRow(queueRow()), { supabase: rotationSupabase(), excludeTemplateIds: ["own-es-1"] });
  assert.equal(r.resolved, false);
  assert.equal(r.hold, true);
  assert.equal(r.reason, "rotation_language_unknown");
  assert.equal(r.message_body, undefined);
});

// ── the failover path end to end (finalizeSendQueueFailure → rotation) ──────
const BLOCKED_ROW = (extra = {}) => ({
  id: "rot-es-1", queue_status: "sending", retry_count: 0, max_retries: 2,
  from_phone_number: "+13235589881", to_phone_number: "+16023329348",
  message_body: "Hola Ana, ¿es usted dueña de 12 Oak St?", template_id: "own-es-1", selected_template_id: "own-es-1",
  use_case_template: "ownership_check", seller_first_name: "Ana", property_address: "12 Oak St",
  provider_message_id: "SM_BLOCKED", textgrid_message_id: "SM_BLOCKED", metadata: { provider_message_sid: "SM_BLOCKED", stage_code: "S1" },
  ...extra,
});
async function failover(row) {
  const captured = [];
  await finalizeSendQueueFailure(row, "lock", new Error("blocked by textgrid content filter"), {
    updateSendQueueRowWithLock: async (row_id, lock_token, payload) => { captured.push(payload); return { id: row_id, ...payload }; },
    supabase: rotationSupabase(),
  });
  assert.equal(captured.length, 1);
  return captured[0];
}

test("failover: a content-filtered SPANISH row (language in metadata only) rotates onto Spanish copy", async () => {
  const p = await failover(BLOCKED_ROW({ metadata: { provider_message_sid: "SM_BLOCKED", stage_code: "S1", selected_template_language: "Spanish" } }));
  assert.equal(p.queue_status, "queued", JSON.stringify(p).slice(0, 400));
  assert.equal(p.template_id, "own-es-2");
  assert.match(p.message_body, /Hola/);
});

test("failover: a content-filtered row with NO known language is HELD for a person — never English, never re-dispatched", async () => {
  const p = await failover(BLOCKED_ROW());
  assert.equal(p.queue_status, "held", JSON.stringify(p).slice(0, 400));
  assert.equal(p.next_retry_at, null);
  assert.ok(p.held_at);
  assert.equal(p.metadata.dispatch_hold, "rotation_language_unknown");
  assert.equal(p.metadata.requires_human_review, true);
  assert.equal(p.message_body, undefined, "the body is not rewritten");
  assert.notEqual(p.template_id, "own-en-2");
});
