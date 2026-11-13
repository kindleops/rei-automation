// adjust_campaign_plan (T2, request_only): ask a HUMAN to apply a BOUNDED change to a campaign's plan: caps
// (daily / total / market / per sender / batch), pacing (send interval) and the texting window, within policy
// (08:00 to 21:00 recipient-local, the outreach policy). The closed input schema has no audience, market,
// filter, eligibility, template, live-flag or status field, so the agent can never widen the audience or bypass
// eligibility. On a named operator's approval campaigns.prepare_plan_adjustment_approval runs
// campaign-automation-service#updateCampaign with exactly these fields (its own cap validation applies).
import { UUID, int, obj } from '../../../../agent/capabilities/defs/_schema.js'
import { hashCanonical } from '../../../../agent/runtime/canonical.js'
import { normalizeCampaignStatus } from '../../../campaigns/campaign-state-machine.js'
import { TIERS } from '../../constants.js'
import { client, HHMM, TEXT } from './_schema.js'
import { agentSource, cleanText, deny, allow } from './shared.js'
import { buildHumanRequest, fileHumanRequest, campaignSnapshot, PLAN_FIELDS } from './requests.js'
import { campaignResource, mustCampaign } from './pause-campaign.js'

export const WINDOW_POLICY = Object.freeze({ earliest: '08:00', latest: '21:00' })
const CAP = int(0, 100000)
export const CHANGES_SCHEMA = obj({ daily_cap: CAP, total_cap: CAP, market_cap: CAP, per_sender_cap: CAP, batch_max: CAP, send_interval_seconds: int(15, 3600), contact_window_start: HHMM, contact_window_end: HHMM })

/** Pure: is this bounded change inside policy against the campaign's current window? null = yes. */
export function planAdjustmentVerdict(changes = {}, current = {}) {
  const keys = Object.keys(changes)
  if (!keys.length) return { code: 'NOTHING_TO_ADJUST' }
  if (keys.some((k) => !PLAN_FIELDS.includes(k))) return { code: 'ADJUSTMENT_FIELD_NOT_ALLOWED' }
  const start = changes.contact_window_start ?? (current.contact_window_start ? String(current.contact_window_start).slice(0, 5) : null)
  const end = changes.contact_window_end ?? (current.contact_window_end ? String(current.contact_window_end).slice(0, 5) : null)
  for (const w of [changes.contact_window_start, changes.contact_window_end]) if (w != null && (w < WINDOW_POLICY.earliest || w > WINDOW_POLICY.latest)) return { code: 'WINDOW_OUTSIDE_POLICY' }
  if ((changes.contact_window_start != null || changes.contact_window_end != null) && start && end && !(start < end)) return { code: 'WINDOW_EMPTY' }
  return null
}

export const spec = {
  name: 'adjust_campaign_plan',
  title: 'Propose a bounded campaign plan adjustment',
  description: 'Ask a human to adjust a campaign\'s caps, pacing or texting window (08:00 to 21:00 local). Never the audience, market, filters, templates, eligibility or live flags. Nothing changes until a named operator approves.',
  capability: 'campaigns.adjust_plan', tier: TIERS.T2, resource: 'campaign', reversible: false, request_only: true,
  input: obj({ ...client, campaign_id: UUID, changes: CHANGES_SCHEMA, reason: TEXT(240, 3) }, ['client_request_id', 'campaign_id', 'changes', 'reason']),
  executor: { kind: 'js', fn: 'filePlanAdjustmentRequest' },
  recovery: 'reexecute',
  limits: { per_min: 6 },
  wraps: { service: 'capabilities campaigns.prepare_plan_adjustment_approval → campaign-automation-service#updateCampaign (bounded patch, human approval only)', module: 'apps/api/src/lib/agent/capabilities/defs/action-gateway-requests.js' },
  touches: ['approval_request'],
}

export const logic = {
  async resolve(input, { services }) { return campaignResource(await mustCampaign(services, input.campaign_id)) },
  params(input, resource, { principal }) {
    const changes = Object.fromEntries(PLAN_FIELDS.filter((k) => input.changes?.[k] !== undefined).map((k) => [k, input.changes[k]]))
    return { campaign_id: resource.id, changes, reason: cleanText(input.reason, 240), source: agentSource(principal.agent_id) }
  },
  async policy({ resource, params }) {
    const row = resource.refs.row
    const status = normalizeCampaignStatus(row.status)
    if (['archived', 'completed'].includes(status)) return deny('CAMPAIGN_CLOSED', { status })
    const v = planAdjustmentVerdict(params.changes, row)
    if (v) return deny(v.code)
    return allow({ fields: Object.keys(params.changes), executes: 'on human approval only' })
  },
  async execute({ intent, services, lease_token, org_id }) {
    const p = intent.params
    const snapshot = campaignSnapshot(await services.t2.campaign(p.campaign_id), p.campaign_id)
    const before = Object.fromEntries(Object.keys(p.changes).map((k) => [k, snapshot[k] ?? null]))
    const request = buildHumanRequest({
      action: 'adjust_campaign_plan', org_id, target: { campaign_id: p.campaign_id },
      intended_change: { action: 'plan_adjustment', campaign_id: p.campaign_id, changes: p.changes, reason: p.reason, source: p.source, from_status: snapshot.status, before },
      snapshot, idempotency: hashCanonical({ c: p.campaign_id, ch: p.changes }),
      summary: [`Agent request: adjust this campaign's ${Object.keys(p.changes).join(', ')}`, `Reason: ${p.reason}`, 'Caps, pacing and the texting window only (08:00 to 21:00 local); never the audience, market or eligibility.'],
    })
    return fileHumanRequest({ intent, services, lease_token, request })
  },
}
