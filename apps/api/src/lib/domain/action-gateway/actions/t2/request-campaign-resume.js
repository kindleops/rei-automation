// request_campaign_resume (T2, request_only): ask a HUMAN to resume a paused campaign. The agent never resumes a
// campaign: its execution files ONE approval of campaigns.prepare_resume_approval; on a named operator's
// approval the capability runs campaign-automation-service#applyCampaignLifecycleAction('resume'), which
// re-checks the launch + resume readiness (every blocker refuses) as that operator.
import { UUID, obj } from '../../../../agent/capabilities/defs/_schema.js'
import { hashCanonical } from '../../../../agent/runtime/canonical.js'
import { normalizeCampaignStatus } from '../../../campaigns/campaign-state-machine.js'
import { TIERS } from '../../constants.js'
import { client, TEXT } from './_schema.js'
import { agentSource, cleanText, deny, allow } from './shared.js'
import { buildHumanRequest, fileHumanRequest, campaignSnapshot } from './requests.js'
import { campaignResource, mustCampaign } from './pause-campaign.js'

export const spec = {
  name: 'request_campaign_resume',
  title: 'Request a campaign resume (a human decides)',
  description: 'Ask a human to resume a paused campaign. Nothing resumes until a named operator approves; the campaign lifecycle then re-checks launch and resume readiness, suppression, templates and sender coverage.',
  capability: 'campaigns.request_resume', tier: TIERS.T2, resource: 'campaign', reversible: false, request_only: true,
  input: obj({ ...client, campaign_id: UUID, reason: TEXT(240, 3) }, ['client_request_id', 'campaign_id', 'reason']),
  executor: { kind: 'js', fn: 'fileResumeRequest' },
  recovery: 'reexecute',
  limits: { per_min: 6 },
  wraps: { service: 'capabilities campaigns.prepare_resume_approval → campaign-automation-service#applyCampaignLifecycleAction(resume) (human approval only)', module: 'apps/api/src/lib/agent/capabilities/defs/action-gateway-requests.js' },
  touches: ['approval_request'],
}

export const logic = {
  async resolve(input, { services }) { return campaignResource(await mustCampaign(services, input.campaign_id)) },
  params(input, resource, { principal }) { return { campaign_id: resource.id, reason: cleanText(input.reason, 240), source: agentSource(principal.agent_id) } },
  async policy({ resource }) {
    const from = normalizeCampaignStatus(resource.refs.row.status)
    if (String(resource.refs.row.status || '').toLowerCase() !== 'paused') return deny('CAMPAIGN_NOT_PAUSED', { from_status: from })
    return allow({ from_status: 'paused', executes: 'on human approval only, readiness re-checked' })
  },
  async execute({ intent, services, lease_token, org_id }) {
    const p = intent.params
    const snapshot = campaignSnapshot(await services.t2.campaign(p.campaign_id), p.campaign_id)
    const request = buildHumanRequest({
      action: 'request_campaign_resume', org_id, target: { campaign_id: p.campaign_id },
      intended_change: { action: 'resume', campaign_id: p.campaign_id, from_status: snapshot.status, reason: p.reason, source: p.source },
      snapshot, idempotency: hashCanonical({ c: p.campaign_id, a: 'resume' }),
      summary: ['Agent request: resume this paused campaign', `Reason: ${p.reason}`, 'On approval the campaign lifecycle re-checks launch and resume readiness; any blocker refuses the resume.'],
    })
    return fileHumanRequest({ intent, services, lease_token, request })
  },
}
