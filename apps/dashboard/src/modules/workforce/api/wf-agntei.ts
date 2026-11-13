/**
 * WORKFORCE × AGNTEI — wire normalizers for the identity / activity / link fields (docs/WORKFORCE-AGNTEI.md §1, §4).
 * Same rule as wf-normalize: a missing or mistyped field is null ("Unknown"), never a fabricated value.
 */
import { arr, obj, str, num } from './wf-normalize'
import type { WfActivity, WfEmployeeLink, WfEmploymentType, WfGatewayAuditEvent, WfHistory, WfLinkStep, WfLinkSteps, WfOrigin } from './wf-types'

type Obj = Record<string, unknown>
const strs = (v: unknown): string[] => arr(v).map((x) => str(x)).filter((x): x is string => Boolean(x))
const EMPLOYMENT: readonly string[] = ['autonomous_ai', 'operator_ai', 'human']

export function normalizeActivity(v: unknown): WfActivity | null {
  const o = obj(v)
  const state = str(o.state)
  if (!state) return null
  return { state, reason: str(o.reason), label: str(o.label), last_seen_at: str(o.last_seen_at), open: num(o.open) }
}

/** The fields an employee row gains (spread into normalizeEmployee). */
export function agnteiEmployeeFields(o: Obj) {
  const et = str(o.employment_type)
  const origin = str(o.origin)
  return {
    employment_type: (et && EMPLOYMENT.includes(et) ? et : null) as WfEmploymentType | null,
    origin: (origin === 'agntei' || origin === 'workforce' ? origin : null) as WfOrigin | null,
    external_agent_id: str(o.external_agent_id),
    external_linked_at: str(o.external_linked_at),
    binding_valid_until: str(o.binding_valid_until),
    binding_revoked_at: str(o.binding_revoked_at),
    skills: strs(o.skills),
    property_specializations: strs(o.property_specializations),
    availability: str(o.availability),
    activity: normalizeActivity(o.activity),
  }
}

/** The fields an assignment row gains (spread into normalizeAssignment). */
export function agnteiAssignmentFields(o: Obj) {
  const m = str(o.execution_mode)
  return { execution_mode: (m === 'internal' || m === 'external' ? m : null) as 'internal' | 'external' | null, activity: normalizeActivity(o.activity) }
}

export function normalizeLink(v: unknown): WfEmployeeLink | null {
  const o = obj(v)
  if (o.system !== 'agntei') return null
  return {
    system: 'agntei', principal_id: str(o.principal_id), bound_at: str(o.bound_at), link_expires_at: str(o.link_expires_at), binding_valid_until: str(o.binding_valid_until),
    binding_revoked_at: str(o.binding_revoked_at), linked: o.linked === true, external_agent_id: str(o.external_agent_id), external_install_id: str(o.external_install_id), linked_at: str(o.linked_at),
  }
}

export function normalizeLinkSteps(v: unknown): WfLinkSteps | null {
  const o = obj(v)
  const agent_id = str(o.agent_id)
  const steps = arr(o.steps).map((x): WfLinkStep | null => {
    const s = obj(x)
    const id = str(s.id)
    const command = str(s.command)
    return id && command ? { id, title: str(s.title) ?? id, who: str(s.who) ?? 'owner', kind: str(s.kind) ?? 'shell', command, note: str(s.note) } : null
  }).filter((s): s is WfLinkStep => Boolean(s))
  if (!agent_id || !steps.length) return null
  return { agent_id, employee_id: str(o.employee_id), tools: strs(o.tools), steps }
}

function normalizeAudit(v: unknown): WfGatewayAuditEvent | null {
  const o = obj(v)
  const id = num(o.event_id)
  const type = str(o.event_type)
  if (id === null || !type) return null
  return { event_id: id, at: str(o.at), event_type: type, action: str(o.action), code: str(o.code), intent_id: str(o.intent_id) }
}

export function normalizeHistory(v: unknown, normalizeEvent: (e: unknown) => WfHistory['events'][number] | null): WfHistory | null {
  if (!v || typeof v !== 'object') return null
  const o = obj(v)
  return {
    events: arr(o.events).map(normalizeEvent).filter((e): e is WfHistory['events'][number] => Boolean(e)),
    events_available: o.events_available !== false,
    gateway: arr(o.gateway).map(normalizeAudit).filter((e): e is WfGatewayAuditEvent => Boolean(e)),
    gateway_available: o.gateway_available === true,
    gateway_reason: str(o.gateway_reason),
  }
}
