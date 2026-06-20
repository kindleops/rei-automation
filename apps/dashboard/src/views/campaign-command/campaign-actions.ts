import { emitNotification } from '../../shared/NotificationToast'
import {
  buildCampaignTargetSnapshots,
  campaignLifecycle,
  cloneCampaign,
  deleteCampaign,
  queueBatch,
  type CampaignLifecycleAction,
} from './campaigns.adapter'
import { computeCampaignHealth, canDeleteDraft } from './campaign-health'
import type { CampaignSummary } from './campaigns.types'

export type CampaignActionCallbacks = {
  onRefresh: () => void | Promise<void>
  onOpenBuilder?: (campaign: CampaignSummary, mode: 'edit' | 'build' | 'schedule') => void
  onOpenSchedule?: (campaign: CampaignSummary, mode: 'schedule' | 'reschedule') => void
  onSelectTab?: (campaignId: string, tab: string) => void
}

const LIFECYCLE_MAP: Record<string, CampaignLifecycleAction> = {
  pause: 'pause',
  resume: 'resume',
  start: 'activate',
  activate: 'activate',
  'activate-now': 'activate',
  schedule: 'schedule',
  reschedule: 'schedule',
  unschedule: 'unschedule',
  cancel: 'unschedule',
  archive: 'archive',
  complete: 'complete',
}

export async function executeCampaignAction(
  action: string,
  campaign: CampaignSummary,
  callbacks: CampaignActionCallbacks,
  payload: Record<string, unknown> = {},
): Promise<boolean> {
  try {
    if (action === 'refresh') {
      await callbacks.onRefresh()
      return true
    }

    if (action === 'open' || action === 'edit') {
      callbacks.onOpenBuilder?.(campaign, 'edit')
      return true
    }

    if (action === 'targets' || action === 'build_targets' || action === 'build-targets') {
      if (['draft', 'built', 'ready', 'previewed'].includes(campaign.status)) {
        callbacks.onOpenBuilder?.(campaign, 'build')
        return true
      }
      const res = await buildCampaignTargetSnapshots(campaign.id, {
        limit: Math.max(campaign.total_targets, campaign.ready_targets, 500),
      })
      emitNotification({
        title: `Built ${res.built_count} targets`,
        detail: `"${campaign.campaign_name}" snapshot v${(res.preview as any)?.build_version ?? 'latest'}`,
        severity: 'success',
      })
      await callbacks.onRefresh()
      return true
    }

    if (action === 'preview_targets') {
      callbacks.onOpenBuilder?.(campaign, 'edit')
      return true
    }

    if (action === 'schedule' || action === 'reschedule') {
      callbacks.onOpenSchedule?.(campaign, action === 'reschedule' ? 'reschedule' : 'schedule')
      return true
    }

    if (action === 'view_targets') {
      callbacks.onSelectTab?.(campaign.id, 'targets')
      return true
    }

    if (action === 'view_queue') {
      callbacks.onSelectTab?.(campaign.id, 'queue')
      return true
    }

    if (action === 'queue-batch' || action === 'queue_batch') {
      const health = computeCampaignHealth(campaign)
      if (health.level === 'dangerous') {
        emitNotification({
          title: 'Cannot Queue Batch',
          detail: health.issues[0] ?? 'Campaign health is critical',
          severity: 'critical',
        })
        return false
      }
      if (['paused', 'archived', 'completed', 'failed'].includes(campaign.status)) {
        emitNotification({
          title: 'Cannot Queue Batch',
          detail: `Campaign is ${campaign.status}`,
          severity: 'warning',
        })
        return false
      }
      if (!campaign.ready_targets) {
        emitNotification({
          title: 'Nothing to queue',
          detail: 'Build targets first — 0 ready targets.',
          severity: 'warning',
        })
        return false
      }
      const res = await queueBatch(campaign.id, {
        limit: campaign.ready_targets,
        respect_send_window: true,
        interval_seconds: campaign.send_interval_seconds || 15,
      })
      if (res.blockers?.length) {
        emitNotification({ title: 'Queue blocked', detail: res.blockers.join(', '), severity: 'warning' })
      } else {
        emitNotification({
          title: `Queued ${res.queued} sends`,
          detail: `"${campaign.campaign_name}" staged. Activate to go live.`,
          severity: 'success',
        })
      }
      await callbacks.onRefresh()
      return true
    }

    if (LIFECYCLE_MAP[action]) {
      const lifecycleAction = LIFECYCLE_MAP[action]
      const result = await campaignLifecycle(campaign.id, lifecycleAction, payload)
      emitNotification({
        title: `"${campaign.campaign_name}" → ${result.to ?? lifecycleAction}`,
        severity: ['pause', 'cancel', 'archive', 'unschedule'].includes(action) ? 'warning' : 'success',
      })
      await callbacks.onRefresh()
      return true
    }

    if (action === 'clone' || action === 'duplicate') {
      const newId = await cloneCampaign(campaign.id)
      emitNotification({
        title: 'Campaign duplicated',
        detail: `New draft created from "${campaign.campaign_name}".`,
        severity: 'success',
      })
      await callbacks.onRefresh()
      return Boolean(newId)
    }

    if (action === 'delete' || action === 'delete_draft') {
      if (!canDeleteDraft(campaign)) {
        emitNotification({
          title: 'Cannot delete',
          detail: 'Only unexecuted drafts can be deleted. Archive instead.',
          severity: 'warning',
        })
        return false
      }
      const res = await deleteCampaign(campaign.id)
      emitNotification({
        title: res.archived ? 'Campaign archived' : 'Campaign deleted',
        detail: res.archived
          ? 'Send history preserved; archived instead of deleted.'
          : `Removed "${campaign.campaign_name}".`,
        severity: 'warning',
      })
      await callbacks.onRefresh()
      return true
    }

    emitNotification({ title: action, severity: 'info' })
    return true
  } catch (err) {
    emitNotification({
      title: `Action failed: ${action}`,
      detail: err instanceof Error ? err.message : String(err),
      severity: 'critical',
    })
    return false
  }
}