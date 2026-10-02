import { describe, expect, it } from 'vitest'
import { countSenderSentToday, senderDayStart, senderOperatingTimezone } from './sender-sent-today'

const NOW = new Date('2026-10-01T20:00:00.000Z')

describe('sender sent-today (derived, not the never-reset counter)', () => {
  it('uses the sender’s own local midnight', () => {
    expect(senderOperatingTimezone({ market: 'Minneapolis, MN' })).toBe('America/Chicago')
    expect(senderDayStart(NOW, 'America/Chicago').toISOString()).toBe('2026-10-01T05:00:00.000Z')
  })

  it('counts only sends since that midnight, per sender', () => {
    const rows = [
      { phone_number: '+16125092623', market: 'Minneapolis, MN', messages_sent_today: 281 },
      { phone_number: '+13235589881', market: 'Los Angeles, CA', messages_sent_today: 2 },
    ]
    const counts = countSenderSentToday(rows, [
      { from_phone_number: '+16125092623', sent_at: '2026-10-01T04:59:00Z' },
      { from_phone_number: '6125092623', sent_at: '2026-10-01T05:00:00Z' },
      { from_phone_number: '+13235589881', sent_at: '2026-10-01T06:30:00Z' },
      { from_phone_number: '+13235589881', sent_at: '2026-10-01T07:30:00Z' },
    ], NOW)
    expect(counts.get('+16125092623')).toBe(1)
    expect(counts.get('+13235589881')).toBe(1)
  })
})
