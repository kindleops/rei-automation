export const CALENDAR_LAYER_OPTIONS = [
  { id: 'follow_ups', label: 'Follow-Ups' },
  { id: 'seller_replies', label: 'Seller Replies' },
  { id: 'sms', label: 'SMS' },
  { id: 'email', label: 'Email' },
  { id: 'workflow', label: 'Workflow' },
  { id: 'offers', label: 'Offers' },
  { id: 'contracts', label: 'Contracts' },
  { id: 'title', label: 'Title' },
  { id: 'closings', label: 'Closings' },
  { id: 'buyers', label: 'Buyers' },
  { id: 'campaigns', label: 'Campaigns' },
  { id: 'manual_events', label: 'Manual Events' },
  { id: 'risks', label: 'Risks' },
] as const

export type CalendarLayerId = (typeof CALENDAR_LAYER_OPTIONS)[number]['id']

const STORAGE_KEY = 'nx-calendar-layers-v1'

export function loadCalendarLayers(): CalendarLayerId[] {
  if (typeof window === 'undefined') return CALENDAR_LAYER_OPTIONS.map((l) => l.id)
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return CALENDAR_LAYER_OPTIONS.map((l) => l.id)
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return CALENDAR_LAYER_OPTIONS.map((l) => l.id)
    return parsed.filter((id): id is CalendarLayerId => CALENDAR_LAYER_OPTIONS.some((l) => l.id === id))
  } catch {
    return CALENDAR_LAYER_OPTIONS.map((l) => l.id)
  }
}

export function saveCalendarLayers(layers: CalendarLayerId[]) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layers))
}