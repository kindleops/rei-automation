// pause_campaign (T2, reversible safety action): IMMEDIATE, through THE campaign lifecycle writer
// (campaign-state-machine#transitionCampaignStatus's canonical path public.campaign_transition_status, via the
// lease-bound action_gateway_dw_campaign_pause). Dispatch defers a paused campaign's rows
// (queue/campaign-execution-authority). Resuming is a human decision (request_campaign_resume).
import { UUID, enumOf, obj } from '../../../../agent/capabilities/defs/_schema.js'
import { normalizeCampaignStatus, isTransitionAllowed } from '../../../campaigns/campaign-state-machine.js'
import { TIERS } from '../../constants.js'
import { gwErr } from '../../errors.js'
import { client } from './_schema.js'
import { deny, allow } from './shared.js'

export const PAUSE_REASON_CODES = Object.freeze(['deliverability_concern', 'complaint_spike', 'wrong_audience', 'compliance_concern', 'reply_backlog', 'operator_requested', 'other'])

export const campaignResource = (c) => ({ type: 'campaign', id: String(c.id), refs: { campaign_id: String(c.id), row: c } })
export async function mustCampaign(services, id) {
  const c = await services.t2.campaign(id)
  if (!c) throw gwErr('not_found', 'CAMPAIGN_NOT_FOUND', 'no campaign with this id')
  return c
}

export const spec = {
  name: 'pause_campaign',
  title: 'Pause a campaign',
  description: 'Pause a running / scheduled campaign immediately through the campaign lifecycle (a reversible safety action: nothing is sent while paused). Resuming needs a human (request_campaign_resume).',
  capability: 'campaigns.pause', tier: TIERS.T2, resource: 'campaign', reversible: true,
  input: obj({ ...client, campaign_id: UUID, reason_code: enumOf(PAUSE_REASON_CODES) }, ['client_request_id', 'campaign_id', 'reason_code']),
  executor: { kind: 'domain_write', fn: 'action_gateway_dw_campaign_pause' },
  recovery: 'reexecute',
  limits: { per_min: 10 },
  wraps: { service: 'campaigns/campaign-state-machine#transitionCampaignStatus canonical path (public.campaign_transition_status), lease-bound', module: 'apps/api/src/lib/domain/campaigns/campaign-state-machine.js' },
  touches: ['campaign_lifecycle'],
}

export const logic = {
  async resolve(input, { services }) { return campaignResource(await mustCampaign(services, input.campaign_id)) },
  params(input, resource) { return { campaign_id: resource.id, reason_code: input.reason_code } },
  async policy({ resource }) {
    const from = normalizeCampaignStatus(resource.refs.row.status)
    if (from === 'paused') return allow({ from_status: from, already: true })
    if (!isTransitionAllowed(from, 'paused')) return deny('CAMPAIGN_NOT_PAUSABLE', { from_status: from })
    return allow({ from_status: from, to_status: 'paused', reversible_by: 'a human (request_campaign_resume)' })
  },
}
