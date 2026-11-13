/**
 * P0 2026-10-19 — false-positive controls found by the v3 evaluation (9bf2e399), in English AND
 * the other languages, plus the model-independence guarantee:
 *   • "stop by / stop over" (a visit) is never an opt-out;
 *   • a CALL-only prohibition with a text affirmative ("Don't call, text is fine",
 *     "No llamen, mándenme mensaje") is a channel preference, never an SMS opt-out —
 *     while any text / contact prohibition ("don't call or text") stays an opt-out;
 *   • deterministic rules run before and regardless of any model result: an explicit opt-out
 *     always suppresses even when a model says otherwise, and a deterministic channel
 *     preference is never turned into a suppression by a model.
 * No network.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { classify, applyContactRevocationSafety } from "@/lib/domain/classification/classify.js";
import { isChannelPreferenceOnly } from "@/lib/domain/classification/multilingual-contact-revocation.js";
import { matchMultilingualOptOut } from "@/lib/domain/classification/multilingual-opt-out.js";
import { deterministicPrecheck } from "@/lib/domain/conversation-ai/precheck.js";

const STOP_BY = ["Stop by Saturday", "stop by anytime", "Stop over Sunday after church", "Can you stop by Tuesday?", "Feel free to stop in tomorrow", "You can stop by and see it"];
const CHANNEL = [
  "Don't call, text is fine", "Don't call me, text me", "Please don't call, just text", "No calls please, text me instead",
  "No llamen, mándenme mensaje", "No me llames, mándame un mensaje", "No me llamen, escríbanme", "No me llames, mejor escríbeme",
  "Não me ligue, me mande mensagem", "Ne m'appelez pas, envoyez-moi un SMS", "Pa rele m, ekri m pito",
  "Non mi chiami, mi scriva", "Nie dzwoń, napisz SMS", "Đừng gọi, nhắn tin được", "不要打电话，发短信就行",
  "전화하지 마시고 문자 주세요", "Huwag mo akong tawagan, text na lang", "لا تتصل بي، راسلني", "Не звоните, пишите", "Не звоните мне, пишите",
];
const STILL_OPT_OUT = ["Don't call or text", "Don't call me or text me", "no me llamen ni me escriban", "No me llames ni me mandes mensajes",
  "Não me ligue nem me mande mensagem", "Не звоните и не пишите", "STOP", "don't call me", "No me llames"];

const opt = (c) => c.primary_intent === "opt_out" || c.compliance_flag === "stop_texting" || c.automation_decision?.suppression_action === "opt_out";

test("a visit ('stop by / stop over / stop in') is never an opt-out, a hold, or a pre-check SUPPRESS", async () => {
  for (const m of STOP_BY) {
    const c = await classify(m, null, { heuristicOnly: true });
    assert.equal(opt(c), false, m);
    assert.notEqual(c.automation_decision?.precautionary_hold, true, m);
    const p = deterministicPrecheck({ text: m, inboundId: "in-1", deterministic: { intent: c.primary_intent, compliance_flag: c.compliance_flag } });
    assert.ok(!(p.decided && p.decision.outcome === "SUPPRESS"), `${m} → ${p.reason}`);
  }
});

test("a call-only prohibition with a text affirmative is a channel preference in every language — never an SMS opt-out", async () => {
  for (const m of CHANNEL) {
    assert.equal(isChannelPreferenceOnly(m), true, `channel: ${m}`);
    assert.equal(matchMultilingualOptOut(m), null, m);
    const c = await classify(m, null, { heuristicOnly: true });
    assert.equal(opt(c), false, `${m} → ${c.primary_intent}/${c.compliance_flag}`);
    assert.notEqual(c.automation_decision?.precautionary_hold, true, m);
    const p = deterministicPrecheck({ text: m, inboundId: "in-1", deterministic: { intent: c.primary_intent, compliance_flag: c.compliance_flag } });
    assert.ok(!(p.decided && p.decision.outcome === "SUPPRESS"), `${m} → ${p.reason}`);
  }
});

test("any text / contact prohibition keeps it an opt-out (the carve never widens)", async () => {
  for (const m of STILL_OPT_OUT) {
    assert.equal(isChannelPreferenceOnly(m), false, m);
    assert.equal(opt(await classify(m, null, { heuristicOnly: true })), true, m);
  }
});

test("model independence: an explicit deterministic opt-out suppresses even when a model result says otherwise", () => {
  const model_said = (primary) => ({ primary_intent: primary, compliance_flag: null, confidence: 0.95, source: "ai", matched_rule_ids: [], automation_decision: { suppression_action: "none", auto_reply_allowed: true, queue_action: "queue_auto_reply" } });
  for (const m of ["Quíteme de su lista", "sáqueme de su lista", "no me vuelvan a contactar", "Tanpri sispann voye mesaj ban mwen", "sispann ekri m", "不要再给我发短信了", "Перестаньте мне писать"]) {
    for (const primary of ["not_interested", "asks_offer", "unclear", "ownership_confirmed"]) {
      const r = applyContactRevocationSafety(model_said(primary), m);
      assert.equal(r.primary_intent, "opt_out", `${m} (model: ${primary})`);
      assert.equal(r.compliance_flag, "stop_texting");
      assert.equal(r.automation_decision.suppression_action, "opt_out");
      assert.equal(r.automation_decision.auto_reply_allowed, false);
    }
  }
});

test("model independence: the full classify() path (model unavailable) and the heuristic path agree on every control", async () => {
  for (const m of [...STOP_BY, ...CHANNEL, ...STILL_OPT_OUT]) {
    const h = await classify(m, null, { heuristicOnly: true });
    const f = await classify(m, null, {});
    assert.equal(opt(f), opt(h), m);
  }
});
