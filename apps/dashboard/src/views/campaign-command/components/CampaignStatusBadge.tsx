import { operatorStateLabel } from '../campaign-operator'
import type { CampaignStatus, CampaignSummary } from '../campaigns.types'
import { cls } from '../campaign-formatters'

const STATUS_LABELS: Record<CampaignStatus, string> = {
  active: 'Active',
  ready: 'Ready',
  built: 'Targets Built',
  queued: 'Queued',
  live_limited: 'Live Limited',
  paused: 'Paused',
  scheduled: 'Scheduled',
  draft: 'Draft',
  previewed: 'Previewed',
  activating: 'Activating',
  failed: 'Failed',
  completed: 'Completed',
  archived: 'Archived',
}

export function CampaignStatusBadge({
  status,
  executionProof,
}: {
  status: CampaignStatus
  executionProof?: CampaignSummary['execution_proof']
}) {
  const operatorLabel = executionProof?.proof_mode ? 'Test' : null
  const label = operatorLabel
    ?? (executionProof?.proof_mode
      ? operatorStateLabel({ status, execution_proof: executionProof } as CampaignSummary)
      : (STATUS_LABELS[status] ?? status))

  return (
    <span className={cls('ccc-status', `is-${status}`, executionProof?.proof_mode && 'is-proof')}>
      <span className="ccc-status__dot" />
      {label}
    </span>
  )
}