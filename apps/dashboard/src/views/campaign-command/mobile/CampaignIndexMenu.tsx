/**
 * The index card's action sheet.
 *
 * Offers only what the campaign's state allows — a draft can't be paused, an
 * archived campaign can't be edited — and routes every action through the
 * page's canonical handler. Anything that changes what gets sent (pause,
 * resume, archive) asks first in the same confirmation sheet Detail uses.
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CampaignSummary } from '../campaigns.types'
import { canArchiveCampaign } from '../campaign-health'
import { CampaignConfirmSheet, confirmSpecFor, type ConfirmSpec } from './CampaignConfirmSheet'
import { cardKindOf, displayName } from './campaign-index-model'

export type IndexMenuAction = 'open' | 'setup' | 'pause' | 'resume' | 'duplicate' | 'archive' | 'restore'

const LABEL: Record<IndexMenuAction, string> = {
  open: 'Open campaign',
  setup: 'Continue setup',
  pause: 'Pause sending',
  resume: 'Resume sending',
  duplicate: 'Duplicate',
  archive: 'Archive',
  restore: 'Restore',
}

/** Valid actions for this campaign's state, in the order they're offered. */
export function indexMenuActions(c: CampaignSummary): IndexMenuAction[] {
  const status = String(c.status ?? '').toLowerCase()
  const kind = cardKindOf(c)
  const out: IndexMenuAction[] = ['open']
  if (kind === 'draft' || kind === 'ready' || (kind === 'hold' && status !== 'archived')) out.push('setup')
  if (['active', 'activating', 'live_limited'].includes(status)) out.push('pause')
  if (status === 'paused' && !c.quarantined) out.push('resume')
  out.push('duplicate')
  if (status === 'archived') out.push('restore')
  else if (canArchiveCampaign(c)) out.push('archive')
  return out
}

export function CampaignIndexMenu({
  campaign,
  onClose,
  onOpen,
  onContinueSetup,
  onAction,
}: {
  campaign: CampaignSummary
  onClose: () => void
  onOpen: (c: CampaignSummary) => void
  onContinueSetup: (c: CampaignSummary) => void
  onAction: (action: string, c: CampaignSummary, payload?: Record<string, unknown>) => Promise<unknown> | void
}) {
  const [pending, setPending] = useState<{ action: IndexMenuAction; spec: ConfirmSpec } | null>(null)
  const [closing, setClosing] = useState(false)
  const { title, subtitle } = displayName(campaign)
  const actions = indexMenuActions(campaign)

  const dismiss = () => {
    setClosing(true)
    window.setTimeout(onClose, 180)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const choose = (action: IndexMenuAction) => {
    if (action === 'open') { onClose(); onOpen(campaign); return }
    if (action === 'setup') { onClose(); onContinueSetup(campaign); return }
    const spec = confirmSpecFor(action, campaign)
    if (spec) { setPending({ action, spec }); return }
    onClose()
    void onAction(action, campaign)
  }

  if (pending) {
    return (
      <CampaignConfirmSheet
        spec={pending.spec}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const action = pending.action
          onClose()
          void onAction(action, campaign, { confirmed: true })
        }}
      />
    )
  }

  return createPortal(
    <div className={`cxs${closing ? ' is-closing' : ''}`} role="presentation">
      <button type="button" className="cxs__backdrop" aria-label="Close" onClick={dismiss} />
      <section className="cxs__panel" role="dialog" aria-modal="true" aria-label={`${title} actions`}>
        <span className="cxs__grip" aria-hidden="true" />
        <header className="cxs__head">
          <span className="cxs__title">{title}</span>
          {subtitle && <span className="cxs__sub">{subtitle}</span>}
        </header>
        <div className="cxs__list">
          {actions.map((a) => (
            <button
              key={a}
              type="button"
              className={`cxs__item${a === 'archive' ? ' is-danger' : ''}`}
              onClick={() => choose(a)}
            >
              {LABEL[a]}
            </button>
          ))}
        </div>
        <button type="button" className="cxs__cancel" onClick={dismiss}>Cancel</button>
      </section>
    </div>,
    document.body,
  )
}
