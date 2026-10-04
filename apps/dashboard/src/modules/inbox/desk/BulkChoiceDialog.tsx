/**
 * The one choice a bulk action needs before it runs: a stage, a status, a
 * follow-up date or a snooze length. It decides nothing — the server's per-item
 * rules do. Stages stop at S6: S7 and later are Closing Desk's.
 */
import { useState } from 'react'
import { LCButton, LCDialog, cx } from '../../../shared/lc'
import { choiceOptions, isoDate, type BulkChoiceKind } from './bulk-choice-options'

export type { BulkChoiceKind } from './bulk-choice-options'

const COPY: Record<BulkChoiceKind, { title: string; note: string; verb: string }> = {
  stage: { title: 'Move stage', note: 'Each conversation moves through its own stage rules; a step back or a skip is refused and listed (set those on the conversation, with a reason). Closed and later stages are set in Closing Desk.', verb: 'Move' },
  status: { title: 'Set status', note: 'The status each conversation shows. Suppression and opt-outs are never set from here.', verb: 'Set' },
  follow_up: { title: 'Set follow-up date', note: 'Sets the follow-up date on each conversation. No message is sent.', verb: 'Set' },
  snooze: { title: 'Snooze', note: 'Parked out of every lens until the time you choose; it comes back on its own.', verb: 'Snooze' },
}

export function BulkChoiceDialog({ kind, openedAt, count, noun, onCancel, onConfirm }: {
  kind: BulkChoiceKind | null
  /** when the operator opened it (one clock reading: presets and the date floor agree) */
  openedAt: number
  count: number
  noun: { one: string; many: string }
  onCancel: () => void
  onConfirm: (value: string) => void
}) {
  const [picked, setPicked] = useState<string | null>(null)
  const [pickedFor, setPickedFor] = useState<BulkChoiceKind | null>(kind)
  if (pickedFor !== kind) { setPickedFor(kind); setPicked(null) }
  const [customDate, setCustomDate] = useState('')
  if (!kind) return null
  const options = choiceOptions(kind, openedAt)
  const copy = COPY[kind]
  const value = kind === 'follow_up' && customDate ? customDate : picked
  const label = `${count.toLocaleString('en-US')} ${count === 1 ? noun.one : noun.many}`
  return (
    <LCDialog
      open
      onOpenChange={(open) => { if (!open) onCancel() }}
      title={`${copy.title} · ${label}`}
      description={copy.note}
      width={440}
      footer={(
        <>
          <LCButton variant="quiet" onClick={onCancel}>Cancel</LCButton>
          <LCButton variant="primary" disabled={!value} onClick={() => { if (value) onConfirm(value) }}>{copy.verb} {count.toLocaleString('en-US')}</LCButton>
        </>
      )}
    >
      <div className="ixl-choice" role="radiogroup" aria-label={copy.title}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={picked === option.value && !(kind === 'follow_up' && customDate)}
            className={cx('ixl-choice__opt', picked === option.value && !(kind === 'follow_up' && customDate) && 'is-on')}
            onClick={() => { setPicked(option.value); setCustomDate('') }}
          >
            {option.label}
          </button>
        ))}
        {kind === 'follow_up' ? (
          <label className="ixl-choice__date">
            <span>Or a date</span>
            <input type="date" value={customDate} min={isoDate(openedAt)} onChange={(e) => setCustomDate(e.target.value)} />
          </label>
        ) : null}
      </div>
    </LCDialog>
  )
}
