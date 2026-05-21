/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useRef, useState } from 'react'
import type { InboxThread } from './inbox.adapter'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ScheduledTime {
  description: string
  label: string
  iso: string
  reason?: string
}

// ─── Internal option type ─────────────────────────────────────────────────────

interface ScheduleOption extends ScheduledTime {
  key: string
  isCustom?: boolean
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean
  onClose: () => void
  thread: InboxThread | null
  onSchedule: (time: ScheduledTime) => void
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function roundUpTo15(d: Date): Date {
  const r = new Date(d)
  const m = r.getMinutes()
  const rounded = Math.ceil((m + 1) / 15) * 15
  if (rounded >= 60) {
    r.setHours(r.getHours() + 1, 0, 0, 0)
  } else {
    r.setMinutes(rounded, 0, 0)
  }
  return r
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

function setHM(d: Date, h: number, m: number): Date {
  const r = new Date(d)
  r.setHours(h, m, 0, 0)
  return r
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

function dayLabel(d: Date, now: Date): string {
  if (d.toDateString() === now.toDateString()) return 'Today'
  const tomorrow = addDays(now, 1)
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow'
  return d.toLocaleDateString('en-US', { weekday: 'long' })
}

// ─── Best contact time mock logic ─────────────────────────────────────────────

function buildOptions(thread: InboxThread | null, now: Date): ScheduleOption[] {
  const isHot = thread?.sentiment === 'hot'
  const isWarm = thread?.sentiment === 'warm'
  const isUrgent = thread?.priority === 'urgent' || thread?.priority === 'high'
  const tomorrow = addDays(now, 1)

  let bestTime: Date
  let bestReason: string

  if (isUrgent || isHot) {
    bestTime = setHM(now, 18, 15)
    if (now >= bestTime) bestTime = setHM(tomorrow, 9, 0)
    bestReason =
      'Seller is actively engaged — evening contact window has the highest response rate for hot leads.'
  } else if (isWarm) {
    bestTime = setHM(tomorrow, 9, 0)
    bestReason =
      'Warm leads respond well to morning outreach. Tomorrow morning optimizes open rate.'
  } else {
    bestTime = setHM(tomorrow, 10, 0)
    bestReason =
      'Mid-morning contact window yields the best engagement for this lead type.'
  }

  // Later today = now + 2h, rounded up to next 15-min mark
  const laterToday = roundUpTo15(new Date(now.getTime() + 2 * 3_600_000))

  const tomorrowMorning = setHM(tomorrow, 9, 15)
  const tomorrowEvening = setHM(tomorrow, 18, 45)

  // Next contact window = next weekday (Mon–Fri) at 10 AM
  const nextWindow = (() => {
    const d = new Date(now)
    do { d.setDate(d.getDate() + 1) } while (d.getDay() === 0 || d.getDay() === 6)
    d.setHours(10, 0, 0, 0)
    return d
  })()

  return [
    {
      key: 'best',
      description: 'Best contact time',
      label: `${dayLabel(bestTime, now)} ${fmtTime(bestTime)}`,
      iso: bestTime.toISOString(),
      reason: bestReason,
    },
    {
      key: 'later-today',
      description: 'Later today',
      label: `${dayLabel(laterToday, now)} ${fmtTime(laterToday)}`,
      iso: laterToday.toISOString(),
    },
    {
      key: 'tomorrow-morning',
      description: 'Tomorrow morning',
      label: `${dayLabel(tomorrowMorning, now)} ${fmtTime(tomorrowMorning)}`,
      iso: tomorrowMorning.toISOString(),
    },
    {
      key: 'tomorrow-evening',
      description: 'Tomorrow evening',
      label: `${dayLabel(tomorrowEvening, now)} ${fmtTime(tomorrowEvening)}`,
      iso: tomorrowEvening.toISOString(),
    },
    {
      key: 'next-window',
      description: 'Next contact window',
      label: `${dayLabel(nextWindow, now)} ${fmtTime(nextWindow)}`,
      iso: nextWindow.toISOString(),
    },
    {
      key: 'custom',
      description: 'Custom time',
      label: 'Pick a time…',
      iso: '',
      isCustom: true,
    },
  ]
}

// ─── Component ────────────────────────────────────────────────────────────────

export function InboxSchedulePanel({ open, onClose, thread, onSchedule }: Props) {
  const [activeIdx, setActiveIdx] = useState(0)
  const [customValue, setCustomValue] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)

  const now = new Date()
  const options = buildOptions(thread, now)

  useEffect(() => {
    if (open) {
      setActiveIdx(0)
      setCustomValue('')
      requestAnimationFrame(() => panelRef.current?.focus())
    }
  }, [open])

  if (!open) return null

  const handleSelect = (idx: number) => {
    const opt = options[idx]
    if (opt.isCustom) {
      if (!customValue) return
      const parsed = new Date(customValue)
      if (isNaN(parsed.getTime())) return
      onSchedule({
        description: 'Custom time',
        label: `${dayLabel(parsed, now)} ${fmtTime(parsed)}`,
        iso: parsed.toISOString(),
      })
      onClose()
      return
    }
    onSchedule({ description: opt.description, label: opt.label, iso: opt.iso, reason: opt.reason })
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx(i => Math.min(i + 1, options.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      handleSelect(activeIdx)
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  const bestOption = options[0]

  return (
    <div className="nx-sp-overlay" onClick={onClose}>
      <div
        className="nx-sp"
        role="dialog"
        aria-label="Schedule send"
        ref={panelRef}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="nx-sp__head">
          <span className="nx-sp__title">Schedule Send</span>
          <kbd className="nx-sp__esc" onClick={onClose}>Esc</kbd>
        </div>

        {bestOption.reason && (
          <p className="nx-sp__reason">{bestOption.reason}</p>
        )}

        <div className="nx-sp__list" role="listbox">
          {options.map((opt, i) =>
            opt.isCustom ? (
              <div
                key={opt.key}
                className={cls('nx-sp__item nx-sp__item--custom', activeIdx === i && 'is-active')}
                onMouseEnter={() => setActiveIdx(i)}
              >
                <span className="nx-sp__item-desc">{opt.description}</span>
                <input
                  type="datetime-local"
                  className="nx-sp__custom-input"
                  value={customValue}
                  onChange={e => { setCustomValue(e.target.value); setActiveIdx(i) }}
                  onKeyDown={e => {
                    e.stopPropagation()
                    if (e.key === 'Enter' && customValue) handleSelect(i)
                  }}
                  onClick={e => e.stopPropagation()}
                  aria-label="Custom send time"
                />
                {customValue && (
                  <button
                    type="button"
                    className="nx-sp__item-confirm"
                    onClick={e => { e.stopPropagation(); handleSelect(i) }}
                  >
                    Set
                  </button>
                )}
              </div>
            ) : (
              <button
                key={opt.key}
                type="button"
                role="option"
                aria-selected={activeIdx === i}
                className={cls('nx-sp__item', activeIdx === i && 'is-active')}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => handleSelect(i)}
              >
                <span className="nx-sp__item-desc">{opt.description}</span>
                <span className="nx-sp__item-time">{opt.label}</span>
              </button>
            )
          )}
        </div>
      </div>
    </div>
  )
}
