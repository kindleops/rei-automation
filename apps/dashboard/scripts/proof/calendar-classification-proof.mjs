import assert from 'node:assert/strict'
import { classifyEventTiming, isActionableEvent, isHistoricalEvent } from '../../src/lib/calendar/calendar-event-classification.ts'

const historical = {
  id: '1', type: 'sms_sent', tone: 'green', title: 'SMS Sent', description: '', timestamp: '2026-04-01T10:00:00Z',
  sourceTable: 'send_queue', status: 'sent', market: 'Tulsa', state: 'OK', sellerName: 'Jane', propertyAddress: '123 Main',
  propertyId: null, sellerId: null, threadId: null, priority: 'normal', actor: 'System', overdue: false, dueSoon: false,
  hot: false, automationBlocked: false, readOnlyReason: 'historical_send', riskState: 'historical',
}

const scheduled = {
  ...historical,
  id: '2', type: 'scheduled_sms', title: 'Scheduled SMS', timestamp: '2026-06-25T10:00:00Z',
  status: 'scheduled', readOnlyReason: null, riskState: 'on_track', reschedulable: true,
}

assert.equal(isHistoricalEvent(historical), true)
assert.equal(isActionableEvent(historical), false)
assert.equal(classifyEventTiming(historical), 'historical')
assert.equal(isActionableEvent(scheduled), true)
assert.equal(classifyEventTiming(scheduled), 'scheduled')

console.log('calendar-classification-proof: PASS')