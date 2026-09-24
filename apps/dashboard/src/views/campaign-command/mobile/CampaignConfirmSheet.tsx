/**
 * CONFIRMATION SHEET — for campaign actions that change what gets sent.
 *
 * Before this, Resume fired the instant it was tapped, and Convert to Live and
 * live batches used `window.confirm` — the operating system's alert box, which
 * on a phone is a grey modal with a URL in its title and no way to say how many
 * sellers are about to be messaged.
 *
 * A send-affecting action should never look like a harmless toggle, but it also
 * shouldn't read like a warning label. So: what will happen, the scope in real
 * numbers, one clear verb, and a way out.
 */
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { CampaignSummary } from '../campaigns.types'

export type ConfirmTone = 'go' | 'danger' | 'neutral'

export type ConfirmSpec = {
  title: string
  body: string
  confirmLabel: string
  tone: ConfirmTone
  facts?: Array<{ label: string; value: string }>
}

const nf = (n: number | null | undefined) => Number(n ?? 0).toLocaleString()

/**
 * Which actions need a confirmation, and what it says. Actions not listed here
 * either change nothing that sends (Refresh, Setup) or open their own guided
 * surface (Schedule, Activate), so they run directly.
 *
 * Every fact is read from the campaign row. Nothing is estimated here.
 */
export function confirmSpecFor(action: string, campaign: CampaignSummary): ConfirmSpec | null {
  const name = campaign.campaign_name || 'this campaign'
  const ready = Number(campaign.ready_targets ?? 0)
  const pace = Number(campaign.send_interval_seconds ?? 0) > 0
    ? `${Math.max(1, Math.round(3600 / Number(campaign.send_interval_seconds)))} an hour`
    : null

  switch (action) {
    case 'pause':
      return {
        title: 'Pause campaign?',
        body: `No new messages from ${name} will be sent until you resume it. Replies still come in.`,
        confirmLabel: 'Pause',
        tone: 'neutral',
      }
    case 'resume':
      return {
        title: 'Resume campaign?',
        body: 'Sending picks up where it left off, using the current settings and today’s sender capacity.',
        confirmLabel: 'Resume sending',
        tone: 'go',
        facts: [
          { label: 'Ready to send', value: nf(ready) },
          ...(pace ? [{ label: 'Pace', value: pace }] : []),
        ],
      }
    case 'convert_to_live':
    case 'convert-to-live':
      return {
        title: 'Switch to live?',
        body: 'Messages will go to real sellers. Test mode ends for this campaign.',
        confirmLabel: 'Go live',
        tone: 'go',
        facts: [{ label: 'Ready to send', value: nf(ready) }],
      }
    case 'queue_batch_live':
      return {
        title: 'Send a live batch?',
        body: 'A controlled batch is prepared and handed to the send queue. Every message still passes suppression, contact-window and sender checks before it goes.',
        confirmLabel: 'Send live batch',
        tone: 'go',
        facts: [{ label: 'Ready to send', value: nf(ready) }],
      }
    case 'queue_batch':
      // No-send batch: queue rows are written, nothing transmits. Still a
      // change to the queue, so it says so before it happens.
      return {
        title: 'Queue the next batch?',
        body: 'Ready sellers are queued as test messages. Nothing is sent to anyone.',
        confirmLabel: 'Queue batch',
        tone: 'neutral',
        facts: [{ label: 'Ready to queue', value: nf(ready) }],
      }
    case 'build_targets':
      // Drafts open the guided builder instead (campaign-actions.ts) — nothing
      // is written by the tap, so there is nothing to confirm.
      if (['draft', 'built', 'ready', 'previewed'].includes(String(campaign.status))) return null
      return {
        title: Number(campaign.total_targets ?? 0) > 0 ? 'Rebuild the audience?' : 'Build the audience?',
        body: Number(campaign.total_targets ?? 0) > 0
          ? 'Sellers matching this campaign’s filters are resolved again, replacing the current audience. Nothing is sent.'
          : 'Sellers matching this campaign’s filters are resolved into its audience. Nothing is sent.',
        confirmLabel: Number(campaign.total_targets ?? 0) > 0 ? 'Rebuild' : 'Build audience',
        tone: 'neutral',
        ...(Number(campaign.total_targets ?? 0) > 0
          ? { facts: [{ label: 'Current audience', value: nf(campaign.total_targets) }] }
          : {}),
      }
    case 'archive':
      return {
        title: 'Archive campaign?',
        body: `${name} stops and moves to your archive. Its history is kept, and you can restore it later.`,
        confirmLabel: 'Archive',
        tone: 'danger',
      }
    case 'unschedule':
    case 'cancel':
      return {
        title: 'Cancel the schedule?',
        body: 'The campaign won’t start at its scheduled time. Nothing that already sent is affected.',
        confirmLabel: 'Cancel schedule',
        tone: 'danger',
      }
    case 'complete':
      return {
        title: 'Mark as complete?',
        body: 'The campaign stops sending and becomes a finished summary.',
        confirmLabel: 'Mark complete',
        tone: 'neutral',
      }
    default:
      return null
  }
}

export function CampaignConfirmSheet({
  spec,
  onConfirm,
  onCancel,
}: {
  spec: ConfirmSpec
  onConfirm: () => void
  onCancel: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  if (typeof document === 'undefined') return null

  return createPortal(
    <div className="cconf" role="presentation">
      <button type="button" className="cconf__backdrop" aria-label="Cancel" onClick={onCancel} />
      <section className={`cconf__sheet is-${spec.tone}`} role="alertdialog" aria-modal="true" aria-labelledby="cconf-title" aria-describedby="cconf-body">
        <span className="cconf__grip" aria-hidden="true" />
        <h2 id="cconf-title" className="cconf__title">{spec.title}</h2>
        <p id="cconf-body" className="cconf__body">{spec.body}</p>

        {spec.facts && spec.facts.length > 0 && (
          <dl className="cconf__facts">
            {spec.facts.map((f) => (
              <div key={f.label} className="cconf__fact">
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        )}

        <div className="cconf__actions">
          <button type="button" className={`cconf__confirm is-${spec.tone}`} onClick={onConfirm} autoFocus>
            {spec.confirmLabel}
          </button>
          <button type="button" className="cconf__cancel" onClick={onCancel}>
            Not now
          </button>
        </div>
      </section>
    </div>,
    document.body,
  )
}

export default CampaignConfirmSheet
