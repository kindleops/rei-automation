import type { ReactNode } from 'react'
import type { IconName } from '../icons'
import type { LCTone } from './states-model'

export interface LCActivityEvent {
  id: string
  /** epoch ms */
  at: number
  title: ReactNode
  subject?: ReactNode
  source?: ReactNode
  result?: ReactNode
  icon?: IconName
  tone?: LCTone
  /** events sharing this key within the window collapse into one group */
  groupKey?: string
  /** "targets queued" — the group reads "{n} {groupNoun}" */
  groupNoun?: string
  onOpen?: () => void
}

export type LCActivityEntry =
  | { kind: 'one'; ev: LCActivityEvent }
  | { kind: 'group'; key: string; events: LCActivityEvent[]; noun: string }

export function groupActivity(events: ReadonlyArray<LCActivityEvent>, windowMs = 10 * 60_000): LCActivityEntry[] {
  const sorted = [...events].sort((a, b) => b.at - a.at)
  const out: LCActivityEntry[] = []
  for (const ev of sorted) {
    const last = out[out.length - 1]
    if (ev.groupKey && last) {
      const lastKey = last.kind === 'group' ? last.key : last.ev.groupKey
      const lastAt = last.kind === 'group' ? last.events[last.events.length - 1].at : last.ev.at
      if (lastKey === ev.groupKey && lastAt - ev.at <= windowMs) {
        if (last.kind === 'group') last.events.push(ev)
        else out[out.length - 1] = { kind: 'group', key: ev.groupKey, events: [last.ev, ev], noun: ev.groupNoun || 'events' }
        continue
      }
    }
    out.push({ kind: 'one', ev })
  }
  return out
}

