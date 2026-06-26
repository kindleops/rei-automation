import { emitNotification } from '../../shared/NotificationToast'
import {
  buildCampaignTargetSnapshots,
  campaignLifecycle,
  cloneCampaign,
  deleteCampaign,
  queueBatch,
  type CampaignLifecycleAction,
} from './campaigns.adapter'
import { canDeleteDraft, canForceDeleteCampaign, canQueueBatch, computeCampaignHealth } from './campaign-health'

type ExtendedLifecycleAction = CampaignLifecycleAction | 'convert_to_live' | 'sync_metrics'
import type { CampaignSummary } from './campaigns.types'

export type CampaignActionCallbacks = {
  onRefresh: () => void | Promise<void>
  onOpenBuilder?: (campaign: CampaignSummary, mode: 'edit' | 'build' | 'schedule') => void
  onOpenSchedule?: (campaign: CampaignSummary, mode: 'schedule' | 'reschedule') => void
  onOpenActivate?: (campaign: CampaignSummary) => void
  onSelectTab?: (campaignId: string, tab: string) => void
}

const pendingActions = new Set<string>()

function actionKey(action: string, campaignId: string): string {
  return `${action}:${campaignId}`
}

const DIRECT_LIFECYCLE_ACTIONS = new Set(['convert_to_live', 'convert-to-live', 'sync_metrics', 'sync-metrics'])

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
  restore: 'restore',
}

export async function executeCampaignAction(
  action: string,
  campaign: CampaignSummary,
  callbacks: CampaignActionCallbacks,
  payload: Record<string, unknown> = {},
): Promise<boolean> {
  const key = actionKey(action, campaign.id)
  if (pendingActions.has(key)) return false

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
      pendingActions.add(key)
      const res = await buildCampaignTargetSnapshots(campaign.id, {
        limit: Math.max(campaign.total_targets, campaign.ready_targets, 500),
      })
      emitNotification({
        title: `Built ${res.built_count} targets`,
        detail: `"${campaign.campaign_name}" snapshot v${(res.preview as Record<string, unknown> | undefined)?.build_version ?? 'latest'}`,
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

    if (action === 'activate' || action === 'activate-now' || action === 'start') {
      if (['archived', 'completed', 'failed'].includes(campaign.status)) {
        emitNotification({
          title: 'Cannot activate',
          detail: `Campaign is ${campaign.status}. Restore or duplicate first.`,
          severity: 'warning',
        })
        return false
      }
      callbacks.onOpenActivate?.(campaign)
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

    if (action === 'queue-batch' || action === 'queue_batch' || action === 'queue_batch_test' || action === 'queue_batch_live') {
      if (!canQueueBatch(campaign)) {
        const health = computeCampaignHealth(campaign)
        emitNotification({
          title: 'Cannot Queue Batch',
          detail: health.issues[0] ?? `Campaign is ${campaign.status} or has no ready targets`,
          severity: 'warning',
        })
        return false
      }
      if (action === 'queue_batch_live') {
        const confirmed = window.confirm(
          'Prepare a controlled LIVE batch? This will create executable send_queue rows subject to all readiness gates.',
        )
        if (!confirmed) return false
      }
      pendingActions.add(key)
      const isLiveBatch = action === 'queue_batch_live'
      const res = await queueBatch(campaign.id, {
        limit: Math.min(campaign.ready_targets, isLiveBatch ? 5 : campaign.ready_targets),
        respect_send_window: true,
        interval_seconds: campaign.send_interval_seconds || 15,
        no_send: !isLiveBatch,
        confirm_live: isLiveBatch,
      })
      const inserted = res.queued ?? 0
      const result = res.result as Record<string, unknown> | undefined
      const testModeHydration = Boolean(result?.proof_hydration ?? result?.no_send)
      if (res.blockers?.length && inserted === 0) {
        emitNotification({ title: 'Batch blocked', detail: res.blockers.join(' · '), severity: 'warning' })
      } else {
        const skipped = Number(result?.skipped_count ?? 0)
        const blocked = Number(result?.blocked_count ?? 0)
        emitNotification({
          title: inserted > 0
            ? (testModeHydration ? `Prepared ${inserted} test rows` : `Prepared ${inserted} live sends`)
            : 'No new rows prepared',
          detail: [
            inserted > 0 ? `${inserted} queue rows created` : null,
            testModeHydration ? 'test mode — no transmission' : null,
            skipped > 0 ? `${skipped} skipped` : null,
            blocked > 0 ? `${blocked} blocked` : null,
          ].filter(Boolean).join(' · ') || `"${campaign.campaign_name}" batch complete`,
          severity: inserted > 0 ? 'success' : 'warning',
        })
      }
      await callbacks.onRefresh()
      return true
    }

    if (LIFECYCLE_MAP[action] && !DIRECT_LIFECYCLE_ACTIONS.has(action)) {
      pendingActions.add(key)
      const lifecycleAction = LIFECYCLE_MAP[action]
      const result = await campaignLifecycle(campaign.id, lifecycleAction, payload)
      const label = lifecycleAction === 'restore' ? 'restored to draft' : (result.to ?? lifecycleAction)
      emitNotification({
        title: `"${campaign.campaign_name}" → ${label}`,
        severity: ['pause', 'cancel', 'archive', 'unschedule'].includes(action) ? 'warning' : 'success',
      })
      await callbacks.onRefresh()
      return true
    }

    if (action === 'clone' || action === 'duplicate') {
      pendingActions.add(key)
      const newId = await cloneCampaign(campaign.id)
      emitNotification({
        title: 'Campaign duplicated',
        detail: `New draft created from "${campaign.campaign_name}".`,
        severity: 'success',
      })
      await callbacks.onRefresh()
      return Boolean(newId)
    }

    if (action === 'convert_to_live' || action === 'convert-to-live') {
      const confirmed = window.confirm(
        `Convert "${campaign.campaign_name}" to a LIVE campaign?\n\nThis will purge test queue rows, hydrate the real send path, and schedule the next valid sending window. Targets, pacing, caps, and templates are preserved.`,
      )
      if (!confirmed) return false
      pendingActions.add(key)
      const result = await campaignLifecycle(campaign.id, 'convert_to_live' as ExtendedLifecycleAction, {
        confirm_live: true,
        explicit_operator_action: true,
      })
      emitNotification({
        title: 'Converted to Live Campaign',
        detail: result.to
          ? `Now ${result.to}. Scheduled launch preserved.`
          : 'Live conversion complete.',
        severity: 'success',
      })
      await callbacks.onRefresh()
      return true
    }

    if (action === 'sync_metrics' || action === 'sync-metrics') {
      pendingActions.add(key)
      await campaignLifecycle(campaign.id, 'sync_metrics' as ExtendedLifecycleAction)
      emitNotification({ title: 'Metrics synced', detail: 'Campaign counts recomputed from canonical sources.', severity: 'success' })
      await callbacks.onRefresh()
      return true
    }

    if (action === 'delete' || action === 'delete_draft') {
      const forceDelete = canForceDeleteCampaign(campaign)
      if (!canDeleteDraft(campaign) && !forceDelete) {
        emitNotification({
          title: 'Cannot delete',
          detail: 'Only unexecuted drafts can be deleted. Archive instead.',
          severity: 'warning',
        })
        return false
      }
      const confirmed = window.confirm(
        forceDelete
          ? `Permanently remove "${campaign.campaign_name}" and all test/mock rows? This cannot be undone.`
          : `Delete draft "${campaign.campaign_name}"? This cannot be undone.`,
      )
      if (!confirmed) return false
      pendingActions.add(key)
      const res = await deleteCampaign(campaign.id, { force_delete: forceDelete })
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
      title: action === 'activate' ? 'Activation failed' : `Action failed: ${action}`,
      detail: err instanceof Error ? err.message : String(err),
      severity: 'critical',
    })
    return false
  } finally {
    pendingActions.delete(key)
  }
}