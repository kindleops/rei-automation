// request_thread_hold_release (T2, request_only): ask a HUMAN to release one hold. The agent can NEVER release a
// hold: its execution files ONE approval of holds.prepare_release_approval; a named operator decides it and the
// release is written as THAT operator (holds/automation-hold-release). The Maxwell permanent exclusion (every
// permanent_exclusion) and the Hartford hold (CLOSED LOST: never revive) are refused outright, here, in the
// database writer and again in the release writer.
import { UUID, enumOf, obj } from '../../../../agent/capabilities/defs/_schema.js'
import { hashCanonical } from '../../../../agent/runtime/canonical.js'
import { TIERS } from '../../constants.js'
import { client, TEXT } from './_schema.js'
import { agentSource, cleanText, neverReviveCode, deny, allow, mustThread, threadResource } from './shared.js'
import { buildHumanRequest, fileHumanRequest, holdSnapshot } from './requests.js'

export const RELEASE_REASON_CODES = Object.freeze(['seller_confirmed_ownership', 'issue_resolved', 'hold_set_in_error', 'conflict_resolved', 'operator_requested', 'other'])

export const spec = {
  name: 'request_thread_hold_release',
  title: 'Request a hold release (a human decides)',
  description: 'Ask a human to release one automation hold on a thread. The agent never releases a hold: this files a release request a named operator approves or denies. Permanent exclusions and the Hartford hold are refused outright.',
  capability: 'holds.request_release', tier: TIERS.T2, resource: 'thread', reversible: false, request_only: true,
  input: obj({ ...client, thread_id: UUID, hold_id: UUID, reason_code: enumOf(RELEASE_REASON_CODES), note: TEXT(300) }, ['client_request_id', 'thread_id', 'hold_id', 'reason_code']),
  executor: { kind: 'js', fn: 'fileHoldReleaseRequest' },
  recovery: 'reexecute',
  limits: { per_min: 10 },
  wraps: { service: 'capabilities holds.prepare_release_approval → holds/automation-hold-release#releaseAutomationHoldByOperator (human approval only)', module: 'apps/api/src/lib/domain/holds/automation-hold-release.js' },
  touches: ['approval_request'],
}

export const logic = {
  async resolve(input, { reads }) { return threadResource(await mustThread(reads, input.thread_id)) },
  params(input, resource, { principal }) {
    return { hold_id: input.hold_id, thread_id: resource.id, reason_code: input.reason_code, ...(input.note ? { note: cleanText(input.note, 300) } : {}), source: agentSource(principal.agent_id) }
  },
  async policy({ resource, params, services }) {
    const r = resource.refs
    const h = await services.t2.hold(params.hold_id)
    if (!h || h.released_at) return deny('HOLD_NOT_ACTIVE')
    if (!(String(h.inbox_thread_id || '') === r.thread_id || (h.thread_key && h.thread_key === r.thread_key))) return deny('HOLD_NOT_ON_THREAD')
    if (h.hold_type === 'permanent_exclusion') return deny('PERMANENT_EXCLUSION', { release: 'never by request' })
    const never = neverReviveCode({ hold_key: h.hold_key, thread_id: h.inbox_thread_id || r.thread_id, thread_key: h.thread_key || r.thread_key, property_id: h.property_id || r.property_id, opportunity_id: h.opportunity_id })
    if (never) return deny(never, { release: 'never by request' })
    return allow({ hold_type: h.hold_type, decided_by: 'a named operator', release_by_agent: false })
  },
  async execute({ intent, services, lease_token, org_id }) {
    const p = intent.params
    const snapshot = holdSnapshot(await services.t2.hold(p.hold_id), p.hold_id)
    const request = buildHumanRequest({
      action: 'request_thread_hold_release', org_id, target: { hold_id: p.hold_id },
      intended_change: { action: 'hold_release', hold_id: p.hold_id, thread_id: p.thread_id, reason_code: p.reason_code, ...(p.note ? { note: p.note } : {}), source: p.source, hold_type: snapshot.hold_type },
      snapshot, idempotency: hashCanonical({ h: p.hold_id, r: 'release' }),
      summary: ['Agent request: release an automation hold on this thread', `Reason: ${p.reason_code}${p.note ? ` (${p.note})` : ''}`, 'Approving releases it as YOU, audited in the hold registry. The agent cannot release holds.'],
    })
    return fileHumanRequest({ intent, services, lease_token, request })
  },
}
