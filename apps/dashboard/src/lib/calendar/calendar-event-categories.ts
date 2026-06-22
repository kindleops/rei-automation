import type { CalendarEvent, CalendarEventType } from '../data/calendarData'
import type { IconName } from '../../shared/icons'

export type CalendarEventCategory =
  | 'automation'
  | 'sms'
  | 'reply'
  | 'offer'
  | 'contract'
  | 'title'
  | 'closing'
  | 'buyer'
  | 'campaign'
  | 'task'
  | 'reminder'
  | 'risk'
  | 'manual'

const AUTOMATION_TYPES = new Set<CalendarEventType>([
  'workflow_wake', 'workflow_task', 'workflow_blocked', 'seller_follow_up',
  'automation_blocked', 'queue_retry', 'pipeline_next_action',
])

const SMS_TYPES = new Set<CalendarEventType>([
  'scheduled_sms', 'sms_sent', 'sms_delivered', 'sms_failed', 'email_follow_up',
])

const REPLY_TYPES = new Set<CalendarEventType>([
  'inbound_reply', 'seller_reply_needs_action', 'positive_intent',
])

const OFFER_TYPES = new Set<CalendarEventType>([
  'offer_created', 'offer_sent', 'offer_expiration', 'offer_follow_up',
])

const CONTRACT_TYPES = new Set<CalendarEventType>([
  'contract_sent', 'contract_signature_deadline', 'fully_executed_contract',
])

const TITLE_TYPES = new Set<CalendarEventType>([
  'title_opened', 'title_milestone', 'clear_to_close',
])

const CLOSING_TYPES = new Set<CalendarEventType>(['closing_scheduled'])

const BUYER_TYPES = new Set<CalendarEventType>(['buyer_follow_up', 'buyer_packet_sent'])

const CAMPAIGN_TYPES = new Set<CalendarEventType>(['campaign_scheduled'])

const RISK_TYPES = new Set<CalendarEventType>([
  'automation_blocked', 'workflow_blocked', 'sms_failed', 'dnc_suppression', 'wrong_number',
])

export const CATEGORY_META: Record<CalendarEventCategory, { icon: IconName; label: string; dot: string }> = {
  automation: { icon: 'cpu', label: 'Automation', dot: '#a855f7' },
  sms: { icon: 'send', label: 'SMS', dot: '#60a5fa' },
  reply: { icon: 'message', label: 'Seller reply', dot: '#22d3ee' },
  offer: { icon: 'dollar-sign', label: 'Offer', dot: '#eab308' },
  contract: { icon: 'file-text', label: 'Contract', dot: '#a78bfa' },
  title: { icon: 'briefcase', label: 'Title', dot: '#f59e0b' },
  closing: { icon: 'check', label: 'Closing', dot: '#22c55e' },
  buyer: { icon: 'users', label: 'Buyer', dot: '#f97316' },
  campaign: { icon: 'target', label: 'Campaign', dot: '#38bdf8' },
  task: { icon: 'check', label: 'Task', dot: '#94a3b8' },
  reminder: { icon: 'bell', label: 'Reminder', dot: '#cbd5e1' },
  risk: { icon: 'alert-circle', label: 'Risk', dot: '#ef4444' },
  manual: { icon: 'file-text', label: 'Manual', dot: '#94a3b8' },
}

export function getEventCategory(event: CalendarEvent): CalendarEventCategory {
  if (event.type === 'manual_task') return 'task'
  if (event.type === 'manual_reminder') return 'reminder'
  if (event.overdue || RISK_TYPES.has(event.type)) return 'risk'
  if (REPLY_TYPES.has(event.type)) return 'reply'
  if (SMS_TYPES.has(event.type)) return event.type === 'scheduled_sms' ? 'sms' : 'sms'
  if (AUTOMATION_TYPES.has(event.type)) return 'automation'
  if (OFFER_TYPES.has(event.type)) return 'offer'
  if (CONTRACT_TYPES.has(event.type)) return 'contract'
  if (TITLE_TYPES.has(event.type)) return 'title'
  if (CLOSING_TYPES.has(event.type)) return 'closing'
  if (BUYER_TYPES.has(event.type)) return 'buyer'
  if (CAMPAIGN_TYPES.has(event.type)) return 'campaign'
  return 'manual'
}

export function summarizeDayCategories(events: CalendarEvent[]): CalendarEventCategory[] {
  const seen = new Set<CalendarEventCategory>()
  const order: CalendarEventCategory[] = []
  for (const event of events) {
    const cat = getEventCategory(event)
    if (!seen.has(cat)) {
      seen.add(cat)
      order.push(cat)
    }
  }
  return order.slice(0, 5)
}

export function categoryIcon(category: CalendarEventCategory): IconName {
  return CATEGORY_META[category].icon
}