// create_deal_action (T2, reversible): ONE operator / deal task bound to an opportunity. REUSES the operator work
// items (agent.ops_work_item, scope agent, kind agent_task, subject opportunity) through the lease-bound writer
// action_gateway_dw_deal_action: it lands in the Inbound Action Center, where a human acknowledges, resolves or
// dismisses it. Never a stage, an offer or a money field; nothing is sent.
import { UUID, int, enumOf, obj } from '../../../../agent/capabilities/defs/_schema.js'
import { TIERS } from '../../constants.js'
import { gwErr } from '../../errors.js'
import { client, ISO_TIME, TEXT } from './_schema.js'
import { cleanText, neverReviveCode, deny, allow } from './shared.js'

export const DEAL_ACTION_KINDS = Object.freeze(['call_seller', 'schedule_walkthrough', 'request_documents', 'review_comps', 'review_offer_position', 'verify_ownership', 'check_title', 'follow_up_check', 'other'])
const CLOSED_STATUSES = new Set(['dead', 'lost', 'archived', 'suppressed', 'won', 'closed'])

export const spec = {
  name: 'create_deal_action',
  title: 'Create a deal next action',
  description: 'Create one operator / deal task bound to an opportunity (call the seller, schedule a walkthrough, request documents, review comps, ...) in the Action Center. A human resolves or dismisses it. Never changes a stage, an offer or a price.',
  capability: 'deals.create_action', tier: TIERS.T2, resource: 'opportunity', reversible: true,
  input: obj({ ...client, opportunity_id: UUID, action_kind: enumOf(DEAL_ACTION_KINDS), title: TEXT(160, 3), note: TEXT(600), priority: int(0, 1000), due_at: ISO_TIME, severity: enumOf(['info', 'warning']) },
    ['client_request_id', 'opportunity_id', 'action_kind', 'title']),
  executor: { kind: 'domain_write', fn: 'action_gateway_dw_deal_action' },
  recovery: 'reexecute',
  limits: { per_min: 20 },
  wraps: { service: 'agent.ops_work_item (operations action center, scope agent, subject opportunity), lease-bound writer', module: 'apps/api/src/lib/agent/operations/operations-store.js' },
  touches: ['ops_work_item'],
}

export const logic = {
  async resolve(input, { services }) {
    const o = await services.t2.opportunity(input.opportunity_id)
    if (!o) throw gwErr('not_found', 'OPPORTUNITY_NOT_FOUND', 'no opportunity with this id')
    return { type: 'opportunity', id: String(o.id), refs: { opportunity_id: String(o.id), market: o.market || null, row: o } }
  },
  params(input, resource) {
    return {
      opportunity_id: resource.id, action_kind: input.action_kind, title: cleanText(input.title, 160), notes: input.note ? [cleanText(input.note, 600)] : [],
      priority: input.priority ?? 100, severity: input.severity || 'info', ...(input.due_at ? { due_at: new Date(input.due_at).toISOString() } : {}),
    }
  },
  async policy({ resource, input }) {
    const o = resource.refs.row
    const never = neverReviveCode({ opportunity_id: o.id, property_id: o.primary_property_id, thread_key: o.primary_thread_key })
    if (never) return deny(never)
    if (CLOSED_STATUSES.has(String(o.opportunity_status || '').toLowerCase())) return deny('OPPORTUNITY_CLOSED', { status: o.opportunity_status })
    if (input.due_at && !Number.isFinite(Date.parse(input.due_at))) return deny('DUE_AT_INVALID')
    return allow({ subject: 'opportunity', decided_by: 'a human in the Action Center' })
  },
}
