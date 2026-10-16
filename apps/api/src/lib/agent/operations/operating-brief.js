// The owner's DAILY OPERATING BRIEF (8.5.20 part C) — built on the 8.5.18
// conversation.review_digest (missions / findings / shadow / approvals) plus the
// operations read model. Deterministic, no model.
//
// Every line carries links to its source records (ids only — never phones, names
// or message text). A source that could not be read makes its section
// `available: false` with a code: missing data is "unavailable", never 0.
export const BRIEF_VERSION = 'operating-brief.v1'
export const BRIEF_SECTIONS = Object.freeze([
  ['work_completed', 'Work completed'],
  ['new_viable_opportunities', 'New viable opportunities'],
  ['offers_prepared', 'Offers prepared'],
  ['negotiations_advanced', 'Negotiations advanced'],
  ['deals_awaiting_approval', 'Deals awaiting approval'],
  ['followups_completed', 'Follow-ups completed'],
  ['recovered_opportunities', 'Recovered opportunities'],
  ['campaign_sender_changes', 'Campaign / sender changes'],
  ['system_incidents', 'System incidents'],
  ['recommended_next_actions', 'Recommended next actions'],
])
const TITLE = Object.fromEntries(BRIEF_SECTIONS)
const LINK_MAX = 10

const unavail = (o) => !o || o.unavailable != null
const code = (o, fallback) => (o && o.unavailable) || fallback
const line = (label, value, links = [], extra = {}) => ({ label, value, links: links.slice(0, LINK_MAX), ...extra })
const section = (id, lines) => ({ id, title: TITLE[id], available: true, lines })
const missing = (id, c) => ({ id, title: TITLE[id], available: false, code: c, lines: [] })

/**
 * @param {object} i
 * @param {object} i.digest        buildDigest(...) of review-digest-handler.js (always present)
 * @param {Array|{unavailable:string}} [i.jobs]  the digest's job rows (job_id, kind, state) for links; { unavailable } ⇒ work completed is unavailable
 * @param {Array}  [i.approvals]   pending approvals (approval_id, capability_id, created_at)
 * @param {object} [i.facts]       BRIEF_FACTS_SQL row | { unavailable }
 * @param {object} [i.recovery]    { candidates: [{ conversation_id, class, priority }], scanned } | { unavailable }
 * @param {object} [i.workItems]   { resolved: [...], open: [...] } | { unavailable }
 * @param {object} [i.actionCenter] { counts, lost, active_queue, computed_at } | { unavailable }
 * @param {object} [i.supervisor]  latest supervisor.summary value | { unavailable }
 */
export function buildOperatingBrief({ digest, jobs = [], approvals = [], facts = null, recovery = null, workItems = null, actionCenter = null, supervisor = null, discoveryJobIds = [] }) {
  const s = []
  // 1 work completed (the 8.5.18 digest's missions); an unread runtime is unavailable, not "0 jobs"
  const runtimeRead = Array.isArray(jobs)
  const done = runtimeRead ? jobs.filter((j) => j.state === 'completed') : []
  const byKind = {}
  for (const j of done) (byKind[j.kind] ||= []).push(j.job_id)
  if (!runtimeRead) s.push(missing('work_completed', code(jobs, 'RUNTIME_UNAVAILABLE')))
  else s.push(section('work_completed', [
    line('Runtime jobs completed', digest.missions.completed, done.map((j) => ({ source: 'agent.research_job', job_id: j.job_id }))),
    ...Object.entries(byKind).map(([k, ids]) => line(`${k}`, ids.length, ids.map((id) => ({ source: 'agent.research_job', job_id: id })))),
    line('Runtime jobs failed', digest.missions.failed, jobs.filter((j) => ['failed', 'dead_letter'].includes(j.state)).map((j) => ({ source: 'agent.research_job', job_id: j.job_id }))),
    line('Model spend (USD)', digest.missions.cost_usd, []),
  ]))

  // 2 new viable opportunities (recovery research / eligible + discovery candidates)
  if (unavail(recovery)) s.push(missing('new_viable_opportunities', code(recovery, 'RECOVERY_NOT_RUN')))
  else {
    const viable = (recovery.candidates || []).filter((c) => c.class === 'research_worthy' || c.class === 'eligible_for_approved_followup').sort((a, b) => (b.priority || 0) - (a.priority || 0))
    const review = (recovery.candidates || []).filter((c) => c.class === 'needs_human_review')
    s.push(section('new_viable_opportunities', [
      line('Recovery: research-worthy', viable.filter((c) => c.class === 'research_worthy').length, viable.filter((c) => c.class === 'research_worthy').map((c) => ({ source: 'public.inbox_thread_state', record_id: c.conversation_id }))),
      line('Recovery: eligible inside an approved program (review only)', viable.filter((c) => c.class === 'eligible_for_approved_followup').length, viable.filter((c) => c.class === 'eligible_for_approved_followup').map((c) => ({ source: 'public.inbox_thread_state', record_id: c.conversation_id }))),
      line('Recovery: needs human review', review.length, review.map((c) => ({ source: 'public.inbox_thread_state', record_id: c.conversation_id }))),
      runtimeRead ? line('Discovery candidates surfaced', digest.findings.by_type?.['discovery.candidate'] ?? 0, discoveryJobIds.map((id) => ({ source: 'agent.research_job', job_id: id }))) : line('Discovery candidates surfaced', null, [], { unavailable: code(jobs, 'RUNTIME_UNAVAILABLE') }),
    ]))
  }

  // 3 offers prepared, 4 negotiations advanced, 6 follow-ups completed, 8 campaign / sender changes
  if (unavail(facts)) {
    for (const id of ['offers_prepared', 'negotiations_advanced', 'followups_completed', 'campaign_sender_changes']) s.push(missing(id, code(facts, 'BRIEF_FACTS_UNAVAILABLE')))
  } else {
    const op = facts.offers_prepared || {}
    s.push(section('offers_prepared', [line('Offers recorded (seller_offers)', op.count ?? null, (op.record_ids || []).map((id) => ({ source: 'public.seller_offers', record_id: id }))), line('Offers sent', op.sent ?? null, [])]))
    const na = facts.negotiations_advanced || {}
    s.push(section('negotiations_advanced', [line('Stage advances (asking price and later)', na.count ?? null, (na.rows || []).map((r) => ({ source: 'public.acquisition_opportunity_history', opportunity_id: r.opportunity_id, to_stage: r.to })))]))
    const fc = facts.followups_completed || {}
    s.push(section('followups_completed', [line('Follow-up messages delivered', fc.count ?? null, (fc.record_ids || []).map((id) => ({ source: 'public.send_queue', record_id: id })))]))
    const cc = facts.campaign_changes || {}
    const sc = facts.sender_changes || {}
    s.push(section('campaign_sender_changes', [
      line('Campaign status transitions', cc.count ?? null, (cc.rows || []).map((r) => ({ source: 'public.campaigns', campaign_id: r.campaign_id, status: r.status }))),
      line('Sender health changes', sc.count ?? null, (sc.rows || []).map((r) => ({ source: 'public.textgrid_numbers', sender_id: r.sender_id, health_state: r.health_state }))),
    ]))
  }

  // 5 deals awaiting approval (pipeline / campaign / reply approvals)
  if (!Array.isArray(approvals)) s.push(missing('deals_awaiting_approval', code(approvals, 'APPROVALS_UNAVAILABLE')))
  else {
    const by = {}
    for (const a of approvals) (by[a.capability_id] ||= []).push(a.approval_id)
    s.push(section('deals_awaiting_approval', [
      line('Approvals pending', approvals.length, approvals.map((a) => ({ source: 'agent.approval_request', approval_id: a.approval_id }))),
      ...Object.entries(by).map(([cap, ids]) => line(cap, ids.length, ids.map((id) => ({ source: 'agent.approval_request', approval_id: id })))),
    ]))
  }

  // 7 recovered opportunities (recovery items an operator resolved in the window)
  if (unavail(workItems)) s.push(missing('recovered_opportunities', code(workItems, 'WORK_ITEMS_UNAVAILABLE')))
  else {
    const rec = (workItems.resolved || []).filter((w) => String(w.kind).startsWith('recovery_') && !String(w.resolved_by || '').startsWith('auto:'))
    s.push(section('recovered_opportunities', [line('Recovery items resolved by an operator', rec.length, rec.map((w) => ({ source: 'agent.ops_work_item', work_item_id: w.work_item_id })))]))
  }

  // 9 system incidents (supervisor escalations + ops.* findings)
  if (unavail(supervisor) && unavail(workItems)) s.push(missing('system_incidents', code(supervisor, 'SUPERVISOR_NOT_RUN')))
  else {
    const esc = unavail(workItems) ? [] : (workItems.open || []).filter((w) => w.escalated)
    const opsFindings = runtimeRead ? Object.entries(digest.findings.by_type || {}).filter(([t]) => t.startsWith('ops.') || t.startsWith('supervisor.escalation')) : []
    s.push(section('system_incidents', [
      line('Open escalations', unavail(workItems) ? null : esc.length, esc.map((w) => ({ source: 'agent.ops_work_item', work_item_id: w.work_item_id }))),
      ...opsFindings.map(([t, n]) => line(t, n, [])),
      ...(unavail(supervisor) ? [line('Supervisor checks', null, [], { unavailable: code(supervisor, 'SUPERVISOR_NOT_RUN') })] : [line('Supervisor checks (critical / warn / unavailable)', `${supervisor.counts?.critical ?? '—'} / ${supervisor.counts?.warn ?? '—'} / ${supervisor.counts?.unavailable ?? '—'}`, supervisor.job_id ? [{ source: 'agent.research_job', job_id: supervisor.job_id }] : [])]),
    ]))
  }

  // 10 recommended next actions — deterministic, from what is open now
  const rec = []
  if (!unavail(actionCenter)) {
    if (actionCenter.lost > 0) rec.push(line(`Answer or assign ${actionCenter.lost} lost conversation(s)`, actionCenter.lost, (actionCenter.lost_ids || []).map((id) => ({ source: 'public.inbox_thread_state', record_id: id }))))
    else if ((actionCenter.counts?.needs_attention ?? 0) > 0) rec.push(line(`Work the active queue (${actionCenter.counts.needs_attention})`, actionCenter.counts.needs_attention, []))
  }
  if (!unavail(workItems)) {
    for (const w of (workItems.open || []).filter((x) => x.escalated).slice(0, 3)) rec.push(line(`Escalation: ${w.title}`, null, [{ source: 'agent.ops_work_item', work_item_id: w.work_item_id }]))
  }
  if (Array.isArray(approvals) && approvals.length) rec.push(line(`Decide ${approvals.length} pending approval(s)`, approvals.length, approvals.slice(0, LINK_MAX).map((a) => ({ source: 'agent.approval_request', approval_id: a.approval_id }))))
  if (!unavail(recovery)) {
    const top = (recovery.candidates || []).filter((c) => c.class === 'needs_human_review' || c.class === 'research_worthy').sort((a, b) => (b.priority || 0) - (a.priority || 0)).slice(0, 5)
    if (top.length) rec.push(line(`Review the top ${top.length} recovery candidate(s)`, top.length, top.map((c) => ({ source: 'public.inbox_thread_state', record_id: c.conversation_id }))))
  }
  if (unavail(actionCenter) && unavail(workItems) && unavail(recovery)) s.push(missing('recommended_next_actions', 'OPERATIONS_READ_MODEL_UNAVAILABLE'))
  else s.push(section('recommended_next_actions', rec.length ? rec : [line('Nothing open in the operations read model', 0, [])]))

  const order = BRIEF_SECTIONS.map(([id]) => id)
  return { version: BRIEF_VERSION, window: digest.window, sections: s.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) }
}

const fmt = (v) => (v == null ? 'unavailable' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(4)) : String(v))
const linkText = (l) => {
  const id = l.record_id || l.job_id || l.approval_id || l.work_item_id || l.opportunity_id || l.campaign_id || l.sender_id
  return `${l.source}:${id}`
}

/** Markdown rendering (ids only). */
export function renderBriefMarkdown(brief, { title = 'LeadCommand daily operating brief' } = {}) {
  const out = [`# ${title}`, '', `Window: ${brief.window?.since ?? '—'} → ${brief.window?.until ?? '—'} (UTC)`, '']
  for (const sec of brief.sections) {
    out.push(`## ${sec.title}`)
    if (!sec.available) { out.push(`_unavailable_ (${sec.code})`, ''); continue }
    for (const l of sec.lines) {
      out.push(`- ${l.label}: **${l.unavailable ? `unavailable (${l.unavailable})` : fmt(l.value)}**`)
      if (l.links?.length) out.push(`  - sources: ${l.links.map(linkText).join(', ')}`)
    }
    out.push('')
  }
  return out.join('\n')
}
