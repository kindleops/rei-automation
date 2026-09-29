import { beforeEach, describe, expect, it } from 'vitest'
import { alertTypeFor, ALERT_TYPES, DEFAULT_ALERT_SOUND, PUSH_DEFAULTS } from './alert-types'
import { alertSoundFor, shouldPlayNotificationSound } from './notification-sound-bridge'
import { resetSettings, updateSetting } from '../../shared/settings'

// The server decides which phones a push reaches with its own copy of this
// mapping; if the two drift, the settings screen lies about what buzzes.
const SERVER_MODULE = '../../../../api/src/lib/domain/notifications/alert-types.js'

const EVENTS = [
  { type: 'inbox_message_received', domain: 'inbox', severity: 'neutral' },
  { type: 'inbox_hot_lead', domain: 'inbox', severity: 'positive' },
  { type: 'inbox_price_captured', domain: 'inbox', severity: 'positive' },
  { type: 'inbox_opt_out_received', domain: 'inbox', severity: 'warning' },
  { type: 'inbox_negative_sentiment', domain: 'inbox', severity: 'warning' },
  { type: 'campaign_scheduled', domain: 'campaigns', severity: 'neutral' },
  { type: 'campaign_stale_heartbeat', domain: 'campaigns', severity: 'warning' },
  { type: 'template_delivery_falling', domain: 'templates', severity: 'warning' },
  { type: 'launch_safety.send_failed', domain: 'launch_safety', severity: 'warning' },
  { type: 'offer_sent', domain: 'acquisition', severity: 'positive' },
]

describe('alert types', () => {
  it('match the server mapping and push defaults exactly', async () => {
    const server = await import(/* @vite-ignore */ SERVER_MODULE)
    for (const e of EVENTS) {
      expect(alertTypeFor(e), e.type).toBe(server.alertTypeFor({ event_type: e.type, domain: e.domain, severity: e.severity }))
    }
    expect([...ALERT_TYPES]).toEqual([...server.ALERT_TYPES])
    expect({ ...PUSH_DEFAULTS }).toEqual({ ...server.PUSH_DEFAULTS })
  })

  it('a seller reply is its own type (it used to ride on severity, and never buzzed)', () => {
    expect(alertTypeFor({ type: 'inbox_message_received', domain: 'inbox', severity: 'neutral' })).toBe('seller_reply')
    expect(PUSH_DEFAULTS.seller_reply).toBe(true)
  })
})

describe('alert sounds', () => {
  beforeEach(() => resetSettings())
  const reply = { type: 'inbox_message_received', domain: 'inbox' as const, severity: 'neutral' as const, soundCategory: 'seller-reply' as const }

  it('play by default — no longer gated on the UI-sound switch that defaulted off', () => {
    expect(shouldPlayNotificationSound(reply)).toBe(true)
    expect(alertSoundFor('seller_reply')).toBe(DEFAULT_ALERT_SOUND.seller_reply)
  })

  it('follow the operator: sounds off, type off, or sound "None" silences', () => {
    updateSetting('notificationSoundEnabled', false)
    expect(shouldPlayNotificationSound(reply)).toBe(false)
    resetSettings()
    updateSetting('alertTypeEnabled', { seller_reply: false })
    expect(shouldPlayNotificationSound(reply)).toBe(false)
    resetSettings()
    updateSetting('alertTypeSound', { seller_reply: 'none' })
    expect(shouldPlayNotificationSound(reply)).toBe(false)
  })

  it('use the sound the operator picked', () => {
    updateSetting('alertTypeSound', { seller_reply: 'priority-sms' })
    expect(alertSoundFor('seller_reply')).toBe('priority-sms')
    updateSetting('alertTypeSound', { seller_reply: 'not-a-sound' })
    expect(alertSoundFor('seller_reply')).toBe(DEFAULT_ALERT_SOUND.seller_reply)
  })
})
