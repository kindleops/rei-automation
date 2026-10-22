/**
 * WORKFORCE FIXTURE SERVER — answers the §7 routes from wf-fixture-data with
 * SYNTHETIC records. DEV only (VITE_LC_WF_FIXTURES=1); never in a bundle.
 *
 * A directive submitted here opens a fixture mission whose assignments move
 * on a fixed clock (one step every ~2.4s), so the live mission card can be
 * reviewed. Every body carries `fixture: true`; the live client refuses such
 * a body, so a fixture can never pass as real data.
 */
import type { BackendResult } from '../../../lib/api/backendClient'
import type { WfRequest, WfTransport } from '../api/wf-client'
import {
  DIAG_ASSIGNMENTS, FOLLOW_ONS, FX_AUTHORITY, FX_CHARTERS, FX_DEPARTMENTS, FX_EMPLOYEES, FX_EVENTS, FX_KPIS, FX_MEMORY, FX_MESSAGES,
  FX_MISSIONS, FX_REPORTS_BRIEF, FX_SUBJECTS, REVIVAL_ASSIGNMENTS, STATUS_ASSIGNMENTS, TRIAGE_ASSIGNMENTS, TRIAGE_PLAN, TRIAGE_REPORT, propRef,
  FX_AGNTEI_ASSIGNMENTS, FX_GATEWAY_AUDIT, fxLinkSteps,
} from './wf-fixture-data'

type R = Record<string, unknown>
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

const missions: R[] = clone(FX_MISSIONS)
const ADDR = new Map(FX_SUBJECTS.map((s) => [s.pid, s.addr]))
const assignments: R[] = clone([...TRIAGE_ASSIGNMENTS, ...FOLLOW_ONS, ...DIAG_ASSIGNMENTS, ...STATUS_ASSIGNMENTS, ...REVIVAL_ASSIGNMENTS, ...FX_AGNTEI_ASSIGNMENTS])
  .map((a) => (a.resource_type === 'property' ? { ...a, resource_label: ADDR.get(String(a.resource_key)) ?? null } : a))
const events: R[] = clone(FX_EVENTS)
const messages: R[] = clone(FX_MESSAGES)
const authority = clone(FX_AUTHORITY)
let nextEvent = Math.max(...events.map((e) => Number(e.event_id))) + 1
let nextMsg = 100

/* ── a live (clocked) mission per submitted directive ─────────────────── */

interface Live { id: string; t0: number; steps: Array<{ key: string; cap: string; who: string; n: number }>; emitted: Set<string>; done: boolean; review: boolean }
const lives: Live[] = []
const STEP_MS = 2400
const REVIEW_STEPS = [
  { key: 'conversation_state', cap: 'intel.conversation_state', who: 'emp_acq_dallas', n: 1 },
  { key: 'acquisition_decision', cap: 'intel.acquisition_decision', who: 'emp_acq_dallas', n: 1 },
  { key: 'cfo_review', cap: 'finance.review_opportunity', who: 'emp_cfo_ledger', n: 1 },
  { key: 'next_action', cap: 'acq.next_action', who: 'emp_acq_dallas', n: 1 },
]
const REVIEW_PLAN = { steps: [
  { step_key: 'conversation_state', capability_key: 'intel.conversation_state', label: 'Conversation state', assignee_role: 'acquisition_agent', depends_on: [] },
  { step_key: 'acquisition_decision', capability_key: 'intel.acquisition_decision', label: 'Acquisition decision', assignee_role: 'acquisition_agent', depends_on: [] },
  { step_key: 'cfo_review', capability_key: 'finance.review_opportunity', label: 'CFO check', assignee_role: 'cfo', depends_on: ['acquisition_decision'] },
  { step_key: 'next_action', capability_key: 'acq.next_action', label: 'Next action and owner', assignee_role: 'acquisition_agent', depends_on: ['conversation_state', 'cfo_review'] },
] }
const LIVE_STEPS = [
  { key: 'active_opportunities', cap: 'intel.active_opportunities', who: 'emp_head_acq', n: 1 },
  { key: 'conversation_state', cap: 'intel.conversation_state', who: 'emp_acq_dallas', n: 3 },
  { key: 'acquisition_decision', cap: 'intel.acquisition_decision', who: 'emp_acq_msp', n: 3 },
  { key: 'research', cap: 'research.property', who: 'emp_research_scout', n: 2 },
  { key: 'cfo_review', cap: 'finance.review_opportunity', who: 'emp_cfo_ledger', n: 1 },
  { key: 'rank', cap: 'acq.rank_opportunities', who: 'emp_head_acq', n: 1 },
  { key: 'next_action', cap: 'acq.next_action', who: 'emp_acq_dallas', n: 3 },
  { key: 'assign', cap: 'work.assign', who: 'emp_coo_atlas', n: 1 },
  { key: 'memory', cap: 'memory.assert', who: 'emp_head_acq', n: 1 },
]

/** Speed multiplier for the capture script (window.__wfFx.speed). */
const speed = () => { const w = typeof window !== 'undefined' ? (window as unknown as { __wfFx?: { speed?: number } }).__wfFx : undefined; return w?.speed && w.speed > 0 ? w.speed : 1 }

function pushEvent(type: string, o: R) { events.push({ event_id: nextEvent++, at: new Date().toISOString(), mission_id: null, assignment_id: null, employee_id: null, payload: {}, type, ...o }) }

function advance() {
  const now = Date.now()
  for (const L of lives) {
    if (L.done) continue
    const m = missions.find((x) => x.mission_id === L.id)
    if (!m) continue
    const elapsed = (now - L.t0) * speed()
    if (elapsed > 1200 && m.status === 'planning') {
      m.status = 'active'
      m.plan = clone(L.review ? REVIEW_PLAN : TRIAGE_PLAN)
      m.plan_version = 1
      if (!L.emitted.has('planned')) {
        L.emitted.add('planned')
        pushEvent('wf.mission.planned', { mission_id: L.id, employee_id: 'emp_coo_atlas', payload: { summary: L.review ? '4 steps · 4 assignments' : '9 steps · 16 assignments' } })
        messages.push({ message_id: `wfx_live_${nextMsg++}`, mission_id: L.id, author: 'coo', author_employee_id: 'emp_coo_atlas', content: L.review ? 'Planned. Mesa reads the conversation and the decision, Ledger checks it, then Mesa names the next action. Read only; nothing reaches the seller.' : 'Planned. Harbor reads the active pipeline, Mesa and North read every conversation and decision, Scout researches the thin ones, Ledger reviews before Harbor ranks. I will report only what completes.', refs: [{ type: 'mission', id: L.id, label: String(m.title) }], created_at: new Date().toISOString() })
      }
    }
    if (m.status === 'planning') continue
    L.steps.forEach((s, si) => {
      for (let i = 0; i < s.n; i++) {
        const id = `${L.id.replace('wfm_', 'wfa_')}${si}${i}`
        let a = assignments.find((x) => x.assignment_id === id)
        if (!a) {
          a = { assignment_id: id, mission_id: L.id, parent_assignment_id: null, step_key: s.n > 1 ? `${s.key}.${i + 1}` : s.key, capability_key: s.cap, assignee_employee_id: s.who, delegated_by_employee_id: 'emp_coo_atlas', status: 'pending', depends_on: [], input: {}, output: {}, evidence: [], attempt: 1, max_attempts: 3, outcome_class: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
          assignments.push(a)
        }
        const start = 1200 + si * STEP_MS + i * 380
        const end = start + STEP_MS * 0.85
        const prev = a.status
        const isResearch = s.cap === 'research.property'
        if (elapsed >= end) { a.status = 'completed'; a.outcome_class = 'verified' }
        else if (elapsed >= start) a.status = isResearch && elapsed < start + STEP_MS * 0.5 ? 'waiting_job' : 'running'
        else if (elapsed >= start - STEP_MS) a.status = 'ready'
        if (isResearch && a.status === 'waiting_job') a.runtime_job_id = `mjob_live${si}${i}`
        if (prev !== a.status) {
          a.updated_at = new Date().toISOString()
          if (a.status === 'running') pushEvent('wf.assignment.started', { mission_id: L.id, assignment_id: id, employee_id: s.who, payload: { summary: String(s.cap) } })
          if (a.status === 'waiting_job') pushEvent('wf.assignment.waiting_job', { mission_id: L.id, assignment_id: id, employee_id: s.who, payload: { summary: 'property.research enqueued' } })
          if (a.status === 'completed') pushEvent('wf.assignment.completed', { mission_id: L.id, assignment_id: id, employee_id: s.who, payload: { outcome_class: 'verified', summary: String(s.cap) } })
        }
      }
    })
    const mine = assignments.filter((a) => a.mission_id === L.id)
    if (mine.length && mine.every((a) => a.status === 'completed')) {
      L.done = true
      m.status = 'completed'
      m.completed_at = new Date().toISOString()
      const rep = clone(TRIAGE_REPORT) as R
      rep.generated_at = m.completed_at
      // the live mission's report items point at its own assignments
      rep.completed = (rep.completed as R[]).map((c) => ({ ...c, assignment_id: null }))
      if (L.review) {
        const first = (rep.ranked as R[])[0]
        m.report = { summary: 'Reviewed one property: CFO-supported, ready for an internal offer recommendation.', generated_at: m.completed_at, completed: [{ label: 'Conversation state, decision and CFO check read', refs: first.refs }], pending: [], escalations: [], refused: [], unknowns: [], ranked: [first], costs: { total_usd: null, status: 'unknown', reason: 'Read-only capabilities ran inline; no runtime jobs to price', by_job: [] } }
      } else m.report = rep
      pushEvent('wf.mission.completed', { mission_id: L.id, employee_id: 'emp_coo_atlas', payload: { summary: L.review ? '1 reviewed · CFO supported' : '10 ranked · 1 escalation · 1 refused · 2 pending' } })
      messages.push({ message_id: `wfx_live_${nextMsg++}`, mission_id: L.id, author: 'coo', author_employee_id: 'emp_coo_atlas', content: L.review ? 'Review done. CFO-supported; Mesa owns the next action: an internal offer recommendation.' : 'Report ready: 10 ranked, 4 CFO-supported. 1533 Kessler Pkwy waits for your review. 3305 Elm St was refused because it is on hold.', refs: L.review ? [propRef(1)] : [propRef(1), propRef(7), propRef(11)], created_at: m.completed_at })
    }
  }
}

function openLive(directive: string, crid: string): R {
  const review = /^review\b/i.test(directive)
  const existing = missions.find((m) => m.idempotency_key === crid)
  if (existing) return existing
  const n = lives.length + 1
  const id = `wfm_0f1x11ce-0000-4000-8000-${String(n).padStart(12, '0')}`
  const now = new Date().toISOString()
  const m: R = {
    mission_id: id, title: directive.length > 64 ? `${directive.slice(0, 61)}...` : directive, directive, idempotency_key: crid,
    objective: review ? { intent: 'status_review', focus: 'one property' } : { intent: 'opportunity_triage', markets: ['Dallas', 'Minneapolis'], count: 10 }, playbook_key: review ? 'status_review' : 'opportunity_triage', owner_employee_id: 'emp_coo_atlas',
    requested_by: 'owner', status: 'planning', priority: 80, due_at: null, plan: null, plan_version: 0, report: null, created_at: now, updated_at: now, completed_at: null,
  }
  missions.unshift(m)
  lives.push({ id, t0: Date.now(), steps: review ? REVIEW_STEPS : LIVE_STEPS, emitted: new Set(), done: false, review })
  pushEvent('wf.mission.opened', { mission_id: id, employee_id: 'emp_coo_atlas', payload: { summary: m.title } })
  return m
}

/* ── routing ─────────────────────────────────────────────────────────── */

const ok = (data: unknown): BackendResult<unknown> => ({ ok: true, status: 200, data: { ok: true, fixture: true, data } })
const fail = (status: number, error: string, message: string): BackendResult<unknown> => ({ ok: false, status, error, message, upstream: { ok: false, error, message, fixture: true } })

const openCount = (empId: string) => assignments.filter((a) => a.assignee_employee_id === empId && !['completed', 'failed', 'cancelled'].includes(String(a.status))).length
const registered: R[] = []
// the truthful activity the server derives (lib/workforce/agntei/activity.js), approximated for the fixture
const fxActivity = (e: R): R => {
  if (e.status === 'pending_link') return { state: 'pending_link', reason: 'not_linked', label: e.action_principal_id ? 'Bound; waiting for the agent to link from Agntei' : 'Registered; the owner has not bound its principal yet', last_seen_at: null }
  const mine = assignments.filter((a) => a.assignee_employee_id === e.employee_id && !['completed', 'failed', 'cancelled'].includes(String(a.status)))
  const seen = (e.heartbeat_at as string | null) ?? null
  const fresh = seen ? Date.now() - Date.parse(seen) < 120_000 : false
  if (mine.some((a) => ['leased', 'running'].includes(String(a.status))) && fresh) return { state: 'working', reason: 'lease_held', label: `${String(e.display_name)}${e.origin === 'agntei' ? ' (Agntei)' : ''} is working on it`, last_seen_at: seen }
  const ext = mine.find((a) => a.execution_mode === 'external' && ['ready', 'pending'].includes(String(a.status)))
  if (ext) return { state: 'waiting', reason: 'external_agent', label: `Waiting for ${String(e.display_name)} (Agntei)`, last_seen_at: seen }
  if (mine.some((a) => a.status === 'waiting_job')) return { state: 'waiting', reason: 'research_job', label: 'Waiting on a research job', last_seen_at: seen }
  return mine.length ? { state: 'waiting', reason: 'queued', label: 'Queued for the Workforce engine', last_seen_at: seen } : { state: 'idle', reason: 'nothing_open', label: 'Idle', last_seen_at: seen }
}
const employees = (): R[] => [...FX_EMPLOYEES, ...registered].map((e): R => ({ ...e, open_assignments: openCount(String(e.employee_id)), activity: fxActivity(e) }))
const counts = (mid: string) => assignments.filter((a) => a.mission_id === mid).reduce<R>((acc, a) => { acc[String(a.status)] = Number(acc[String(a.status)] ?? 0) + 1; return acc }, {})
const missionRow = (m: R) => ({ ...m, assignment_counts: counts(String(m.mission_id)) })

function route(req: WfRequest): BackendResult<unknown> {
  advance()
  const u = new URL(req.path, 'http://fx.local')
  const p = u.pathname.replace(/^\/api\/cockpit\/workforce/, '')
  const q = u.searchParams
  const body = (req.body ?? {}) as R

  if (req.method === 'GET' && p === '/overview') {
    const byStatus: R = {}
    for (const m of missions) byStatus[String(m.status)] = Number(byStatus[String(m.status)] ?? 0) + 1
    return ok({
      departments: FX_DEPARTMENTS.map((d) => ({ ...d, employee_count: FX_EMPLOYEES.filter((e) => e.department_key === d.department_key).length, open_assignments: FX_EMPLOYEES.filter((e) => e.department_key === d.department_key).reduce((n, e) => n + openCount(String(e.employee_id)), 0) })),
      employees: employees(),
      missions_by_status: byStatus,
      last_events: events.slice(-8).reverse(),
      runtime: { emergency_stop: false, last_tick_at: new Date(Date.now() - 22_000).toISOString(), kinds_armed: ['workforce.coo_plan', 'workforce.dispatch', 'workforce.mission_review'], dispatch_enabled: true, detail: 'FIXTURE runtime' },
      flags: authority.flags,
    })
  }
  if (req.method === 'GET' && p === '/employees') return ok({ employees: employees() })
  if (req.method === 'POST' && p === '/employees' && body.op === 'register_agntei') {
    const x = (body.employee ?? {}) as R
    const id = String(x.employee_id ?? '')
    if (!/^emp_[a-z0-9_]{3,40}$/.test(id)) return fail(422, 'EMPLOYEE_ID_INVALID', 'The employee is not valid.')
    if (employees().some((e) => e.employee_id === id)) return fail(409, 'CONFLICT', 'An employee with this id already exists.')
    const e: R = { employee_id: id, kind: 'ai', role_key: x.role_key, department_key: x.role_key === 'acquisition_agent' ? 'acquisitions' : 'data_intelligence', display_name: x.display_name ?? id, employee_code: null, manager_employee_id: null,
      user_id: null, action_principal_id: null, status: 'pending_link', origin: 'agntei', employment_type: 'operator_ai', markets: x.markets ?? [], skills: x.skills ?? [], segments: null, tier_ceiling: 'T1', spend_day_cap_usd: 0, heartbeat_at: null, last_activity_at: null }
    registered.push(e)
    return ok({ employee: { ...e, activity: fxActivity(e) }, link: fxLinkSteps(id, `agt_${id.slice(4)}`), executed: false })
  }
  if (req.method === 'POST' && p === '/employees') return fail(403, 'CEO_ONLY', 'Fixture mode does not create employees')
  const empMatch = p.match(/^\/employees\/([^/]+)$/)
  if (req.method === 'GET' && empMatch) {
    const id = decodeURIComponent(empMatch[1])
    const e = employees().find((x) => x.employee_id === id)
    if (!e) return fail(404, 'NOT_FOUND', 'No such employee')
    const role = String(e.role_key)
    const mine = assignments.filter((a) => a.assignee_employee_id === id).slice(0, 40)
    const ai = e.kind === 'ai'
    return ok({
      employee: e,
      charter: FX_CHARTERS[role] ?? null,
      authority: { policies: authority.policies.filter((x) => x.role_key === role || x.employee_id === id) },
      memory: FX_MEMORY.filter((f) => f.author_employee_id === id || (f.scope === 'company')),
      assignments: mine,
      kpis: [
        { subject_type: 'employee', subject_key: id, kpi_key: 'assignments_completed', window: '7d', value: mine.filter((a) => a.status === 'completed').length, status: 'known', computed_at: new Date().toISOString() },
        { subject_type: 'employee', subject_key: id, kpi_key: 'median_assignment_minutes', window: '7d', value: null, status: 'unknown', source: { reason: ai ? 'Fewer than 5 timed assignments in the window' : 'Human assignments are not timed in Phase A' } },
        { subject_type: 'employee', subject_key: id, kpi_key: 'assignment_success_rate', window: '7d', value: mine.length ? mine.filter((a) => a.status === 'completed').length / mine.length : null, status: mine.length ? 'known' : 'unknown', source: { reason: 'No assignments in the window' } },
      ],
      cost: ai
        ? (role === 'research_analyst' ? { today_usd: 0.42, window_usd: 1.84, window: '7d', cap_usd: e.spend_day_cap_usd, status: 'known' } : { today_usd: 0, window_usd: 0, window: '7d', cap_usd: e.spend_day_cap_usd, status: 'known', reason: 'Read-only capabilities ran inline; no metered spend' })
        : { today_usd: null, window_usd: null, window: '7d', cap_usd: null, status: 'unknown', reason: 'People are not metered' },
      activity: e.activity,
      link: e.origin === 'agntei' ? { system: 'agntei', principal_id: e.action_principal_id ?? null, bound_at: null, link_expires_at: null, binding_valid_until: e.binding_valid_until ?? null, binding_revoked_at: null, linked: Boolean(e.external_agent_id), external_agent_id: e.external_agent_id ?? null, external_install_id: e.external_agent_id ? 'inst_fx_mac01' : null, linked_at: e.external_linked_at ?? null } : null,
      link_steps: e.origin === 'agntei' && e.status === 'pending_link' ? fxLinkSteps(id, `agt_${id.slice(4)}`) : null,
      history: { events: events.filter((x) => x.employee_id === id).slice(-30), events_available: true, gateway: e.origin === 'agntei' && e.external_agent_id ? FX_GATEWAY_AUDIT : [], gateway_available: true, gateway_reason: e.action_principal_id ? null : 'no_principal' },
    })
  }
  if (req.method === 'GET' && p === '/missions') {
    const st = q.get('status')
    return ok({ missions: missions.filter((m) => !st || m.status === st).map(missionRow) })
  }
  if (req.method === 'POST' && p === '/missions') {
    const d = String(body.directive ?? '').trim()
    if (!d) return fail(422, 'DIRECTIVE_REQUIRED', 'A directive is required')
    return ok({ mission: missionRow(openLive(d, String(body.client_request_id ?? ''))) })
  }
  const mMatch = p.match(/^\/missions\/([^/]+)(\/cancel)?$/)
  if (mMatch) {
    const id = decodeURIComponent(mMatch[1])
    const m = missions.find((x) => x.mission_id === id)
    if (!m) return fail(404, 'NOT_FOUND', 'No such mission')
    if (req.method === 'POST' && mMatch[2]) {
      if (['completed', 'failed', 'cancelled'].includes(String(m.status))) return fail(409, 'ILLEGAL_TRANSITION', 'The mission is already finished')
      m.status = 'cancelled'
      for (const a of assignments) if (a.mission_id === id && !['completed', 'failed', 'cancelled'].includes(String(a.status))) a.status = 'cancelled'
      const L = lives.find((x) => x.id === id)
      if (L) L.done = true
      pushEvent('wf.mission.cancelled', { mission_id: id, employee_id: 'emp_coo_atlas', payload: { summary: 'Cancelled by the CEO' } })
      return ok({ mission: missionRow(m) })
    }
    if (req.method === 'GET' && !mMatch[2]) return ok({ mission: missionRow(m), assignments: assignments.filter((a) => a.mission_id === id), events: events.filter((e) => e.mission_id === id) })
  }
  if (req.method === 'GET' && p === '/assignments') {
    const st = q.get('status')
    const who = q.get('employee')
    return ok({ assignments: assignments.filter((a) => (!st || a.status === st) && (!who || a.assignee_employee_id === who)).slice(-300) })
  }
  if (req.method === 'GET' && p === '/events') {
    const after = Number(q.get('after') ?? 0)
    const before = Number(q.get('before') ?? 0)
    const mission = q.get('mission')
    const limit = Math.min(Number(q.get('limit') ?? 50) || 50, 200)
    let list = events.filter((e) => (!mission || e.mission_id === mission))
    if (after) list = list.filter((e) => Number(e.event_id) > after).slice(0, limit)
    else if (before) list = list.filter((e) => Number(e.event_id) < before).slice(-limit)
    else list = list.slice(-limit)
    return ok({ events: list, next_after: events.length ? Number(events[events.length - 1].event_id) : null })
  }
  if (p === '/command') {
    if (req.method === 'GET') return ok({ messages })
    const content = String(body.content ?? '').trim()
    if (!content) return fail(422, 'CONTENT_REQUIRED', 'Say something to the COO')
    const ceo = { message_id: `wfx_live_${nextMsg++}`, mission_id: null as string | null, author: 'ceo', author_user_id: 'owner', content, refs: [], created_at: new Date().toISOString() }
    const actionable = /^(find|get|increase|move|triage|diagnose|why|revive|review)\b/i.test(content)
    if (actionable) {
      const m = openLive(content, String(body.client_request_id ?? ''))
      ceo.mission_id = String(m.mission_id)
      const coo = { message_id: `wfx_live_${nextMsg++}`, mission_id: m.mission_id, author: 'coo', author_employee_id: 'emp_coo_atlas', content: m.playbook_key === 'status_review' ? 'Opened as a status review of that property. Planning now.' : 'Opened as an opportunity triage. Planning now; you will see each assignment as it moves.', refs: [{ type: 'mission', id: m.mission_id, label: m.title }], created_at: new Date().toISOString() }
      messages.push(ceo, coo)
      return ok({ messages: [ceo, coo], mission: missionRow(m) })
    }
    const blocked = assignments.filter((a) => a.status === 'blocked').length
    const waiting = assignments.filter((a) => a.status === 'waiting_approval').length
    const active = missions.filter((m) => m.status === 'active' || m.status === 'planning').length
    const coo = { message_id: `wfx_live_${nextMsg++}`, mission_id: null, author: 'coo', author_employee_id: 'emp_coo_atlas', content: `From live state: ${active} mission${active === 1 ? '' : 's'} running, ${blocked} assignment${blocked === 1 ? '' : 's'} blocked, ${waiting} waiting on you. The one waiting on you is 1533 Kessler Pkwy.`, refs: [propRef(7)], created_at: new Date().toISOString() }
    messages.push(ceo, coo)
    return ok({ messages: [ceo, coo] })
  }
  if (p === '/authority') {
    if (req.method === 'GET') return ok(authority)
    if (body.op === 'revoke') {
      const pol = authority.policies.find((x) => x.policy_id === body.policy_id)
      if (!pol) return fail(404, 'NOT_FOUND', 'No such policy')
      pol.status = 'revoked'
      return ok({ policy: pol })
    }
    return fail(403, 'CEO_ONLY', 'Fixture mode does not author policies')
  }
  if (req.method === 'GET' && p === '/kpis') return ok({ kpis: FX_KPIS })
  if (req.method === 'GET' && p === '/reports') {
    return ok({
      reports: missions.filter((m) => m.report).map((m) => ({ mission_id: m.mission_id, title: m.title, status: m.status, completed_at: m.completed_at, report: m.report })),
      daily_brief: FX_REPORTS_BRIEF,
    })
  }
  return fail(404, 'NOT_MOUNTED', `Fixture has no route for ${req.method} ${p}`)
}

/** Fixture latency: enough to show skeletons once, never theatrical. */
export const wfFixtureTransport: WfTransport = (req) => new Promise((resolve, reject) => {
  if (req.signal?.aborted) { resolve({ ok: false, status: 499, error: 'BACKEND_REQUEST_CANCELLED', message: 'cancelled' }); return }
  const t = setTimeout(() => { try { resolve(route(req)) } catch (e) { reject(e) } }, 120 + Math.round(Math.random() * 120))
  req.signal?.addEventListener('abort', () => { clearTimeout(t); resolve({ ok: false, status: 499, error: 'BACKEND_REQUEST_CANCELLED', message: 'cancelled' }) })
})

if (typeof window !== 'undefined') (window as unknown as { __wfFx?: { speed: number } }).__wfFx = { speed: 1 }
