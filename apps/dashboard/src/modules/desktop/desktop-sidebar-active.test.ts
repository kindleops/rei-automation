import { describe, expect, it } from 'vitest'
import { NEXUS_APPS } from '../../domain/app-registry/app-registry'
import {
  isInboxDealIntelligenceShowing,
  publishInboxDealIntelligenceShowing,
  subscribeInboxDealIntelligenceShowing,
} from '../mobile/mobile-inbox-bridge'
import { activeFor } from './rail/rail-nav'

const inbox = NEXUS_APPS.find((app) => app.id === 'inbox')!
const intel = NEXUS_APPS.find((app) => app.id === 'deal-intelligence')!
const pipeline = NEXUS_APPS.find((app) => app.id === 'pipeline')!

describe('desktop sidebar: Deal Intelligence is the active app while its panel shows', () => {
  it('on /inbox with the panel showing, Deal Intelligence is highlighted and Inbox is not', () => {
    expect(activeFor('/inbox', intel, true)).toBe(true)
    expect(activeFor('/inbox', inbox, true)).toBe(false)
  })

  it('on /inbox without the panel, Inbox is highlighted', () => {
    expect(activeFor('/inbox', inbox, false)).toBe(true)
    expect(activeFor('/inbox', intel, false)).toBe(false)
  })

  it('a stale "showing" never claims another app\'s route', () => {
    expect(activeFor('/pipeline', intel, true)).toBe(false)
    expect(activeFor('/pipeline', pipeline, true)).toBe(true)
  })

  it('the panel state is a subscribable fact, and only changes notify', () => {
    let calls = 0
    const off = subscribeInboxDealIntelligenceShowing(() => { calls += 1 })
    publishInboxDealIntelligenceShowing(true)
    publishInboxDealIntelligenceShowing(true)
    expect(isInboxDealIntelligenceShowing()).toBe(true)
    publishInboxDealIntelligenceShowing(false)
    off()
    publishInboxDealIntelligenceShowing(true)
    expect(calls).toBe(2)
    publishInboxDealIntelligenceShowing(false)
  })
})
