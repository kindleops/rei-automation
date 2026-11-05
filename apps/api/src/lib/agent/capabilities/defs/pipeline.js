// Pipeline capabilities. Stage is a PROJECTION of offer / contract / closing
// events: the agent reads the evidence and may only PROPOSE a stage change; the
// approved change runs transitionOpportunityStage (its money/contract guard and
// the closing authority apply). The agent never supplies an offer event, a
// valuation or a closing: those inputs do not exist in the schema.
import { hashCanonical } from '../../runtime/canonical.js'
import { maskContacts } from '../../research/pii.js'
import { refusal } from '../registry.js'
import { UUID, str, obj, clean, lower, isoOrNull } from './_schema.js'

const STAGE_RE = '^[a-z][a-z0-9_]{1,39}$'
/** Closed-won is a closing-authority action, never a proposed stage move. */
const CLOSING_ONLY = new Set(['closed', 'closed_won'])
/** Contract / closing stages an agent (Action Gateway) request may never reach. */
const CONTRACT_STAGES = new Set(['formal_contract', 'contract_to_close', 'disposition', 'under_contract', 'prepared_to_close', 'closed', 'closed_won', 'closed_lost'])

function stageSnapshot(row) {
  return { opportunity_id: row?.id || null, stage: lower(row?.acquisition_stage) || null, status: lower(row?.opportunity_status) || null, stage_entered_at: isoOrNull(row?.stage_entered_at) }
}

const cleanReason = (s) => maskContacts(clean(s).replace(/[\u0000-\u001f]/g, ' ').slice(0, 240)).value

export const pipelineCapabilities = [
  {
    id: 'pipeline.inspect_stage_evidence',
    version: 1,
    domain: 'pipeline',
    title: 'Inspect stage evidence',
    description: 'An opportunity\'s current stage and the events it is projected from: stage history, offer events (status / direction / dates), closing state and conversation counts. No message text, no valuations.',
    input_schema: obj({ opportunity_id: UUID }, ['opportunity_id']),
    output_schema: { type: 'object' },
    side_effect: 'read',
    tier: 'autonomous_internal',
    cost_class: 'db_heavy',
    limits: { per_min: 20, per_day: 1000, timeout_ms: 30_000, rows_to_model: 40 },
    wraps: { service: 'pipeline-command-service#getPipelineDealStory + opportunity-service#getOpportunityById' },
    async execute(input, ctx) {
      const [row, story] = await Promise.all([ctx.services.pipeline.get(input.opportunity_id), ctx.services.pipeline.story(input.opportunity_id)])
      if (!row || !story) throw refusal('OPPORTUNITY_NOT_FOUND')
      const offers = Array.isArray(story.negotiation?.offers) ? story.negotiation.offers : []
      return {
        current: stageSnapshot(row),
        temperature: row.lead_temperature || row.temperature || null,
        market: row.market || null,
        property_id: row.property_id ? String(row.property_id) : null,
        offer_events: offers.slice(0, 20).map((o) => ({ direction: o.direction || null, status: o.status || null, has_price: o.price != null, sent_at: isoOrNull(o.sentAt), accepted_at: isoOrNull(o.acceptedAt) })),
        closing: story.closing && typeof story.closing === 'object' ? { state: story.closing.state || story.closing.status || null, case: Boolean(story.closing.caseId || story.closing.closing_case_id) } : null,
        conversation: { messages: Number(story.conversation?.messages || 0), inbound: Number(story.conversation?.inbound || 0), last_inbound_at: isoOrNull(story.conversation?.lastInbound?.at), last_inbound_intent: story.conversation?.lastInbound?.intent || null },
        timeline: (Array.isArray(story.story) ? story.story : []).slice(-40).map((b) => ({ at: isoOrNull(b.at), kind: b.kind || null, title: clean(b.title).slice(0, 120) || null })),
      }
    },
    audit: (input) => ({ opportunity_id: input.opportunity_id }),
  },
  {
    id: 'pipeline.propose_stage_change',
    version: 1,
    domain: 'pipeline',
    title: 'Propose a stage change for approval',
    description: 'Prepares a PENDING stage-change approval. The pipeline\'s own transition validation runs as a dry run now and again on approval; money / contract stages still require real offer / contract events. Closed-won is never proposable (closing authority only).',
    input_schema: obj({ opportunity_id: UUID, to_stage: str(40, { pattern: STAGE_RE }), reason: str(240, { minLength: 3 }) }, ['opportunity_id', 'to_stage', 'reason']),
    output_schema: { type: 'object' },
    side_effect: 'internal_write',
    tier: 'requires_explicit_approval',
    approval_class: 'pipeline',
    cost_class: 'db_light',
    limits: { per_min: 6, per_day: 100, timeout_ms: 30_000, rows_to_model: 10 },
    touches: ['pipeline_stage', 'approval_request'],
    wraps: { service: 'opportunity-service#transitionOpportunityStage (human approval only)' },
    compensation: { kind: 'inverse_stage_move', note: 'Propose the reverse move (to the recorded from_stage) — itself an approval.' },
    idempotency: (input) => hashCanonical({ o: input.opportunity_id, s: input.to_stage }),
    async prepare(input, ctx) {
      if (CLOSING_ONLY.has(input.to_stage)) return { ok: false, code: 'CLOSING_AUTHORITY_ONLY' }
      const row = await ctx.services.pipeline.get(input.opportunity_id)
      if (!row) return { ok: false, code: 'OPPORTUNITY_NOT_FOUND' }
      const snap = stageSnapshot(row)
      if (snap.stage === input.to_stage) return { ok: false, code: 'ALREADY_IN_STAGE' }
      const reason = cleanReason(input.reason)
      const v = await ctx.services.pipeline.validate({ fromStage: row.acquisition_stage, toStage: input.to_stage, opportunityStatus: row.opportunity_status, reason })
      if (v && v.ok === false) return { ok: false, code: String(v.code || v.error || 'TRANSITION_INVALID').toUpperCase(), detail: { message: clean(v.message).slice(0, 200) || null } }
      return {
        ok: true,
        target: { opportunity_id: input.opportunity_id },
        intended_change: { action: 'stage_change', opportunity_id: input.opportunity_id, from_stage: snap.stage, to_stage: input.to_stage, reason },
        snapshot: snap,
        summary: [`Move opportunity from ${snap.stage || 'unknown'} → ${input.to_stage}`, `Reason: ${reason}`, 'On approval the pipeline transition re-validates; offer / contract stages need recorded events.'],
      }
    },
    async snapshot(target, ctx) {
      return stageSnapshot(await ctx.services.pipeline.get(target.opportunity_id))
    },
    async executeApproved(change, ctx) {
      // R1: the source is SERVER-derived. A request the Action Gateway filed carries its authenticated agent
      // (action_gateway:<agent>, set by the gateway, bound by the payload hash); anything else is agent_approval.
      // Neither is a manual or closing-authority source, so the money / contract guard applies in full.
      const gatewaySourced = /^action_gateway:agt_[a-z0-9][a-z0-9_]{2,40}$/.test(String(change.source || ''))
      if (CLOSING_ONLY.has(lower(change.to_stage)) || (gatewaySourced && CONTRACT_STAGES.has(lower(change.to_stage)))) return { ok: false, code: 'CLOSING_AUTHORITY_ONLY', from_stage: change.from_stage, to_stage: change.to_stage }
      const r = await ctx.services.pipeline.transition(change.opportunity_id, { to_stage: change.to_stage, reason: change.reason, source: gatewaySourced ? change.source : 'agent_approval', actor: ctx.approver })
      const back = stageSnapshot(await ctx.services.pipeline.get(change.opportunity_id))
      return { ok: r?.ok === true && back.stage === lower(change.to_stage), code: r?.ok ? null : clean(r?.code || r?.error) || 'transition_refused', from_stage: change.from_stage, to_stage: change.to_stage, readback: { stage: back.stage, status: back.status } }
    },
    audit: (input) => ({ opportunity_id: input.opportunity_id, to_stage: input.to_stage }),
  },
]
