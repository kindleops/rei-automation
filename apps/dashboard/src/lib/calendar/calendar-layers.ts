export const CALENDAR_LAYER_OPTIONS = [
  { id: 'seller_replies', label: 'Seller Replies', category: 'communication' as const },
  { id: 'sms', label: 'SMS', category: 'communication' as const },
  { id: 'email', label: 'Email', category: 'communication' as const },
  { id: 'follow_ups', label: 'Follow-Ups', category: 'automation' as const },
  { id: 'workflow', label: 'Workflow Wakes', category: 'automation' as const },
  { id: 'campaigns', label: 'Campaigns', category: 'automation' as const },
  { id: 'offers', label: 'Offers', category: 'transactions' as const },
  { id: 'contracts', label: 'Contracts', category: 'transactions' as const },
  { id: 'title', label: 'Title', category: 'transactions' as const },
  { id: 'closings', label: 'Closings', category: 'transactions' as const },
  { id: 'buyers', label: 'Buyers', category: 'network' as const },
  { id: 'manual_events', label: 'Manual Tasks', category: 'operator' as const },
  { id: 'risks', label: 'Risks / Blocked', category: 'attention' as const },
] as const

export const CALENDAR_LAYER_CATEGORIES = [
  { id: 'communication', label: 'Communication', layers: ['seller_replies', 'sms', 'email'] as CalendarLayerId[] },
  { id: 'automation', label: 'Automation', layers: ['follow_ups', 'workflow', 'campaigns'] as CalendarLayerId[] },
  { id: 'transactions', label: 'Transactions', layers: ['offers', 'contracts', 'title', 'closings'] as CalendarLayerId[] },
  { id: 'network', label: 'Network', layers: ['buyers'] as CalendarLayerId[] },
  { id: 'operator', label: 'Operator', layers: ['manual_events'] as CalendarLayerId[] },
  { id: 'attention', label: 'Attention', layers: ['risks'] as CalendarLayerId[] },
] as const

export const CALENDAR_LAYER_PRESETS = [
  { id: 'all', label: 'All Layers', layers: () => CALENDAR_LAYER_OPTIONS.map((l) => l.id) },
  { id: 'ops', label: 'Operations', layers: () => ['seller_replies', 'sms', 'workflow', 'follow_ups', 'offers', 'contracts', 'risks'] as CalendarLayerId[] },
  { id: 'transactions', label: 'Transactions', layers: () => ['contracts', 'title', 'closings', 'offers'] as CalendarLayerId[] },
  { id: 'attention', label: 'Attention', layers: () => ['risks', 'follow_ups'] as CalendarLayerId[] },
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