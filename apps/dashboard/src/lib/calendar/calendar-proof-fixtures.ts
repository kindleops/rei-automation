import type { CalendarEvent } from '../data/calendarData'

/** Deterministic fixtures for proof/tests only — never shown in production without ?calendar_proof=1 */
export function buildCalendarProofFixtures(anchor = new Date()): CalendarEvent[] {
  const day = anchor.toISOString().slice(0, 10)
  const at = (hour: number, min = 0) => `${day}T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00.000Z`

  const base = {
    market: 'Tulsa',
    state: 'OK',
    sellerName: 'Jane Seller',
    propertyAddress: '1550 E Emelita Ave',
    propertyId: 'prop-proof-1',
    sellerId: 'owner-proof-1',
    threadId: 'thread-proof-1',
    opportunityId: 'opp-proof-1',
    priority: 'normal',
    actor: 'System',
    hot: false,
    automationBlocked: false,
    timezone: 'America/Chicago',
  }

  return [
    {
      ...base, id: 'proof:scheduled-sms', type: 'scheduled_sms', tone: 'blue',
      title: 'Scheduled SMS', description: 'Queue send', timestamp: at(9, 30),
      sourceTable: 'send_queue', sourceDomain: 'queue', status: 'scheduled',
      overdue: false, dueSoon: true, reschedulable: false, readOnlyReason: 'queue_owned',
    },
    {
      ...base, id: 'proof:workflow-wake', type: 'workflow_wake', tone: 'violet',
      title: 'Workflow wake', description: 'Resume enrollment', timestamp: at(11),
      sourceTable: 'workflow_enrollments', sourceDomain: 'workflow', status: 'waiting',
      overdue: false, dueSoon: false, reschedulable: false, readOnlyReason: 'workflow_owned',
    },
    {
      ...base, id: 'proof:seller-reply', type: 'inbound_reply', tone: 'cyan',
      title: 'Seller replied', description: 'Inbound SMS', timestamp: at(10, 15),
      sourceTable: 'message_events', status: 'received', riskState: 'historical',
      overdue: false, dueSoon: false, reschedulable: false, readOnlyReason: 'historical_message',
    },
    {
      ...base, id: 'proof:follow-up', type: 'seller_follow_up', tone: 'amber',
      title: 'Follow-up due', description: 'Next action', timestamp: at(14),
      sourceTable: 'acquisition_opportunities', sourceDomain: 'pipeline', status: 'due',
      overdue: false, dueSoon: true, reschedulable: false,
    },
    {
      ...base, id: 'proof:offer', type: 'offer_expiration', tone: 'gold',
      title: 'Offer expiration', description: 'Offer expiration window', timestamp: at(16),
      sourceTable: 'offers', status: 'pending', overdue: false, dueSoon: false, reschedulable: false,
    },
    {
      ...base, id: 'proof:contract', type: 'contract_signature_deadline', tone: 'purple',
      title: 'Contract signature', description: 'Signature deadline', timestamp: at(17),
      sourceTable: 'contracts', status: 'awaiting_signature', overdue: false, dueSoon: false, reschedulable: false,
    },
    {
      ...base, id: 'proof:title', type: 'title_milestone', tone: 'gold',
      title: 'Title milestone', description: 'Title milestone checkpoint', timestamp: at(13),
      sourceTable: 'title_routing_closing_engine', status: 'scheduled', overdue: false, dueSoon: false, reschedulable: false,
    },
    {
      ...base, id: 'proof:closing', type: 'closing_scheduled', tone: 'emerald',
      title: 'Closing scheduled', description: 'Closing date', timestamp: at(15), allDay: true,
      sourceTable: 'closings', status: 'scheduled', overdue: false, dueSoon: false, reschedulable: false,
    },
    {
      ...base, id: 'proof:manual-task', type: 'manual_task', tone: 'gray',
      title: 'Review comps', description: 'Manual task', timestamp: at(8), sourceTable: 'calendar_manual_events',
      sourceDomain: 'manual', status: 'scheduled', overdue: false, dueSoon: false, reschedulable: true, editable: true,
      sourceRecordId: 'manual-proof-1',
    },
    {
      ...base, id: 'proof:reminder', type: 'manual_reminder', tone: 'gray',
      title: 'Call title company', description: 'Manual reminder', timestamp: at(12), sourceTable: 'calendar_manual_events',
      sourceDomain: 'manual', status: 'scheduled', overdue: false, dueSoon: false, reschedulable: true, editable: true,
      sourceRecordId: 'manual-proof-2',
    },
    {
      ...base, id: 'proof:overdue', type: 'scheduled_sms', tone: 'red',
      title: 'Overdue queue send', description: 'Overdue scheduled SMS', timestamp: new Date(anchor.getTime() - 86400000 * 2).toISOString(),
      sourceTable: 'send_queue', sourceDomain: 'queue', status: 'scheduled',
      overdue: true, dueSoon: false, reschedulable: false, readOnlyReason: 'queue_owned',
    },
  ]
}

export function isCalendarProofMode(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).has('calendar_proof')
}