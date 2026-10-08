// ROUND 10 · QUEUE RECONCILIATION (read-only, dry run) — 2026-10-08.
// Run BEFORE dispatch resumes.
//
// Lists every unsent send_queue row whose recipient is now suppressed:
//   - sms_suppression_list: active global row, or an active pair row whose
//     sender_phone_e164 is the row's from number
//   - automation_suppressions: active (status active/suppressed, not expired)
//   - inbox_thread_state: is_suppressed, or disposition / contactability opt_out
// and, separately, round-10 SUPPRESSION CANDIDATES (latest inbound since
// --since matches classify.js matchesRepeatNoContactFrustration) whose pending
// sends the new executor would hold.
//
// Cancellation goes through the CANONICAL path: cancelSupabasePendingOutbound
// (policy COMPLIANCE_TERMINAL) is called with dry_run:true on a read-only
// adapter (writes throw), so the would-cancel ids are exactly what the
// canonical function selects. A PROPOSED SQL DO block mirroring that
// function's update (v_commit false, CAS on status + sent_at) is written for
// the owner; rows in statuses the canonical path does not cancel (paused_*,
// retry, blocked_*) are listed separately because they can resume.
//
//   DATABASE_URL=... node --import ./tests/register-aliases.mjs \
//     scripts/ops/r10-safety/reconcile-suppressed-queue.mjs --since=2026-10-01 --out=<dir>
import { connectReadOnly, phoneRef, e164, arg, writeOut, csv, roSupabase } from "./_ro-db.mjs";
import { CANCELLABLE_QUEUE_STATUSES, TERMINAL_QUEUE_OUTCOMES } from "@/lib/domain/compliance/canonical-no-contact-states.js";
import { cancelSupabasePendingOutbound, CANCELLATION_POLICIES } from "@/lib/domain/queue/cancel-supabase-pending-outbound.js";
import { matchesRepeatNoContactFrustration } from "@/lib/domain/classification/classify.js";

const OUT = arg("out");
const SINCE = arg("since", "2026-10-01T00:00:00Z");
if (!OUT) {
  console.error("usage: --out=<dir> [--since=<iso>]");
  process.exit(2);
}
const db = await connectReadOnly();
const TERMINAL = [...TERMINAL_QUEUE_OUTCOMES, "expired"];
const { rows: unsent } = await db.query(
  `select id::text, to_phone_number, from_phone_number, thread_key, queue_status, coalesce(type, message_type) kind,
          campaign_id::text, created_at, scheduled_for
     from send_queue
    where sent_at is null and not (lower(queue_status) = any($1::text[]))`,
  [TERMINAL],
);
const phones = [...new Set(unsent.map((r) => e164(r.to_phone_number || r.thread_key)).filter(Boolean))];

const sup = new Map(); // phone -> Set(source)
const add = (p, s) => { if (!p) return; if (!sup.has(p)) sup.set(p, new Set()); sup.get(p).add(s); };
const variants = phones.flatMap((p) => [p, p.slice(1), p.slice(2)]);
const { rows: list } = await db.query(
  `select phone_e164, sender_phone_e164 from sms_suppression_list where is_active and phone_e164 = any($1)`, [variants]);
const pairOnly = new Map();
for (const r of list) {
  const p = e164(r.phone_e164);
  if (!r.sender_phone_e164) add(p, "sms_suppression_list");
  else { if (!pairOnly.has(p)) pairOnly.set(p, new Set()); pairOnly.get(p).add(e164(r.sender_phone_e164)); }
}
const { rows: auto } = await db.query(
  `select phone_e164 from automation_suppressions
    where phone_e164 = any($1) and lower(coalesce(status,'')) in ('active','suppressed','applied')
      and (expires_at is null or expires_at > now())`, [variants]);
for (const r of auto) add(e164(r.phone_e164), "automation_suppressions");
const { rows: thr } = await db.query(
  `select coalesce(canonical_e164, thread_key) phone, is_suppressed, disposition, contactability_status
     from inbox_thread_state
    where (canonical_e164 = any($1) or thread_key = any($1))
      and (is_suppressed is true or lower(coalesce(disposition,'')) in ('suppressed','opt_out')
           or lower(coalesce(contactability_status,'')) in ('opt_out','opted_out','suppressed','do_not_contact'))`, [variants]);
for (const r of thr) add(e164(r.phone), "thread_suppressed");

// Round-10 suppression candidates: latest inbound per phone since --since.
const { rows: inbound } = await db.query(
  `select distinct on (from_phone_number) from_phone_number, message_body, created_at
     from message_events where direction = 'inbound' and created_at >= $1
    order by from_phone_number, created_at desc`, [SINCE]);
const candidates = new Set();
for (const r of inbound) if (matchesRepeatNoContactFrustration(r.message_body || "")) candidates.add(e164(r.from_phone_number));

const rowsFor = (p) => unsent.filter((r) => e164(r.to_phone_number || r.thread_key) === p);
const suppressedRows = [];
for (const r of unsent) {
  const p = e164(r.to_phone_number || r.thread_key);
  const sources = new Set(sup.get(p) || []);
  if (pairOnly.has(p) && pairOnly.get(p).has(e164(r.from_phone_number))) sources.add("sms_suppression_list_pair");
  if (sources.size) suppressedRows.push({ ...r, phone: p, sources: [...sources].join("|") });
}

// Canonical dry run, one scope per recipient.
const supabase = roSupabase(db);
const wouldCancel = new Set();
const perRecipient = [];
const recipients = [...new Set([...suppressedRows.map((r) => r.phone), ...[...candidates].filter((p) => rowsFor(p).length)])];
for (const p of recipients) {
  const res = await cancelSupabasePendingOutbound(
    {
      thread_key: p,
      to_phone_number: p,
      policy: CANCELLATION_POLICIES.COMPLIANCE_TERMINAL,
      reason: candidates.has(p) && !sup.has(p) ? "suppression_candidate_hold" : "queue_reconciliation_suppressed_recipient",
      suppression_reason: candidates.has(p) && !sup.has(p) ? "suppression_candidate" : "suppressed_recipient",
      cancelled_by: "r10_queue_reconciliation",
      dry_run: true,
    },
    { supabase },
  );
  for (const id of res.would_cancel_ids || []) wouldCancel.add(id);
  perRecipient.push({ phone_ref: phoneRef(p), candidate: candidates.has(p) && !sup.has(p), would_cancel: (res.would_cancel_ids || []).length, reason: res.reason || null });
}
await db.end();

const cancellable = new Set(CANCELLABLE_QUEUE_STATUSES);
const lines = ["queue_row_id,phone_ref,queue_status,kind,campaign_id,scheduled_for,sources,canonical_would_cancel,note"];
const notCancellable = [];
for (const r of suppressedRows) {
  const would = wouldCancel.has(r.id);
  const note = would ? "cancel" : cancellable.has(String(r.queue_status).toLowerCase()) ? "cancellable_status_but_not_selected" : "status_outside_canonical_cancellable_set_can_resume";
  if (!would) notCancellable.push(r);
  lines.push([r.id, phoneRef(r.phone), r.queue_status, r.kind, r.campaign_id || "", r.scheduled_for?.toISOString?.() || "", r.sources, would, note].map(csv).join(","));
}
const candRows = [...candidates].flatMap((p) => rowsFor(p).map((r) => ({ ...r, phone: p })));
for (const r of candRows) {
  if (suppressedRows.some((x) => x.id === r.id)) continue;
  lines.push([r.id, phoneRef(r.phone), r.queue_status, r.kind, r.campaign_id || "", r.scheduled_for?.toISOString?.() || "", "suppression_candidate", wouldCancel.has(r.id), wouldCancel.has(r.id) ? "hold" : "status_outside_canonical_cancellable_set_can_resume"].map(csv).join(","));
}
writeOut(OUT, "r10-queue-reconciliation.csv", lines.join("\n") + "\n");

const ids = [...wouldCancel];
const sql = `-- PROPOSED (round 10, 2026-10-08) — DO NOT APPLY WITHOUT OWNER APPROVAL.
-- Cancels the ${ids.length} unsent send_queue rows whose recipient is suppressed
-- (or a round-10 suppression candidate), exactly as the canonical
-- cancelSupabasePendingOutbound(policy=compliance_terminal) would: same status
-- set, same metadata keys. Selected by that function's own dry run
-- (scripts/ops/r10-safety/reconcile-suppressed-queue.mjs). CAS: a row is touched
-- only while it is still unsent and in a cancellable status.
-- v_commit false = report only (raises the count, rolls back).
do $$
declare
  v_commit boolean := false;
  v_ids uuid[] := array[${ids.map((i) => `'${i}'`).join(",") || ""}]::uuid[];
  v_n int;
begin
  update send_queue
     set queue_status = 'cancelled', is_locked = false, locked_at = null, lock_token = null, updated_at = now(),
         metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'skip_reason', 'queue_reconciliation_suppressed_recipient',
           'cancellation_reason', 'queue_reconciliation_suppressed_recipient',
           'suppression_reason', 'suppressed_recipient',
           'cancelled_by', 'r10_queue_reconciliation',
           'cancelled_at', now(), 'compliance_cancelled_at', now(),
           'finalized_at', now(), 'final_queue_status', 'cancelled')
   where id = any(v_ids) and sent_at is null
     and queue_status = any(array[${[...CANCELLABLE_QUEUE_STATUSES].map((s) => `'${s}'`).join(",")}]);
  get diagnostics v_n = row_count;
  raise notice 'r10 queue reconciliation: % rows cancelled (commit=%)', v_n, v_commit;
  if not v_commit then raise exception 'r10 dry run: % rows would be cancelled; rolled back', v_n; end if;
end $$;
`;
const resumable = notCancellable.map((r) => r.id);
const sql2 = resumable.length
  ? `
-- OWNER DECISION (not the canonical path): ${resumable.length} row(s) to suppressed
-- recipients sit in statuses the canonical cancellation does not touch
-- (${[...new Set(notCancellable.map((r) => r.queue_status))].join(", ")}). They cannot send
-- while held there, but they CAN resume if an operator / guard releases them.
-- Same metadata, same CAS on the row's CURRENT status. v_commit false.
do $$
declare
  v_commit boolean := false;
  v_ids uuid[] := array[${resumable.map((i) => `'${i}'`).join(",")}]::uuid[];
  v_n int;
begin
  update send_queue
     set queue_status = 'cancelled', is_locked = false, locked_at = null, lock_token = null, updated_at = now(),
         metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'skip_reason', 'queue_reconciliation_suppressed_recipient',
           'cancellation_reason', 'queue_reconciliation_suppressed_recipient',
           'suppression_reason', 'suppressed_recipient',
           'cancelled_by', 'r10_queue_reconciliation',
           'previous_queue_status', queue_status,
           'cancelled_at', now(), 'compliance_cancelled_at', now(),
           'finalized_at', now(), 'final_queue_status', 'cancelled')
   where id = any(v_ids) and sent_at is null
     and queue_status = any(array[${[...new Set(notCancellable.map((r) => `'${r.queue_status}'`))].join(",")}]);
  get diagnostics v_n = row_count;
  if not v_commit then raise exception 'r10 dry run (held rows): % rows would be cancelled; rolled back', v_n; end if;
end $$;
`
  : "";
writeOut(OUT, "PROPOSED-r10-queue-reconciliation-cancel.sql", sql + sql2);

const bySource = {};
for (const r of suppressedRows) for (const s of r.sources.split("|")) bySource[s] = (bySource[s] || 0) + 1;
const byStatus = {};
for (const r of suppressedRows) byStatus[r.queue_status] = (byStatus[r.queue_status] || 0) + 1;
const summary = {
  generated_at: new Date().toISOString(),
  unsent_nonterminal_rows: unsent.length,
  suppressed_recipient_rows: suppressedRows.length,
  suppressed_recipients: new Set(suppressedRows.map((r) => r.phone)).size,
  by_source: bySource,
  by_status: byStatus,
  canonical_would_cancel: ids.length,
  not_cancellable_by_canonical_path: notCancellable.length,
  not_cancellable_statuses: notCancellable.reduce((a, r) => ((a[r.queue_status] = (a[r.queue_status] || 0) + 1), a), {}),
  suppression_candidates: candidates.size,
  suppression_candidate_rows: candRows.length,
  per_recipient: perRecipient,
};
writeOut(OUT, "r10-queue-reconciliation.json", JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ ...summary, per_recipient: `${perRecipient.length} recipients (see json)` }, null, 1));
