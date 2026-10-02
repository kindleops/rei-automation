#!/usr/bin/env node

/**
 * RC 7.1 — repair verification harness (READ-ONLY).
 *
 * Snapshots every RC 7.1 repair surface BEFORE and AFTER the deploy-window
 * repairs and writes JSON plus a markdown diff. It never writes to the database:
 * every query runs inside `BEGIN READ ONLY` with a statement_timeout, and the
 * transaction is always rolled back.
 *
 * Repairs covered (runbook: ~/.claude/jobs/c39b0175/tmp/rc/DEPLOY-RUNBOOK.md):
 *   R1 market   campaign market identity  (20261001_campaign_market_identity_dryrun.sql, Part 2)
 *   R2 p7       review-placeholder cleanup (20261001_p7_review_placeholder_cleanup_APPLY.sql)
 *   R3 canary   d2 + d2b canary archive    (tmp/rc/d2-canary-cleanup.sql, d2b-…sql)
 *   R4 nurture  not-interested nurture     (scripts/repair-not-interested-nurture.mjs --apply)
 *   R5 nr       New Replies cleanup 7.2    (scripts/repairs/20261001_new_replies_cleanup.mjs --apply)
 *
 * Usage (from apps/api):
 *   node --env-file=.env.local --no-warnings scripts/repairs/rc71-repair-verify.mjs --mode=before --out=<dir>
 *   node --env-file=.env.local --no-warnings scripts/repairs/rc71-repair-verify.mjs --mode=after \
 *        --before=<dir>/rc71-verify-before.json --out=<dir> [--stage=after-p7]
 *   node scripts/repairs/rc71-repair-verify.mjs --print-sql [--since=<iso>]   # paste into MCP execute_sql
 *   node scripts/repairs/rc71-repair-verify.mjs --ingest=<mcp-results.json> --mode=… # offline
 *
 * --since   start of the repair window (default: the BEFORE snapshot's taken_at
 *           in after-mode, now()-24h in before-mode). Window-scoped sections
 *           (send_queue rows, audit rows, duplicates) count only rows created
 *           at/after it.
 * --stage   free label written into the file name (after-p7, after-nurture …),
 *           so each step of the runbook can keep its own AFTER snapshot.
 *
 * Exit code: 0 = all invariants hold; 3 = an invariant failed (duplicates,
 * operator-touched deal cleared, parity broken …); 1 = harness error.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.includes("=") ? hit.split("=").slice(1).join("=") : true;
};

const MODE = String(opt("mode", "before"));
const STAGE = opt("stage", null);
const OUT = String(opt("out", path.join(os.tmpdir(), "rc71-repair-verify")));
const BEFORE_PATH = opt("before", null);
const PRINT_SQL = Boolean(opt("print-sql", false));
const INGEST = opt("ingest", null);
const TIMEOUT_MS = Number(opt("timeout-ms", 60_000));

// ── constants shared with the repair scripts (keep in sync) ────────────────
export const TAGS = Object.freeze({
  p7: "rc71_p7_cleanup",
  canary_d2: "rc7.1_canary_cleanup",
  canary_d2b: "ic8.1_canary_cleanup",
  dequincy: "rc7.1_dequincy_fix",
  nurture: "rc71_not_interested_nurture_repair",
  nr: "classifier_cleanup_20261001",
  market: "rc71_campaign_market_identity",
});
export const CANARY_DEALS = Object.freeze([
  "1cda1a2f-b34a-4031-9cd8-06992354b253",
  "f554add3-4503-4454-bcd3-ea6b578ee8a2",
  "b228d1d0-13a7-4241-b447-ea29e514ba0a",
  "78e4cce2-c5fc-42b3-9923-f8ad3428dda2",
  "bdd43b67-0ffc-4bac-ba2d-af9ef2d1d1a1",
]);
export const DEQUINCY_DEAL = "f0615bc0-4ae5-4b9d-8bfe-8ade7a0e1634";
export const CANARY_THREADS = Object.freeze([
  "+13059807795", "6128072000", "+16128072000", "+13055376631", "+16127433952", "6127433952",
]);
// send_queue statuses that are still going to send (mirror of the nurture script)
const LIVE = `('queued','ready','runnable','scheduled','pending','paused','paused_after_hours','processing','approved','approval','held','sending')`;
const k10 = (col) => `right(regexp_replace(coalesce(${col}, ''), '\\D', '', 'g'), 10)`;
const lit = (arr) => `(${arr.map((v) => `'${v}'`).join(",")})`;

/**
 * Every section is one read-only statement returning ONE row with ONE jsonb
 * column `v`. `$1` is the window start (timestamptz).
 */
export const SECTIONS = {
  // ── New Replies: the view, the counts view (Command Rail + Inbox lens), raw bucket
  new_replies: `
    select jsonb_build_object(
      'view_in_new_replies', (select count(*) from v_inbox_thread_state_buckets where in_new_replies),
      'counts_view_new_replies', (select new_replies from v_inbox_bucket_counts limit 1),
      'raw_bucket_new_replies', (select count(*) from inbox_thread_state where inbox_bucket = 'new_replies' and coalesce(is_archived,false) = false),
      'parity_ok', (select count(*) from v_inbox_thread_state_buckets where in_new_replies)
                    = (select new_replies from v_inbox_bucket_counts limit 1),
      'view_column_count', (select count(*) from information_schema.columns where table_schema='public' and table_name='v_inbox_thread_state_buckets'),
      'threads_with_cleanup_marker', (select count(*) from inbox_thread_state where metadata ? '${TAGS.nr}'),
      'cleanup_events_by_field', (select coalesce(jsonb_object_agg(field_name, n), '{}') from (
          select field_name, count(*) n from universal_lead_state_events where source_view = '${TAGS.nr}' group by 1) x),
      'counts_row', (select to_jsonb(c) from v_inbox_bucket_counts c limit 1)
    ) as v`,

  // ── P7: human_review flags on threads and deals, audit rows, guards
  p7: `
    select jsonb_build_object(
      'threads_human_review', (select count(*) from inbox_thread_state where next_action = 'human_review' and coalesce(is_archived,false) = false),
      'threads_human_review_incl_archived', (select count(*) from inbox_thread_state where next_action = 'human_review'),
      'deals_human_review', (select count(*) from acquisition_opportunities where next_action = 'human_review'),
      'deals_by_status_human_review', (select coalesce(jsonb_object_agg(s, n), '{}') from (
          select coalesce(opportunity_status,'null') s, count(*) n from acquisition_opportunities where next_action = 'human_review' group by 1) x),
      'audit_thread_rows', (select count(*) from universal_lead_state_events where source_view = '${TAGS.p7}'),
      'audit_deal_rows', (select count(*) from acquisition_opportunity_history where source = '${TAGS.p7}'),
      'audit_thread_distinct', (select count(distinct thread_key) from universal_lead_state_events where source_view = '${TAGS.p7}'),
      'audit_deal_distinct', (select count(distinct opportunity_id) from acquisition_opportunity_history where source = '${TAGS.p7}'),
      -- invariant: a deal an operator touched must never be cleared by P7
      'operator_touched_deals_cleared', (select count(distinct h.opportunity_id)
          from acquisition_opportunity_history h
          where h.source = '${TAGS.p7}'
            and exists (select 1 from acquisition_opportunity_history o
                        where o.opportunity_id = h.opportunity_id
                          and (o.source = 'operator' or o.actor in ('operator','certification','cert'))
                          and o.created_at > coalesce((select max(s.created_at) from acquisition_opportunity_history s
                                where s.opportunity_id = h.opportunity_id and s.field_name='next_action'
                                  and s.new_value='human_review' and s.source='seller_execution_gap_recovery'), '-infinity'))),
      -- invariant: a cleared thread whose seller is waiting (latest message inbound) must be 0
      'cleared_threads_with_seller_waiting', (select count(*) from universal_lead_state_events e
          join inbox_thread_state t on t.thread_key = e.thread_key
          where e.source_view = '${TAGS.p7}' and lower(coalesce(t.latest_direction,'')) = 'inbound'
            and t.latest_message_at < e.created_at),
      'autopilot_review_holds_still_flagged', (select count(*) from inbox_thread_state t
          where t.next_action = 'human_review' and exists (select 1 from universal_lead_state_events e
            where e.thread_key = t.thread_key and e.field_name='next_action' and e.new_value='human_review'
              and e.source_view in ('seller_inbound_orchestrator','seller_autopilot')))
    ) as v`,

  // ── Canaries (d2 + d2b) and the Dequincy option-A row
  canary: `
    select jsonb_build_object(
      'deals', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'status', opportunity_status, 'stage', acquisition_stage,
                 'automation_state', automation_state, 'next_action', next_action, 'test_fixture', metadata->>'test_fixture',
                 'archived_reason', metadata->>'archived_reason', 'version', version) order by id), '[]')
                from acquisition_opportunities where id::text in ${lit(CANARY_DEALS)}),
      'deals_archived', (select count(*) from acquisition_opportunities where id::text in ${lit(CANARY_DEALS)} and opportunity_status = 'archived'),
      'deals_present', (select count(*) from acquisition_opportunities where id::text in ${lit(CANARY_DEALS)}),
      'dequincy', (select jsonb_build_object('status', opportunity_status, 'stage', acquisition_stage, 'last_updated_by', last_updated_by)
                   from acquisition_opportunities where id::text = '${DEQUINCY_DEAL}'),
      'threads', (select coalesce(jsonb_object_agg(thread_key, coalesce(is_archived,false)), '{}') from inbox_thread_state where thread_key in ${lit(CANARY_THREADS)}),
      'threads_unarchived', (select count(*) from inbox_thread_state where thread_key in ${lit(CANARY_THREADS)} and coalesce(is_archived,false) = false),
      'audit_rows', (select count(*) from acquisition_opportunity_history where idempotency_key like 'rc71_canary_archive:%' or idempotency_key like 'ic81_canary_archive:%'),
      'live_sends_on_canary_threads', (select count(*) from send_queue where (thread_key in ${lit(CANARY_THREADS)} or to_phone_number in ${lit(CANARY_THREADS)})
                                         and lower(queue_status) in ${LIVE})
    ) as v`,

  // ── Not-interested nurture: population status, scheduled follow-ups, audit
  nurture: `
    with pop as (
      select distinct opportunity_id from acquisition_opportunity_history
      where field_name = 'opportunity_status' and new_value = 'suppressed' and reason like '%NOT_INTERESTED_NURTURE%'
    )
    select jsonb_build_object(
      'population_deals', (select count(*) from pop),
      'population_by_status', (select coalesce(jsonb_object_agg(s, n), '{}') from (
          select coalesce(o.opportunity_status,'missing') s, count(*) n from pop p left join acquisition_opportunities o on o.id = p.opportunity_id group by 1) x),
      'status_audit_rows', (select count(*) from acquisition_opportunity_history where source = '${TAGS.nurture}'),
      'repair_queue_rows_by_status', (select coalesce(jsonb_object_agg(queue_status, n), '{}') from (
          select queue_status, count(*) n from send_queue where metadata->>'source' = '${TAGS.nurture}' group by 1) x),
      'repair_queue_rows', (select count(*) from send_queue where metadata->>'source' = '${TAGS.nurture}'),
      'repair_queue_due_range', (select jsonb_build_object('min', min(coalesce(scheduled_for_utc, scheduled_for)), 'max', max(coalesce(scheduled_for_utc, scheduled_for)))
          from send_queue where metadata->>'source' = '${TAGS.nurture}'),
      'repair_rows_sent', (select count(*) from send_queue where metadata->>'source' = '${TAGS.nurture}' and sent_at is not null),
      'nurture_rows_live', (select count(*) from send_queue where use_case_template = 'nurture_not_interested' and sent_at is null and lower(queue_status) in ${LIVE}),
      'nurture_rows_by_status', (select coalesce(jsonb_object_agg(queue_status, n), '{}') from (
          select queue_status, count(*) n from send_queue where use_case_template = 'nurture_not_interested' group by 1) x),
      'nurture_rows_ever_sent', (select count(*) from send_queue where use_case_template = 'nurture_not_interested' and sent_at is not null),
      -- invariant: never two live nurture follow-ups for one thread
      'threads_with_2plus_live_nurture', (select count(*) from (
          select ${k10("thread_key")} k from send_queue where use_case_template = 'nurture_not_interested' and sent_at is null and lower(queue_status) in ${LIVE}
          group by 1 having count(*) > 1) d),
      -- invariant: the repair queued at most one row per thread
      'threads_with_2plus_repair_rows', (select count(*) from (
          select ${k10("thread_key")} k from send_queue where metadata->>'source' = '${TAGS.nurture}' group by 1 having count(*) > 1) d),
      -- invariant: no repair row on an opted-out / suppressed phone
      'repair_rows_on_suppressed_phone', (select count(*) from send_queue q
          where q.metadata->>'source' = '${TAGS.nurture}'
            and exists (select 1 from sms_suppression_list s where coalesce(s.is_active, true)
                        and ${k10("s.phone_e164")} = ${k10("q.to_phone_number")}))
    ) as v`,

  // ── Campaign market identity
  market: `
    select jsonb_build_object(
      'campaigns_live', (select count(*) from campaigns where status not in ('archived','completed')),
      'repaired', (select count(*) from campaigns where metadata->'market_identity'->>'repaired_by' = '${TAGS.market}'),
      'with_market_identity', (select count(*) from campaigns where metadata ? 'market_identity'),
      'with_previous_timezone_key', (select count(*) from campaigns where metadata ? 'previous_timezone'),
      'rows', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'status', status, 'market', market, 'state', state,
                'timezone', metadata->>'timezone', 'kind', metadata->'market_identity'->>'kind',
                'tz_mode', metadata->'market_identity'->>'timezone_mode') order by status, name), '[]')
               from campaigns c where status not in ('archived','completed')
                 and exists (select 1 from campaign_targets t where t.campaign_id = c.id))
    ) as v`,

  // ── send_queue rows created in the window, by source / template / status
  queue_window: `
    with w as (select * from send_queue where created_at >= $1::timestamptz)
    select jsonb_build_object(
      'rows', (select count(*) from w),
      'by_source_template_status', (select coalesce(jsonb_agg(jsonb_build_object('source', src, 'use_case', uc, 'template_id', tid,
                 'status', st, 'n', n) order by n desc), '[]') from (
          select coalesce(metadata->>'source', source, 'unknown') src, coalesce(use_case_template,'-') uc,
                 coalesce(template_id::text, selected_template_id::text, 'null') tid, queue_status st, count(*) n
          from w group by 1,2,3,4) x),
      'class', (select coalesce(jsonb_object_agg(c, n), '{}') from (
          select case when sent_at is not null or lower(queue_status) in ('sent','delivered') then 'sent'
                      when lower(queue_status) in ('blocked','failed','failed_transport','cancelled','canceled','expired','suppressed','rejected') then 'blocked_or_cancelled'
                      when lower(queue_status) in ('held','paused','paused_after_hours','approval') then 'held'
                      when lower(queue_status) in ${LIVE} then 'queued'
                      else 'other:' || queue_status end c, count(*) n from w group by 1) x),
      'blocked_held_reasons', (select coalesce(jsonb_agg(jsonb_build_object('status', queue_status, 'reason', r, 'n', n) order by n desc), '[]') from (
          select queue_status, coalesce(nullif(guard_reason,''), nullif(blocked_reason,''), nullif(paused_reason,''), nullif(failed_reason,''), metadata->>'hold_reason', 'none') r, count(*) n
          from w where sent_at is null and lower(queue_status) not in ('scheduled','queued','ready','pending')
          group by 1,2) x),
      -- invariant: one thread never gets two live sends created in the window
      'threads_with_2plus_live_rows_in_window', (select count(*) from (
          select ${k10("thread_key")} from w where sent_at is null and lower(queue_status) in ${LIVE} and thread_key is not null
          group by 1 having count(*) > 1) d),
      -- invariant: two follow-ups created for one thread in the window
      'threads_with_2plus_followups_in_window', (select count(*) from (
          select ${k10("thread_key")} from w where (type = 'followup' or message_type = 'followup') and thread_key is not null
          group by 1 having count(*) > 1) d)
    ) as v`,

  // ── queue health (global, not window-scoped)
  queue_health: `
    select jsonb_build_object(
      'live_by_status', (select coalesce(jsonb_object_agg(queue_status, n), '{}') from (
          select queue_status, count(*) n from send_queue where sent_at is null and lower(queue_status) in ${LIVE} group by 1) x),
      'due_now_unsent', (select count(*) from send_queue where sent_at is null and lower(queue_status) in ('queued','ready','scheduled','pending')
          and coalesce(scheduled_for_utc, scheduled_for) <= now()),
      'locked_rows', (select count(*) from send_queue where is_locked = true),
      'sent_last_24h', (select count(*) from send_queue where sent_at >= now() - interval '24 hours'),
      'last_sent_at', (select max(sent_at) from send_queue),
      'threads_with_2plus_live_rows', (select count(*) from (
          select ${k10("thread_key")} from send_queue where sent_at is null and lower(queue_status) in ${LIVE} and thread_key is not null
          group by 1 having count(*) > 1) d)
    ) as v`,

  // ── audit rows per source tag (window) and duplicate-touch checks
  audit: `
    select jsonb_build_object(
      'lead_state_events_by_source', (select coalesce(jsonb_object_agg(s, n), '{}') from (
          select coalesce(source_view, change_source, 'null') s, count(*) n from universal_lead_state_events where created_at >= $1::timestamptz group by 1) x),
      'opportunity_history_by_source', (select coalesce(jsonb_object_agg(s, n), '{}') from (
          select coalesce(source, actor, 'null') s, count(*) n from acquisition_opportunity_history where created_at >= $1::timestamptz group by 1) x),
      'repair_tag_totals', jsonb_build_object(
          'p7_threads', (select count(*) from universal_lead_state_events where source_view = '${TAGS.p7}'),
          'p7_deals', (select count(*) from acquisition_opportunity_history where source = '${TAGS.p7}'),
          'canary', (select count(*) from acquisition_opportunity_history where idempotency_key like 'rc71_canary_archive:%' or idempotency_key like 'ic81_canary_archive:%'),
          'nurture_history', (select count(*) from acquisition_opportunity_history where source = '${TAGS.nurture}'),
          'nr_lead_state', (select count(*) from universal_lead_state_events where source_view = '${TAGS.nr}'),
          'nr_history', (select count(*) from acquisition_opportunity_history where source = '${TAGS.nr}'),
          'market_campaigns', (select count(*) from campaigns where metadata->'market_identity'->>'repaired_by' = '${TAGS.market}')),
      -- invariants: the same subject touched twice by one repair
      'dup_p7_thread', (select count(*) from (select thread_key from universal_lead_state_events where source_view = '${TAGS.p7}' group by 1 having count(*) > 1) d),
      'dup_p7_deal', (select count(*) from (select opportunity_id from acquisition_opportunity_history where source = '${TAGS.p7}' group by 1 having count(*) > 1) d),
      'dup_nurture_deal', (select count(*) from (select opportunity_id from acquisition_opportunity_history where source = '${TAGS.nurture}' group by 1 having count(*) > 1) d),
      'dup_nr_thread_field', (select count(*) from (select thread_key, field_name from universal_lead_state_events where source_view = '${TAGS.nr}'
                                                     and created_at >= $1::timestamptz group by 1,2 having count(*) > 1) d),
      -- the same thread touched by two different repairs in the window (informational: expected small, listed)
      'threads_touched_by_2plus_repairs', (select coalesce(jsonb_agg(jsonb_build_object('k10', k, 'repairs', r)), '[]') from (
          select k, jsonb_agg(distinct tag) r from (
            select ${k10("thread_key")} k, source_view tag from universal_lead_state_events
              where source_view in ('${TAGS.p7}','${TAGS.nr}') and created_at >= $1::timestamptz
            union all
            select ${k10("thread_key")}, '${TAGS.nurture}' from send_queue where metadata->>'source' = '${TAGS.nurture}' and created_at >= $1::timestamptz
          ) u group by k having count(distinct tag) > 1) x)
    ) as v`,

  // ── extra outbound each repair generated (window), nurture vs New Replies
  extra_outbound: `
    with nr_threads as (
      select distinct ${k10("thread_key")} k from universal_lead_state_events where source_view = '${TAGS.nr}' and created_at >= $1::timestamptz
    ), w as (
      select q.*, ${k10("q.thread_key")} k,
        case when q.metadata->>'source' = '${TAGS.nurture}' then 'nurture_repair'
             when q.metadata->>'source' = '${TAGS.nr}' then 'new_replies_cleanup'
             when exists (select 1 from nr_threads n where n.k = ${k10("q.thread_key")}) then 'new_replies_thread_other_source'
             else null end attribution
      from send_queue q where q.created_at >= $1::timestamptz
    )
    select jsonb_build_object(
      'by_attribution', (select coalesce(jsonb_agg(jsonb_build_object('attribution', attribution, 'source', src, 'use_case', uc,
                 'status', st, 'due', due, 'n', n) order by attribution, n desc), '[]') from (
          select attribution, coalesce(metadata->>'source', source, 'unknown') src, coalesce(use_case_template,'-') uc, queue_status st,
                 case when sent_at is not null then 'sent'
                      when coalesce(scheduled_for_utc, scheduled_for) <= now() + interval '24 hours' then 'within_24h'
                      when coalesce(scheduled_for_utc, scheduled_for) <= now() + interval '7 days' then 'within_7d'
                      else 'later' end due, count(*) n
          from w where attribution is not null group by 1,2,3,4,5) x),
      'totals', (select coalesce(jsonb_object_agg(attribution, n), '{}') from (
          select attribution, count(*) n from w where attribution is not null group by 1) x),
      'outbound_messages_on_repair_threads_in_window', (select count(*) from message_events m
          where m.created_at >= $1::timestamptz and lower(coalesce(m.direction,'')) like 'out%'
            and (exists (select 1 from nr_threads n where n.k = ${k10("m.thread_key")})
                 or exists (select 1 from send_queue q where q.metadata->>'source' = '${TAGS.nurture}' and ${k10("q.thread_key")} = ${k10("m.thread_key")}))),
      'nr_threads_touched', (select count(*) from nr_threads)
    ) as v`,
};

// ── invariants (checked on every snapshot; zero means pass) ────────────────
export const INVARIANTS = [
  ["new_replies.parity_ok", (s) => s.new_replies?.parity_ok === true, "view count = v_inbox_bucket_counts.new_replies (Inbox lens = Command Rail)"],
  ["p7.operator_touched_deals_cleared", (s) => num(s.p7?.operator_touched_deals_cleared) === 0, "P7 never clears an operator-touched deal"],
  ["p7.cleared_threads_with_seller_waiting", (s) => num(s.p7?.cleared_threads_with_seller_waiting) === 0, "P7 never clears a thread whose seller is waiting"],
  ["canary.deals_present", (s) => num(s.canary?.deals_present) === CANARY_DEALS.length, "canary deals are archived, never deleted"],
  ["canary.live_sends_on_canary_threads", (s) => num(s.canary?.live_sends_on_canary_threads) === 0, "no live send on a canary thread"],
  ["nurture.threads_with_2plus_live_nurture", (s) => num(s.nurture?.threads_with_2plus_live_nurture) === 0, "never two live nurture follow-ups per thread"],
  ["nurture.threads_with_2plus_repair_rows", (s) => num(s.nurture?.threads_with_2plus_repair_rows) === 0, "nurture repair queues ≤ 1 row per thread"],
  ["nurture.repair_rows_on_suppressed_phone", (s) => num(s.nurture?.repair_rows_on_suppressed_phone) === 0, "no nurture repair row on a suppressed phone"],
  ["queue_window.threads_with_2plus_live_rows_in_window", (s) => num(s.queue_window?.threads_with_2plus_live_rows_in_window) === 0, "no thread got two live sends in the window"],
  ["queue_window.threads_with_2plus_followups_in_window", (s) => num(s.queue_window?.threads_with_2plus_followups_in_window) === 0, "no thread got two follow-ups in the window"],
  ["audit.dup_p7_thread", (s) => num(s.audit?.dup_p7_thread) === 0, "P7 touched each thread once"],
  ["audit.dup_p7_deal", (s) => num(s.audit?.dup_p7_deal) === 0, "P7 touched each deal once"],
  ["audit.dup_nurture_deal", (s) => num(s.audit?.dup_nurture_deal) === 0, "nurture touched each deal once"],
  ["audit.dup_nr_thread_field", (s) => num(s.audit?.dup_nr_thread_field) === 0, "New Replies cleanup wrote each thread field once"],
];

// ── expected end-state (after the full sequence) — informational, from the dry runs
export const EXPECTED_AFTER = [
  ["audit.repair_tag_totals.p7_threads", 4373, "P7 preview clear_ok threads (2026-10-01)"],
  ["audit.repair_tag_totals.p7_deals", 52, "P7 preview clear_ok deals"],
  ["canary.deals_archived", 5, "d2 (3) + d2b (2)"],
  ["audit.repair_tag_totals.canary", 5, "one history row per archived canary"],
  ["audit.repair_tag_totals.nurture_history", 34, "nurture dry run: suppressed → nurture"],
  ["nurture.repair_queue_rows", 35, "nurture dry run: follow-ups scheduled"],
  ["nurture.repair_rows_sent", 0, "nurture rows are due +30 days; none may send in the window"],
];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}
function get(obj, dotted) {
  return dotted.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

async function runLive(since) {
  const { default: pg } = await import("pg");
  const { resolveDatabaseUrl } = await import("../../src/lib/postgres/resolve-database-url.js");
  const url = resolveDatabaseUrl();
  if (!url) throw new Error("no database url (SUPABASE_DB_URL) — run with --env-file=.env.local, or use --print-sql + MCP");
  const client = new pg.Client({ connectionString: url, ssl: url.includes("localhost") ? false : { rejectUnauthorized: false } });
  await client.connect();
  const out = {};
  const errors = {};
  try {
    await client.query("begin read only");
    await client.query(`set local statement_timeout = ${Math.trunc(TIMEOUT_MS)}`);
    const meta = await client.query("select now() as db_now, current_setting('transaction_read_only') as ro");
    if (meta.rows[0].ro !== "on") throw new Error("refusing to run: transaction is not read-only");
    out._db_now = meta.rows[0].db_now;
    for (const [name, sql] of Object.entries(SECTIONS)) {
      await client.query(`savepoint s_${name}`);
      try {
        const usesParam = sql.includes("$1");
        const r = await client.query(sql, usesParam ? [since] : []);
        out[name] = r.rows[0]?.v ?? null;
        await client.query(`release savepoint s_${name}`);
      } catch (error) {
        errors[name] = String(error?.message || error);
        await client.query(`rollback to savepoint s_${name}`);
      }
    }
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end().catch(() => {});
  }
  return { sections: out, errors };
}

/**
 * One statement returning ONE jsonb object { _db_now, <section>: v, … } so the
 * whole snapshot can be taken with a single MCP execute_sql call. Save the
 * returned object to a file and pass it to --ingest.
 */
function printSql(since) {
  const bind = (sql) => sql.replaceAll("$1::timestamptz", `'${since}'::timestamptz`).trim();
  const parts = Object.entries(SECTIONS).map(([name, sql]) => `  '${name}', (select s.v from (${bind(sql)}) s)`);
  console.log(
    `-- rc71-repair-verify (read-only). since = ${since}\n` +
      `set statement_timeout = '120s';\n` +
      `select jsonb_build_object(\n  '_db_now', now(),\n${parts.join(",\n")}\n) as snapshot;`,
  );
}

function flatten(obj, prefix = "", acc = {}) {
  if (obj === null || obj === undefined) return acc;
  if (Array.isArray(obj)) {
    acc[prefix] = JSON.stringify(obj).length > 160 ? `[${obj.length} items]` : JSON.stringify(obj);
    return acc;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, acc);
    return acc;
  }
  acc[prefix] = obj;
  return acc;
}

function checkInvariants(snapshot) {
  return INVARIANTS.map(([key, test, desc]) => {
    let ok = false;
    try { ok = Boolean(test(snapshot.sections)); } catch { ok = false; }
    return { key, ok, value: get(snapshot.sections, key), desc };
  });
}

function renderMarkdown(snapshot, before) {
  const L = [];
  L.push(`# RC 7.1 repair verification — ${snapshot.mode}${snapshot.stage ? ` (${snapshot.stage})` : ""}`);
  L.push("");
  L.push(`- taken_at (db): ${snapshot.taken_at}`);
  L.push(`- window since: ${snapshot.since}`);
  if (before) L.push(`- compared with BEFORE taken_at ${before.taken_at}`);
  if (Object.keys(snapshot.errors || {}).length) {
    L.push(`- **section errors:** ${Object.entries(snapshot.errors).map(([k, v]) => `${k}: ${v}`).join("; ")}`);
  }
  L.push("");
  L.push("## Invariants (must all pass)");
  L.push("");
  L.push("| invariant | value | pass | meaning |");
  L.push("|---|---|---|---|");
  for (const r of snapshot.invariants) L.push(`| ${r.key} | ${JSON.stringify(r.value)} | ${r.ok ? "PASS" : "**FAIL**"} | ${r.desc} |`);
  L.push("");
  if (snapshot.mode === "after") {
    L.push("## Expected end-state (from the dry runs; informational until the whole sequence ran)");
    L.push("");
    L.push("| metric | expected | actual | match |");
    L.push("|---|---|---|---|");
    for (const [key, expected, why] of EXPECTED_AFTER) {
      const actual = get(snapshot.sections, key);
      L.push(`| ${key} | ${expected} | ${JSON.stringify(actual)} | ${num(actual) === expected ? "yes" : "no"} — ${why} |`);
    }
    L.push("");
  }
  const a = flatten(snapshot.sections);
  const b = before ? flatten(before.sections) : {};
  L.push(before ? "## Before → after" : "## Snapshot");
  L.push("");
  L.push(before ? "| metric | before | after | delta |" : "| metric | value |");
  L.push(before ? "|---|---|---|---|" : "|---|---|");
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => !k.startsWith("_")).sort();
  for (const k of keys) {
    if (!before) {
      L.push(`| ${k} | ${String(a[k]).replaceAll("|", "\\|")} |`);
      continue;
    }
    const x = b[k];
    const y = a[k];
    const delta = typeof x === "number" && typeof y === "number" ? y - x : Number.isFinite(Number(x)) && Number.isFinite(Number(y)) && x !== "" && y !== "" && typeof x !== "boolean" ? Number(y) - Number(x) : x === y ? "" : "changed";
    L.push(`| ${k} | ${String(x).replaceAll("|", "\\|")} | ${String(y).replaceAll("|", "\\|")} | ${delta === 0 ? "" : delta} |`);
  }
  L.push("");
  return L.join("\n");
}

async function main() {
  const before = BEFORE_PATH ? JSON.parse(fs.readFileSync(BEFORE_PATH, "utf8")) : null;
  const since =
    opt("since", null) ||
    (MODE === "after" && before ? before.taken_at : new Date(Date.now() - 24 * 3600 * 1000).toISOString());

  if (PRINT_SQL) return printSql(since);

  let result;
  if (INGEST) {
    // MCP output: { "<section>": <v jsonb> , … } assembled by hand from execute_sql results
    // Accepts the bare object, { snapshot: {...} }, or the MCP row array [{ snapshot: {...} }].
    let raw = JSON.parse(fs.readFileSync(INGEST, "utf8"));
    if (Array.isArray(raw)) raw = raw[0];
    if (raw && raw.snapshot && typeof raw.snapshot === "object") raw = raw.snapshot;
    result = { sections: raw, errors: {} };
  } else {
    result = await runLive(since);
  }
  const taken_at = result.sections._db_now ? new Date(result.sections._db_now).toISOString() : new Date().toISOString();
  const snapshot = {
    harness: "rc71-repair-verify@1",
    mode: MODE,
    stage: STAGE || null,
    project: "lcppdrmrdfblstpcbgpf",
    taken_at,
    since,
    sections: result.sections,
    errors: result.errors,
  };
  snapshot.invariants = checkInvariants(snapshot);

  fs.mkdirSync(OUT, { recursive: true });
  const base = `rc71-verify-${MODE}${STAGE ? `-${STAGE}` : ""}`;
  fs.writeFileSync(path.join(OUT, `${base}.json`), JSON.stringify(snapshot, null, 1));
  fs.writeFileSync(path.join(OUT, `${base}.md`), renderMarkdown(snapshot, before));

  const failed = snapshot.invariants.filter((r) => !r.ok);
  console.log(JSON.stringify({
    out: path.join(OUT, `${base}.json`),
    taken_at,
    since,
    section_errors: Object.keys(result.errors || {}),
    invariants_failed: failed.map((r) => `${r.key}=${JSON.stringify(r.value)}`),
  }, null, 2));
  if (Object.keys(result.errors || {}).length) process.exitCode = 1;
  else if (failed.length) process.exitCode = 3;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invokedDirectly) {
  main().catch((error) => {
    console.error("[rc71-repair-verify] failed:", error?.stack || error);
    process.exitCode = 1;
  });
}
