// PROPOSED state correction: deals closed "dead" after a NOT INTERESTED (8.5.21-b, Phase 9).
//
// Locked seller policy: "No" to selling → a 30-day follow-up (nurture), never a closed deal.
// The 8.5.20 C live proof found 205 conversations classified previously_closed with
// closed_after_not_interested_policy_says_30_day_follow_up. This module produces a
// PROPOSED, REVERSIBLE, AUDITED correction plan — a dry-run list with ids and the exact change —
// and renders its apply / rollback SQL for owner review. NOTHING HERE APPLIES IT:
//   • buildNotInterestedCorrectionPlan() is pure (facts in, plan out);
//   • renderCorrectionSql() returns TEXT; its apply block is a DRY RUN unless the owner flips
//     v_commit := true by hand (it raises at the end otherwise, rolling everything back).
//
// THE CHANGE per opportunity (only if it still matches the plan's BEFORE state at apply time):
//   opportunity_status  dead / lost / closed … → 'nurture'
//   acquisition_stage   'closed' → the thread's last verified seller stage (else ownership_confirmation);
//                       any other stage is kept
//   next_action         'not_interested_30d_follow_up'
//   next_action_due     max(not-interested reply + 30 days, apply time)
//   version + 1, last_updated_source 'owner_state_correction_<tag>' (production columns), history rows
//   with idempotency keys (the history table's unique key) — a re-run never duplicates
// The correction does NOT queue or send a follow-up: the follow-up engine sends only inside an
// approved program (recovery RECOVERY_PROGRAMS.not_interested_30d_nurture) with permission verified.
// EXCLUDED: any stop / opt-out / suppression, wrong number, ownership denial (those are not
// "not interested"), a newer meaningful seller message (that is a reopen, not this plan).
import { classifyRecoveryCandidate } from './recovery-classifier.js'
import { STAGES, closedVerdict } from './conversation-facts.js'

export const DEAD_DEAL_CORRECTION_VERSION = 'dead-deal-correction.v1'
export const CORRECTION_NEXT_ACTION = 'not_interested_30d_follow_up'
const DAY = 86_400_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ms = (v) => { const t = Date.parse(String(v ?? '')); return Number.isFinite(t) ? t : null }

/**
 * @param {Array<object>} facts  normalizeConversationFacts() rows
 * @param {{ now?: number }} [o]
 */
export function buildNotInterestedCorrectionPlan(facts = [], { now = Date.now() } = {}) {
  const entries = []
  const skipped = {}
  const skip = (k) => { skipped[k] = (skipped[k] || 0) + 1 }
  const seenOpp = new Set()
  for (const f of facts) {
    const c = classifyRecoveryCandidate(f, { now, approved_programs: [] })
    // 8.5.21-b: a closed deal whose "No" was an OWNERSHIP denial (canonical ledger) is a property-scoped denial,
    // never a 30-day nurture — counted, kept out of the plan
    if (c.class === 'wrong_owner_or_number' && c.permission.blocks.includes('ownership_denied')) { const cv = closedVerdict(f); if (cv.closed && cv.after_not_interested) { skip('ownership_denied_property_scoped'); continue } }
    if (c.class !== 'previously_closed' || !c.reasons.includes('closed_after_not_interested_policy_says_30_day_follow_up')) continue
    const o = f.opportunity
    if (!o?.opportunity_id || !UUID.test(o.opportunity_id)) { skip('no_opportunity_id'); continue }
    if (seenOpp.has(o.opportunity_id)) { skip('duplicate_opportunity'); continue }
    if (!c.permission.permitted && (c.permission.suppression || c.permission.wrong_owner_or_number)) { skip('permission_block'); continue }
    seenOpp.add(o.opportunity_id)
    const niAt = ms(f.inbound.last_meaningful?.at) ?? ms(f.inbound.last?.at)
    const due = Math.max((niAt ?? now) + 30 * DAY, now)
    const sellerStage = STAGES.includes(String(f.thread.seller_stage || '')) && f.thread.seller_stage !== 'closed' ? f.thread.seller_stage : 'ownership_confirmation'
    const toStage = o.stage === 'closed' ? sellerStage : o.stage
    entries.push({
      opportunity_id: o.opportunity_id,
      conversation_id: f.conversation_id,
      property_ref: f.property_ref,
      before: { opportunity_status: o.status, acquisition_stage: o.stage, next_action: o.next_action, next_action_due: o.next_action_due },
      after: { opportunity_status: 'nurture', acquisition_stage: toStage, next_action: CORRECTION_NEXT_ACTION, next_action_due: new Date(due).toISOString() },
      due_now: due === now,
      policy: 'seller_policy:not_interested_is_30_day_follow_up',
      evidence_refs: c.evidence_refs.slice(0, 6),
      ownership: c.permission.ownership,
      ownership_evidence: f.ownership_evidence || 'none_read',
      followup_send: 'none_by_this_plan:follow_up_engine_inside_approved_program_only',
    })
  }
  const by_before_status = {}
  for (const e of entries) by_before_status[e.before.opportunity_status || 'null'] = (by_before_status[e.before.opportunity_status || 'null'] || 0) + 1
  return {
    version: DEAD_DEAL_CORRECTION_VERSION,
    status: 'PROPOSED_DRY_RUN_NOT_APPLIED',
    scope: 'historical_recovery_requires_its_own_owner_approved_scope (no bulk backfill)',
    generated_at: new Date(now).toISOString(),
    count: entries.length,
    by_before_status,
    stage_changes: entries.filter((e) => e.before.acquisition_stage !== e.after.acquisition_stage).length,
    due_now: entries.filter((e) => e.due_now).length,
    skipped,
    entries,
  }
}

const lit = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`)

/**
 * Apply / rollback SQL TEXT for owner review. The apply block snapshots every target row into an
 * audit table, applies the change ONLY where the row still matches the plan's before state, writes
 * history rows, and is a DRY RUN (raises → rolls back) unless v_commit is flipped to true by hand.
 * @param {object} plan  buildNotInterestedCorrectionPlan()
 * @param {{ tag?: string }} [o]  audit table suffix (yyyymmdd)
 */
export function renderCorrectionSql(plan, { tag = new Date().toISOString().slice(0, 10).replace(/-/g, '') } = {}) {
  if (!/^[0-9]{8}$/.test(tag)) throw new Error('tag must be yyyymmdd')
  const audit = `public._state_correction_not_interested_${tag}`
  const rows = plan.entries.map((e) => `(${lit(e.opportunity_id)}::uuid, ${lit(e.before.opportunity_status)}, ${lit(e.before.acquisition_stage)}, ${lit(e.after.opportunity_status)}, ${lit(e.after.acquisition_stage)}, ${lit(e.after.next_action)}, ${lit(e.after.next_action_due)}::timestamptz)`)
  const values = rows.length ? rows.join(',\n    ') : `(null::uuid, null, null, null, null, null, null::timestamptz)`
  const apply = `-- PROPOSED ONLY. NOT APPLIED. Owner approval required. Generated by ${DEAD_DEAL_CORRECTION_VERSION} at ${plan.generated_at}.
-- ${plan.count} opportunities closed after "not interested" → nurture + 30-day follow-up (seller policy).
-- DRY RUN unless v_commit is set to true below. Every target row is snapshotted into ${audit} first;
-- a row that changed since the plan (status or stage differs from BEFORE) is skipped, never forced.
-- Rollback: the companion rollback SQL restores the snapshot for rows still in the corrected state.
create table if not exists ${audit} (opportunity_id uuid primary key, before jsonb not null, applied_after jsonb, captured_at timestamptz not null default now());
alter table ${audit} enable row level security;
revoke all on ${audit} from anon, authenticated;
do $correction$
declare
  v_commit boolean := false; -- DRY RUN unless flipped to true by the owner
  v_now timestamptz := now();
  v_applied int;
begin
  create temporary table _plan (opportunity_id uuid primary key, from_status text, from_stage text, to_status text, to_stage text, to_next_action text, to_due timestamptz) on commit drop;
  insert into _plan values
    ${values};
  delete from _plan where opportunity_id is null;
  insert into ${audit} (opportunity_id, before)
    select o.id, to_jsonb(o) from public.acquisition_opportunities o join _plan p on p.opportunity_id = o.id
    on conflict (opportunity_id) do nothing;
  with updated as (
    update public.acquisition_opportunities o set
      opportunity_status = p.to_status,
      acquisition_stage = p.to_stage,
      stage_entered_at = case when p.to_stage is distinct from p.from_stage then v_now else o.stage_entered_at end,
      next_action = p.to_next_action,
      next_action_due = p.to_due,
      last_updated_source = 'owner_state_correction_${tag}',
      version = coalesce(o.version, 1) + 1,
      updated_at = v_now
    from _plan p
    where o.id = p.opportunity_id and o.opportunity_status is not distinct from p.from_status and o.acquisition_stage is not distinct from p.from_stage
    returning o.id, p.from_status, p.from_stage, p.to_status, p.to_stage
  ), hist as (
    insert into public.acquisition_opportunity_history (opportunity_id, event_type, field_name, previous_value, new_value, reason, actor, source, idempotency_key, metadata)
    select u.id, 'opportunity_status_changed', 'opportunity_status', u.from_status, u.to_status, 'seller_policy_not_interested_is_30_day_follow_up', 'owner_state_correction_${tag}', '${DEAD_DEAL_CORRECTION_VERSION}', 'state-correction-ni-${tag}:status:' || u.id, jsonb_build_object('correction', 'not_interested_30d_${tag}')
      from updated u
    union all
    select u.id, 'stage_transition', 'acquisition_stage', u.from_stage, u.to_stage, 'seller_policy_not_interested_is_30_day_follow_up', 'owner_state_correction_${tag}', '${DEAD_DEAL_CORRECTION_VERSION}', 'state-correction-ni-${tag}:stage:' || u.id, jsonb_build_object('correction', 'not_interested_30d_${tag}')
      from updated u where u.to_stage is distinct from u.from_stage
    returning 1
  )
  update ${audit} a set applied_after = jsonb_build_object('opportunity_status', u.to_status, 'acquisition_stage', u.to_stage, 'applied_at', v_now)
    from updated u where a.opportunity_id = u.id;
  select count(*) into v_applied from ${audit} where applied_after is not null;
  raise notice 'state correction: % of % planned rows applied', v_applied, (select count(*) from _plan);
  if not v_commit then raise exception 'DRY RUN: % rows would change (set v_commit := true to apply)', v_applied; end if;
end
$correction$;
`
  const rollback = `-- PROPOSED ONLY. Rollback of the not-interested state correction ${tag}: restores the snapshot in ${audit}
-- for every row still in the corrected state (a row an operator changed since is left alone and listed).
do $rollback$
declare v_now timestamptz := now(); v_restored int;
begin
  with restored as (
    update public.acquisition_opportunities o set
      opportunity_status = a.before ->> 'opportunity_status',
      acquisition_stage = a.before ->> 'acquisition_stage',
      stage_entered_at = (a.before ->> 'stage_entered_at')::timestamptz,
      next_action = a.before ->> 'next_action',
      next_action_due = (a.before ->> 'next_action_due')::timestamptz,
      last_updated_source = coalesce(a.before ->> 'last_updated_source', 'system'),
      version = coalesce(o.version, 1) + 1,
      updated_at = v_now
    from ${audit} a
    where a.opportunity_id = o.id and a.applied_after is not null
      and o.opportunity_status is not distinct from a.applied_after ->> 'opportunity_status'
      and o.acquisition_stage is not distinct from a.applied_after ->> 'acquisition_stage'
    returning o.id, a.applied_after ->> 'opportunity_status' as from_status, a.before ->> 'opportunity_status' as to_status
  ), hist as (
    insert into public.acquisition_opportunity_history (opportunity_id, event_type, field_name, previous_value, new_value, reason, actor, source, idempotency_key, metadata)
    select r.id, 'opportunity_status_changed', 'opportunity_status', r.from_status, r.to_status, 'state_correction_${tag}_reverted', 'owner_state_correction_${tag}', '${DEAD_DEAL_CORRECTION_VERSION}', 'state-correction-ni-${tag}:revert:' || r.id || ':' || extract(epoch from v_now)::bigint, jsonb_build_object('correction_reverted', 'not_interested_30d_${tag}')
      from restored r
    returning 1
  )
  update ${audit} a set applied_after = null from restored r where a.opportunity_id = r.id;
  get diagnostics v_restored = row_count;
  raise notice 'state correction rollback: % rows restored', v_restored;
end
$rollback$;
`
  return { audit_table: audit, apply_sql: apply, rollback_sql: rollback }
}
