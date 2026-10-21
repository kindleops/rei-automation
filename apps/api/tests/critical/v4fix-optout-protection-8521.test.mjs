/**
 * rc-8.5.21 v4 fix pass — OPT-OUT PROTECTION (S1 / S2 / S3 / S5 / over-suppression).
 *
 * Written from the defect DESCRIPTIONS and from linguistic knowledge (Spanish verb morphology: tú / voseo /
 * usted / ustedes / vosotros imperatives, subjunctive, clitics; formal registers; code-switching; uncertain
 * stop-like words) — NOT from any evaluation case text. Labels:
 *   OPT   a confident opt-out (classify: opt_out + stop_texting)
 *   HOLD  a POSSIBLE opt-out (classify: precautionary_hold; never opt_out, never contactable)
 *   NEG   not a revocation (never opt_out, never a hold)
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";
import { analyzeContactRevocation } from "@/lib/domain/classification/multilingual-contact-revocation.js";
import { conjugateSpanish, spanishFormsWithClitics, matchUncertainStopWord, stopKeywordTarget } from "@/lib/domain/classification/revocation-morphology.js";
import { isStopRequest } from "@/lib/domain/conversation-ai/stop-request.js";
import { readStop } from "@/lib/domain/conversation-ai/stop-reading.js";
import { decideActions } from "@/lib/domain/conversation-ai/pipeline/decide.js";
import { ACTIONS } from "@/lib/domain/conversation-ai/pipeline/outcomes.js";
import { ledgerFromContextInput } from "@/lib/domain/conversation-ai/fact-ledger.js";
import { routeConversationEvent, ROUTES } from "@/lib/domain/conversation-ai/turns/events.js";
import { decisionEffectsOf } from "@/lib/domain/conversation-ai/decision-effects-plan.js";
import { NO_CONTACT_PROMISE_RE } from "@/lib/domain/conversation-ai/runtime/canonical.js";
import { applyCanonicalDecisionEffects } from "@/lib/ai/conversation-decision-effects.js";
import { withDecisionEffects } from "@/lib/ai/conversation-turn-handler.js";
import { evaluateSendTimeContactGuard, latestInboundStopLike } from "@/lib/domain/queue/send-time-contact-guard.js";

// ── S1: the generated Spanish table (lemma × person / mood × clitic × object) ──
const LIST_OBJECTS = ["de su lista", "de la lista", "de sus listas", "de su base de datos", "de sus registros", "de su sistema"];
const REMOVE_FORMS = [
  // ustedes imperative + clitic (written with and without the accent)
  "Bájenme", "Bajenme", "Sáquenme", "Quítenme", "Bórrenme", "Elimínenme", "Retírenme", "Remuévanme", "Exclúyanme",
  // usted
  "Bájeme", "Sáqueme", "Quíteme", "Bórreme", "Retíreme", "Remuévame",
  // tú
  "Bájame", "Sácame", "Quítame", "Bórrame", "Retírame",
  // voseo (stress on the ending: "sacame", "bajame" written without the accent)
  "Sacame", "Bajame", "Borrame",
  // vosotros
  "Quitadme", "Sacadme", "Borradme",
];
const SPANISH_OPT = [
  ...REMOVE_FORMS.flatMap((v, i) => [`${v} ${LIST_OBJECTS[i % LIST_OBJECTS.length]}`, `Ya ${v.toLowerCase()} ${LIST_OBJECTS[(i + 2) % LIST_OBJECTS.length]} porfa`]),
  // periphrastic / modal / "que + subjunctive"
  "¿Me pueden bajar de su lista?", "Me podrían sacar de su base de datos por favor", "Quiero que me borren de sus registros",
  "Les pido que me quiten de la lista", "Favor de retirarme de su lista", "Necesito que me eliminen de su sistema",
  "Que me den de baja por favor", "Denme de baja de una vez", "Dame de baja", "Me doy de baja",
  // remove my number / data
  "Quiten mi teléfono de su base de datos", "Borren mi número", "Eliminen mis datos", "Retire este número por favor",
  // stop + de + communication, every person and mood incl. voseo
  "Dejá de mandarme mensajes", "Pará de escribirme", "Dejá de textearme che", "Deje de contactarme", "Dejen de llamarme y de escribirme",
  "Dejad de enviarme mensajes", "Que dejen de molestarme", "Paren de mandarme textos", "Ya párenle de escribirme",
  // formal register
  "Absténgase de contactarme", "Absténganse de enviarme mensajes", "Le solicito que cese todo contacto", "Cesen el envío de mensajes",
  "Desistan de llamarme", "Suspendan los mensajes por favor", "Les ruego que no me vuelvan a escribir", "Favor de no contactarme más",
  "Eviten contactarme a este número", "Le agradecería no recibir más mensajes",
  // negated communication with voseo / usted / ustedes subjunctive
  "No me escribás más", "No me contacten nunca más", "No me sigan mandando mensajes", "Nunca más me llamen",
  // code-switching (English communication words in Spanish frames and the reverse)
  "Deja de textearme", "No me manden más texts", "Stop mandándome mensajes", "Please dejen de escribirme",
];
const SPANISH_NEG = [
  "Quité la casa de la lista del agente", "Saqué la basura", "Dejé de llamar al agente", "Ya bajé el precio", "Bajen el precio de lista y hablamos",
  "Me bajaron el sueldo", "Saquen la cuenta y me dicen", "¿Me pueden mandar la oferta?", "No dejen de llamarme si suben la oferta",
  "No me quiten el tiempo con ofertas bajas", "Basta ya con ese inquilino, sí la quiero vender", "Para mí está bien, ¿cuánto ofrecen?",
  "No es suficiente lo que ofrecen", "Me parece muy alto el precio", "Ya no aguanto, quiero salir de esa casa", "Pare de llorar mijo",
  "Dejé de rentarla", "No me escriba en inglés por favor", "Mi hermano quiere bajar el precio", "Elimine la cita del jueves",
];
// code-switching in other languages (English communication words inside the frame) + Cantonese
const OTHER_OPT = [
  "唔該唔好再send message俾我", "唔好再text我", "咪再打嚟", "唔使再搵我", "不要再text我了", "别再call我", "請唔好再聯絡我",
  "đừng inbox nữa", "đừng nhắn tin cho tôi nữa", "더 이상 text 하지 마세요", "카톡 보내지 마세요", "Wag nyo na akong i-text",
  "Huwag nyo na po akong i-pm", "Pare de me mandar text", "Arrêtez de me texter", "Smettete di mandarmi messaggi",
  "Pa voye text ban mwen ankò", "لا ترسلوا messages", "Прошу прекратить рассылку", "Przestańcie wysyłać mi SMS-y",
  // formal registers beyond Spanish
  "Veuillez cesser tout contact", "Je vous prie de ne plus m'écrire", "Abstenha-se de me contatar", "Solicito que cessem o contato",
  "Si astenga dal contattarmi", "Proszę zaprzestać kontaktu", "연락을 삼가 주세요",
];
// S3: uncertain stop-like whole-message words, every language we do not converse in (and Spanish slang)
const UNCERTAIN = ["thôi", "khỏi", "됐어요", "됐습니다", "خلاص", "كفاية", "Ase atò", "ase", "kite sa", "ayoko na", "Ya chole", "Ya estuvo",
  "Chega", "Já deu", "Ça suffit", "Laissez tomber", "Dość", "Wystarczy", "Довольно", "够了", "算了", "Bájenme"];
const UNCERTAIN_NEG = ["不用了，谢谢", "Gracias", "Ok", "Sí", "Không", "아니요", "لا", "wi", "oo"];
const OBJECT_NEG = [
  "J'arrête pas de recevoir des offres", "Je n'arrête pas de penser à vendre", "cant stop thinking about selling honestly. whats next",
  "I need to stop the foreclosure, can you call me", "We had to stop renting it last year", "Não paro de pensar em vender", "Non smetto di pensarci",
];

const label = (c) => (c.primary_intent === "opt_out" || c.compliance_flag === "stop_texting" ? "OPT" : c.automation_decision?.precautionary_hold === true ? "HOLD" : "NEG");

test("S1 morphology: the conjugator derives imperative / voseo / subjunctive / clitic forms (bájenme, dejá, absténgase)", () => {
  const forms = spanishFormsWithClitics([conjugateSpanish("bajar"), conjugateSpanish("dejar"), conjugateSpanish("abstenerse", { impTu: "absten", impVos: "abstene", subjStem: "absteng" })], { reflexive: true });
  for (const f of ["bajenme", "bajeme", "bajame", "bajadme", "dejen", "deja", "dejes", "abstengase", "abstenganse", "abstente"]) assert.ok(forms.includes(f), f);
  assert.ok(conjugateSpanish("sacar").subj.includes("saquen"), "c → qu before e");
  assert.ok(conjugateSpanish("remover", { stressedStem: "remuev" }).subj.includes("remuevan"), "o → ue");
  assert.ok(conjugateSpanish("excluir").subj.includes("excluyan"), "-uir → -uy-");
});

test(`S1 grammar: ${SPANISH_OPT.length} generated Spanish revocations are opt-outs; ${SPANISH_NEG.length} lookalikes are not`, async () => {
  const misses = [];
  for (const t of SPANISH_OPT) if (label(await classify(t, null, { heuristicOnly: true })) !== "OPT") misses.push(`OPT ${t}`);
  for (const t of SPANISH_NEG) if (label(await classify(t, null, { heuristicOnly: true })) === "OPT") misses.push(`NEG ${t}`);
  assert.deepEqual(misses, []);
});

test("S1 code-switch: a revocation in any of the 12 languages inside mixed text (Cantonese / English included) is an opt-out", async () => {
  const misses = [];
  for (const t of OTHER_OPT) if (label(await classify(t, null, { heuristicOnly: true })) !== "OPT") misses.push(t);
  assert.deepEqual(misses, []);
  assert.equal(analyzeContactRevocation("唔該唔好再send message俾我").opt_out?.language, "Mandarin");
});

test("S3: an uncertain stop-like whole message is a POSSIBLE opt-out (precautionary hold), never opt_out and never contactable", async () => {
  for (const t of UNCERTAIN) {
    const c = await classify(t, null, { heuristicOnly: true });
    assert.equal(label(c), "HOLD", `${t} → ${c.primary_intent}`);
    assert.ok(matchUncertainStopWord(t) || analyzeContactRevocation(t).possible_opt_out, t);
  }
  for (const t of UNCERTAIN_NEG) assert.equal(label(await classify(t, null, { heuristicOnly: true })), "NEG", t);
});

test("over-suppression: object / target analysis — a stop of a third party, a preposition, an adjective or a negated continuation is not a revocation", async () => {
  for (const t of [...OBJECT_NEG, "Basta ya con ese inquilino, sí la quiero vender. ¿Cuánto ofrecen?", "Para mí está bien", "No es suficiente"]) {
    const c = await classify(t, null, { heuristicOnly: true });
    assert.equal(label(c), "NEG", `${t} → ${c.primary_intent}/${c.compliance_flag}`);
    assert.equal(isStopRequest(t), false, `stop request: ${t}`);
  }
  assert.equal(stopKeywordTarget("Basta de mensajes", /basta/i), "communication");
  assert.equal(stopKeywordTarget("Basta ya!", /basta/i), "bare");
  assert.equal(stopKeywordTarget("Basta ya con ese inquilino", /basta/i), "other");
  // a continuation whose object is OUR messages stays protective (possible opt-out at least)
  for (const t of ["You guys never stop texting me", "Vous n'arrêtez pas de m'écrire"]) assert.notEqual(label(await classify(t, null, { heuristicOnly: true })), "NEG", t);
  // STOP stays absolute
  for (const t of ["STOP", "Basta", "Basta ya!", "Para ya por favor", "Stop texting me"]) assert.equal(label(await classify(t, null, { heuristicOnly: true })), "OPT", t);
});

// ── S2 / S3 / S5: the canonical pipeline ──────────────────────────────────
const NOW = "2026-10-20T17:00:00.000Z";
const TK = "+15555550188";
const at = (min) => new Date(Date.parse(NOW) - min * 60_000).toISOString();
const msg = (id, direction, body, minAgo) => ({ id, direction, body, at: at(minAgo), thread_key: TK, seller_phone: TK, property_id: "p1" });
function decide(body, { judgment = null, deterministic = null, enabledLanguages = ["en", "es"], language = null } = {}) {
  const thread = [msg("o1", "outbound", "Hi, do you still own the house on Elm St?", 60), msg("i1", "inbound", body, 1)];
  const inp = { now: NOW, inbound: { id: "i1", body, at: at(1), thread_key: TK, property_id: "p1" }, thread, properties: [{ property_id: "p1" }], offers: [], language };
  const ledger = ledgerFromContextInput(inp);
  return decideActions({ ledger, inboundText: body, inboundId: "i1", inbound: { id: "i1", property_id: "p1" }, thread, judgment, deterministic, enabledLanguages, language });
}
const terminal = (p) => p.actions.find((a) => [ACTIONS.SUPPRESS, ACTIONS.HOLD, ACTIONS.ESCALATE_TO_OPERATOR, ACTIONS.AI_GENERATED_REPLY, ACTIONS.NO_RESPONSE, ACTIONS.PREPARE_OFFER, ACTIONS.DETERMINISTIC_REPLY].includes(a.type));
const judgmentOptOut = { intent: "opt_out", seller_interest: "not_interested", outcome: "REPLY_CANDIDATE", confidence: 0.95, facts_extracted: [], next_objective: "none" };

test("S2: the understanding reads opt_out and the grammar did not confirm it ⇒ SUPPRESS precautionary (contact-wide hold), never a review hold or a composed close", () => {
  for (const body of ["Please arrange for this to be my last message from you all", "Kindly refrain from further correspondence", "Gracias por todo, que sea el último"]) {
    const p = decide(body, { judgment: judgmentOptOut });
    const t = terminal(p);
    assert.equal(t.type, ACTIONS.SUPPRESS, `${body}: ${JSON.stringify(t)}`);
    assert.ok(["precautionary", "opt_out"].includes(t.mode), body);
    assert.ok(!p.actions.some((a) => a.type === ACTIONS.AI_GENERATED_REPLY), body);
    const eff = decisionEffectsOf({ terminal: t, plan: p });
    assert.ok(eff.some((e) => e.kind === "precautionary_no_contact" || e.kind === "opt_out"), body);
  }
});

test("S2 / S3: a possible / uncertain stop in a NON-enabled language ⇒ the contact-wide precautionary hold, never language_not_enabled alone", () => {
  for (const body of ["thôi", "됐어요", "خلاص", "Ase atò!!", "ayoko na"]) {
    const p = decide(body);
    const t = terminal(p);
    assert.equal(t.type, ACTIONS.SUPPRESS, `${body}: ${JSON.stringify(t)}`);
    assert.equal(t.mode, "precautionary", body);
    assert.equal(t.suppression_type, "precautionary_no_contact", body);
    assert.deepEqual(decisionEffectsOf({ terminal: t, plan: p }).map((e) => e.kind), ["precautionary_no_contact"], body);
  }
  // a confirmed revocation in a non-enabled language is the opt-out itself
  const p = decide("唔該唔好再send message俾我");
  assert.equal(terminal(p).mode, "opt_out");
  assert.deepEqual(decisionEffectsOf({ terminal: terminal(p), plan: p }).map((e) => e.kind), ["opt_out"]);
});

test("S2: the event router sends an unconfirmed stop-like inbound to the immediate path (decided + recorded), never 'nothing to answer'", () => {
  for (const text of ["thôi", "Bájenme", "됐어요"]) {
    const r = routeConversationEvent({ kind: "inbound", text, openTurn: false });
    assert.equal(r.route, ROUTES.SUPPRESS_NOW, text);
    assert.equal(r.type, "possible_opt_out", text);
  }
  assert.equal(routeConversationEvent({ kind: "inbound", text: "Dejá de mandarme mensajes", openTurn: false }).type, "opt_out");
  assert.equal(routeConversationEvent({ kind: "inbound", text: "Basta ya con ese inquilino, sí la quiero vender", openTurn: false }).route, ROUTES.SCHEDULE_TURN);
});

test("S2: every layer's stop reading is combined — model, classifier possible opt-out, stop word, grammar", () => {
  assert.equal(readStop({ text: "Absténgase de contactarme" }).confirmed, true);
  assert.equal(readStop({ text: "Please arrange this", judgment: judgmentOptOut }).uncertain, true);
  assert.equal(readStop({ text: "hmm", deterministic: { intent: "unclear", possible_opt_out: { rule_id: "x" } } }).uncertain, true);
  assert.equal(readStop({ text: "Yes I still own it" }).uncertain, false);
  assert.equal(readStop({ text: "Don't call, text is fine" }).uncertain, false, "a channel preference is not a stop");
});

test("S5: a composed promise to stop contacting is never sent (the writer read a stop the decide step did not)", () => {
  for (const t of ["Entendido, no le vuelvo a escribir sobre el tema. Que tenga buen día.", "Got it, I won't text you again.", "Understood, we will not contact you anymore.", "Listo, ya no le escribo más.", "Perfecto, lo quitamos de la lista."]) assert.ok(NO_CONTACT_PROMISE_RE.test(t), t);
  for (const t of ["Thanks for letting me know. What price did you have in mind?", "Gracias. ¿Tiene un precio en mente?", "No worries, I'll check back next month."]) assert.ok(!NO_CONTACT_PROMISE_RE.test(t), t);
});

// ── the writes and the independent final-dispatch enforcement ─────────────
function recordingWriters({ fail = null } = {}) {
  const calls = [];
  return { calls, writers: {
    suppress: async (a) => { calls.push(["opt_out", a.phone]); return fail === "opt_out" ? { ok: false, reason: "x" } : { ok: true } },
    precautionary: async (a) => { calls.push(["precautionary_no_contact", a.phone, a.inboundEventId]); return fail === "precautionary" ? { ok: false, reason: "x" } : { ok: true, held: true } },
    ownership: async (_sb, a) => { calls.push(["property_denial", a.property_id, a.outcome]); return { ok: true } },
  } };
}

test("S2 / S3: the canonical path WRITES the hold (handler) and raises ONE critical operator item; a failed write throws (retry, nothing dispatched)", async () => {
  const p = decide("thôi");
  const record = { terminal: terminal(p), plan: p };
  const w = recordingWriters();
  const items = [];
  const decideTurn = withDecisionEffects(async () => ({ code: "SUPPRESS", precautionary: true, canonical: record, reply: null, effects_input: { record, sellerPhone: TK, threadKey: TK, inboundEventId: "i1" } }), { supabase: {}, effectsDeps: { writers: w.writers }, raiseOperatorItem: async (it) => { items.push(it); return { ok: true } } });
  const d = await decideTurn({ turn_id: "t-1" });
  assert.deepEqual(w.calls, [["precautionary_no_contact", TK, "i1"]]);
  assert.equal(items.length, 1);
  assert.equal(items[0].severity, "critical");
  assert.equal(d.reply, null);
  const bad = recordingWriters({ fail: "precautionary" });
  await assert.rejects(() => applyCanonicalDecisionEffects({ supabase: {}, record, sellerPhone: TK, threadKey: TK, inboundEventId: "i1" }, { writers: bad.writers }), (e) => e.code === "DECISION_EFFECT_WRITE_FAILED");
});

test("independent final dispatch: the latest inbound reads as a stop / possible stop ⇒ every automated row is refused, until an operator releases THAT reading", () => {
  const row = { id: "q1", to_phone_number: TK, thread_key: TK, from_phone_number: "+15555550100", use_case_template: "s2_no_response_fu1", message_body: "Just checking in", metadata: {} };
  const thread = (body) => [{ id: "o1", direction: "outbound", message_body: "Hi", created_at: at(60) }, { id: "i9", direction: "inbound", message_body: body, created_at: at(5) }];
  for (const body of ["thôi", "Bájenme de su lista", "唔好再text我", "Stop texting me"]) {
    const g = evaluateSendTimeContactGuard(row, { thread_messages: thread(body) });
    assert.equal(g.blocked, true, body);
    assert.equal(g.reason, "latest_inbound_stop_like", body);
  }
  assert.equal(evaluateSendTimeContactGuard(row, { thread_messages: thread("Yes I still own it") }).reason === "latest_inbound_stop_like", false);
  const released = [{ phone_e164: TK, suppression_type: "precautionary_no_contact", status: "released", payload: { inbound_event_id: "i9" } }];
  assert.equal(latestInboundStopLike(thread("thôi"), released), null, "an operator released the uncertain reading");
  assert.ok(latestInboundStopLike(thread("Stop texting me"), [{ ...released[0] }]), "a confirmed stop is never released this way");
});

test("ownership: a decided property denial is PERSISTED for that property only (never the phone)", () => {
  const p = decide("No, I sold that one years ago");
  const effects = decisionEffectsOf({ terminal: terminal(p), plan: p });
  const denial = effects.find((e) => e.kind === "property_denial");
  if (denial) {
    assert.equal(denial.property_id, "p1");
    assert.ok(["not_owner", "former_owner"].includes(denial.outcome));
  }
  assert.ok(!effects.some((e) => e.kind === "opt_out"), "a denial is never a suppression");
});
