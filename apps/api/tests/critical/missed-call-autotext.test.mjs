// Missed-call auto-text: voice webhook auth, CallSid idempotency, forward /
// no-answer / answered, cadence gates, compliance gates, contact window,
// language, template-missing alert, dispatch name-guard predicate, and the
// proposed template copy. No network, no provider: every dependency injected.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handleVoiceWebhook, outcomeFromDialStatus } from "@/lib/domain/calls/handle-voice-webhook.js";
import {
  processCallOutcome,
  CALL_OUTCOMES,
  resolveCallerLanguage,
  evaluateCadenceGates,
  buildCallLogBody,
} from "@/lib/domain/calls/process-missed-call.js";
import { readMissedCallEnv } from "@/lib/domain/calls/missed-call-config.js";
import { planMissedCallSendTime } from "@/lib/domain/calls/missed-call-window.js";
import { isMissedCallAutotextSend } from "@/lib/domain/calls/missed-call-send-kind.js";
import {
  verifyTextgridWebhookRequest,
  buildCanonicalWebhookUrl,
} from "@/lib/webhooks/textgrid-verify-webhook.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SECRET = "test-webhook-secret-123";
const OUR = "+12145550100";
const CALLER = "+14695550111";
const OWNER = "+19725550199";
const BASE_URL = "https://ops.example.test/api/webhooks/textgrid/voice";
// 2026-10-06 18:00Z = 13:00 CDT / 14:00 EDT / 11:00 PDT — inside every window.
const MIDDAY = "2026-10-06T18:00:00.000Z";

// ── fakes ───────────────────────────────────────────────────────────────────

function makeDb(seed = {}) {
  const tables = {
    message_events: [],
    inbox_thread_state: [],
    send_queue: [],
    sms_templates: [],
    ...structuredClone(seed),
  };
  const calls = { inserts: [], updates: [] };

  function builder(table) {
    const filters = [];
    let op = "select";
    let payload = null;
    let limit = null;
    let single = false;
    const rows = () => tables[table] || [];
    const match = (r) =>
      filters.every(([k, kind, v]) => {
        if (kind === "eq") return r[k] === v;
        if (kind === "gte") return String(r[k] ?? "") >= String(v);
        return true;
      });
    const run = () => {
      if (op === "insert") {
        if (table === "message_events" && rows().some((r) => r.message_event_key === payload.message_event_key)) {
          return { data: null, error: { code: "23505", message: "duplicate key value" } };
        }
        tables[table].push({ ...payload });
        calls.inserts.push({ table, row: payload });
        return { data: payload, error: null };
      }
      if (op === "update") {
        let n = 0;
        for (const r of rows()) if (match(r)) { Object.assign(r, payload); n += 1; }
        calls.updates.push({ table, patch: payload, n });
        return { data: null, error: null };
      }
      let out = rows().filter(match);
      if (limit != null) out = out.slice(0, limit);
      if (single) return { data: out[0] ?? null, error: null };
      return { data: out, error: null };
    };
    const b = {
      select() { return b; },
      insert(row) { op = "insert"; payload = row; return b; },
      update(patch) { op = "update"; payload = patch; return b; },
      eq(k, v) { filters.push([k, "eq", v]); return b; },
      gte(k, v) { filters.push([k, "gte", v]); return b; },
      order() { return b; },
      limit(n) { limit = n; return b; },
      maybeSingle() { single = true; return Promise.resolve(run()); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  }
  return { from: (t) => builder(t), tables, calls };
}

const ACTIVE_TEMPLATES = [
  { template_id: "lc-missed-call-en-1", use_case: "missed_call", language: "English", agent_persona: "Alex", is_active: true, quarantine_state: "active", fallback_rank: 1,
    template_body: "Hey it's {{agent_name}}. Sorry I missed your call, I'm tied up in a meeting. Can you text me what's on your mind? I'll call you back as soon as I'm out." },
  { template_id: "lc-missed-call-es-1", use_case: "missed_call", language: "Spanish", agent_persona: "Alex", is_active: true, quarantine_state: "active", fallback_rank: 1,
    template_body: "Hola soy {{agent_name}}, perdón que no contesté su llamada. Estoy en una reunión. ¿Me escribe aquí qué necesita? Le llamo al salir." },
];

function sysValues(overrides = {}) {
  const v = {
    missed_call_autotext_enabled: "true",
    queue_processor_mode: "live",
    queue_emergency_stop_at: "",
    campaign_mode: "live_limited",
    ...overrides,
  };
  return async (key) => v[key] ?? null;
}

function harness({ seed = {}, sys = {}, now = MIDDAY, contact = { blocked: false }, geo = null, env = {} } = {}) {
  const db = makeDb({ sms_templates: ACTIVE_TEMPLATES, ...seed });
  const enqueued = [];
  const alerts = [];
  const lastInsert = { payload: null };
  const processDeps = {
    contactabilityImpl: async () => contact,
    loadPropertyGeographyImpl: async (_s, ids) => new Map(geo ? ids.map((id) => [id, geo]) : []),
    recordAlertImpl: async (a) => { alerts.push(a); return { ok: true }; },
    enqueueImpl: async (input, deps) => {
      // Exercise the KPI wrapper exactly as the canonical writer would.
      await deps.insertQueueImpl({ metadata: input.metadata }, {});
      enqueued.push({ input });
      return { ok: true, queue_row_id: `q-${enqueued.length}`, scheduled_for: input.scheduled_for };
    },
    insertQueueImpl: async (payload) => { lastInsert.payload = payload; return { queue_row_id: "x" }; },
  };
  const cfg = readMissedCallEnv({ MISSED_CALL_AUTOTEXT_ENABLED: "true", ...env });
  const deps = { supabase: db, getSystemValue: sysValues(sys), cfg, now, ...processDeps };
  return { db, enqueued, alerts, deps, lastInsert, processDeps, cfg };
}

function sign(url, body) {
  const canonical = buildCanonicalWebhookUrl(url);
  return crypto.createHmac("sha1", SECRET).update(canonical + body, "utf8").digest("base64");
}

function voiceReq({ phase = null, form = {}, signed = true, badSig = false } = {}) {
  const url = phase ? `${BASE_URL}?phase=${phase}` : BASE_URL;
  const raw_body = new URLSearchParams({ CallSid: "CA1", From: CALLER, To: OUR, ...form }).toString();
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  if (signed) headers.set("x-textgrid-signature", badSig ? "nope" : sign(url, raw_body));
  return { url, raw_body, content_type: "application/x-www-form-urlencoded", headers };
}

const verifyWithSecret = (args) => verifyTextgridWebhookRequest({ ...args, webhook_secret: SECRET, auth_token: "" });

// ── webhook auth ───────────────────────────────────────────────────────────

test("auth fails closed: missing / bad signature → 401, nothing processed", async () => {
  let processed = 0;
  const deps = { env: { MISSED_CALL_AUTOTEXT_ENABLED: "true" }, verifyImpl: verifyWithSecret, processImpl: async () => { processed += 1; return {}; } };
  const unsigned = await handleVoiceWebhook(voiceReq({ signed: false }), deps);
  const bad = await handleVoiceWebhook(voiceReq({ badSig: true }), deps);
  assert.equal(unsigned.status, 401);
  assert.equal(bad.status, 401);
  assert.equal(processed, 0);
});

test("auth fails closed even when the shared verifier fails OPEN (no secrets configured)", async () => {
  let processed = 0;
  const out = await handleVoiceWebhook(voiceReq({ signed: false }), {
    env: { MISSED_CALL_AUTOTEXT_ENABLED: "true" },
    verifyImpl: (args) => verifyTextgridWebhookRequest({ ...args, webhook_secret: "", auth_token: "" }),
    processImpl: async () => { processed += 1; return {}; },
  });
  assert.equal(out.status, 401);
  assert.equal(processed, 0);
});

test("env ceiling off (default) → busy Reject, zero side effects", async () => {
  let processed = 0;
  const out = await handleVoiceWebhook(voiceReq(), { env: {}, verifyImpl: verifyWithSecret, processImpl: async () => { processed += 1; } });
  assert.equal(out.status, 200);
  assert.match(out.body, /<Response><Reject reason="busy"\/><\/Response>/);
  assert.equal(processed, 0);
});

// ── forward flow ───────────────────────────────────────────────────────────

test("incoming with OWNER_FORWARD_NUMBER → <Dial> 20s to owner, action=dial_complete, no text yet", async () => {
  let processed = 0;
  const out = await handleVoiceWebhook(voiceReq(), {
    env: { MISSED_CALL_AUTOTEXT_ENABLED: "true", OWNER_FORWARD_NUMBER: "(972) 555-0199" },
    verifyImpl: verifyWithSecret,
    processImpl: async () => { processed += 1; },
  });
  assert.equal(out.status, 200);
  assert.match(out.body, /<Dial timeout="20" action="[^"]*phase=dial_complete" method="POST" callerId="\+12145550100"><Number>\+19725550199<\/Number><\/Dial>/);
  assert.equal(processed, 0);
});

test("forward → no-answer → missed-call text queued from the SAME number, call logged", async () => {
  const h = harness();
  const out = await handleVoiceWebhook(voiceReq({ phase: "dial_complete", form: { DialCallStatus: "no-answer" } }), {
    env: { MISSED_CALL_AUTOTEXT_ENABLED: "true", OWNER_FORWARD_NUMBER: OWNER },
    verifyImpl: verifyWithSecret,
    supabase: h.db,
    getSystemValue: h.deps.getSystemValue,
    now: MIDDAY,
    processDeps: h.processDeps,
  });
  assert.equal(out.status, 200);
  assert.match(out.body, /<Say>.*<\/Say><Hangup\/>/);
  assert.equal(h.enqueued.length, 1);
  const q = h.enqueued[0].input;
  assert.equal(q.to_phone_number, CALLER);
  assert.equal(q.from_phone_number, OUR);
  assert.equal(q.use_case, "missed_call");
  assert.equal(q.template_id, "lc-missed-call-en-1");
  assert.equal(q.idempotency_key, "missed_call:CA1");
  assert.equal(q.scheduled_for, MIDDAY);
  assert.ok(!q.message_body.includes("{{"));
  assert.match(q.message_body, /it's Alex\./);
  // KPI join: the template_id COLUMN is stamped on the row.
  assert.equal(h.lastInsert.payload.template_id, "lc-missed-call-en-1");
  const log = h.db.tables.message_events.find((r) => r.message_event_key === "call_CA1");
  assert.equal(log.direction, "system");
  assert.equal(log.event_type, "missed_call");
  assert.equal(log.thread_key, CALLER);
  assert.equal(log.message_body, "Missed call · 0:00 · auto-text queued");
  assert.equal(log.metadata.missed_call_autotext.status, "queued");
});

test("forward answered → logged as answered, NO text", async () => {
  const h = harness();
  const out = await handleVoiceWebhook(voiceReq({ phase: "dial_complete", form: { DialCallStatus: "completed", DialCallDuration: "133" } }), {
    env: { MISSED_CALL_AUTOTEXT_ENABLED: "true", OWNER_FORWARD_NUMBER: OWNER },
    verifyImpl: verifyWithSecret,
    supabase: h.db,
    getSystemValue: h.deps.getSystemValue,
    now: MIDDAY,
    processDeps: h.processDeps,
  });
  assert.match(out.body, /<Hangup\/>/);
  assert.equal(h.enqueued.length, 0);
  const log = h.db.tables.message_events[0];
  assert.equal(log.event_type, "answered_call");
  assert.equal(log.message_body, "Call answered · 2:13 · forwarded to owner");
});

test("no forward number → polite prompt + hangup, call treated as missed", async () => {
  const h = harness();
  const out = await handleVoiceWebhook(voiceReq(), {
    env: { MISSED_CALL_AUTOTEXT_ENABLED: "true" },
    verifyImpl: verifyWithSecret,
    supabase: h.db,
    getSystemValue: h.deps.getSystemValue,
    now: MIDDAY,
    processDeps: h.processDeps,
  });
  assert.match(out.body, /<Say>Sorry, we can&apos;t take your call right now\./);
  assert.equal(h.enqueued.length, 1);
});

test("outcomeFromDialStatus maps provider vocabulary", () => {
  assert.equal(outcomeFromDialStatus("no-answer"), CALL_OUTCOMES.NO_ANSWER);
  assert.equal(outcomeFromDialStatus("busy"), CALL_OUTCOMES.BUSY);
  assert.equal(outcomeFromDialStatus("canceled"), CALL_OUTCOMES.CANCELED);
  assert.equal(outcomeFromDialStatus("completed", 12), CALL_OUTCOMES.ANSWERED);
  assert.equal(outcomeFromDialStatus("completed", 0), CALL_OUTCOMES.NO_ANSWER);
});

// ── idempotency ────────────────────────────────────────────────────────────

test("CallSid idempotency: redelivered dial_complete + status callback → one log, one text", async () => {
  const h = harness();
  const input = { call_sid: "CA9", caller: CALLER, called: OUR, outcome: CALL_OUTCOMES.NO_ANSWER };
  const a = await processCallOutcome(input, h.deps);
  const b = await processCallOutcome(input, h.deps);
  const c = await processCallOutcome({ ...input, outcome: CALL_OUTCOMES.CANCELED }, h.deps);
  assert.equal(a.text.status, "queued");
  assert.equal(b.duplicate, true);
  assert.equal(c.duplicate, true);
  assert.equal(h.enqueued.length, 1);
  assert.equal(h.db.tables.message_events.filter((r) => r.message_event_key === "call_CA9").length, 1);
});

// ── gates ──────────────────────────────────────────────────────────────────

const run = (h, sid = "CA2") => processCallOutcome({ call_sid: sid, caller: CALLER, called: OUR, outcome: CALL_OUTCOMES.NO_ANSWER }, h.deps);
const iso = (minsAgo) => new Date(Date.parse(MIDDAY) - minsAgo * 60000).toISOString();

test("rate limit: one missed-call text per caller per 24h", async () => {
  const h = harness({ seed: { send_queue: [{ id: "old", to_phone_number: CALLER, queue_status: "delivered", use_case_template: "missed_call", created_at: iso(600), sent_at: iso(600), metadata: { missed_call: { call_sid: "CA0" } } }] } });
  const r = await run(h);
  assert.equal(r.text.status, "skipped");
  assert.equal(r.text.reason, "missed_call_text_within_window");
  assert.equal(h.enqueued.length, 0);
  assert.match(h.db.tables.message_events[0].message_body, /auto-text skipped \(already texted for a missed call in the last 24h\)/);
});

test("rate limit: texted in the last 30 min → skipped recent_outbound", async () => {
  const h = harness({ seed: { send_queue: [{ id: "o", to_phone_number: CALLER, queue_status: "sent", use_case_template: "ownership_check", created_at: iso(12), sent_at: iso(10), metadata: {} }] } });
  const r = await run(h);
  assert.equal(r.text.reason, "recent_outbound");
});

test("rate limit: live conversation in the last 30 min → skipped active_conversation", async () => {
  const h = harness({ seed: { message_events: [{ id: "m", thread_key: CALLER, direction: "inbound", message_body: "ok call me", created_at: iso(5), event_timestamp: iso(5) }] } });
  const r = await run(h);
  assert.equal(r.text.reason, "active_conversation");
});

test("pending auto-reply/operator send already queued → skipped pending_outbound", async () => {
  const h = harness({ seed: { send_queue: [{ id: "p", to_phone_number: CALLER, queue_status: "queued", use_case_template: "auto_reply", created_at: iso(90), metadata: {} }] } });
  const r = await run(h);
  assert.equal(r.text.reason, "pending_outbound");
});

test("cadence gates are pure and ignore this call's own row", () => {
  const cfg = readMissedCallEnv({});
  const own = [{ queue_status: "queued", use_case_template: "missed_call", created_at: iso(1), metadata: { missed_call: { call_sid: "CAx" } } }];
  assert.deepEqual(evaluateCadenceGates({ thread_state: null, events: [], queue_rows: own, now: new Date(MIDDAY), cfg, call_sid: "CAx" }), { ok: true });
});

test("suppression / opt-out / wrong-number block (canonical contactability)", async () => {
  for (const [contact, expected] of [
    [{ blocked: true, reason: "phone_suppressed", detail_reason: "opt_out" }, "opted_out"],
    [{ blocked: true, reason: "phone_suppressed", detail_reason: "wrong_number" }, "wrong_number"],
    [{ blocked: true, reason: "phone_suppressed", detail_reason: "manual" }, "suppressed"],
    [{ blocked: true, reason: "suppression_check_unavailable" }, "lookup_failed"],
  ]) {
    const h = harness({ contact });
    const r = await run(h);
    assert.equal(r.text.status, "skipped");
    assert.equal(r.text.reason, expected);
    assert.equal(h.enqueued.length, 0);
  }
});

test("thread suppressed flag blocks before anything else", async () => {
  const h = harness({ seed: { inbox_thread_state: [{ thread_key: CALLER, is_suppressed: true }] } });
  assert.equal((await run(h)).text.reason, "suppressed");
});

test("emergency stop / queue_processor_mode off → skipped sending_paused", async () => {
  for (const sys of [{ queue_emergency_stop_at: "2026-10-06T00:00:00Z" }, { queue_processor_mode: "off" }, { queue_processor_mode: null }]) {
    const h = harness({ sys });
    const r = await run(h);
    assert.equal(r.text.reason, "sending_paused");
    assert.equal(h.enqueued.length, 0);
  }
});

test("operator switch off → call still logged, text skipped autotext_disabled", async () => {
  const h = harness({ sys: { missed_call_autotext_enabled: "false" } });
  const r = await run(h);
  assert.equal(r.logged, true);
  assert.equal(r.text.reason, "autotext_disabled");
  assert.equal(h.db.tables.message_events[0].message_body, "Missed call · 0:00 · auto-text skipped (auto-text is off)");
});

test("withheld caller ID → no thread, no text", async () => {
  const h = harness();
  const r = await processCallOutcome({ call_sid: "CA3", caller: "anonymous", called: OUR, outcome: CALL_OUTCOMES.NO_ANSWER }, h.deps);
  assert.equal(r.text.reason, "caller_id_unavailable");
  assert.equal(h.db.tables.message_events.length, 0);
});

// ── window ─────────────────────────────────────────────────────────────────

test("outside the window → queued for 8:00 AM in the caller's zone (property geography)", async () => {
  // 03:00Z = 22:00 CDT the night before.
  const h = harness({
    now: "2026-10-06T03:00:00.000Z",
    geo: { state: "TX", zip: "75201" },
    seed: { inbox_thread_state: [{ thread_key: CALLER, property_id: "prop-1" }] },
  });
  const r = await run(h);
  assert.equal(r.text.status, "queued");
  assert.equal(r.text.reason, "deferred_to_window_open");
  assert.equal(h.enqueued[0].input.scheduled_for, "2026-10-06T13:00:00.000Z"); // 08:00 CDT
  assert.equal(h.enqueued[0].input.timezone, "America/Chicago");
  assert.match(h.db.tables.message_events[0].message_body, /auto-text queued for 8:00 AM CDT/);
});

test("unknown zone → waits until the window is open in EVERY US zone (8 AM Pacific)", () => {
  const early = planMissedCallSendTime({ now: new Date("2026-10-06T12:30:00Z"), timezone: null }); // 8:30 ET / 5:30 PT
  assert.equal(early.send_now, false);
  assert.equal(early.scheduled_for, "2026-10-06T15:00:00.000Z"); // 08:00 PDT
  const late = planMissedCallSendTime({ now: new Date("2026-10-07T01:30:00Z"), timezone: null }); // 21:30 ET
  assert.equal(late.scheduled_for, "2026-10-07T15:00:00.000Z");
  const mid = planMissedCallSendTime({ now: new Date(MIDDAY), timezone: null });
  assert.equal(mid.send_now, true);
});

// ── language ───────────────────────────────────────────────────────────────

test("language: latest substantive reply wins; reactions are ignored; unknown caller → English", async () => {
  const events = [
    { direction: "inbound", message_body: 'Liked "hola"', language: "English" },
    { direction: "inbound", message_body: "Sí, todavía soy el dueño", language: "Spanish" },
  ];
  assert.equal(resolveCallerLanguage({ events }).language, "Spanish");
  assert.equal(resolveCallerLanguage({ events: [] }).language, "English");
  assert.equal(resolveCallerLanguage({ events: [{ direction: "outbound", language: "Spanish", message_body: "Hola" }] }).language, "Spanish");

  const h = harness({ seed: { message_events: [{ id: "e", thread_key: CALLER, direction: "inbound", message_body: "Sí, todavía soy el dueño", language: "Spanish", created_at: iso(300), event_timestamp: iso(300) }] } });
  const r = await run(h);
  assert.equal(r.text.language, "Spanish");
  assert.equal(h.enqueued[0].input.template_id, "lc-missed-call-es-1");
  assert.match(h.enqueued[0].input.message_body, /^Hola soy Alex,/);
});

test("template missing → no send + alert", async () => {
  const h = harness({ seed: { sms_templates: [{ ...ACTIVE_TEMPLATES[0], is_active: false }] } });
  const r = await run(h);
  assert.equal(r.text.reason, "template_missing");
  assert.equal(h.enqueued.length, 0);
  assert.equal(h.alerts.length, 1);
  assert.equal(h.alerts[0].code, "missed_call_template_missing");
});

test("template with an unfillable placeholder counts as missing", async () => {
  const h = harness({ seed: { sms_templates: [{ ...ACTIVE_TEMPLATES[0], template_body: "Hey {{seller_first_name}} sorry I missed you" }] } });
  assert.equal((await run(h)).text.reason, "template_missing");
});

// ── dispatch + copy ────────────────────────────────────────────────────────

test("dispatch name-guard exemption matches ONLY the missed-call shape", () => {
  const row = { use_case_template: "missed_call", message_body: "Sorry I missed your call", metadata: { action_type: "missed_call_autotext", missed_call: { call_sid: "CA1" } } };
  assert.equal(isMissedCallAutotextSend(row), true);
  assert.equal(isMissedCallAutotextSend({ ...row, use_case_template: "ownership_check" }), false);
  assert.equal(isMissedCallAutotextSend({ ...row, metadata: { action_type: "missed_call_autotext" } }), false);
  assert.equal(isMissedCallAutotextSend({ ...row, message_body: "Hi {{seller_first_name}}" }), false);
});

test("proposed copy: no blank-greeting trip, EN fits one segment, only {{agent_name}}", () => {
  const sql = fs.readFileSync(path.join(HERE, "../../../../supabase/migrations/PROPOSED_20261005200000_missed_call_templates.sql"), "utf8");
  const bodies = [...sql.matchAll(/\('missed_call', '(lc-missed-call-[a-z]{2}-\d)'[^\n]*\n\s*'((?:[^']|'')*)'/g)].map((m) => [m[1], m[2].replace(/''/g, "'")]);
  assert.equal(bodies.length, 4);
  for (const [id, body] of bodies) {
    const rendered = body.replace("{{agent_name}}", "Alex");
    assert.ok(!/\{\{/.test(rendered), id);
    assert.ok(!/^(hi|hey|hello|hola|ola|marhaba)\s*,/i.test(rendered), id);
    assert.ok(!/(Hello\s*,|Hey\s*,|Hi\s*,|Hola\s*,|Ola\s*,|Marhaba\s*,)/.test(rendered), id);
    if (id.includes("-en-")) assert.ok(rendered.length <= 160, `${id} is ${rendered.length} chars`);
  }
  assert.match(sql, /is_active[\s\S]*false, false, 'auto'/);
});

test("call log copy", () => {
  assert.equal(buildCallLogBody({ outcome: "no_answer", text: { status: "skipped", reason: "opted_out" } }), "Missed call · 0:00 · auto-text skipped (caller opted out)");
});

test("end-to-end through the REAL canonical queue writer: gates, row shape, KPI template_id", async () => {
  const h = harness();
  delete h.deps.enqueueImpl; // use enqueueCanonicalOutboundSms
  const r = await run(h, "CA77");
  assert.equal(r.text.status, "queued");
  const row = h.lastInsert.payload;
  assert.equal(row.template_id, "lc-missed-call-en-1");
  assert.equal(row.use_case_template, "missed_call");
  assert.equal(row.from_phone_number, OUR);
  assert.equal(row.to_phone_number, CALLER);
  assert.equal(row.thread_key, CALLER);
  assert.equal(row.queue_key, "missed_call:CA77");
  assert.equal(row.metadata.idempotency_key, "missed_call:CA77");
  assert.equal(row.metadata.no_direct_provider_send, true);
  assert.equal(row.metadata.language, "English");
  assert.equal(isMissedCallAutotextSend(row), true, "dispatch exemption recognises the real row");

  // campaign_mode paused → the canonical writer itself refuses; the skip is recorded.
  const paused = harness({ sys: { campaign_mode: "paused" } });
  delete paused.deps.enqueueImpl;
  const p = await run(paused, "CA78");
  assert.equal(p.text.status, "skipped");
  assert.equal(p.text.reason, "queue_rejected");
  assert.equal(paused.lastInsert.payload, null);
});
