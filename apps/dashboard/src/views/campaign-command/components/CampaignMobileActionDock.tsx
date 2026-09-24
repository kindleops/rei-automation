import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import type { CampaignActionDef } from '../campaign-health'
import type { CampaignSummary } from '../campaigns.types'
import { cls, fmt } from '../campaign-formatters'
import { CampaignConfirmSheet, confirmSpecFor, type ConfirmSpec } from '../mobile/CampaignConfirmSheet'

/**
 * Campaign Detail — mobile action dock.
 *
 * Three defects this fixes, all found by tapping:
 *
 *   RESUME FIRED ON TAP. Generic lifecycle actions went straight to the backend
 *   with no confirmation, so the control that restarts sending to sellers
 *   looked and behaved like a harmless toggle. Send-affecting and destructive
 *   actions now confirm in a sheet that states the scope in real numbers.
 *
 *   "REVIEW BLOCKERS" DID NOTHING. It had no handler; the catch-all toasted the
 *   raw string "review_blockers" and reported success. It now opens Overview,
 *   where blockers are listed first.
 *
 *   NO FEEDBACK. A tap gave no sign it had registered until a toast arrived.
 *   The button now says what it is doing ("Pausing…") until the action returns;
 *   the page's reload then shows the real state — nothing is claimed early.
 */

type IconName = 'pause' | 'zap' | 'calendar' | 'users' | 'play' | 'archive' | 'bolt' | 'alert-circle' | 'refresh-cw' | 'activity' | 'check' | 'send'

function actionIcon(actionId: string): IconName {
  switch (actionId) {
    case 'pause': return 'pause'
    case 'queue_batch': return 'zap'
    case 'queue_batch_live': return 'send'
    case 'schedule':
    case 'reschedule': return 'calendar'
    case 'build_targets': return 'users'
    case 'activate':
    case 'resume':
    case 'convert_to_live': return 'play'
    case 'archive': return 'archive'
    case 'review_blockers': return 'alert-circle'
    case 'restore': return 'refresh-cw'
    default: return 'bolt'
  }
}

/** What the button says. The action ids and their handlers are unchanged. */
const MOBILE_LABEL: Record<string, string> = {
  convert_to_live: 'Go live',
  queue_batch_live: 'Send live batch',
  queue_batch: 'Queue next batch',
  review_blockers: 'Review blockers',
  build_targets: 'Build audience',
  activate: 'Launch',
  resume: 'Resume',
  pause: 'Pause',
  schedule: 'Schedule',
  reschedule: 'Reschedule',
  archive: 'Archive',
  restore: 'Restore',
  duplicate: 'Duplicate',
  open: 'Open',
}

/** The progressive form shown while an action is in flight. */
const BUSY_LABEL: Record<string, string> = {
  pause: 'Pausing…',
  resume: 'Resuming…',
  convert_to_live: 'Going live…',
  queue_batch_live: 'Preparing batch…',
  queue_batch: 'Queueing…',
  archive: 'Archiving…',
  restore: 'Restoring…',
  duplicate: 'Duplicating…',
  build_targets: 'Building…',
  sync_metrics: 'Recalculating…',
  refresh: 'Reloading…',
}

interface CampaignMobileActionDockProps {
  campaign: CampaignSummary
  detailActions: CampaignActionDef[]
  onAction: (action: string, campaign: CampaignSummary, payload?: Record<string, unknown>) => void | Promise<unknown>
}

export function CampaignMobileActionDock({
  campaign,
  detailActions,
  onAction,
}: CampaignMobileActionDockProps) {
  const [sheetOpen, setSheetOpen] = useState(false)
  const [pending, setPending] = useState<{ action: string; spec: ConfirmSpec } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const primaryAction = detailActions[0]
  const secondaryActions = detailActions.slice(1)

  const run = async (action: string, payload?: Record<string, unknown>) => {
    setBusy(action)
    try {
      await onAction(action, campaign, payload)
      if (action === 'review_blockers') {
        // Overview lists blockers first; bring the top of the section into view.
        requestAnimationFrame(() => {
          document.querySelector('.ccc--mobile-campaign-detail .ccc__detail-body')
            ?.scrollTo({ top: 0, behavior: 'smooth' })
        })
      }
    } finally {
      setBusy(null)
    }
  }

  const request = (action: string) => {
    setSheetOpen(false)
    const spec = confirmSpecFor(action, campaign)
    if (spec) setPending({ action, spec })
    else void run(action)
  }

  const utilityActions: Array<{ id: string; label: string; icon: IconName; tone?: 'danger' }> = [
    ...secondaryActions.map((a) => ({
      id: a.id,
      label: MOBILE_LABEL[a.id] ?? a.label,
      icon: actionIcon(a.id),
      tone: a.id === 'archive' ? ('danger' as const) : undefined,
    })),
    { id: 'sync_metrics', label: 'Recalculate numbers', icon: 'activity' },
    { id: 'refresh', label: 'Reload', icon: 'refresh-cw' },
  ]

  const primaryLabel = primaryAction
    ? (busy === primaryAction.id
        ? (BUSY_LABEL[primaryAction.id] ?? 'Working…')
        : primaryAction.id === 'queue_batch'
          ? `Queue ${fmt(campaign.ready_targets)}`
          : MOBILE_LABEL[primaryAction.id] ?? primaryAction.label)
    : (busy === 'refresh' ? 'Reloading…' : 'Reload')

  const sheet = sheetOpen ? createPortal(
    <div className="cad-sheet" role="presentation">
      <button type="button" className="cad-sheet__backdrop" aria-label="Close" onClick={() => setSheetOpen(false)} />
      <section className="cad-sheet__panel" role="dialog" aria-modal="true" aria-label="More actions">
        <span className="cad-sheet__grip" aria-hidden="true" />
        <h2 className="cad-sheet__title">{campaign.campaign_name || 'Campaign'}</h2>
        <div className="cad-sheet__list">
          {utilityActions.map((act) => (
            <button
              key={act.id}
              type="button"
              className={cls('cad-sheet__item', act.tone === 'danger' && 'is-danger')}
              onClick={() => request(act.id)}
              disabled={busy != null}
            >
              <span className="cad-sheet__icon" aria-hidden="true"><Icon name={act.icon} size={16} /></span>
              {busy === act.id ? (BUSY_LABEL[act.id] ?? 'Working…') : act.label}
            </button>
          ))}
        </div>
        <button type="button" className="cad-sheet__cancel" onClick={() => setSheetOpen(false)}>Close</button>
      </section>
    </div>,
    document.body,
  ) : null

  return (
    <>
      <div className="ccc-mobile-dock cad" role="toolbar" aria-label="Campaign actions">
        <button
          type="button"
          className={cls(
            'ccc-mobile-dock__primary cad__primary',
            primaryAction?.id === 'review_blockers' ? 'is-warn' : 'is-go',
            busy === primaryAction?.id && 'is-busy',
          )}
          onClick={() => (primaryAction ? request(primaryAction.id) : void run('refresh'))}
          disabled={busy != null}
          aria-busy={busy === primaryAction?.id || undefined}
        >
          {busy === (primaryAction?.id ?? 'refresh')
            ? <span className="cad__spinner" aria-hidden="true" />
            : <Icon name={primaryAction ? actionIcon(primaryAction.id) : 'refresh-cw'} size={15} />}
          <span className="cad__label">{primaryLabel}</span>
        </button>

        {/* 'edit' routes through executeCampaignAction to onOpenBuilder(campaign,
            'edit') — the same builder desktop uses. */}
        <button
          type="button"
          className="ccc-mobile-dock__setup cad__secondary"
          onClick={() => void run('edit')}
          disabled={busy != null}
        >
          Setup
        </button>

        <button
          type="button"
          className="ccc-mobile-dock__more cad__more"
          aria-label="More actions"
          aria-expanded={sheetOpen}
          onClick={() => setSheetOpen(true)}
          disabled={busy != null}
        >
          <Icon name="more" size={18} />
        </button>
      </div>

      {sheet}

      {pending && (
        <CampaignConfirmSheet
          spec={pending.spec}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const action = pending.action
            setPending(null)
            // `confirmed` tells the action handler this sheet already asked, so
            // the native window.confirm does not appear a second time.
            void run(action, { confirmed: true })
          }}
        />
      )}
    </>
  )
}
