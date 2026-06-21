import { useEffect, useState } from 'react'
import type { CalendarEvent } from '../../lib/data/calendarData'
import { TimelineExecutionFeed } from './TimelineExecutionFeed'

const RAIL_PREFS_KEY = 'nx-cal-rail-sections-v1'

type RailSection = {
  id: string
  title: string
  events: CalendarEvent[]
  defaultOpen: boolean
}

type CalendarRightRailProps = {
  sections: RailSection[]
  selectedEventId: string | null
  onSelect: (event: CalendarEvent) => void
}

function loadRailPrefs(): Record<string, boolean> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(RAIL_PREFS_KEY)
    return raw ? JSON.parse(raw) as Record<string, boolean> : {}
  } catch {
    return {}
  }
}

function saveRailPrefs(prefs: Record<string, boolean>) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(RAIL_PREFS_KEY, JSON.stringify(prefs))
}

export function CalendarRightRail({ sections, selectedEventId, onSelect }: CalendarRightRailProps) {
  const [openMap, setOpenMap] = useState<Record<string, boolean>>(() => {
    const prefs = loadRailPrefs()
    const initial: Record<string, boolean> = {}
    for (const section of sections) {
      initial[section.id] = prefs[section.id] ?? section.defaultOpen
    }
    return initial
  })

  useEffect(() => {
    saveRailPrefs(openMap)
  }, [openMap])

  const visible = sections.filter((section) => section.events.length > 0 || openMap[section.id] !== false)

  if (visible.every((section) => section.events.length === 0)) {
    return (
      <aside className="calendar-command__rail nx-cal__right-rail">
        <section className="calendar-command__rail-card nx-cal__surface">
          <p className="nx-cal__rail-empty">No rail items for the current range and filters.</p>
        </section>
      </aside>
    )
  }

  return (
    <aside className="calendar-command__rail nx-cal__right-rail">
      {visible.map((section) => {
        const open = openMap[section.id] ?? section.defaultOpen
        if (!open && section.events.length === 0) return null
        return (
          <section key={section.id} className="calendar-command__rail-card nx-cal__surface">
            <button
              type="button"
              className="calendar-command__rail-head nx-cal__section-head nx-cal__rail-toggle"
              onClick={() => setOpenMap((prev) => ({ ...prev, [section.id]: !open }))}
            >
              <strong>{section.title}</strong>
              <span>{section.events.length}</span>
            </button>
            {open ? (
              section.events.length ? (
                <TimelineExecutionFeed events={section.events} selectedId={selectedEventId} onSelect={onSelect} compact />
              ) : (
                <p className="nx-cal__rail-empty">No items</p>
              )
            ) : null}
          </section>
        )
      })}
    </aside>
  )
}