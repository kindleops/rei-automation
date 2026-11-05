// update_lead_stage (T2, request_only): PROPOSE a stage change for a human. Pipeline = projection: the agent
// supplies a target stage and a reason only, never an offer event, a valuation or a source; the source is the
// authenticated agent (R1). REUSES the capability plane's pipeline.propose_stage_change: on a named operator's
// approval its executeApproved runs opportunity-service#transitionOpportunityStage with every existing rule
// (hold on advance, the money / contract guard, the closing authority). Contract / closing stages (S6+, S10)
// are refused outright: S10 is finalize_closing_case only, by a human.
import { hashCanonical } from '../../../../agent/runtime/canonical.js'
import { UUID, obj } from '../../../../agent/capabilities/defs/_schema.js'
import { isStageAdvance } from '../../../holds/automation-hold-core.js'
import { TIERS } from '../../constants.js'
import { gwErr } from '../../errors.js'
import { client, CODE, TEXT } from './_schema.js'
import { agentSource, cleanText, holdVerdict, neverReviveCode, deny, allow, CONTRACT_OR_CLOSING_STAGES, AGENT_PROPOSABLE_STAGES } from './shared.js'
import { buildHumanRequest, fileHumanRequest, normalizedStageRow, stageSnapshotOf } from './requests.js'

export const spec = {
  name: 'update_lead_stage',
  title: 'Propose a lead stage change',
  description: 'Ask a human to move an opportunity to another pipeline stage (S1 to S5 only). Nothing changes until a named operator approves; the pipeline transition then re-runs every rule (holds, offer events for Offer, the closing authority). Contract and closing stages are never proposable.',
  capability: 'leads.update_stage', tier: TIERS.T2, resource: 'opportunity', reversible: false, request_only: true,
  input: obj({ ...client, opportunity_id: UUID, to_stage: CODE, reason: TEXT(240, 3) }, ['client_request_id', 'opportunity_id', 'to_stage', 'reason']),
  executor: { kind: 'js', fn: 'fileStageRequest' },
  recovery: 'reexecute',
  limits: { per_min: 10 },
  wraps: { service: 'capabilities pipeline.propose_stage_change → opportunity-service#transitionOpportunityStage (human approval only)', module: 'apps/api/src/lib/agent/capabilities/defs/pipeline.js' },
  touches: ['approval_request'],
}

export const logic = {
  async resolve(input, { services }) {
    const o = await services.t2.opportunity(input.opportunity_id)
    if (!o) throw gwErr('not_found', 'OPPORTUNITY_NOT_FOUND', 'no opportunity with this id')
    return { type: 'opportunity', id: String(o.id), refs: { opportunity_id: String(o.id), market: o.market || null, row: o } }
  },
  params(input, resource, { principal }) {
    return { opportunity_id: resource.id, to_stage: String(input.to_stage).toLowerCase(), reason: cleanText(input.reason, 240), source: agentSource(principal.agent_id) }
  },
  async policy({ resource, params, services }) {
    const o = resource.refs.row
    const never = neverReviveCode({ opportunity_id: o.id, property_id: o.primary_property_id, thread_key: o.primary_thread_key })
    if (never) return deny(never)
    if (CONTRACT_OR_CLOSING_STAGES.has(params.to_stage)) return deny('CONTRACT_OR_CLOSING_STAGE_REFUSED', { to_stage: params.to_stage, closing: 'finalize_closing_case only, by a human' })
    if (!AGENT_PROPOSABLE_STAGES.includes(params.to_stage)) return deny('STAGE_NOT_PROPOSABLE', { to_stage: params.to_stage })
    const row = await normalizedStageRow(o)
    if (row.acquisition_stage === params.to_stage) return deny('ALREADY_IN_STAGE', { stage: row.acquisition_stage })
    if (isStageAdvance(row.acquisition_stage, params.to_stage)) {
      const h = await holdVerdict(services, { opportunityId: o.id, threadKey: o.primary_thread_key || null, propertyId: o.primary_property_id || null, masterOwnerId: o.master_owner_id || null }, 'stage_advance')
      if (h) return h
    }
    // the pipeline's OWN rules as a dry run now (they run again on approval)
    const { validateStageTransition } = await import('../../../opportunity/universal-pipeline-registry.js')
    const v = validateStageTransition({ fromStage: row.acquisition_stage, toStage: params.to_stage, opportunityStatus: row.opportunity_status, reason: params.reason })
    if (!v?.ok) return deny(String(v?.error || 'TRANSITION_INVALID').toUpperCase().slice(0, 80), { from_stage: row.acquisition_stage })
    const { evaluateStageAdvance } = await import('../../../opportunity/stage-advance-guard.js')
    const g = evaluateStageAdvance({ current: row, to_stage: params.to_stage, source: params.source, live_closing_case: false, offer_events: await services.t2.offerEvents(o.id), valuation: {} })
    if (!g.ok) return deny(String(g.code || 'STAGE_ADVANCE_BLOCKED').slice(0, 80), { from_stage: row.acquisition_stage })
    return allow({ from_stage: row.acquisition_stage, to_stage: params.to_stage, executes: 'on human approval only' })
  },
  async execute({ intent, services, lease_token, org_id }) {
    const p = intent.params
    const row = await normalizedStageRow(await services.t2.opportunity(p.opportunity_id))
    if (!row) return { status: 'failed', code: 'OPPORTUNITY_NOT_FOUND', result: {} }
    const snapshot = stageSnapshotOf(row)
    const request = buildHumanRequest({
      action: 'update_lead_stage', org_id, target: { opportunity_id: p.opportunity_id },
      intended_change: { action: 'stage_change', opportunity_id: p.opportunity_id, from_stage: snapshot.stage, to_stage: p.to_stage, reason: p.reason, source: p.source },
      snapshot, idempotency: hashCanonical({ o: p.opportunity_id, s: p.to_stage }),
      summary: [`Agent request: move this deal from ${snapshot.stage || 'unknown'} to ${p.to_stage}`, `Reason: ${p.reason}`, 'On approval the pipeline transition re-validates; Offer needs a recorded offer event; contract and closing stages are never proposable.'],
    })
    return fileHumanRequest({ intent, services, lease_token, request })
  },
}
