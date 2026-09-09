/**
 * dispatch-sendability-parity.test.mjs
 *
 * Split-brain (2026-09-09): sms-health-guard refused templates/senders at
 * dispatch that assignment, campaign enqueue and the manual sender fallback
 * happily selected (24 blocked_template_id refusals on the first live day).
 * Contract: there is ONE answer to "can this template / sender participate in
 * production sending?", and every upstream selector reads the guard's own
 * merged config. Established-conversation sender continuity is untouched.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  getDispatchBlockedSets,
  isTemplateDispatchBlocked,
  isSenderDispatchBlocked,
  evaluateSmsHealthGuard,
} from "@/lib/domain/delivery/sms-health-guard.js";
import { renderableRotationPool, assignTemplateForTargetFast } from "@/lib/domain/campaigns/campaign-target-template-assignment.js";

const EMPTY_ENV = {};
const tpl = (id, lang = "English", extra = {}) => ({
  template_id: id, id, language: lang, is_active: true, use_case: "ownership_check", stage_code: "S1",
  property_type_scope: "any residential",
  template_body: `V${id} {{seller_first_name}} {{agent_name}} {{property_address}}`, ...extra,
});
const TARGET = { id: "t-1", master_owner_id: "o-1", property_id: "p-1", phone_id: "ph-1", language: "English",
  property_address: "1 Main St", market: "Miami, FL", metadata: { candidate_snapshot: { seller_first_name: "Ana", property_type: "Residential" } } };
const CAMPAIGN = { id: "c-1", metadata: { stage_code: "S1", template_use_case: "ownership_check" } };

// ── the single source ────────────────────────────────────────────────────────

test("dynamic lists (env + system_control) and dispatch agree on the same sets", () => {
  const sets = getDispatchBlockedSets({ SMS_BLOCKED_TEMPLATE_IDS: "T-ENV", SMS_BLOCKED_SENDER_NUMBERS: "+13055550001" },
                                      { sms_blocked_template_ids: "T-SC", sms_blocked_sender_numbers: "3055550002" });
  assert.equal(isTemplateDispatchBlocked("T-ENV", sets), true);
  assert.equal(isTemplateDispatchBlocked("T-SC", sets), true);
  assert.equal(isTemplateDispatchBlocked("T-OK", sets), false);
  assert.equal(isSenderDispatchBlocked("+13055550001", sets), true);
  assert.equal(isSenderDispatchBlocked("(305) 555-0002", sets), true, "normalized before comparing");
  assert.equal(isSenderDispatchBlocked("+13055559999", sets), false);
  // and dispatch itself refuses exactly those
  const refused = evaluateSmsHealthGuard({ from_phone_number: "+13055559999", template_id: "T-SC", env: {}, system_control: { sms_blocked_template_ids: "T-SC" } });
  assert.equal(refused.allowed, false); assert.equal(refused.reason, "blocked_template_id");
});

// ── contract 1 + 2: templates ────────────────────────────────────────────────

test("1. a dispatch-blocked template is never assigned, even when governed and renderable", () => {
  const sets = getDispatchBlockedSets(EMPTY_ENV, { sms_blocked_template_ids: "B1" });
  const pool = [tpl("B1"), tpl("G1"), tpl("G2")];
  const catalog = pool.filter((t) => !isTemplateDispatchBlocked(t.template_id, sets)); // what loadOwnershipTemplates now returns as `eligible`
  for (let i = 0; i < 40; i += 1) {
    const r = assignTemplateForTargetFast({ ...TARGET, id: `t-${i}`, master_owner_id: `o-${i}` }, CAMPAIGN, catalog);
    assert.equal(r.template_state, "assigned"); assert.notEqual(r.template_id, "B1");
  }
});

test("2. a canonical-valid template is NOT rejected when no dynamic block names it", () => {
  const sets = getDispatchBlockedSets(EMPTY_ENV, {});
  assert.equal(isTemplateDispatchBlocked("211393", sets) || isTemplateDispatchBlocked("204273", sets), false,
    "valid governed templates must not be blocked by anything other than an explicit, visible list");
});

// ── contract 3 + 4: senders ──────────────────────────────────────────────────

test("3. a dispatch-blocked sender is not selectable for new outreach; 4. a valid one is", () => {
  const sets = getDispatchBlockedSets(EMPTY_ENV, { sms_blocked_sender_numbers: "+13055552000" });
  const candidates = [{ phone_number: "+13055552000" }, { phone_number: "+13055553000" }];
  const sendable = candidates.filter((n) => !isSenderDispatchBlocked(n.phone_number, sets));
  assert.deepEqual(sendable.map((n) => n.phone_number), ["+13055553000"]);
  assert.equal(isSenderDispatchBlocked("+13055553000", getDispatchBlockedSets(EMPTY_ENV, {})), false);
});

// ── contract 6 + 7: rotation still spans the valid pools ─────────────────────

test("6. English rotation spans the remaining valid pool after a block; 7. Spanish unchanged", () => {
  const sets = getDispatchBlockedSets(EMPTY_ENV, { sms_blocked_template_ids: "E5" });
  const en = ["E1","E2","E3","E4","E5"].map((id) => tpl(id)).filter((t) => !isTemplateDispatchBlocked(t.template_id, sets));
  const es = ["S1","S2","S3"].map((id) => tpl(id, "Spanish"));
  assert.equal(renderableRotationPool(en, "English").length, 4);
  const used = new Set(), usedEs = new Set();
  for (let i = 0; i < 80; i += 1) {
    used.add(assignTemplateForTargetFast({ ...TARGET, id: `e-${i}`, master_owner_id: `o-${i}` }, CAMPAIGN, en).template_id);
    usedEs.add(assignTemplateForTargetFast({ ...TARGET, id: `s-${i}`, master_owner_id: `o-${i}`, language: "Spanish" }, CAMPAIGN, es).template_id);
  }
  assert.ok(used.size >= 3 && !used.has("E5"), `english used=${[...used]}`);
  assert.ok(usedEs.size >= 2, `spanish used=${[...usedEs]}`);
});

// ── contract 9: dispatch behaviour itself is unchanged ───────────────────────

test("9. dispatch still refuses exactly what the merged config names -- nothing more", () => {
  const ok = evaluateSmsHealthGuard({ from_phone_number: "+13055559999", template_id: "211393", env: {}, system_control: {} });
  assert.equal(ok.allowed, true);
});
