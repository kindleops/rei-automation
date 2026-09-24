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

/**
 * What a lifecycle action did, in words.
 *
 * The toast used to read `"Miami - Test Campaign" → paused` — the lifecycle
 * enum, printed verbatim — and a failure read `Action failed: resume` followed
 * by the raw error. Neither says what happened to the campaign or what to do.
 */
const OUTCOME_COPY: Record<string, { done: string; verb: string; stillTrue: string }> = {
  pause:      { done: 'Paused. No new messages will be sent.', verb: 'pause', stillTrue: 'It’s still sending.' },
  resume:     { done: 'Resumed. Sending has restarted.', verb: 'resume', stillTrue: 'It’s still paused.' },
  activate:   { done: 'Live. Messages are going out.', verb: 'launch', stillTrue: 'Nothing has been sent.' },
  schedule:   { done: 'Scheduled.', verb: 'schedule', stillTrue: 'The schedule hasn’t changed.' },
  unschedule: { done: 'Schedule cancelled.', verb: 'cancel the schedule for', stillTrue: 'It’s still scheduled.' },
  archive:    { done: 'Archived. You can restore it any time.', verb: 'archive', stillTrue: 'It hasn’t been archived.' },
  complete:   { done: 'Marked complete.', verb: 'complete', stillTrue: 'It hasn’t changed.' },
  restore:    { done: 'Restored to draft.', verb: 'restore', stillTrue: 'It hasn’t changed.' },
}

const ACTION_VERB: Record<string, string> = {
  convert_to_live: 'switch to live', 'convert-to-live': 'switch to live',
  queue_batch: 'queue the next batch', queue_batch_live: 'send the live batch', queue_batch_test: 'prepare the test batch',
  build_targets: 'build the audience', 'build-targets': 'build the audience', targets: 'build the audience',
  duplicate: 'duplicate', clone: 'duplicate', delete: 'delete', delete_draft: 'delete',
  sync_metrics: 'refresh the numbers for', 'sync-metrics': 'refresh the numbers for',
}

function verbFor(action: string): string {
  const lifecycle = LIFECYCLE_MAP[action]
  if (lifecycle && OUTCOME_COPY[lifecycle]) return OUTCOME_COPY[lifecycle].verb
  return ACTION_VERB[action] ?? 'update'
}

/** A backend message only reaches the operator if it is a sentence, not a code. */
function humanDetail(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  const text = raw.trim()
  if (!text || /^[a-z0-9_:.\-]+$/i.test(text) || /status \d{3}/i.test(text) || text.length > 180) return fallback
  return text
}

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

    // Was unhandled: it fell through to the catch-all below, which toasted the
    // raw string "review_blockers" and returned success. It is the dock's
    // PRIMARY action for a blocked campaign. Blockers are listed first in
    // Overview, so that is where it goes.
    if (action === 'review_blockers' || action === 'review-blockers') {
      callbacks.onSelectTab?.(campaign.id, 'overview')
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
      // A caller that has already shown its own confirmation (the mobile
      // confirmation sheet) passes `confirmed: true`; anything else still gets
      // the native prompt. Either way nothing live happens unconfirmed.
      if (action === 'queue_batch_live' && payload.confirmed !== true) {
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
      void result
      emitNotification({
        title: campaign.campaign_name || 'Campaign',
        detail: OUTCOME_COPY[lifecycleAction]?.done ?? 'Updated.',
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
      const confirmed = payload.confirmed === true || window.confirm(
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

    // An action with no handler must not report success. This branch used to
    // toast the raw action id and return true.
    emitNotification({
      title: 'That action isn’t available here',
      detail: 'Nothing was changed.',
      severity: 'warning',
    })
    return false
  } catch (err) {
    const lifecycle = LIFECYCLE_MAP[action]
    const stillTrue = lifecycle ? OUTCOME_COPY[lifecycle]?.stillTrue : null
    emitNotification({
      title: `Couldn’t ${verbFor(action)} ${campaign.campaign_name || 'this campaign'}`,
      detail: humanDetail(err, [stillTrue, 'Try again.'].filter(Boolean).join(' ')),
      severity: 'critical',
    })
    return false
  } finally {
    pendingActions.delete(key)
  }
}