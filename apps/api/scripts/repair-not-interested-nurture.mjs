#!/usr/bin/env node

/**
 * RC 7.1 — repair "not interested" sellers that were treated as suppressed.
 *
 * Owner rule (2026-09-30): "A not interested is a 30 day follow up." Before
 * 56b39c10 (+ the RC 7.1 follow-up cycle fix) production:
 *   - set the deal to opportunity_status `suppressed` (the opt-out status) with
 *     a *_NOT_INTERESTED_NURTURE_30D reason, and
 *   - cancelled the 30-day follow-up (stage rule `not_interested`, the
 *     gap-recovery sweep), and could never schedule a second one.
 *
 * DRY-RUN BY DEFAULT. Nothing is written unless --apply is passed. Run only
 * from a tree that contains the RC 7.1 scheduler fix (seller-followup-
 * scheduler.js cycle keys), or the re-scheduled follow-up replays onto the
 * dead first row.
 *
 * Deterministic classification per seller (thread):
 *   BLOCKED_OPT_OUT     any DNC / STOP / opt-out / invalid / manual suppression
 *                       evidence → never touched.
 *   REVIEW              something else happened since (later inbound replies,
 *                       a non-not-interested latest intent, missing thread) →
 *                       listed for a human, never touched.
 *   ALREADY_OK          a live nurture follow-up exists and status is not
 *                       `suppressed` → nothing to do.
 *   REPAIR              status `suppressed` → `nurture` (version-guarded,
 *                       audited) and/or one nurture follow-up scheduled
 *                       through the canonical scheduler (30 days from now,
 *                       every send-time guard still applies).
 *   LEGACY_JUL01        the 2026-07-01 backfill cohort (no deal, follow-up due
 *                       2026-07-31). Reported; repaired only with
 *                       --include-legacy (owner decision).
 *
 * Atomicity (RC 7.1 runbook gap 5): the status change and its audit row are
 * ONE statement in ONE transaction through a direct Postgres connection
 * (applyStatusTransitionAtomic), so a partial failure can never leave a status
 * change without its audit row or an audit row without the change. --apply
 * therefore needs SUPABASE_DB_URL / DATABASE_URL; the dry run does not.
 *
 * Usage (from apps/api):
 *   node --import ./tests/register-aliases.mjs scripts/repair-not-interested-nurture.mjs
 *   node --import ./tests/register-aliases.mjs scripts/repair-not-interested-nurture.mjs --json
 *   node --import ./tests/register-aliases.mjs scripts/repair-not-interested-nurture.mjs --apply [--include-legacy] [--limit=N]
 */

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

import { COMPLIANCE_TERMINAL_INTENTS } from "../src/lib/domain/compliance/canonical-no-contact-states.js";

dotenv.config({ path: ".env.local", quiet: true });

const APPLY = process.argv.includes("--apply");
const INCLUDE_LEGACY = process.argv.includes("--include-legacy");
const AS_JSON = process.argv.includes("--json");
const LIMIT = Number((process.argv.find((a) => a.startsWith("--limit=")) || "").split("=")[1]) || Infinity;
const REPAIR_SOURCE = "rc71_not_interested_nurture_repair";
const LEGACY_COHORT_DAY = "2026-07-01";

const LIVE_STATUSES = [
  "queued", "ready", "runnable", "scheduled", "pending", "paused",
  "paused_after_hours", "processing", "approved", "approval", "held", "sending",
];
const BLOCKING_CONTACTABILITY = new Set([
  "opted_out", "invalid_number", "wrong_number", "do_not_contact", "dnc", "suppressed", "blocked",
]);

const clean = (v) => String(v ?? "").trim();
const lower = (v) => clean(v).toLowerCase();

/** Thread keys are E.164 now; the July backfill stored 10-digit keys. */
export function phoneVariants(key) {
  const digits = clean(key).replace(/\D/g, "");
  if (!digits) return [];
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return [...new Set([clean(key), ten, `1${ten}`, `+1${ten}`])];
}
export function e164(key) {
  const digits = clean(key).replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return ten.length === 10 ? `+1${ten}` : null;
}

/**
 * Pure classifier — the whole decision lives here so it can be read and
 * tested without a database.
 */
export function classifyNurtureRepair(seller) {
  const reasons = [];
  if (!seller.phone) return { action: "REVIEW", reasons: ["no_valid_phone"] };

  const optOut =
    seller.thread?.is_suppressed === true ||
    BLOCKING_CONTACTABILITY.has(lower(seller.thread?.contactability_status)) ||
    seller.deal_thread?.opt_out === true ||
    seller.active_suppressions > 0 ||
    seller.opt_out_events > 0;
  if (optOut) return { action: "BLOCKED_OPT_OUT", reasons: ["opt_out_or_suppression_evidence"] };

  if (seller.opportunity && lower(seller.opportunity.latest_intent) !== "not_interested") {
    return { action: "REVIEW", reasons: [`latest_intent_${lower(seller.opportunity.latest_intent) || "missing"}`] };
  }
  if (seller.inbound_after_not_interested > 0) {
    return { action: "REVIEW", reasons: ["seller_replied_after_not_interested"] };
  }

  const fixStatus = lower(seller.opportunity?.opportunity_status) === "suppressed";
  const needFollowUp = seller.live_nurture_rows === 0;
  if (!fixStatus && !needFollowUp) return { action: "ALREADY_OK", reasons: [] };

  if (!seller.opportunity && seller.first_nurture_day === LEGACY_COHORT_DAY) {
    return { action: "LEGACY_JUL01", reasons: ["jul01_backfill_cohort_no_deal"], fixStatus: false, needFollowUp };
  }
  if (fixStatus) reasons.push("status_suppressed_to_nurture");
  if (needFollowUp) reasons.push("schedule_nurture_follow_up");
  return { action: "REPAIR", reasons, fixStatus, needFollowUp };
}

async function loadPopulation(db) {
  // A. deals moved to `suppressed` by a not-interested nurture transition.
  const { data: hist, error: histErr } = await db
    .from("acquisition_opportunity_history")
    .select("opportunity_id,reason,created_at")
    .eq("field_name", "opportunity_status")
    .eq("new_value", "suppressed")
    .like("reason", "%NOT_INTERESTED_NURTURE%");
  if (histErr) throw histErr;
  const oppIds = [...new Set((hist || []).map((h) => h.opportunity_id))];
  const notInterestedAt = new Map();
  for (const h of hist || []) {
    const prev = notInterestedAt.get(h.opportunity_id);
    if (!prev || h.created_at > prev) notInterestedAt.set(h.opportunity_id, h.created_at);
  }
  const opps = [];
  for (let i = 0; i < oppIds.length; i += 200) {
    const { data, error } = await db
      .from("acquisition_opportunities")
      .select("id,primary_thread_key,primary_property_id,master_owner_id,opportunity_status,latest_intent,acquisition_stage,version")
      .in("id", oppIds.slice(i, i + 200));
    if (error) throw error;
    opps.push(...(data || []));
  }

  // B. threads whose nurture_not_interested follow-up was cancelled by the
  //    stage rule or the gap-recovery sweep.
  const { data: cancelled, error: qErr } = await db
    .from("send_queue")
    .select("id,thread_key,property_id,master_owner_id,created_at,guard_reason,metadata")
    .eq("queue_status", "cancelled")
    .eq("use_case_template", "nurture_not_interested")
    .limit(5000);
  if (qErr) throw qErr;
  const killedRows = (cancelled || []).filter(
    (r) => r.guard_reason === "not_interested" || r.metadata?.cancelled_by === "seller_execution_gap_recovery"
  );

  const byPhone = new Map();
  const ensure = (phone) => {
    if (!byPhone.has(phone)) byPhone.set(phone, { phone, opportunity: null, not_interested_at: null, killed_rows: [] });
    return byPhone.get(phone);
  };
  for (const o of opps) {
    const phone = e164(o.primary_thread_key);
    const s = ensure(phone || `invalid:${o.id}`);
    s.phone = phone;
    s.opportunity = o;
    s.not_interested_at = notInterestedAt.get(o.id) || null;
  }
  for (const r of killedRows) {
    const phone = e164(r.thread_key);
    if (!phone) continue;
    const s = ensure(phone);
    s.killed_rows.push(r);
    if (!s.not_interested_at || r.created_at > s.not_interested_at) s.not_interested_at = r.created_at;
  }
  return [...byPhone.values()];
}

export async function hydrate(db, s) {
  if (!s.phone) return s;
  const variants = phoneVariants(s.phone);
  const orPhone = variants.map((v) => `phone_e164.eq.${v}`).concat(variants.map((v) => `phone_number.eq.${v}`)).join(",");

  const [thread, dealThread, sup, events, nurture] = await Promise.all([
    db.from("inbox_thread_state").select("thread_key,is_suppressed,contactability_status,prospect_id,status").in("thread_key", variants).limit(1).maybeSingle(),
    db.from("deal_thread_state").select("thread_key,opt_out").in("thread_key", variants).limit(1).maybeSingle(),
    db.from("sms_suppression_list").select("id,is_active").or(orPhone),
    db.from("message_events").select("id,direction,is_opt_out,detected_intent,message_body,created_at").in("from_phone_number", variants).eq("direction", "inbound").order("created_at", { ascending: false }).limit(200),
    db.from("send_queue").select("id,queue_status,sent_at,created_at,dedupe_key").in("thread_key", variants).eq("use_case_template", "nurture_not_interested").limit(50),
  ]);
  for (const r of [thread, dealThread, sup, events, nurture]) if (r.error) throw r.error;

  const inbound = events.data || [];
  const since = s.not_interested_at ? Date.parse(s.not_interested_at) + 2 * 60 * 1000 : Infinity;
  s.thread = thread.data || null;
  s.deal_thread = dealThread.data || null;
  s.active_suppressions = (sup.data || []).filter((r) => r.is_active !== false).length;
  s.opt_out_events = inbound.filter(
    (m) => m.is_opt_out === true || COMPLIANCE_TERMINAL_INTENTS.has(lower(m.detected_intent)) || lower(m.message_body) === "stop"
  ).length;
  s.inbound_after_not_interested = inbound.filter((m) => Date.parse(m.created_at) > since).length;
  const rows = nurture.data || [];
  s.live_nurture_rows = rows.filter((r) => !r.sent_at && LIVE_STATUSES.includes(lower(r.queue_status))).length;
  const first = rows.map((r) => r.created_at).sort()[0];
  s.first_nurture_day = first ? first.slice(0, 10) : null;
  return s;
}

/**
 * ONE statement, ONE transaction: the guarded status (and optional stage)
 * change and its audit row land together or not at all. A writable CTE is a
 * single statement, so Postgres applies both or neither; the explicit
 * BEGIN/COMMIT adds a post-check that refuses (ROLLBACK) if the change landed
 * without its audit row. Idempotent: the guard (`from_status`, optional
 * `from_stage`) matches nothing once applied, and the audit insert is keyed by
 * a UNIQUE idempotency_key (`on conflict do nothing`).
 *
 * @param {import('pg').PoolClient|import('pg').Client} pgClient
 * @returns {Promise<{updated:number, audited:number}>}
 */
export const ATOMIC_STATUS_TRANSITION_SQL = `
  with upd as (
    update public.acquisition_opportunities o
       set opportunity_status  = $3,
           acquisition_stage   = coalesce($5, o.acquisition_stage),
           stage_entered_at    = case when $5 is not null and $5 is distinct from o.acquisition_stage then now() else o.stage_entered_at end,
           last_updated_source = $6,
           last_updated_by     = $6,
           metadata            = coalesce(o.metadata, '{}'::jsonb) || $9::jsonb,
           version             = coalesce(o.version, 0) + 1,
           updated_at          = now()
     where o.id = $1::uuid
       and o.opportunity_status = $2
       and ($4::text is null or o.acquisition_stage = $4)
    returning o.id
  ), ins as (
    insert into public.acquisition_opportunity_history
      (opportunity_id, event_type, field_name, previous_value, new_value, reason, actor, source, idempotency_key, metadata, created_at)
    select upd.id, 'status_change', 'opportunity_status', $2, $3, $7, $6, $6, $8, $9::jsonb, now() from upd
    on conflict (idempotency_key) do nothing
    returning id
  )
  select (select count(*) from upd)::int as updated, (select count(*) from ins)::int as audited`;

export async function applyStatusTransitionAtomic(pgClient, t) {
  await pgClient.query("begin");
  try {
    await pgClient.query("set local lock_timeout = '5s'");
    await pgClient.query("set local statement_timeout = '30s'");
    const { rows } = await pgClient.query(ATOMIC_STATUS_TRANSITION_SQL, [
      t.opportunity_id,
      t.from_status,
      t.to_status,
      t.from_stage ?? null,
      t.to_stage ?? null,
      t.source,
      t.reason,
      t.idempotency_key,
      JSON.stringify(t.metadata || {}),
    ]);
    const r = rows[0] || { updated: 0, audited: 0 };
    if (r.updated !== r.audited) {
      // e.g. the idempotency key already exists from another path: never leave
      // a change without its own audit row.
      throw new Error(`atomic_status_transition_mismatch updated=${r.updated} audited=${r.audited}`);
    }
    await pgClient.query("commit");
    return r;
  } catch (error) {
    await pgClient.query("rollback").catch(() => {});
    throw error;
  }
}

export async function openRepairPgClient() {
  const { default: pg } = await import("pg");
  const { resolveDatabaseUrl } = await import("../src/lib/postgres/resolve-database-url.js");
  const url = resolveDatabaseUrl();
  if (!url) throw new Error("--apply needs a database URL (SUPABASE_DB_URL / DATABASE_URL) for the atomic status+audit write");
  const client = new pg.Client({ connectionString: url, ssl: url.includes("localhost") ? false : { rejectUnauthorized: false } });
  await client.connect();
  return client;
}

async function applyRepair(db, s, decision, scheduleFollowUp, pgClient) {
  const out = { status_fixed: false, follow_up: null };
  if (decision.fixStatus && s.opportunity) {
    const r = await applyStatusTransitionAtomic(pgClient, {
      opportunity_id: s.opportunity.id,
      from_status: "suppressed", // status guard: never clobber a newer state
      to_status: "nurture",
      source: REPAIR_SOURCE,
      reason: "not_interested_is_30_day_follow_up",
      idempotency_key: `${REPAIR_SOURCE}:${s.opportunity.id}`,
      metadata: { rule: "A not interested is a 30 day follow up (owner, 2026-09-30)" },
    });
    out.status_fixed = r.updated === 1;
  }
  if (decision.needFollowUp) {
    out.follow_up = await scheduleFollowUp(
      "not_interested",
      s.phone,
      {
        source: REPAIR_SOURCE,
        inbound_message_event_id: REPAIR_SOURCE, // cycle id: re-runs stay idempotent
        master_owner_id: s.opportunity?.master_owner_id || s.killed_rows[0]?.master_owner_id || null,
        property_id: s.opportunity?.primary_property_id || s.killed_rows[0]?.property_id || null,
      },
      db
    );
  }
  return out;
}

async function main() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");
  const db = createClient(url, key, { auth: { persistSession: false } });

  const population = await loadPopulation(db);
  const report = [];
  for (const s of population) {
    await hydrate(db, s);
    const decision = classifyNurtureRepair(s);
    report.push({
      thread_key: s.phone,
      opportunity_id: s.opportunity?.id || null,
      property_id: s.opportunity?.primary_property_id || s.killed_rows[0]?.property_id || null,
      prospect_id: s.thread?.prospect_id || null,
      opportunity_status: s.opportunity?.opportunity_status || null,
      latest_intent: s.opportunity?.latest_intent || null,
      killed_follow_ups: s.killed_rows.length,
      live_nurture_rows: s.live_nurture_rows,
      opt_out_evidence: decision.action === "BLOCKED_OPT_OUT",
      inbound_after_not_interested: s.inbound_after_not_interested,
      action: decision.action,
      reasons: decision.reasons,
      _decision: decision,
      _seller: s,
    });
  }

  const counts = report.reduce((acc, r) => ({ ...acc, [r.action]: (acc[r.action] || 0) + 1 }), {});
  const printable = report.map(({ _decision, _seller, ...row }) => row);

  if (APPLY) {
    const { scheduleFollowUp } = await import("../src/lib/domain/seller-flow/seller-followup-scheduler.js");
    const pgClient = await openRepairPgClient();
    let done = 0;
    try {
      for (const r of report) {
        const eligible = r.action === "REPAIR" || (INCLUDE_LEGACY && r.action === "LEGACY_JUL01");
        if (!eligible || done >= LIMIT) continue;
        const decision = r.action === "LEGACY_JUL01" ? { fixStatus: false, needFollowUp: r._decision.needFollowUp } : r._decision;
        r.result = await applyRepair(db, r._seller, decision, scheduleFollowUp, pgClient);
        done += 1;
      }
    } finally {
      await pgClient.end().catch(() => {});
    }
    console.log(`[apply] repaired ${done} seller(s)`);
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ mode: APPLY ? "apply" : "dry_run", counts, sellers: printable }, null, 2));
  } else {
    console.log(`mode: ${APPLY ? "APPLY" : "DRY RUN (no writes; pass --apply to write)"}`);
    console.log("counts:", counts);
    console.table(
      printable.map((r) => ({
        thread: r.thread_key,
        property: r.property_id,
        status: r.opportunity_status,
        killed: r.killed_follow_ups,
        live: r.live_nurture_rows,
        later_in: r.inbound_after_not_interested,
        action: r.action,
        why: r.reasons.join(","),
      }))
    );
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invokedDirectly) {
  main().catch((error) => {
    console.error("[repair-not-interested-nurture] failed:", error?.message || error);
    process.exitCode = 1;
  });
}
