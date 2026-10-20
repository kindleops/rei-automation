// Operations supervisor — deterministic checks (8.5.20 part C, Phases 1C + 11).
// No model. Every check reads one named source; a source that could not be read
// is `unavailable` (never ok, never 0). Recoverable issues become durable
// remediation work items; material exceptions escalate.
//
// RETRY SAFETY: a failed send whose provider never accepted it (no provider
// message id) is an internal failure — re-running it through the queue is a
// remediation. A send the provider ACCEPTED and then failed is never re-sent
// automatically (a duplicate text risk): it escalates to a person.
import { evaluateHealthSnapshot } from '../runtime/handlers/ops-health-check.js'

export const SUPERVISOR_VERSION = 'ops-supervisor.v1'
export const SUPERVISOR_THRESHOLDS = Object.freeze({
  delivery_rate_warn: 0.85,
  delivery_rate_critical: 0.7,
  delivery_min_sample: 50,
  opt_out_rate_warn: 0.03,
  opt_out_rate_critical: 0.06,
  opt_out_trend_warn: 1.5, // this week's rate ≥ 1.5 × last week's
  sender_failure_warn: 0.15,
  sender_min_sample: 50,
  campaign_min_delivered: 200,
  approval_oldest_warn_hours: 12,
  spend_day_warn_share: 0.8,
  action_center_stale_hours: 6,
  lost_warn: 1,
  lost_critical: 10,
  // 8.5.21-b
  valuation_offer_ready_warn_share: 0.5, // < 50 % of live opportunities offer-ready ⇒ warn
  valuation_missing_warn: 1,
  overdue_offers_warn: 1,
  research_failed_warn: 1,
  valuation_batch_stale_hours: 30,
})

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 10_000) / 10_000 : null)
const n = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)

function check(id, status, o = {}) {
  return { id, status, ...o }
}
const unavailable = (id, code, o = {}) => check(id, 'unavailable', { code, ...o })

/**
 * @param {object} i
 * @param {object|{unavailable:string}} i.snapshot      SUPERVISOR_SNAPSHOT_SQL row (or { unavailable: code })
 * @param {object|{unavailable:string}} [i.health]      agent.ops_health_snapshot
 * @param {object|{unavailable:string}} [i.actionCenter] { counts, active_queue, lost, computed_at }
 * @param {object|{unavailable:string}} [i.recovery]    latest recovery.batch summary { by_class, at }
 * @param {object|{unavailable:string}} [i.runtime]     { jobs: [{ kind, state }] } (24 h)
 * @param {object|{unavailable:string}} [i.spend]       { day_usd, cycle_usd, limits: { day_usd, cycle_usd } }
 * @param {Array|{unavailable:string}} [i.approvals]    pending approvals
 * @param {object|{unavailable:string}} [i.researchValuation]  8.5.21-b agent.ops_research_valuation_snapshot row
 * @param {object|{unavailable:string}} [i.valuationBatch]     8.5.21-b latest valuation.refresh_batch finding value (+ at)
 * @param {object|{unavailable:string}} [i.holds]              owner P0: active automation holds { count, by_type, items }
 * @param {object|{unavailable:string}} [i.followups]          P0 2026-10-17: public.v_followup_intent_health row (+ reasons)
 */
export function evaluateSupervisor({ snapshot, health = null, actionCenter = null, recovery = null, runtime = null, spend = null, approvals = null, researchValuation = null, valuationBatch = null, holds = null, followups = null, autoRecovery = null, now = Date.now(), thresholds = SUPERVISOR_THRESHOLDS } = {}) {
  const T = { ...SUPERVISOR_THRESHOLDS, ...thresholds }
  const checks = []
  const issues = []
  const snapOk = snapshot && !snapshot.unavailable
  const S = snapOk ? snapshot : null
  const add = (c, issue = null) => { checks.push(c); if (issue) issues.push({ check_id: c.id, ...issue }) }

  // 1 unhandled inbounds (the action center read model)
  if (!actionCenter || actionCenter.unavailable) add(unavailable('unhandled_inbounds', actionCenter?.unavailable || 'ACTION_CENTER_NOT_RUN'))
  else {
    const age = actionCenter.computed_at ? (now - Date.parse(actionCenter.computed_at)) / 3_600_000 : null
    if (age == null || age > T.action_center_stale_hours) add(unavailable('unhandled_inbounds', 'ACTION_CENTER_STALE', { computed_at: actionCenter.computed_at || null }))
    else {
      const lost = Number(actionCenter.lost || 0)
      const st = lost >= T.lost_critical ? 'critical' : lost >= T.lost_warn ? 'warn' : 'ok'
      add(check('unhandled_inbounds', st, { value: { needs_attention: actionCenter.counts?.needs_attention ?? null, lost, active_queue: actionCenter.active_queue ?? null }, source: 'agent.conversation_action_state' }),
        st === 'ok' ? null : { dedupe_key: 'supervisor:unhandled_inbounds', kind: 'remediation', severity: st === 'critical' ? 'critical' : 'warning', escalate: st === 'critical', recoverable: true, title: `${lost} conversation(s) with a seller message and no next action`, remediation: { action: 'assign_or_answer', where: 'Intelligence Command → Action Center (needs_attention, lost)' } })
    }
  }

  if (!S) {
    for (const id of ['followups_due_failed', 'failed_scheduled_messages', 'negotiations_progress', 'missing_valuations', 'hot_opportunities', 'queue_overdue', 'delivery_rate', 'opt_out_rate', 'sender_health', 'campaign_reply_rates', 'profitability', 'stage_stagnation']) add(unavailable(id, snapshot?.unavailable || 'SNAPSHOT_UNAVAILABLE'))
  } else {
    // 2 follow-ups due / failed
    const fu = S.followups || {}
    const expired = n(fu.expired_followup_dates) ?? 0
    const fsDue = n(fu.followup_state_due) ?? 0
    const fuFailed = n(S.queue?.followups_failed) ?? 0
    const fst = expired + fsDue + fuFailed > 0 ? 'warn' : 'ok'
    add(check('followups_due_failed', fst, { value: { expired_followup_dates: expired, followup_state_due: fsDue, followups_failed_24h: fuFailed }, source: 'public.inbox_thread_state + public.seller_followup_state + public.send_queue' }),
      fst === 'ok' ? null : { dedupe_key: 'supervisor:followups_due_failed', kind: 'remediation', severity: 'warning', recoverable: true, title: `${expired} expired follow-up date(s), ${fsDue} due cadence step(s), ${fuFailed} failed follow-up send(s) in 24 h`, remediation: { action: 'review_followups', note: 'Follow-ups resume only inside an approved program; nothing is re-sent automatically.' } })

    // 3 failed scheduled messages — internal vs provider-accepted
    const q = S.queue || {}
    const fi = n(q.failed_internal) ?? 0
    const fp = n(q.failed_provider) ?? 0
    const fst3 = fp > 0 ? 'critical' : fi > 0 ? 'warn' : 'ok'
    add(check('failed_scheduled_messages', fst3, { value: { failed_24h: n(q.failed) ?? 0, failed_internal: fi, failed_provider_accepted: fp, blocked_24h: n(q.blocked) ?? 0, paused_24h: n(q.paused) ?? 0, top_failure_reasons: q.top_failure_reasons || [] }, source: 'public.send_queue' }))
    if (fi > 0) issues.push({ check_id: 'failed_scheduled_messages', dedupe_key: 'supervisor:failed_internal_sends', kind: 'remediation', severity: 'warning', recoverable: true, title: `${fi} send(s) failed before the provider accepted them (24 h)`, remediation: { action: 'requeue_through_send_queue_after_review', retry_safe: true, note: 'No provider message id: the text never left. Re-queue through the normal queue path (every guard runs again).' } })
    // rc-8.5.21 v3: a send BLOCKED or PAUSED (an unhealthy / ineligible sender, a sender-continuity hold, an
    // unavailable eligibility read, a review hold) never disappears into a count: one operator item
    const bp = (n(q.blocked) ?? 0) + (n(q.paused) ?? 0)
    if (bp > 0) issues.push({ check_id: 'failed_scheduled_messages', dedupe_key: 'supervisor:blocked_or_paused_sends', kind: 'remediation', severity: 'warning', recoverable: true, title: `${n(q.blocked) ?? 0} send(s) blocked and ${n(q.paused) ?? 0} paused in 24 h (sender eligibility / holds): operator review`, remediation: { action: 'review_blocked_and_paused_rows', where: 'public.send_queue (guard_reason / paused_reason)', top_reasons: (q.top_failure_reasons || []).slice(0, 5) } })
    if (fp > 0) issues.push({ check_id: 'failed_scheduled_messages', dedupe_key: 'supervisor:failed_provider_accepted_sends', kind: 'escalation', severity: 'critical', escalate: true, recoverable: false, title: `${fp} send(s) failed AFTER the provider accepted them (24 h)`, remediation: { action: 'human_review', retry_safe: false, note: 'The provider accepted these: never re-send automatically (duplicate text risk).' } })

    // 4 negotiations progress, 5 missing valuations, 6 HOT, 14 stagnation
    const p = S.pipeline || {}
    const stalled = n(p.negotiations_stalled_7d) ?? 0
    add(check('negotiations_progress', stalled > 0 ? 'warn' : 'ok', { value: { negotiations: n(p.negotiations), stalled_7d: stalled }, source: 'public.acquisition_opportunities' }),
      stalled > 0 ? { dedupe_key: 'supervisor:negotiations_stalled', kind: 'remediation', severity: 'warning', recoverable: true, title: `${stalled} live negotiation(s) without activity for 7 days`, remediation: { action: 'set_next_action_or_research' } } : null)
    const mv = n(p.missing_valuation) ?? 0
    add(check('missing_valuations', mv > 0 ? 'warn' : 'ok', { value: { live_without_valuation: mv, live: n(p.live) }, source: 'public.acquisition_opportunities × public.property_acquisition_scores' }),
      mv > 0 ? { dedupe_key: 'supervisor:missing_valuations', kind: 'remediation', severity: 'warning', recoverable: true, title: `${mv} live opportunit(ies) without an acquisition score`, remediation: { action: 'run_decision_engine', note: 'ensurePropertyAcquisitionDecision; never a guessed value.' } } : null)
    const hotNo = n(p.hot_without_current_action) ?? 0
    add(check('hot_opportunities', hotNo > 0 ? 'critical' : 'ok', { value: { hot: n(p.hot), hot_without_current_action: hotNo, hot_threads: n(S.hot_threads) }, source: 'public.acquisition_opportunities' }),
      hotNo > 0 ? { dedupe_key: 'supervisor:hot_without_action', kind: 'escalation', severity: 'critical', escalate: true, recoverable: true, title: `${hotNo} HOT opportunit(ies) with no current next action`, remediation: { action: 'assign_now' } } : null)
    const stag = n(p.stagnant_14d) ?? 0
    add(check('stage_stagnation', stag > 0 ? 'warn' : 'ok', { value: { stagnant_14d: stag, live: n(p.live), by_stage: p.by_stage || {} }, source: 'public.acquisition_opportunities' }),
      stag > 0 ? { dedupe_key: 'supervisor:stage_stagnation', kind: 'remediation', severity: 'info', recoverable: true, title: `${stag} live opportunit(ies) in the same stage for 14+ days`, remediation: { action: 'pipeline_reconcile' } } : null)

    // 8 queue overdue (+ heartbeats below)
    const od = n(q.overdue_pending) ?? 0
    add(check('queue_overdue', od > 0 ? 'warn' : 'ok', { value: { overdue_pending: od, capped: od >= 1000 }, source: 'public.send_queue' }),
      od > 0 ? { dedupe_key: 'supervisor:queue_overdue', kind: 'remediation', severity: 'warning', recoverable: true, title: `${od} queued send(s) overdue by 15+ minutes`, remediation: { action: 'check_queue_processor_mode_and_heartbeat' } } : null)

    // 9 delivery rate
    const d = S.delivery || {}
    const sent24 = n(d.sent_24h) ?? 0
    const sent7 = n(d.sent_7d) ?? 0
    const r24 = pct(n(d.delivered_24h) ?? 0, sent24)
    const r7 = pct(n(d.delivered_7d) ?? 0, sent7)
    const rPrev = pct(n(d.delivered_prev_7d) ?? 0, n(d.sent_prev_7d) ?? 0)
    const judged = sent24 >= T.delivery_min_sample ? r24 : sent7 >= T.delivery_min_sample ? r7 : null
    const dst = judged == null ? 'unavailable' : judged < T.delivery_rate_critical ? 'critical' : judged < T.delivery_rate_warn ? 'warn' : 'ok'
    add(check('delivery_rate', dst, { value: { rate_24h: r24, sent_24h: sent24, rate_7d: r7, sent_7d: sent7, rate_prev_7d: rPrev, judged_on: sent24 >= T.delivery_min_sample ? '24h' : sent7 >= T.delivery_min_sample ? '7d' : null }, ...(dst === 'unavailable' ? { code: 'SAMPLE_TOO_SMALL' } : {}), source: 'public.send_queue' }),
      dst === 'warn' || dst === 'critical' ? { dedupe_key: 'supervisor:delivery_rate', kind: dst === 'critical' ? 'escalation' : 'remediation', severity: dst === 'critical' ? 'critical' : 'warning', escalate: dst === 'critical', recoverable: true, title: `Delivery rate ${Math.round(judged * 1000) / 10}%`, remediation: { action: 'inspect_sender_health_and_carrier_failures' } } : null)

    // 10 opt-out rate + trend (per delivered message)
    const ib = S.inbound || {}
    const oo7 = n(ib.opt_out_7d) ?? 0
    const ooPrev = n(ib.opt_out_prev_7d) ?? 0
    const del7 = n(d.delivered_7d) ?? 0
    const delPrev = n(d.delivered_prev_7d) ?? 0
    const rate7 = pct(oo7, del7)
    const ratePrev = pct(ooPrev, delPrev)
    const trend = rate7 != null && ratePrev != null && ratePrev > 0 ? Math.round((rate7 / ratePrev) * 100) / 100 : null
    const ost = del7 < T.delivery_min_sample ? 'unavailable' : rate7 >= T.opt_out_rate_critical ? 'critical' : rate7 >= T.opt_out_rate_warn || (trend != null && trend >= T.opt_out_trend_warn) ? 'warn' : 'ok'
    add(check('opt_out_rate', ost, { value: { opt_outs_7d: oo7, delivered_7d: del7, rate_7d: rate7, opt_outs_prev_7d: ooPrev, rate_prev_7d: ratePrev, trend_ratio: trend }, ...(ost === 'unavailable' ? { code: 'SAMPLE_TOO_SMALL' } : {}), source: 'public.message_events + public.send_queue' }),
      ost === 'warn' || ost === 'critical' ? { dedupe_key: 'supervisor:opt_out_rate', kind: ost === 'critical' ? 'escalation' : 'remediation', severity: ost === 'critical' ? 'critical' : 'warning', escalate: ost === 'critical', recoverable: true, title: `Opt-out rate ${rate7 == null ? '—' : `${Math.round(rate7 * 1000) / 10}%`} (trend ×${trend ?? '—'})`, remediation: { action: 'review_copy_and_audience' } } : null)

    // 11 sender routing / health
    const s = S.senders || {}
    const rates = Array.isArray(s.rates_7d) ? s.rates_7d : []
    const bad = rates.filter((r) => n(r.sent_7d) >= T.sender_min_sample && pct(n(r.failed_7d) ?? 0, n(r.sent_7d)) >= T.sender_failure_warn)
    const unmatched = n(s.unmatched_sent_7d) ?? 0
    const sst = bad.length || unmatched > 0 || (n(s.spam_flagged) ?? 0) > 0 ? 'warn' : 'ok'
    add(check('sender_health', sst, { value: { numbers: n(s.numbers), active: n(s.active), cooling: n(s.cooling), spam_flagged: n(s.spam_flagged), by_health_state: s.by_health_state || {}, high_failure_sender_ids: bad.map((r) => r.sender_id).filter(Boolean).slice(0, 10), unmatched_sent_7d: unmatched }, source: 'public.textgrid_numbers × public.send_queue' }),
      sst === 'warn' ? { dedupe_key: 'supervisor:sender_health', kind: 'remediation', severity: 'warning', recoverable: true, title: `${bad.length} sender(s) failing ≥ ${Math.round(T.sender_failure_warn * 100)}%, ${n(s.spam_flagged) ?? 0} spam-flagged, ${unmatched} send(s) from unregistered numbers`, remediation: { action: 'rotate_or_cool_senders', note: 'Routing changes go through the sender routing service; nothing is changed here.' } } : null)

    // 12 campaign qualified-reply rates
    const camps = (Array.isArray(S.campaigns_30d) ? S.campaigns_30d : []).map((c) => ({ campaign_id: c.campaign_id, status: c.status, delivered: n(c.delivered), threads: n(c.threads), replied_threads: n(c.replied_threads), qualified_threads: n(c.qualified_threads), reply_rate: pct(n(c.replied_threads) ?? 0, n(c.threads) ?? 0), qualified_rate: pct(n(c.qualified_threads) ?? 0, n(c.threads) ?? 0) }))
    const dead = camps.filter((c) => (c.delivered ?? 0) >= T.campaign_min_delivered && (c.qualified_threads ?? 0) === 0)
    add(check('campaign_reply_rates', !camps.length ? 'unavailable' : dead.length ? 'warn' : 'ok', { value: { campaigns: camps.slice(0, 10), zero_qualified_campaign_ids: dead.map((c) => c.campaign_id) }, ...(!camps.length ? { code: 'NO_CAMPAIGN_SENDS_30D' } : {}), source: 'public.send_queue × public.message_events × public.campaigns' }),
      dead.length ? { dedupe_key: 'supervisor:campaign_zero_qualified', kind: 'remediation', severity: 'info', recoverable: true, title: `${dead.length} campaign(s) with ${T.campaign_min_delivered}+ deliveries and no qualified reply (30 d)`, remediation: { action: 'review_campaign_targeting' } } : null)

    // 13 profitability (only where data exists)
    const rv = S.revenue || {}
    add((n(rv.closings_with_revenue) ?? 0) > 0
      ? check('profitability', 'ok', { value: { closings_with_revenue: n(rv.closings_with_revenue), confirmed_gross_revenue: n(rv.confirmed_gross_revenue) }, source: 'public.closing_cases' })
      : unavailable('profitability', 'NO_CLOSED_REVENUE_RECORDS', { value: { closing_cases: n(rv.closing_cases) }, source: 'public.closing_cases' }))
  }

  // 15 worker health (heartbeats + runtime jobs)
  if (!health || health.unavailable) add(unavailable('worker_heartbeats', health?.unavailable || 'HEALTH_SNAPSHOT_UNAVAILABLE'))
  else {
    let ev
    try { ev = evaluateHealthSnapshot(health) } catch { ev = null }
    if (!ev) add(unavailable('worker_heartbeats', 'HEALTH_SNAPSHOT_INVALID'))
    else {
      const stale = ev.heartbeats.filter((h) => h.status === 'stale' || h.status === 'missing' || h.status === 'unparseable')
      add(check('worker_heartbeats', stale.length ? 'critical' : 'ok', { value: { heartbeats: Object.fromEntries(ev.heartbeats.map((h) => [h.key, h.status])), modes: ev.modes }, source: 'public.system_control' }),
        stale.length ? { dedupe_key: 'supervisor:worker_heartbeats', kind: 'escalation', severity: 'critical', escalate: true, recoverable: true, title: `${stale.length} scheduler heartbeat(s) stale or missing: ${stale.map((h) => h.key).join(', ')}`, remediation: { action: 'check_cron_lanes' } } : null)
    }
  }
  if (!runtime || runtime.unavailable) add(unavailable('runtime_jobs', runtime?.unavailable || 'RUNTIME_UNAVAILABLE'))
  else {
    const failed = runtime.jobs.filter((j) => ['failed', 'dead_letter'].includes(j.state))
    const byKind = {}
    for (const j of failed) byKind[j.kind] = (byKind[j.kind] || 0) + 1
    add(check('runtime_jobs', failed.length ? 'warn' : 'ok', { value: { jobs_24h: runtime.jobs.length, failed_24h: failed.length, failed_by_kind: byKind }, source: 'agent.research_job' }),
      failed.length ? { dedupe_key: 'supervisor:runtime_failures', kind: 'remediation', severity: 'warning', recoverable: true, title: `${failed.length} runtime job(s) failed in 24 h`, remediation: { action: 'inspect_missions' } } : null)
  }
  // 15b rc-8.5.21 RUN-13: AI conversation turns stopped by the spend guard. The job is parked
  // budget_blocked (no composition, no fallback, no send) and its lease is gone, so no operator item can
  // be written under IT: the per-turn item (conversation:turn_budget_exhausted:<turn>) is raised by the
  // immediate budget-notice job under its own lease; THIS check is the aggregate backstop (reason
  // budget_exhausted) should a notice fail. The turn itself is finalized with BUDGET_EXHAUSTED and
  // re-scheduled, bounded (turn-engine.js onBudgetBlocked).
  if (!runtime || runtime.unavailable) add(unavailable('conversation_turn_budget', runtime?.unavailable || 'RUNTIME_UNAVAILABLE'))
  else {
    const blocked = runtime.jobs.filter((j) => j.kind === 'conversation.turn' && j.state === 'budget_blocked')
    const codes = {}
    for (const j of blocked) { const c = String(j.last_error?.code || j.error_code || 'budget_blocked'); codes[c] = (codes[c] || 0) + 1 }
    add(check('conversation_turn_budget', blocked.length ? 'warn' : 'ok', { value: { budget_blocked_24h: blocked.length, reason: blocked.length ? 'budget_exhausted' : null, by_code: codes }, source: 'agent.research_job (conversation.turn)' }),
      blocked.length ? { dedupe_key: 'supervisor:conversation_turn_budget_exhausted', kind: 'escalation', severity: 'warning', escalate: true, recoverable: true, title: `${blocked.length} AI conversation turn(s) blocked by the AI budget in 24 h (budget_exhausted): no reply composed, nothing sent`, remediation: { action: 'raise_ai_budget_then_requeue_budget_blocked_turn_jobs', reason: 'budget_exhausted', note: 'The turn is re-scheduled at most 3 times, an hour apart; an owner may raise the AI spend ceiling and requeue the parked conversation.turn jobs. Nothing is sent from here.' } } : null)
  }

  // 16 AI spend
  if (!spend || spend.unavailable) add(unavailable('ai_spend', spend?.unavailable || 'SPEND_UNAVAILABLE'))
  else {
    const cap = n(spend.limits?.day_usd)
    const share = cap ? Math.round((spend.day_usd / cap) * 1000) / 1000 : null
    const st = share != null && share >= T.spend_day_warn_share ? 'warn' : 'ok'
    add(check('ai_spend', st, { value: { day_usd: spend.day_usd, cycle_usd: spend.cycle_usd, day_cap_usd: cap, cycle_cap_usd: n(spend.limits?.cycle_usd), day_share: share }, source: 'agent.spend_ledger' }),
      st === 'warn' ? { dedupe_key: 'supervisor:ai_spend', kind: 'remediation', severity: 'warning', recoverable: true, title: `AI spend at ${Math.round(share * 100)}% of the daily cap`, remediation: { action: 'review_mission_schedules' } } : null)
  }

  // 17 approval backlog
  if (!Array.isArray(approvals)) add(unavailable('approval_backlog', approvals?.unavailable || 'APPROVALS_UNAVAILABLE'))
  else {
    const oldest = approvals.map((a) => a.created_at).filter(Boolean).sort()[0] || null
    const ageH = oldest ? Math.round(((now - Date.parse(oldest)) / 3_600_000) * 10) / 10 : null
    const st = ageH != null && ageH >= T.approval_oldest_warn_hours ? 'warn' : 'ok'
    const by = {}
    for (const a of approvals) by[a.capability_id] = (by[a.capability_id] || 0) + 1
    add(check('approval_backlog', st, { value: { pending: approvals.length, oldest_age_hours: ageH, by_capability: by }, source: 'agent.approval_request' }),
      st === 'warn' ? { dedupe_key: 'supervisor:approval_backlog', kind: 'remediation', severity: 'warning', recoverable: true, title: `${approvals.length} approval(s) pending, oldest ${ageH} h`, remediation: { action: 'decide_or_let_expire' } } : null)
  }

  // 7 recovery candidates (latest sweep)
  if (!recovery || recovery.unavailable) add(unavailable('recovery_candidates', recovery?.unavailable || 'RECOVERY_NOT_RUN'))
  else add(check('recovery_candidates', 'ok', { value: { by_class: recovery.by_class || {}, at: recovery.at || null, scanned: recovery.scanned ?? null, held: recovery.held ? { count: recovery.held.count, by_type: recovery.held.by_type } : null }, source: 'agent.finding (recovery.batch)' }))
  // owner P0: held items are REPORTED ("held: operator review"), never acted on — from the recovery batch and the hold registry
  const holdsRead = holds && !holds.unavailable ? holds : null
  if (!holdsRead && !(recovery && !recovery.unavailable && recovery.held)) add(unavailable('automation_holds', holds?.unavailable || 'AUTOMATION_HOLDS_UNAVAILABLE'))
  else {
    const byType = { ...(holdsRead?.by_type || {}) }
    for (const [k, v] of Object.entries(recovery?.held?.by_type || {})) byType[k] = Math.max(byType[k] || 0, v)
    const items = [...(holdsRead?.items || []), ...((recovery?.held?.items) || [])].slice(0, 20)
    add(check('automation_holds', 'ok', { value: { held_items: holdsRead?.count ?? recovery?.held?.count ?? 0, by_type: byType, items, action: 'report_only_never_act' }, source: holdsRead ? 'public.automation_holds' : 'agent.finding (recovery.batch held)' }))
  }

  // P0 2026-10-17: the follow-up execution lifecycle. A follow-up that cannot run is never "scheduled": stuck
  // intents (overdue planned, stale lease, ready rows past due, dispatch with no outcome) are remediation;
  // a failure the provider may have seen (after accept / ambiguous) is a person's decision (never re-sent).
  if (!followups || followups.unavailable) add(unavailable('followup_lifecycle', followups?.unavailable || 'FOLLOWUP_LIFECYCLE_UNAVAILABLE'))
  else {
    const f = (k) => Number(followups[k] || 0)
    const stuck = f('planned_overdue') + f('materializing_stale') + f('ready_overdue') + f('dispatched_stale')
    const review = f('failed_after_accept') + f('failed_ambiguous')
    // rc-8.5.21 v3 (RT-45 / RT-46 / RT-33): a HELD follow-up (language not enabled, an undeclared offer plan,
    // sender continuity, ...) needs a person — never a silent count
    const heldOnly = review === 0 && !(stuck + f('accepted_unconfirmed') > 0 || f('failed') > review) && f('held') > 0
    const st = review > 0 ? 'critical' : stuck + f('accepted_unconfirmed') > 0 || f('failed') > review ? 'warn' : heldOnly ? 'warn' : 'ok'
    const value = {
      scheduled_executable: f('scheduled_executable'), planned_overdue: f('planned_overdue'), materializing_stale: f('materializing_stale'), ready_overdue: f('ready_overdue'),
      dispatched_stale: f('dispatched_stale'), accepted_unconfirmed: f('accepted_unconfirmed'), delivered: f('delivered'), failed: f('failed'), failed_after_accept: f('failed_after_accept'),
      failed_ambiguous: f('failed_ambiguous'), held: f('held'), not_executable: f('not_executable'), not_executable_24h: f('not_executable_24h'), top_reasons: (followups.reasons || []).slice(0, 10),
    }
    add(check('followup_lifecycle', st, { value, source: 'public.v_followup_intent_health' }),
      st === 'ok' ? null : heldOnly
        ? { dedupe_key: 'supervisor:followup_held', kind: 'remediation', severity: 'warning', recoverable: true, title: `${f('held')} follow-up(s) HELD for a person (top reasons: ${(followups.reasons || []).slice(0, 3).map((r) => r?.reason || r?.code || r).join(', ') || 'see reasons'})`, remediation: { action: 'operator_review_held_followups', where: 'public.v_followup_intent_reasons' } }
        : review > 0
        ? { dedupe_key: 'supervisor:followup_review', kind: 'escalation', severity: 'critical', escalate: true, recoverable: false, title: `${review} follow-up(s) may have reached the seller and failed: review, never re-send automatically`, remediation: { action: 'human_review', retry_safe: false } }
        : { dedupe_key: 'supervisor:followup_stuck', kind: 'remediation', severity: 'warning', recoverable: true, title: `${stuck + f('accepted_unconfirmed')} follow-up(s) stuck (overdue / stale lease / no outcome); ${f('held')} held, ${f('not_executable_24h')} not executable in 24 h`, remediation: { action: 'run_followup_reconcile_report_then_review', where: 'public.v_followup_intent_reasons' } })
  }

  // rc-8.5.21 v3: AUTO-RECOVERY (born off; only when the wiring passes the source). The supervisor runs the
  // idempotent recovery sweeps — a stranded inbound (persisted, no decide job) gets exactly one job; a
  // delivered anchor whose next silence follow-up was never planned gets exactly one — and SURFACES
  // everything it could not recover (a failed sweep item, a processing row held for manual review after a
  // crash with an ambiguous provider outcome) as an escalated operator item. Never a send.
  if (autoRecovery) {
    if (autoRecovery.unavailable) add(unavailable('auto_recovery', autoRecovery.unavailable))
    else {
      const unrec = Array.isArray(autoRecovery.unrecoverable) ? autoRecovery.unrecoverable : []
      const value = {
        stranded_inbounds_recovered: Number(autoRecovery.inbound?.enqueued || 0), inbounds_examined: Number(autoRecovery.inbound?.examined || 0),
        missed_followups_recovered: Number(autoRecovery.followups?.scheduled || 0), anchors_examined: Number(autoRecovery.followups?.examined || 0),
        lease_manual_review: Number(autoRecovery.lease_manual_review || 0), unrecoverable: unrec.length, items: unrec.slice(0, 20),
      }
      const st = unrec.length ? 'warn' : 'ok'
      add(check('auto_recovery', st, { value, source: 'recovery sweeps (conversation inbound, delivered follow-up anchors, processing leases)' }),
        st === 'ok' ? null : { dedupe_key: 'supervisor:auto_recovery_unrecoverable', kind: 'escalation', severity: 'warning', escalate: true, recoverable: false, title: `${unrec.length} interrupted workflow(s) the supervisor could not recover: operator review`, remediation: { action: 'human_review', retry_safe: false, items: unrec.slice(0, 20) } })
    }
  }

  // ── 8.5.21-b: research status, valuation coverage, overdue offers, negotiation authority ──
  // 18 research status (property.research + valuation.refresh runtime jobs, 24 h)
  if (!runtime || runtime.unavailable) add(unavailable('research_status', runtime?.unavailable || 'RUNTIME_UNAVAILABLE'))
  else {
    const rj = runtime.jobs.filter((j) => j.kind === 'property.research' || j.kind === 'valuation.refresh')
    const by = {}
    for (const j of rj) by[`${j.kind}:${j.state}`] = (by[`${j.kind}:${j.state}`] || 0) + 1
    const failed = rj.filter((j) => ['failed', 'dead_letter', 'budget_blocked'].includes(j.state)).length
    const st = !rj.length ? 'unavailable' : failed >= T.research_failed_warn ? 'warn' : 'ok'
    add(check('research_status', st, { value: { jobs_24h: rj.length, by_kind_state: by, failed_or_blocked: failed }, ...(st === 'unavailable' ? { code: 'NO_RESEARCH_JOBS_24H' } : {}), source: 'agent.research_job (property.research, valuation.refresh)' }),
      st === 'warn' ? { dedupe_key: 'supervisor:research_failures', kind: 'remediation', severity: 'warning', recoverable: true, title: `${failed} research / valuation job(s) failed or budget-blocked in 24 h`, remediation: { action: 'inspect_research_jobs', note: 'A budget_blocked property.research job means its event budget is below one web call: raise the ceiling (owner) or run internal-only.' } } : null)
  }
  // 19 valuation coverage (live opportunities with an offer-ready engine row) + the latest dry run
  const RV = researchValuation && !researchValuation.unavailable ? researchValuation : null
  if (!RV?.valuation) add(unavailable('valuation_coverage', researchValuation?.unavailable || 'RESEARCH_VALUATION_SNAPSHOT_UNAVAILABLE'))
  else {
    const v = RV.valuation
    const live = n(v.live) ?? 0
    const ready = n(v.offer_ready) ?? 0
    const missing = n(v.missing) ?? 0
    const share = live > 0 ? Math.round((ready / live) * 1000) / 1000 : null
    const vb = valuationBatch && !valuationBatch.unavailable ? valuationBatch : null
    const batchAgeH = vb?.at ? Math.round(((now - Date.parse(vb.at)) / 3_600_000) * 10) / 10 : null
    const st = live === 0 ? 'ok' : (share != null && share < T.valuation_offer_ready_warn_share) || missing >= T.valuation_missing_warn ? 'warn' : 'ok'
    add(check('valuation_coverage', st, { value: { live, with_score: n(v.with_score), offer_ready: ready, offer_ready_share: share, missing, stale_30d: n(v.stale_30d), by_tier: v.by_tier || {}, last_dry_run: vb ? { at: vb.at || null, age_hours: batchAgeH, queued: n(vb.queued), gained_offer_ready: n(vb.gained_offer_ready), gained_valuation: n(vb.gained_valuation), mode: vb.mode || null } : null }, source: 'public.acquisition_opportunities × public.property_acquisition_scores (+ agent.finding valuation.refresh_batch)' }),
      st === 'warn' ? { dedupe_key: 'supervisor:valuation_coverage', kind: 'remediation', severity: 'warning', recoverable: true, title: `${ready}/${live} live opportunities offer-ready; ${missing} without an engine valuation`, remediation: { action: 'run_valuation_refresh_queue_dry_run', note: 'valuation.refresh (dry run) shows the coverage gain; production valuation writes need a separate owner approval.' } } : null)
  }
  // 20 overdue offers (sent > 72 h, no seller reply since, deal still live)
  if (!RV?.offers) add(unavailable('overdue_offers', researchValuation?.unavailable || 'RESEARCH_VALUATION_SNAPSHOT_UNAVAILABLE'))
  else {
    const od = n(RV.offers.overdue_no_reply_72h) ?? 0
    const st = od >= T.overdue_offers_warn ? 'warn' : 'ok'
    add(check('overdue_offers', st, { value: { sent_30d: n(RV.offers.sent_30d), overdue_no_reply_72h: od, opportunity_ids: (RV.offers.overdue_opportunity_ids || []).slice(0, 20) }, source: 'public.seller_offers × public.message_events' }),
      st === 'warn' ? { dedupe_key: 'supervisor:overdue_offers', kind: 'remediation', severity: 'warning', recoverable: true, title: `${od} offer(s) sent 72 h+ ago with no seller reply`, remediation: { action: 'offer_follow_up_inside_policy', note: 'An offer follow-up goes out only as an approved template inside the follow-up policy; nothing is sent from here.' } } : null)
  }
  // 21 negotiation authority (envelopes / send authorizations) — null tables = unavailable, never 0
  if (!RV?.negotiations) add(unavailable('negotiation_authority', researchValuation?.unavailable || 'RESEARCH_VALUATION_SNAPSHOT_UNAVAILABLE'))
  else {
    const ng = RV.negotiations
    const applied = ng.envelopes != null
    add(applied
      ? check('negotiation_authority', 'ok', { value: { in_negotiation_stage: n(ng.in_negotiation_stage), envelopes: n(ng.envelopes), live_envelopes: n(ng.live_envelopes), ledger_events_7d: n(ng.ledger_events_7d), send_authorizations: ng.send_authorizations == null ? null : n(ng.send_authorizations) }, source: 'public.negotiation_envelopes / _offer_events / _send_authorizations' })
      : unavailable('negotiation_authority', 'NEGOTIATION_TABLES_NOT_APPLIED', { value: { in_negotiation_stage: n(ng.in_negotiation_stage) }, source: 'public.negotiation_envelopes (PROPOSED 8.5.19)' }))
  }

  const counts = { ok: 0, warn: 0, critical: 0, unavailable: 0 }
  for (const c of checks) counts[c.status] += 1
  return {
    version: SUPERVISOR_VERSION,
    checks,
    issues: issues.map((i) => ({ severity: 'warning', escalate: false, ...i })),
    counts,
    // no false success: "all clear" requires every check to have been read
    all_clear: counts.warn === 0 && counts.critical === 0 && counts.unavailable === 0,
    escalations: issues.filter((i) => i.escalate).length,
  }
}
