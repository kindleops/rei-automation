// P1 · ACTIVE CAMPAIGN RECONCILIATION + OVERDUE BACKLOG (read-only) — 2026-10-08.
//
// 1. Every target of every ACTIVE campaign (status ready / planned) is judged
//    by the send-time contact guard (send-time-contact-guard.js, pure) against
//    ACTUAL outreach history, using set-based reads (one query per source, all
//    phone shapes). Cause buckets: opt_out, precautionary_hold (and any other
//    automation_suppressions type), wrong_number, former_or_not_owner, past
//    outreach (exact person-phone / phone / person / property), current queue
//    reservation (an unsent row for the phone outside this target), plus
//    legacy_phone_only (the phone exists only in public.phones, no graph row).
//    The target's own send_queue rows are not "history".
// 2. Overdue backlog: every unsent pending / scheduled / queued / approval /
//    ready row whose scheduled_for_utc (else scheduled_for) is in the past, by
//    origin and age.
//
//   DATABASE_URL=... node --import ./tests/register-aliases.mjs \
//     scripts/ops/r10-safety/active-campaign-reconcile.mjs --out=<dir>
import { connectReadOnly, arg, writeOut } from "./_ro-db.mjs";
import { evaluateSendTimeContactGuard, phoneKey, phoneVariants, SEND_TIME_REPLY_INTENTS } from "@/lib/domain/queue/send-time-contact-guard.js";

const OUT = arg("out");
if (!OUT) { console.error("usage: --out=<dir>"); process.exit(2); }
const db = await connectReadOnly();
const q = async (sql, params) => (await db.query(sql, params)).rows;

const camps = await q(`select id::text, name from campaigns where status = 'active' order by name`);
const targets = await q(
  `select id::text, campaign_id::text, to_phone_number, property_id, prospect_id, master_owner_id, phone_id, coalesce(target_status,'') target_status, touch_number
     from campaign_targets where campaign_id::text = any($1) and coalesce(target_status,'') in ('ready','planned')`,
  [camps.map((c) => c.id)]);
const keys = [...new Set(targets.map((t) => phoneKey(t.to_phone_number)).filter(Boolean))];
const V = phoneVariants(keys.map((k) => `+1${k}`));
const props = [...new Set(targets.map((t) => String(t.property_id || "")).filter(Boolean))];
const persons = [...new Set(targets.map((t) => String(t.prospect_id || "")).filter(Boolean))];

const [supp, auto, threads, phones, replies, sends_phone, sends_prop, ev_phone, ev_prop, graph] = [
  await q(`select phone_e164, phone_number, sender_phone_e164, is_active, suppression_type from sms_suppression_list where is_active and (phone_e164 = any($1) or phone_number = any($1))`, [V]),
  await q(`select phone_e164, status, suppression_type, expires_at from automation_suppressions where phone_e164 = any($1)`, [V]),
  await q(`select thread_key, canonical_e164, property_id, is_suppressed, disposition, last_intent, stage, lifecycle_stage, contactability_status from inbox_thread_state where thread_key = any($1) or canonical_e164 = any($1)`, [V]),
  await q(`select phone_id::text, canonical_e164, phone, phone_raw, phone_contact_status, wrong_number_at, primary_prospect_id, canonical_prospect_id from phones where canonical_e164 = any($1) or primary_prospect_id = any($2) or canonical_prospect_id = any($2)`, [V, persons]),
  await q(`select from_phone_number, property_id, detected_intent, is_opt_out from message_events where direction = 'inbound' and from_phone_number = any($1) and (detected_intent = any($2) or is_opt_out is true)`, [V, SEND_TIME_REPLY_INTENTS]),
  await q(`select id::text, to_phone_number, property_id, prospect_id, queue_status, sent_at, created_at, campaign_target_id::text, campaign_id::text, touch_number from send_queue where to_phone_number = any($1)`, [V]),
  await q(`select id::text, to_phone_number, property_id, prospect_id, queue_status, sent_at, created_at, campaign_target_id::text, campaign_id::text, touch_number from send_queue where property_id = any($1)`, [props]),
  await q(`select id::text, direction, to_phone_number, property_id, prospect_id, event_type, delivery_status, is_final_failure, queue_id, created_at from message_events where direction = 'outbound' and to_phone_number = any($1)`, [V]),
  await q(`select id::text, direction, to_phone_number, property_id, prospect_id, event_type, delivery_status, is_final_failure, queue_id, created_at from message_events where direction = 'outbound' and property_id = any($1)`, [props]),
  await q(`select canonical_e164 from campaign_target_graph where canonical_e164 = any($1)`, [V]),
];
const graphKeys = new Set(graph.map((g) => phoneKey(g.canonical_e164)));
const phoneKeys = new Set(phones.map((p) => phoneKey(p.canonical_e164)));
const byKey = (rows, col) => { const m = new Map(); for (const r of rows) { const k = phoneKey(r[col]); if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
const byCol = (rows, col) => { const m = new Map(); for (const r of rows) { const k = String(r[col] ?? ""); if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
const M = {
  supp: new Map([...byKey(supp, "phone_e164")].map(([k, v]) => [k, v])),
  supp2: byKey(supp, "phone_number"), auto: byKey(auto, "phone_e164"),
  thr: byKey(threads, "thread_key"), thr2: byKey(threads, "canonical_e164"),
  ph: byKey(phones, "canonical_e164"), phP: byCol(phones, "primary_prospect_id"), phC: byCol(phones, "canonical_prospect_id"),
  rep: byKey(replies, "from_phone_number"), sp: byKey(sends_phone, "to_phone_number"), sP: byCol(sends_prop, "property_id"),
  ep: byKey(ev_phone, "to_phone_number"), eP: byCol(ev_prop, "property_id"),
};
const UNSENT = new Set(["pending", "scheduled", "queued", "ready", "approved", "approval", "held", "processing", "sending"]);
const CAUSE = {
  sms_suppression_list_active: "opt_out", thread_suppressed: "opt_out", thread_opted_out: "opt_out", opt_out_reply: "opt_out",
  wrong_number: "wrong_number", prior_reply_not_owner: "former_or_not_owner",
  already_contacted_person_phone: "past_outreach_person_phone", already_contacted_phone: "past_outreach_phone",
  already_contacted_person: "past_outreach_person", already_contacted_property: "past_outreach_property",
  send_time_guard_read_failed: "read_failed",
};
const report = Object.fromEntries(camps.map((c) => [c.name, { targets: 0, by_status: {}, blocked: 0, by_cause: {}, queue_reservation_elsewhere: 0, legacy_phone_only: 0, sendable_remaining: 0, past_outreach_source: {} }]));
const name = new Map(camps.map((c) => [c.id, c.name]));
const uniq = (a) => [...new Map(a.map((r) => [r.id || JSON.stringify(r), r])).values()];
for (const t of targets) {
  const r = report[name.get(t.campaign_id)];
  r.targets += 1;
  r.by_status[t.target_status] = (r.by_status[t.target_status] || 0) + 1;
  const k = phoneKey(t.to_phone_number);
  const own = (row) => row.campaign_target_id && row.campaign_target_id === t.id;
  const ownIds = new Set((M.sp.get(k) || []).filter(own).map((x) => x.id));
  const person_phones = [...(M.phP.get(String(t.prospect_id)) || []), ...(M.phC.get(String(t.prospect_id)) || [])].map((p) => p.canonical_e164);
  const personKeys = person_phones.map(phoneKey);
  const facts = {
    suppressions: uniq([...(M.supp.get(k) || []), ...(M.supp2.get(k) || [])]),
    automation_suppressions: M.auto.get(k) || [],
    threads: uniq([...(M.thr.get(k) || []), ...(M.thr2.get(k) || [])]),
    phones: M.ph.get(k) || [],
    inbound_replies: M.rep.get(k) || [],
    person_phones,
    prior_sends: uniq([...(M.sp.get(k) || []), ...personKeys.flatMap((pk) => M.sp.get(pk) || []), ...(M.sP.get(String(t.property_id)) || [])]).filter((x) => !own(x)),
    prior_outbound_events: uniq([...(M.ep.get(k) || []), ...personKeys.flatMap((pk) => M.ep.get(pk) || []), ...(M.eP.get(String(t.property_id)) || [])]).filter((e) => !ownIds.has(String(e.queue_id || ""))),
  };
  const row = { id: `target:${t.id}`, to_phone_number: t.to_phone_number, thread_key: k ? `+1${k}` : null, property_id: t.property_id, prospect_id: t.prospect_id, phone_id: t.phone_id, type: "campaign_launch", touch_number: t.touch_number ?? 1, created_at: new Date().toISOString() };
  const g = evaluateSendTimeContactGuard(row, facts, { now: Date.now() });
  const reservation = (M.sp.get(k) || []).some((x) => !own(x) && !x.sent_at && UNSENT.has(String(x.queue_status).toLowerCase()));
  if (k && phoneKeys.has(k) && !graphKeys.has(k)) r.legacy_phone_only += 1;
  if (g.blocked) {
    let cause = CAUSE[g.reason] || g.reason;
    if (g.reason === "automation_suppression_active") cause = /precaution/i.test(g.detail?.suppression_type || "") ? "precautionary_hold" : `automation_suppression:${g.detail?.suppression_type || "unknown"}`;
    r.blocked += 1;
    r.by_cause[cause] = (r.by_cause[cause] || 0) + 1;
    if (cause.startsWith("past_outreach")) {
      // Where the prior touch came from: this campaign (an earlier touch / a
      // duplicate target), another campaign, or a non-campaign send.
      const sentRows = facts.prior_sends.filter((x) => x.sent_at || ["sent", "delivered"].includes(String(x.queue_status).toLowerCase()));
      const src = sentRows.some((x) => x.campaign_id === t.campaign_id) ? "this_campaign" : sentRows.some((x) => x.campaign_id) ? "other_campaign" : sentRows.length ? "non_campaign_send" : (facts.prior_outbound_events.some((e) => String(e.created_at?.toISOString?.() || e.created_at) < "2026-09-01") ? "message_events_only_pre_0901" : "message_events_only_since_0901");
      const key = `${cause}:${src}:touch${t.touch_number ?? "?"}`;
      r.past_outreach_source[key] = (r.past_outreach_source[key] || 0) + 1;
    }
  } else if (reservation) {
    r.queue_reservation_elsewhere += 1;
  } else {
    r.sendable_remaining += 1;
  }
}

// Overdue backlog.
const overdue = await q(
  `select coalesce(type, message_type, '(none)') origin, coalesce(metadata->>'source', '') source, queue_status,
          case when campaign_id is not null then 'campaign' else 'non_campaign' end scope,
          case when coalesce(scheduled_for_utc, scheduled_for) > now() - interval '1 hour' then '<1h'
               when coalesce(scheduled_for_utc, scheduled_for) > now() - interval '6 hours' then '1-6h'
               when coalesce(scheduled_for_utc, scheduled_for) > now() - interval '24 hours' then '6-24h'
               else '>24h' end age, count(*)::int n
     from send_queue
    where sent_at is null and queue_status = any($1) and coalesce(scheduled_for_utc, scheduled_for) < now()
    group by 1,2,3,4,5 order by n desc`,
  [["pending", "scheduled", "queued", "approval", "approved", "ready"]]);
await db.end();
const summary = { generated_at: new Date().toISOString(), active_campaigns: camps.map((c) => c.name), targets_evaluated: targets.length, campaigns: report, overdue_total: overdue.reduce((a, r) => a + r.n, 0), overdue };
writeOut(OUT, "p1-active-campaign-reconcile.json", JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
