// NO-RESPONSE FOLLOW-UP DRY RUN — READ ONLY, NO SENDS, NO WRITES.
// Lists every thread that would get FU1 right now (S2 interest question or an
// offer, seller silent ≥ 24h), through the SAME pure policy the live path uses
// (no-response-followup.js evaluateNoResponseCandidate).
//
//   cd apps/api && nice -n 15 node --import ./tests/register-aliases.mjs \
//     scripts/ops/no-response-followup-dry-run.mjs --db-url-file /tmp/.dburl \
//     --out ../../tmp/followup-s2/DRY_RUN.json
//
// Safety: BEGIN READ ONLY + statement_timeout 30s; the URL is never printed.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  evaluateNoResponseCandidate,
  resolveNoResponseConfig,
  classifyNoResponseAnchor,
  detectOutboundOffer,
} from "../../src/lib/domain/seller-flow/no-response-followup.js";
import { isInternalTestPhone } from "../../src/lib/config/internal-phones.js";

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const SQL = `
with ob as (
  select me.id, me.thread_key, coalesce(me.sent_at, me.event_timestamp, me.created_at) t, me.queue_id
    from message_events me
   where me.direction = 'outbound' and me.created_at > now() - interval '60 days'
     and coalesce(me.delivery_status, '') not in ('failed', 'undelivered')
), last_ob as (
  select distinct on (thread_key) * from ob order by thread_key, t desc
), inb as (
  select i.thread_key, max(coalesce(i.event_timestamp, i.created_at)) last_in, min(coalesce(i.event_timestamp, i.created_at)) first_in
    from message_events i
   where i.direction = 'inbound' and i.thread_key in (select thread_key from last_ob)
   group by i.thread_key
), cand as (
  select l.*, (inb.last_in >= l.t) as has_inbound_after_anchor
    from last_ob l join inb on inb.thread_key = l.thread_key
   where l.t < now() - interval '24 hours' and inb.first_in < l.t
)
select l.id as anchor_message_event_id, l.thread_key, l.t as anchor_sent_at, l.has_inbound_after_anchor,
       q.id, q.type, q.use_case_template, q.message_body, q.template_id, q.language, q.seller_first_name,
       q.property_address, q.property_type, q.timezone, q.market, q.agent_name, q.master_owner_id, q.property_id, q.metadata,
       its.is_suppressed, its.is_archived, its.contactability_status, its.last_intent, its.lifecycle_stage, its.market as thread_market,
       exists (select 1 from sms_suppression_list x where (x.phone_e164 = l.thread_key or x.phone_number = l.thread_key) and coalesce(x.is_active, true)) as on_suppression_list,
       (select coalesce(json_agg(json_build_object('message_body', i.message_body, 'language', i.language) order by i.ts desc), '[]'::json)
          from (select i.message_body, i.language, coalesce(i.event_timestamp, i.created_at) ts from message_events i
                 where i.thread_key = l.thread_key and i.direction = 'inbound' and coalesce(i.event_timestamp, i.created_at) < l.t
                 order by 3 desc limit 10) i) as inbound_before
  from cand l
  left join send_queue q on q.id = l.queue_id
  left join inbox_thread_state its on its.thread_key = l.thread_key
`;

// Every outbound in 14 days that carries a money-shaped token: the offer
// extractor's examples (automated + manual), whatever happened afterwards.
const OFFER_SQL = `
select me.id, me.thread_key, coalesce(me.sent_at, me.event_timestamp, me.created_at) t, me.message_body,
       q.use_case_template, q.metadata->>'template_source' as template_source,
       exists (select 1 from message_events i where i.thread_key = me.thread_key and i.direction = 'inbound'
               and coalesce(i.event_timestamp, i.created_at) >= coalesce(me.sent_at, me.event_timestamp, me.created_at)) as replied_after
  from message_events me left join send_queue q on q.id = me.queue_id
 where me.direction = 'outbound' and me.created_at > now() - interval '14 days'
   and coalesce(me.delivery_status, '') not in ('failed', 'undelivered')
   and me.message_body ~ '\\$\\s?\\d|\\d{1,3}(,\\d{3})+|\\d+\\s?k\\b'
 order by t desc
 limit 400
`;

async function main() {
  const url = String(readFileSync(arg("db-url-file", "/tmp/.dburl"), "utf8")).trim();
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  let rows;
  let offer_bodies;
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '30s'");
    rows = (await client.query(SQL)).rows;
    offer_bodies = (await client.query(OFFER_SQL)).rows;
    await client.query("ROLLBACK");
  } finally {
    await client.end();
  }

  const now = new Date();
  const results = { s2_interest: [], offer: [] };
  const skipped = {};
  const age_capped = resolveNoResponseConfig();
  const no_cap = resolveNoResponseConfig({ max_anchor_age_hours: 24 * 60 });
  const all60 = { s2_interest: 0, offer: 0 };
  for (const r of rows) {
    if (isInternalTestPhone(r.thread_key)) continue;
    const anchor = { ...r, use_case: r.use_case_template };
    const kind = classifyNoResponseAnchor(anchor, age_capped).kind;
    if (!kind) continue;
    const inbound = Array.isArray(r.inbound_before) ? r.inbound_before : [];
    const facts = {
      anchor,
      anchor_sent_at: new Date(r.anchor_sent_at).toISOString(),
      anchor_message_event_id: r.anchor_message_event_id,
      thread_key: r.thread_key,
      has_inbound_before_anchor: inbound.length > 0, // cand requires an inbound before the anchor
      has_inbound_after_anchor: r.has_inbound_after_anchor,
      has_newer_outbound: false, // anchor is the latest outbound by construction
      thread_state: {
        is_suppressed: r.is_suppressed, is_archived: r.is_archived, contactability_status: r.contactability_status,
        last_intent: r.last_intent, lifecycle_stage: r.lifecycle_stage,
      },
      on_suppression_list: r.on_suppression_list,
      inbound_rows_newest_first: inbound,
    };
    if (evaluateNoResponseCandidate(facts, { config: no_cap, now }).eligible) all60[kind] += 1;
    const ev = evaluateNoResponseCandidate(facts, { config: age_capped, now });
    if (!ev.eligible) {
      const key = `${kind}:${ev.reason}`;
      skipped[key] = (skipped[key] || 0) + 1;
      continue;
    }
    results[kind].push({
      thread_key: r.thread_key,
      market: r.market || r.thread_market || null,
      language: ev.plan.language,
      language_source: ev.plan.language_source,
      anchor_sent_at: ev.plan.anchor_at,
      fu1_due_at: ev.plan.scheduled_for,
      use_case: ev.plan.use_case,
      greeting_name: ev.plan.seller_first_name,
      anchor_text: String(r.message_body || "").slice(0, 220),
      anchor_template_id: r.template_id || null,
      anchor_use_case: r.use_case_template || null,
      offer: ev.plan.offer,
      last_seller_text: String(inbound[0]?.message_body || "").slice(0, 120),
    });
  }

  const offer_examples = [];
  const offer_extraction = {};
  for (const b of offer_bodies || []) {
    if (isInternalTestPhone(b.thread_key)) continue;
    const d = detectOutboundOffer({ message_body: b.message_body, use_case: b.use_case_template });
    const key = d.is_offer ? `${d.mode}${d.confidence ? ":" + d.confidence : ""}` : "not_an_offer";
    offer_extraction[key] = (offer_extraction[key] || 0) + 1;
    offer_examples.push({
      sent_at: new Date(b.t).toISOString(),
      thread_key: b.thread_key,
      source: b.template_source === "manual_composer" || b.use_case_template === "manual_reply" ? "manual" : "automated",
      seller_replied_after: b.replied_after,
      text: String(b.message_body || "").slice(0, 200),
      extracted: d,
    });
  }

  const split = (list, key) => list.reduce((acc, x) => ((acc[x[key] || "∅"] = (acc[x[key] || "∅"] || 0) + 1), acc), {});
  const summary = {
    generated_at: now.toISOString(),
    read_only: true,
    sends: 0,
    max_anchor_age_hours: age_capped.max_anchor_age_hours,
    fu1_now: { s2_interest: results.s2_interest.length, offer: results.offer.length },
    fu1_if_backlog_60d: all60,
    s2_by_market: split(results.s2_interest, "market"),
    s2_by_language: split(results.s2_interest, "language"),
    offer_by_market: split(results.offer, "market"),
    offer_by_language: split(results.offer, "language"),
    offer_modes: results.offer.reduce((a, x) => ((a[x.offer?.mode] = (a[x.offer?.mode] || 0) + 1), a), {}),
    skipped,
    offer_extraction_14d: offer_extraction,
  };
  const out = arg("out");
  if (out) {
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ summary, ...results, offer_examples }, null, 2));
  }
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error("dry run failed:", error?.message || error);
  process.exit(1);
});
