// TRUTHFUL employee / assignment activity (docs/WORKFORCE-AGNTEI.md §3–§4). Pure.
//   working   only while a lease is held (unexpired) AND the holder was seen < 2 min ago
//   waiting   with the reason: a research job, an approval / a person, a hold, or an external (Agntei) agent
//             that has not claimed it — "Waiting for Scout (Agntei), last seen 3 min ago"
//   idle      nothing open
// Plus the employee-level states pending_link (registered, not linked yet), binding_expired / binding_revoked
// (an Agntei employee whose operator-authorized binding ended), paused, retired.

export const WORKING_HEARTBEAT_MS = 2 * 60_000
const OPEN = new Set(['pending', 'ready', 'leased', 'running', 'waiting_job', 'waiting_approval', 'blocked'])
const ms = (v) => { const t = Date.parse(String(v ?? '')); return Number.isFinite(t) ? t : null }
const toMs = (now) => (typeof now === 'number' ? now : ms(now) ?? Date.now())

/** "3 min ago" / "just now" / "2 h ago" / "never" (a request-time rendering; the UI re-renders from last_seen_at). */
export function ago(iso, now = Date.now()) {
  const t = ms(iso)
  if (t == null) return 'never'
  const s = Math.max(0, Math.round((toMs(now) - t) / 1000))
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

const who = (e) => `${e?.display_name || e?.employee_id || 'the agent'}${e?.origin === 'agntei' ? ' (Agntei)' : ''}`
/** The last time this employee was seen working (a heartbeat or a claim). */
export const lastSeenOf = (employee, assignments = []) => {
  const ts = [ms(employee?.heartbeat_at), ...assignments.filter((a) => a.assignee_employee_id === employee?.employee_id).map((a) => ms(a.claimed_at))].filter((x) => x != null)
  return ts.length ? new Date(Math.max(...ts)).toISOString() : null
}

/** One assignment's activity → { state, reason, label, last_seen_at } */
export function assignmentActivity(a, { employee = null, now = Date.now(), last_seen_at = null } = {}) {
  if (!a) return null
  const t = toMs(now)
  const seen = last_seen_at ?? lastSeenOf(employee, [a])
  const fresh = ms(seen) != null && t - ms(seen) < WORKING_HEARTBEAT_MS
  if (['completed', 'failed', 'cancelled'].includes(a.status)) return { state: 'done', reason: a.status, label: a.status, last_seen_at: seen }
  if (['leased', 'running'].includes(a.status)) {
    const live = ms(a.lease_until) != null && ms(a.lease_until) > t
    if (live && fresh) return { state: 'working', reason: 'lease_held', label: `${who(employee)} is working on it`, last_seen_at: seen }
    if (!live) return { state: 'waiting', reason: 'lease_expired', label: `The lease of ${who(employee)} expired; it is handed back to the same assignee`, last_seen_at: seen }
    return { state: 'waiting', reason: 'agent_silent', label: `${who(employee)} holds it, last seen ${ago(seen, t)}`, last_seen_at: seen }
  }
  if (a.status === 'waiting_job') return { state: 'waiting', reason: 'research_job', label: 'Waiting on a research job', last_seen_at: seen }
  if (a.status === 'waiting_approval') return { state: 'waiting', reason: 'approval', label: a.input?.task ? 'In the CEO queue' : 'Waiting for a person', last_seen_at: seen }
  if (a.status === 'blocked') return { state: 'waiting', reason: 'hold', label: 'Blocked', last_seen_at: seen }
  if (a.execution_mode === 'external') return { state: 'waiting', reason: 'external_agent', label: `Waiting for ${who(employee)}, ${ms(seen) == null ? 'never seen' : `last seen ${ago(seen, t)}`}`, last_seen_at: seen }
  if (a.status === 'pending') return { state: 'waiting', reason: 'dependencies', label: 'Waiting on an upstream step', last_seen_at: seen }
  return { state: 'waiting', reason: 'queued', label: 'Queued for the Workforce engine', last_seen_at: seen }
}

/** One employee's activity over its assignments → { state, reason, label, last_seen_at, open } */
export function employeeActivity(employee, assignments = [], { now = Date.now() } = {}) {
  if (!employee) return null
  const t = toMs(now)
  const mine = assignments.filter((a) => a.assignee_employee_id === employee.employee_id)
  const open = mine.filter((a) => OPEN.has(a.status))
  const seen = lastSeenOf(employee, mine)
  const base = { last_seen_at: seen, open: open.length }
  if (employee.status === 'pending_link') return { ...base, state: 'pending_link', reason: 'not_linked', label: employee.action_principal_id ? 'Bound; waiting for the agent to link from Agntei' : 'Registered; the owner has not bound its principal yet' }
  if (employee.status === 'retired') return { ...base, state: 'retired', reason: 'retired', label: 'Retired' }
  if (employee.status === 'paused') return { ...base, state: 'paused', reason: 'paused', label: 'Paused' }
  if (employee.origin === 'agntei') {
    if (employee.binding_revoked_at) return { ...base, state: 'binding_revoked', reason: 'binding_revoked', label: 'Binding revoked by the owner' }
    if (ms(employee.binding_valid_until) != null && ms(employee.binding_valid_until) <= t) return { ...base, state: 'binding_expired', reason: 'binding_expired', label: 'Binding expired; the owner re-binds it' }
  }
  const acts = open.map((a) => assignmentActivity(a, { employee, now: t, last_seen_at: seen }))
  const working = acts.find((x) => x.state === 'working')
  if (working) return { ...base, state: 'working', reason: working.reason, label: working.label }
  const order = ['agent_silent', 'lease_expired', 'external_agent', 'research_job', 'approval', 'hold', 'dependencies', 'queued']
  const waiting = acts.filter((x) => x.state === 'waiting').sort((x, y) => order.indexOf(x.reason) - order.indexOf(y.reason))[0]
  if (waiting) return { ...base, state: 'waiting', reason: waiting.reason, label: waiting.label }
  return { ...base, state: 'idle', reason: 'nothing_open', label: 'Idle' }
}
