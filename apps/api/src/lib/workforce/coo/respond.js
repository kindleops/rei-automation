// The COO's executive messages (docs/WORKFORCE.md §5 respond.js). Pure text over records.
// It describes the plan, the assignment states and the report. It NEVER claims completion for a
// non-terminal assignment: "done" counts come from terminal-success assignments only, and anything
// not done is named as pending, escalated, refused or unknown. No phone, email or name ever appears:
// properties are pid_ refs.
import { label } from './interpret.js'
import { isTerminalSuccess } from '../engine/report.js'

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const usd = (v) => (v == null ? 'unknown' : `$${Math.round(Number(v)).toLocaleString('en-US')}`)

export function planMessage({ mission, plan }) {
  if (!plan) return { content: 'I could not build a plan for that directive.', refs: [{ type: 'mission', id: mission.mission_id }] }
  const p = plan.params || {}
  const where = p.markets?.length ? ` in ${p.markets.join(', ')}` : ' across your active markets'
  const lines = [`Plan: ${label(plan.intent)}${where}.`]
  if (['opportunity_triage', 'offer_activity', 'conversation_revival'].includes(plan.intent)) {
    lines.push(`Acquisitions pulls up to ${p.pool} live opportunities (held, excluded and suppressed ones are left out). For each one we read the conversation${plan.variant?.decision ? ' and the Decision Engine row' : ''}${plan.variant?.research ? ', research where the evidence is missing or stale' : ''}${plan.variant?.finance ? ', and the CFO reviews the economics independently' : ''}. Then I rank them (contact and identity first, then pressure, then deal quality), set a next action for the top ${p.n}, and queue the follow-up work.`)
  } else if (plan.intent === 'market_diagnosis') {
    lines.push('Marketing reads the pipeline overview and Acquisitions reads the live opportunities. I record what they show.')
  }
  if (plan.unavailable?.length) lines.push(`Not available in this phase: ${plan.unavailable.map((u) => u.capability).join(', ')}.`)
  lines.push('Nothing in this plan contacts a seller, makes an offer or changes a stage. I will report back with what is verified and what is not.')
  return { content: lines.join(' '), refs: [{ type: 'mission', id: mission.mission_id }] }
}

export function progressLine(assignments = []) {
  const done = assignments.filter(isTerminalSuccess).length
  const open = assignments.filter((a) => !['completed', 'failed', 'cancelled'].includes(a.status)).length
  const waiting = assignments.filter((a) => a.status === 'waiting_job').length
  return `${done} of ${assignments.length} steps verified complete, ${open} still open${waiting ? ` (${plural(waiting, 'research job')} running)` : ''}.`
}

export function reportMessage({ mission, report }) {
  const r = report
  const lines = []
  lines.push(r.state === 'complete' ? `Mission report: ${label(r.intent)}.` : `Interim report: ${label(r.intent)}. Not everything is finished.`)
  lines.push(`${r.counts.completed} ${r.counts.completed === 1 ? 'step' : 'steps'} verified complete.`)
  if (r.ranked?.length) {
    const top = r.ranked.slice(0, 5).map((x) => `#${x.rank} ${x.refs.property_ref} (${x.next_action ? `next: ${x.next_action.replace(/_/g, ' ')}` : `next action ${x.next_action_status.replace(/_/g, ' ')}`}${x.cfo_verdict ? `, CFO: ${x.cfo_verdict.replace(/_/g, ' ')}` : ''})`)
    lines.push(`Ranked ${plural(r.ranked.length, 'opportunity', 'opportunities')}: ${top.join('; ')}${r.ranked.length > 5 ? '; …' : ''}.`)
    const evKnown = r.ranked.filter((x) => x.ev.status === 'known').length
    lines.push(evKnown ? `Expected value is known for ${evKnown} of them.` : 'Expected value is unknown for all of them: there is no calibrated close-rate input yet, and I do not assume a spread.')
  } else if (['opportunity_triage', 'offer_activity', 'conversation_revival'].includes(r.intent)) {
    lines.push('No opportunity was ranked.')
  }
  const escItems = new Set(r.escalations.map((e) => e.ceo_assignment_id || e.assignment_id)).size
  if (r.escalations.length) lines.push(`${plural(escItems, 'item')} escalated to you (${[...new Set(r.escalations.flatMap((e) => e.reasons))].slice(0, 4).join(', ').toLowerCase()}).`)
  if (r.refused.length) lines.push(`${plural(r.refused.length, 'step')} refused (${[...new Set(r.refused.flatMap((e) => e.reasons))].slice(0, 4).join(', ').toLowerCase() || 'see details'}).`)
  const open = r.pending.filter((p) => p.queue !== 'person')
  if (open.length) lines.push(`${plural(open.length, 'step')} not finished.`)
  const queued = r.pending.filter((p) => p.queue === 'person')
  if (queued.length) lines.push(`${plural(queued.length, 'item')} queued for you (not done yet).`)
  if (r.unknowns.length) lines.push(`${plural(r.unknowns.length, 'unknown')} recorded.`)
  lines.push(`Research cost: ${r.costs.status === 'known' ? usd(r.costs.total_usd) : r.costs.status === 'partial' ? `at least ${usd(r.costs.total_usd)} (some job costs unreadable)` : 'unknown'}.`)
  const refs = [{ type: 'mission', id: mission.mission_id }, ...(r.ranked || []).slice(0, 10).map((x) => ({ type: 'property', id: x.refs.property_ref }))]
  return { content: lines.join(' '), refs }
}

/** A status answer from live Workforce data (the /command route): counts, never claims. */
export function statusAnswer({ missions = [], assignments = [], employees = [] }) {
  const by = (xs, k) => xs.reduce((m, x) => ({ ...m, [x[k]]: (m[x[k]] || 0) + 1 }), {})
  const ms = by(missions, 'status')
  const as = by(assignments, 'status')
  const active = employees.filter((e) => e.status === 'active').length
  const parts = [
    `Missions: ${Object.entries(ms).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}.`,
    `Assignments: ${Object.entries(as).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ') || 'none'}.`,
    `${plural(active, 'employee')} active.`,
  ]
  const waitingCeo = assignments.filter((a) => a.status === 'waiting_approval' && a.assignee_employee_id === 'emp_ceo').length
  if (waitingCeo) parts.push(`${plural(waitingCeo, 'item')} waiting for you.`)
  return { content: parts.join(' '), refs: missions.slice(0, 5).map((m) => ({ type: 'mission', id: m.mission_id })) }
}
