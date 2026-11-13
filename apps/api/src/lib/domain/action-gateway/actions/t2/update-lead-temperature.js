// update_lead_temperature (T2, request_only): PROPOSE a lead temperature for a human. WRAPS
// lead-state/patch-universal-lead-state#patchUniversalLeadState through the capability plane's
// inbox.prepare_temperature_change (dry run first, then the write, as the approving operator) — the same path
// as update_lead_disposition. The owner's rules are applied here AND again on approval (temperatureRuleVerdict
// is shared):
//   * a temperature is a PIPELINE label (cold / warm / hot from the universal lead-state registry), never a
//     contact-eligibility fact: a suppressed, opted-out or wrong-number contact keeps its eligibility state
//     untouched and a temperature request neither reads it as permission nor changes it
//     (docs/LEADCOMMAND-CORPUS-INTELLIGENCE.md §6: opportunity status and communication eligibility stay apart);
//   * an operator's manual temperature lock is final for agents (TEMPERATURE_LOCKED); the registry's own lock
//     guard refuses a non-manual write under the lock again at execution;
//   * a held thread (incl. the ownership-unresolved hold) and the never-revive identities refuse;
//   * every request names the EVIDENCE CLASS it rests on (seller words, a seller price or timeline, no response,
//     the Decision Engine, property evidence) and the agent's reason; a label is proposed, never evidence.
import { hashCanonical } from '../../../../agent/runtime/canonical.js'
import { UUID, obj } from '../../../../agent/capabilities/defs/_schema.js'
import { TIERS } from '../../constants.js'
import { client, CODE, TEXT } from './_schema.js'
import { agentSource, cleanText, holdVerdict, neverReviveCode, deny, allow, mustThread, threadResource, AGENT_TEMPERATURES, TEMPERATURE_BASES } from './shared.js'
import { buildHumanRequest, fileHumanRequest, temperatureSnapshot } from './requests.js'

/**
 * Pure: the owner's temperature rules over the thread row.
 * @returns {null | { code: string, evidence: object }}  null = allowed
 */
export function temperatureRuleVerdict({ to, row }) {
  if (!AGENT_TEMPERATURES.includes(to)) return { code: 'TEMPERATURE_NOT_ALLOWED', evidence: { to } }
  const from = String(row?.lead_temperature || row?.temperature || '').trim().toLowerCase() || null
  if (from && from === to) return { code: 'ALREADY_SET', evidence: { to } }
  if (row?.manual_temperature_lock === true) return { code: 'TEMPERATURE_LOCKED', evidence: { rule: 'operator_manual_temperature_lock', from } }
  return null
}

export const spec = {
  name: 'update_lead_temperature',
  title: 'Propose a lead temperature',
  description: 'Ask a human to set a thread\'s lead temperature (cold, warm, hot — the canonical LeadCommand registry) with the evidence class it rests on. Nothing changes until a named operator approves; the lead-state writer then runs its dry run and invariants. A temperature is a pipeline label: it never changes, and is never blocked by, contact eligibility (suppression, opt-out, wrong number stay exactly as recorded). An operator\'s manual temperature lock is final.',
  capability: 'leads.update_temperature', tier: TIERS.T2, resource: 'thread', reversible: false, request_only: true,
  input: obj({ ...client, thread_id: UUID, temperature: CODE, basis: CODE, reason: TEXT(240, 3) }, ['client_request_id', 'thread_id', 'temperature', 'basis', 'reason']),
  executor: { kind: 'js', fn: 'fileTemperatureRequest' },
  recovery: 'reexecute',
  limits: { per_min: 10 },
  wraps: { service: 'capabilities inbox.prepare_temperature_change → lead-state/patch-universal-lead-state#patchUniversalLeadState (human approval only)', module: 'apps/api/src/lib/domain/lead-state/patch-universal-lead-state.js' },
  touches: ['approval_request'],
}

export const logic = {
  async resolve(input, { reads }) { return threadResource(await mustThread(reads, input.thread_id)) },
  params(input, resource, { principal }) {
    return { thread_id: resource.id, to_temperature: String(input.temperature).toLowerCase(), basis: String(input.basis).toLowerCase(), reason: cleanText(input.reason, 240), source: agentSource(principal.agent_id) }
  },
  async policy({ resource, params, services }) {
    const r = resource.refs
    const never = neverReviveCode({ thread_id: r.thread_id, thread_key: r.thread_key, property_id: r.property_id })
    if (never) return deny(never)
    if (!AGENT_TEMPERATURES.includes(params.to_temperature)) return deny('TEMPERATURE_NOT_ALLOWED', { to: params.to_temperature })
    if (!TEMPERATURE_BASES.includes(params.basis)) return deny('BASIS_NOT_ALLOWED', { basis: params.basis })
    const h = await holdVerdict(services, { threadKey: r.thread_key, threadId: r.thread_id, propertyId: r.property_id }, 'ai_action')
    if (h) return h
    let row
    try { row = await services.t2.thread(r.thread_id) } catch { return deny('THREAD_UNREADABLE') }
    const v = temperatureRuleVerdict({ to: params.to_temperature, row })
    if (v) return deny(v.code, v.evidence)
    // deliberately NOT a permission check: contact eligibility (STOP / suppression / wrong number) is a separate authority and is left untouched
    return allow({ to: params.to_temperature, basis: params.basis, executes: 'on human approval only', contact_eligibility: 'not read, not changed' })
  },
  async execute({ intent, services, lease_token, org_id }) {
    const p = intent.params
    const row = await services.t2.thread(p.thread_id)
    if (!row) return { status: 'failed', code: 'THREAD_NOT_FOUND', result: {} }
    const snapshot = temperatureSnapshot(row)
    const request = buildHumanRequest({
      action: 'update_lead_temperature', org_id, target: { thread_id: p.thread_id },
      intended_change: { action: 'temperature_change', thread_id: p.thread_id, from_temperature: snapshot.temperature, to_temperature: p.to_temperature, basis: p.basis, reason: p.reason, source: p.source },
      snapshot, idempotency: hashCanonical({ t: p.thread_id, temp: p.to_temperature }),
      summary: [`Agent request: set this thread's temperature from ${snapshot.temperature || 'unscored'} to ${p.to_temperature} (basis: ${p.basis})`, `Reason: ${p.reason}`, 'On approval the lead-state writer runs its dry run and invariants; the temperature lock, holds and never-revive rules are re-checked. Contact eligibility is untouched.'],
    })
    return fileHumanRequest({ intent, services, lease_token, request })
  },
}
