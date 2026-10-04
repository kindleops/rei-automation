/** Choices for the bulk bar's stage / status / follow-up / snooze actions (S1–S6 only). */
import { LIFECYCLE_STAGE_META, OPERATIONAL_STATUS_META } from '../../../domain/lead-state/universal-lead-state-registry'

export type BulkChoiceKind = 'stage' | 'status' | 'follow_up' | 'snooze'

const STAGES = ['ownership_confirmation', 'offer_interest', 'asking_price', 'property_condition', 'offer', 'formal_contract'] as const
const STATUSES = ['new_reply', 'active_communication', 'waiting_on_seller', 'follow_up_due', 'needs_review', 'paused'] as const

const HOUR = 3_600_000
const DAY = 24 * HOUR
export const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export function choiceOptions(kind: BulkChoiceKind, now = Date.now()): Array<{ value: string; label: string; hint?: string }> {
  if (kind === 'stage') return STAGES.map((code) => ({ value: code, label: `${LIFECYCLE_STAGE_META[code].shortLabel} · ${LIFECYCLE_STAGE_META[code].label}` }))
  if (kind === 'status') return STATUSES.map((code) => ({ value: code, label: OPERATIONAL_STATUS_META[code].label }))
  if (kind === 'follow_up') {
    return [
      { value: isoDate(now + DAY), label: 'Tomorrow' },
      { value: isoDate(now + 3 * DAY), label: 'In 3 days' },
      { value: isoDate(now + 7 * DAY), label: 'In a week' },
      { value: isoDate(now + 30 * DAY), label: 'In 30 days' },
    ]
  }
  return [
    { value: new Date(now + 4 * HOUR).toISOString(), label: '4 hours' },
    { value: new Date(now + DAY).toISOString(), label: '24 hours' },
    { value: new Date(now + 3 * DAY).toISOString(), label: '3 days' },
    { value: new Date(now + 7 * DAY).toISOString(), label: 'A week' },
  ]
}

