#!/usr/bin/env node
// LIVE SMOKE TEST — no-response follow-ups (S2 / S3 / offer silence), rc-8.5.5.
//
// READ-ONLY: one READ ONLY transaction, statement_timeout 15s, serial queries.
// Prints counts only (never a phone, name or message body). Run it before the
// canary, after each canary day, and before switching canary → live.
//
//   DATABASE_URL=… node apps/api/scripts/ops/no-response-followup-smoke.mjs [--since=ISO]
//
// Checks (each must be 0 violations; exit 1 otherwise):
//   flags          mode / enable instant / canary cap / follow-up + queue modes
//   scheduling     rows by kind × step × status since the enable instant
//   prospective    rows whose anchor predates the enable instant
//   canary cap     rows per UTC day above followup_no_response_canary_daily_cap
//   idempotency    duplicate dedupe_key, duplicate (thread, kind, chain, step)
//   suppression    sent / live rows on a suppressed, opted-out, held or blocked phone
//   identity       sent / live rows on a wrong-number / not-owner / sold thread
//   stage          sent rows after the seller replied, or after the thread moved past the anchor stage
//   window         sent outside 8am–9pm recipient-local
//   templates      sent rows whose template_id is not an active, auto-safe sms_templates row

import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}
const sinceArg = (process.argv.find((a) => a.startsWith("--since=")) || "").slice(8) || null;

const NR = `q.type = 'followup' and q.metadata ? 'no_response_followup'`;
const LIVE = `('scheduled','queued','processing','sending','held')`;
const SENT = `('sent','delivered')`;
const BLOCKED = `('opted_out','dnc','do_not_text','invalid_number','provider_blacklisted','wrong_number','suppressed')`;
const NON_OWNER = `('wrong_number','wrong_person','not_owner','non_owner','former_owner','sold','suppressed','unqualified')`;
const STAGE_ORDER = `array['ownership_confirmation','offer_interest','asking_price','property_condition','offer','formal_contract','under_contract','disposition','prepared_to_close','closed']`;
const KIND_STAGE = `case q.metadata->'no_response_followup'->>'kind' when 's2_interest' then 'offer_interest' when 's3_asking_price' then 'asking_price' when 'offer' then 'offer' end`;

const client = new pg.Client({ connectionString: url, statement_timeout: 15_000, connectionTimeoutMillis: 15_000 });
const violations = [];

async function one(label, sql, params = []) {
  const { rows } = await client.query(sql, params);
  return rows;
}
function check(label, n) {
  const count = Number(n || 0);
  console.log(`${count === 0 ? "PASS" : "FAIL"}  ${label}: ${count}`);
  if (count !== 0) violations.push(label);
}

try {
  await client.connect();
  await client.query("begin read only");

  const flags = await one("flags", `select key, value from system_control where key in
    ('followup_no_response_mode','followup_no_response_enabled_at','followup_no_response_canary_daily_cap',
     'followup_no_response_config','followup_automation_mode','queue_processor_mode') order by key`);
  const flag = Object.fromEntries(flags.map((r) => [r.key, r.value]));
  console.log("flags:", JSON.stringify(flag));
  const enabledAt = sinceArg || flag.followup_no_response_enabled_at || null;
  const cap = Number.isFinite(Number(flag.followup_no_response_canary_daily_cap)) && String(flag.followup_no_response_canary_daily_cap ?? "") !== ""
    ? Number(flag.followup_no_response_canary_daily_cap) : 5;
  const mode = String(flag.followup_no_response_mode || "disabled");
  if ((mode === "canary" || mode === "live") && !Date.parse(flag.followup_no_response_enabled_at || "")) {
    check("sending mode without a valid followup_no_response_enabled_at", 1);
  }

  const sched = await one("scheduling", `select metadata->'no_response_followup'->>'kind' kind,
      metadata->'no_response_followup'->>'step' step, queue_status, count(*)::int n,
      count(*) filter (where (metadata->>'no_response_canary')::boolean)::int canary
    from send_queue q where ${NR} and ($1::timestamptz is null or created_at >= $1::timestamptz)
    group by 1,2,3 order by 1,2,3`, [enabledAt]);
  console.log("scheduling (kind/step/status):");
  for (const r of sched) console.log(`  ${r.kind} step=${r.step} ${r.queue_status}: ${r.n} (canary ${r.canary})`);
  if (!sched.length) console.log("  (no no-response follow-up rows yet)");

  if (enabledAt) {
    const [p] = await one("prospective", `select count(*)::int n from send_queue q
      where ${NR} and created_at >= $1::timestamptz and q.metadata->'rearm' is null
        and (q.metadata->'no_response_followup'->>'anchor_at')::timestamptz < $1::timestamptz`, [enabledAt]);
    check("prospective: scheduler rows anchored before the enable instant", p.n);
  }

  const [c] = await one("canary", `select count(*)::int n from (
      select date_trunc('day', created_at at time zone 'utc') d, count(*) k from send_queue q
       where ${NR} and (q.metadata->>'no_response_canary')::boolean group by 1 having count(*) > $1) z`, [cap]);
  check(`canary: UTC days above the cap (${cap})`, c.n);

  const [d1] = await one("dedupe", `select count(*)::int n from (select dedupe_key from send_queue q
      where ${NR} and dedupe_key is not null group by 1 having count(*) > 1) z`);
  check("idempotency: duplicate dedupe_key", d1.n);
  const [d2] = await one("chain", `select count(*)::int n from (select thread_key,
      metadata->'no_response_followup'->>'kind', metadata->'no_response_followup'->>'chain_root_id', metadata->'no_response_followup'->>'step'
      from send_queue q where ${NR} and queue_status not in ('cancelled') group by 1,2,3,4 having count(*) > 1) z`);
  check("idempotency: duplicate (thread, kind, chain, step)", d2.n);

  const [s] = await one("suppression", `select count(*)::int n from send_queue q
      left join inbox_thread_state t on t.thread_key = q.thread_key
     where ${NR} and q.queue_status in ${SENT} and (
       exists (select 1 from sms_suppression_list s where coalesce(s.is_active, true) and (s.phone_e164 = q.thread_key or s.phone_number = q.thread_key) and s.created_at < coalesce(q.sent_at, q.updated_at))
       or exists (select 1 from automation_suppressions a where a.phone_e164 = q.thread_key and a.status = 'active' and a.created_at < coalesce(q.sent_at, q.updated_at))
       or lower(coalesce(t.contactability_status,'')) in ${BLOCKED})`);
  check("suppression: sent to a suppressed / held / blocked phone", s.n);
  const [sl] = await one("suppression-live", `select count(*)::int n from send_queue q
      left join inbox_thread_state t on t.thread_key = q.thread_key
     where ${NR} and q.queue_status in ${LIVE} and (coalesce(t.is_suppressed,false) or lower(coalesce(t.contactability_status,'')) in ${BLOCKED}
       or exists (select 1 from sms_suppression_list s where coalesce(s.is_active, true) and (s.phone_e164 = q.thread_key or s.phone_number = q.thread_key)))`);
  check("suppression: live rows on a now-suppressed phone (dispatch must refuse; cancel them)", sl.n);

  const [i] = await one("identity", `select count(*)::int n from send_queue q join inbox_thread_state t on t.thread_key = q.thread_key
     where ${NR} and q.queue_status in ${SENT} and lower(coalesce(t.disposition,'')) in ${NON_OWNER}
       and t.updated_at < coalesce(q.sent_at, q.updated_at)`);
  check("identity: sent to a wrong-number / not-owner / sold thread", i.n);

  const [r] = await one("stage-reply", `select count(*)::int n from send_queue q
     where ${NR} and q.queue_status in ${SENT} and exists (
       select 1 from message_events m where m.thread_key = q.thread_key and m.direction = 'inbound'
          and m.event_timestamp >= (q.metadata->'no_response_followup'->>'anchor_at')::timestamptz
          and m.event_timestamp < coalesce(q.sent_at, q.updated_at))`);
  check("stage: sent after the seller had replied", r.n);
  const [g] = await one("stage-order", `select count(*)::int n from send_queue q join inbox_thread_state t on t.thread_key = q.thread_key
     where ${NR} and q.queue_status in ${LIVE}
       and array_position(${STAGE_ORDER}, lower(t.lifecycle_stage)) > array_position(${STAGE_ORDER}, ${KIND_STAGE})`);
  check("stage: live rows on a thread already past the anchor stage (dispatch must refuse)", g.n);

  const [w] = await one("window", `select count(*)::int n from send_queue q
     where ${NR} and q.queue_status in ${SENT} and q.sent_at is not null and coalesce(q.timezone,'') <> ''
       and (extract(hour from q.sent_at at time zone q.timezone) < 8 or extract(hour from q.sent_at at time zone q.timezone) >= 21)`);
  check("window: sent outside 8am–9pm recipient-local", w.n);

  const [tpl] = await one("templates", `select count(*)::int n from send_queue q
     where ${NR} and q.queue_status in ${SENT}
       and not exists (select 1 from sms_templates t where t.template_id = q.template_id and t.is_active and t.safe_for_auto_reply)`);
  check("templates: sent without an active, auto-safe sms_templates row", tpl.n);

  const [held] = await one("parked", `select count(*)::int n from send_queue q where ${NR} and q.queue_status like 'paused%'`);
  console.log(`info  parked for review (no approved copy / revalidation refused): ${held.n}`);

  await client.query("rollback");
} catch (error) {
  console.error("smoke test error:", error?.message || error);
  violations.push("error");
} finally {
  await client.end().catch(() => {});
}

console.log(violations.length ? `\nSMOKE FAIL (${violations.length})` : "\nSMOKE PASS");
process.exit(violations.length ? 1 : 0);
