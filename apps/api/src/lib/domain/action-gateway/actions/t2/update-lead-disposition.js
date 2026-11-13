// update_lead_disposition (T2, request_only): PROPOSE a disposition for a human. WRAPS
// lead-state/patch-universal-lead-state#patchUniversalLeadState through the capability plane's
// inbox.prepare_disposition_change (dry run first, then the write, as the approving operator). The owner's rules
// are applied here AND again on approval (dispositionRuleVerdict is shared):
//   * only the agent allowlist (never suppression / contactability / wrong number / wrong person);
//   * a "No thanks" / "Not interested" to the OWNERSHIP question is declined_unverified, never not_interested;
//   * a bare "No" to the ownership question is a property denial (the ownership pipeline records it), never a
//     disposition; a denied property × contact pair is never given an ownership-implying disposition;
//   * a held thread (incl. the ownership-unresolved thread hold), STOP and suppression refuse.
import { hashCanonical } from '../../../../agent/runtime/canonical.js'
import { UUID, obj } from '../../../../agent/capabilities/defs/_schema.js'
import { TIERS } from '../../constants.js'
import { client, CODE, TEXT } from './_schema.js'
import { agentSource, cleanText, holdVerdict, neverReviveCode, deny, allow, mustThread, threadResource, permissionOf, AGENT_DISPOSITIONS } from './shared.js'
import { buildHumanRequest, fileHumanRequest, dispositionSnapshot } from './requests.js'

const OWNERSHIP_IMPLYING = new Set(['interested', 'not_interested', 'sold', 'referred'])

/**
 * Pure: the owner's disposition rules over the thread's recent messages and its property × contact block.
 * @returns {null | { code: string, evidence: object }}  null = allowed
 */
export async function dispositionRuleVerdict({ to, from = null, messages = [], block = null }) {
  if (!AGENT_DISPOSITIONS.includes(to)) return { code: 'DISPOSITION_NOT_ALLOWED', evidence: { to } }
  if (from && from === to) return { code: 'ALREADY_SET', evidence: { to } }
  const [{ ownershipQuestionReply }, { bareNoAnswer }, { isOwnershipConfirmation, isBareNotInterested }] = await Promise.all([
    import('../../../followups/followup-lifecycle.js'), import('../../../conversation-ai/answers.js'), import('../../../classification/ownership-answer-forms.js')])
  const burst = ownershipQuestionReply(messages) || null
  if (burst && burst.length && !burst.some((m) => isOwnershipConfirmation(m.message_body || ''))) {
    const bare = burst.map((m) => bareNoAnswer(m.message_body || ''))
    if (bare.some((b) => b.matched && b.ownership_denial) && OWNERSHIP_IMPLYING.has(to)) return { code: 'PROPERTY_DENIAL_NOT_A_DISPOSITION', evidence: { rule: 'bare_no_to_ownership_question' } }
    const declined = burst.every((m) => { const b = bareNoAnswer(m.message_body || ''); return (b.matched && b.ownership_declined) || isBareNotInterested(m.message_body || '') || !String(m.message_body || '').trim() })
    if (declined && to === 'not_interested') return { code: 'DECLINED_UNVERIFIED_REQUIRED', evidence: { rule: 'decline_to_ownership_question_is_declined_unverified' } }
  }
  if (to === 'declined_unverified' && !(burst && burst.length)) return { code: 'NOT_AN_OWNERSHIP_ANSWER', evidence: { rule: 'declined_unverified_needs_an_ownership_question_reply' } }
  if (block?.blocked && block.kind === 'property_denial' && OWNERSHIP_IMPLYING.has(to)) return { code: 'PROPERTY_DENIED', evidence: { reason: block.reason } }
  if (block?.blocked && block.state === 'held' && OWNERSHIP_IMPLYING.has(to)) return { code: 'DECLINED_UNVERIFIED_HOLD', evidence: { reason: block.reason } }
  return null
}

export const spec = {
  name: 'update_lead_disposition',
  title: 'Propose a lead disposition',
  description: 'Ask a human to set a thread\'s disposition (interested, not interested, referred, no response, unqualified, duplicate, sold, declined (ownership unverified)). Nothing changes until a named operator approves; the lead-state writer then runs its dry run and every invariant. Never suppression, contactability, wrong number or wrong person.',
  capability: 'leads.update_disposition', tier: TIERS.T2, resource: 'thread', reversible: false, request_only: true,
  input: obj({ ...client, thread_id: UUID, disposition: CODE, reason: TEXT(240, 3) }, ['client_request_id', 'thread_id', 'disposition', 'reason']),
  executor: { kind: 'js', fn: 'fileDispositionRequest' },
  recovery: 'reexecute',
  limits: { per_min: 10 },
  wraps: { service: 'capabilities inbox.prepare_disposition_change → lead-state/patch-universal-lead-state#patchUniversalLeadState (human approval only)', module: 'apps/api/src/lib/domain/lead-state/patch-universal-lead-state.js' },
  touches: ['approval_request'],
}

export const logic = {
  async resolve(input, { reads }) { return threadResource(await mustThread(reads, input.thread_id)) },
  params(input, resource, { principal }) {
    return { thread_id: resource.id, to_disposition: String(input.disposition).toLowerCase(), reason: cleanText(input.reason, 240), source: agentSource(principal.agent_id) }
  },
  async policy({ resource, params, reads, services }) {
    const r = resource.refs
    const never = neverReviveCode({ thread_id: r.thread_id, thread_key: r.thread_key, property_id: r.property_id })
    if (never) return deny(never)
    if (!AGENT_DISPOSITIONS.includes(params.to_disposition)) return deny('DISPOSITION_NOT_ALLOWED', { to: params.to_disposition })
    const h = await holdVerdict(services, { threadKey: r.thread_key, threadId: r.thread_id, propertyId: r.property_id }, 'ai_action')
    if (h) return h
    const perm = await permissionOf(reads, resource)
    if (perm.blocked) return deny(perm.reasons.includes('stop_requested') ? 'STOP_REQUESTED' : 'CONTACT_NOT_PERMITTED', { reasons: perm.reasons })
    let messages, block, row
    try {
      ;[messages, block, row] = await Promise.all([services.t2.messages(r.thread_key), services.t2.propertyContactBlock({ thread_key: r.thread_key, phone: r.thread_key, property_id: r.property_id }), services.t2.thread(r.thread_id)])
    } catch { return deny('OWNERSHIP_FACTS_UNREADABLE') }
    const v = await dispositionRuleVerdict({ to: params.to_disposition, from: String(row?.disposition || '').toLowerCase() || null, messages, block })
    if (v) return deny(v.code, v.evidence)
    return allow({ to: params.to_disposition, executes: 'on human approval only' })
  },
  async execute({ intent, services, lease_token, org_id }) {
    const p = intent.params
    const row = await services.t2.thread(p.thread_id)
    if (!row) return { status: 'failed', code: 'THREAD_NOT_FOUND', result: {} }
    const snapshot = dispositionSnapshot(row)
    const request = buildHumanRequest({
      action: 'update_lead_disposition', org_id, target: { thread_id: p.thread_id },
      intended_change: { action: 'disposition_change', thread_id: p.thread_id, from_disposition: snapshot.disposition, to_disposition: p.to_disposition, reason: p.reason, source: p.source },
      snapshot, idempotency: hashCanonical({ t: p.thread_id, d: p.to_disposition }),
      summary: [`Agent request: set this thread's disposition from ${snapshot.disposition || 'none'} to ${p.to_disposition}`, `Reason: ${p.reason}`, 'On approval the lead-state writer runs its dry run, its invariants and the ownership rules again.'],
    })
    return fileHumanRequest({ intent, services, lease_token, request })
  },
}
