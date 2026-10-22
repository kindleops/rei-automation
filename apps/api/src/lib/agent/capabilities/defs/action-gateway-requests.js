// Capabilities a HUMAN decides for Action Gateway T2 REQUEST actions (docs/ACTION-MCP.md §8).
//
// Only the Action Gateway files these approvals (public.action_gateway_dw_human_request verifies every
// authority field against the agent's intent); prepare() refuses, and they are not model-facing tools of the
// operator-session plane (filed_by: 'action_gateway'). A named operator decides through the EXISTING path
// (POST /api/cockpit/agent/actions/approvals/:id/decide → approvals.decide: payload hash echo, drift re-check,
// single claim). executeApproved re-runs the owner's rules and calls the EXISTING service AS that operator.
// The drift snapshots are the shared ones (domain/action-gateway/actions/t2/requests.js), so the gateway and
// the decide path compute them identically.
import { hashCanonical } from '../../runtime/canonical.js'
import { UUID, obj } from './_schema.js'
import { dispositionSnapshot, holdSnapshot, campaignSnapshot } from '../../../domain/action-gateway/actions/t2/requests.js'
import { AGENT_SOURCE_RE, neverReviveCode } from '../../../domain/action-gateway/actions/t2/shared.js'
import { dispositionRuleVerdict } from '../../../domain/action-gateway/actions/t2/update-lead-disposition.js'
import { planAdjustmentVerdict } from '../../../domain/action-gateway/actions/t2/adjust-campaign-plan.js'

const gatewayOnly = async () => ({ ok: false, code: 'FILED_BY_ACTION_GATEWAY_ONLY' })
const fromAgent = (change) => AGENT_SOURCE_RE.test(String(change?.source || ''))
const refused = (code) => ({ ok: false, code })
const base = (o) => ({
  version: 1, output_schema: { type: 'object' }, tier: 'requires_explicit_approval', cost_class: 'db_light', min_role: 'operator', filed_by: 'action_gateway',
  limits: { per_min: 10, per_day: 500, timeout_ms: 30_000, rows_to_model: 5 }, prepare: gatewayOnly, ...o,
})

export const actionGatewayRequestCapabilities = [
  base({
    id: 'inbox.prepare_disposition_change',
    domain: 'inbox',
    title: 'Set a lead disposition (agent request)',
    description: 'A human decision on an agent\'s request to set ONE thread\'s disposition. Approving runs the lead-state writer (dry run, then the write) with every invariant and the ownership rules re-checked.',
    input_schema: obj({ thread_id: UUID }, ['thread_id']),
    side_effect: 'internal_write',
    approval_class: 'default',
    touches: ['lead_state'],
    wraps: { service: 'lead-state/patch-universal-lead-state#patchUniversalLeadState', module: 'apps/api/src/lib/domain/lead-state/patch-universal-lead-state.js' },
    compensation: { kind: 'inverse_disposition', note: 'A later request (or the operator in the inbox) sets the previous disposition back.' },
    idempotency: (input) => hashCanonical({ t: input.thread_id }),
    async snapshot(target, ctx) { return dispositionSnapshot(await ctx.services.leadState.threadRow(target.thread_id)) },
    async executeApproved(change, ctx) {
      if (!fromAgent(change)) return refused('SOURCE_NOT_AN_AGENT')
      const t = await ctx.services.leadState.threadRow(change.thread_id)
      if (!t?.thread_key) return refused('THREAD_NOT_FOUND')
      const never = neverReviveCode({ thread_id: t.id, thread_key: t.thread_key, property_id: t.property_id })
      if (never) return refused(never)
      if (t.is_suppressed === true) return refused('CONTACT_NOT_PERMITTED')
      const hold = await ctx.services.holds.check({ threadKey: t.thread_key, threadId: t.id, propertyId: t.property_id || null, capability: 'ai_action' })
      if (hold?.held !== false) return refused(hold?.fail_closed ? 'AUTOMATION_HOLD_LOOKUP_FAILED' : 'AUTOMATION_HOLD')
      const [messages, block] = await Promise.all([ctx.services.leadState.messages(t.thread_key), ctx.services.leadState.contactBlock({ thread_key: t.thread_key, phone: t.thread_key, property_id: t.property_id || null })])
      const v = await dispositionRuleVerdict({ to: change.to_disposition, from: String(t.disposition || '').toLowerCase() || null, messages, block })
      if (v) return refused(v.code)
      const args = { threadKey: t.thread_key, patch: { disposition: change.to_disposition }, meta: { change_source: 'ai', reason: change.reason, source_view: 'action_gateway', actor: ctx.approver, approval_id: ctx.approval_id, requested_by_agent: change.source } }
      const dry = await ctx.services.leadState.patch({ ...args, dryRun: true })
      if (!dry?.ok) return refused(String(dry?.reason || 'DRY_RUN_REFUSED').toUpperCase().slice(0, 80))
      const r = await ctx.services.leadState.patch(args)
      return { ok: r?.ok === true, code: r?.ok ? 'DISPOSITION_SET' : String(r?.reason || 'PATCH_REFUSED').toUpperCase().slice(0, 80), state: change.to_disposition }
    },
    audit: (input) => ({ thread_id: input?.thread_id || null }),
  }),
  base({
    id: 'holds.prepare_release_approval',
    domain: 'inbox',
    title: 'Release an automation hold (agent request)',
    description: 'A human decision on an agent\'s request to release ONE automation hold. Approving releases it AS YOU in the hold registry (audited). Permanent exclusions and the Hartford hold are never released this way.',
    input_schema: obj({ hold_id: UUID }, ['hold_id']),
    side_effect: 'internal_write',
    approval_class: 'default',
    touches: ['automation_hold'],
    wraps: { service: 'holds/automation-hold-release#releaseAutomationHoldByOperator', module: 'apps/api/src/lib/domain/holds/automation-hold-release.js' },
    compensation: { kind: 'set_hold_again', note: 'An operator (or an agent, set_thread_hold) sets a new hold.' },
    idempotency: (input) => hashCanonical({ h: input.hold_id }),
    async snapshot(target, ctx) { return holdSnapshot(await ctx.services.holds.row(target.hold_id), target.hold_id) },
    async executeApproved(change, ctx) {
      if (!fromAgent(change)) return refused('SOURCE_NOT_AN_AGENT')
      const r = await ctx.services.holds.release({ hold_id: change.hold_id, released_by: ctx.approver, release_reason: `agent_request:${change.reason_code}; approval:${ctx.approval_id}` })
      return { ok: r?.ok === true, code: r?.code || null, state: r?.state || null }
    },
    audit: (input) => ({ hold_id: input?.hold_id || null }),
  }),
  base({
    id: 'campaigns.prepare_resume_approval',
    domain: 'campaigns',
    title: 'Resume a paused campaign (agent request)',
    description: 'A human decision on an agent\'s request to resume ONE paused campaign. Approving runs the campaign lifecycle resume, which re-checks launch and resume readiness; any blocker refuses it.',
    input_schema: obj({ campaign_id: UUID }, ['campaign_id']),
    side_effect: 'outbound_prepare',
    approval_class: 'campaign_launch',
    touches: ['campaign_lifecycle'],
    wraps: { service: 'campaigns/campaign-automation-service#applyCampaignLifecycleAction(resume)', module: 'apps/api/src/lib/domain/campaigns/campaign-automation-service.js' },
    compensation: { kind: 'pause_campaign', note: 'Pause it again (pause_campaign / Campaign Command); sent messages cannot be recalled.' },
    idempotency: (input) => hashCanonical({ c: input.campaign_id, a: 'resume' }),
    async snapshot(target, ctx) { return campaignSnapshot(await ctx.services.campaigns.row(target.campaign_id), target.campaign_id) },
    async executeApproved(change, ctx) {
      if (!fromAgent(change)) return refused('SOURCE_NOT_AN_AGENT')
      const r = await ctx.services.campaigns.lifecycle(change.campaign_id, { action: 'resume', reason: `agent_request_approved:${ctx.approval_id}` })
      return { ok: r?.ok === true, code: r?.ok ? 'CAMPAIGN_RESUMED' : String(r?.code || r?.error || 'RESUME_REFUSED').slice(0, 80), state: r?.to || r?.state || null }
    },
    audit: (input) => ({ campaign_id: input?.campaign_id || null }),
  }),
  base({
    id: 'campaigns.prepare_plan_adjustment_approval',
    domain: 'campaigns',
    title: 'Adjust a campaign plan (agent request)',
    description: 'A human decision on an agent\'s bounded change to ONE campaign\'s caps, pacing or texting window (08:00 to 21:00 local). Approving writes exactly those fields through the campaign editor\'s validation; never audience, market or eligibility.',
    input_schema: obj({ campaign_id: UUID }, ['campaign_id']),
    side_effect: 'internal_write',
    approval_class: 'campaign_launch',
    touches: ['campaign_plan'],
    wraps: { service: 'campaigns/campaign-automation-service#updateCampaign (bounded patch)', module: 'apps/api/src/lib/domain/campaigns/campaign-automation-service.js' },
    compensation: { kind: 'inverse_adjustment', note: 'The intended change records the previous values (before); a new request sets them back.' },
    idempotency: (input) => hashCanonical({ c: input.campaign_id, a: 'plan' }),
    async snapshot(target, ctx) { return campaignSnapshot(await ctx.services.campaigns.row(target.campaign_id), target.campaign_id) },
    async executeApproved(change, ctx) {
      if (!fromAgent(change)) return refused('SOURCE_NOT_AN_AGENT')
      const row = await ctx.services.campaigns.row(change.campaign_id)
      if (!row) return refused('CAMPAIGN_NOT_FOUND')
      const v = planAdjustmentVerdict(change.changes || {}, row)
      if (v) return refused(v.code)
      const r = await ctx.services.campaigns.update(change.campaign_id, { ...change.changes })
      return { ok: r?.ok === true, code: r?.ok ? 'CAMPAIGN_PLAN_ADJUSTED' : String(r?.error || 'UPDATE_REFUSED').slice(0, 80) }
    },
    audit: (input) => ({ campaign_id: input?.campaign_id || null }),
  }),
]
