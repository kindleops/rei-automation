import { describe, expect, it } from 'vitest'
import {
  computePinModeModifiers,
  getIntelligenceMode,
} from '../../src/views/map/command-map-intelligence-modes'
import { getCommandMapThemeIdentity } from '../../src/views/map/command-map-theme-identity'
import {
  buildUniversalSellerPinVisuals,
  resolveCommandPinRingColor,
  resolveEffectiveSellerState,
} from '../../src/views/map/universal-pin-system'
import {
  getUniversalRingColor,
  resolveSellerStateRingKey,
  UNIVERSAL_STAGE_RING_COLORS,
} from '../../src/views/map/universal-stage-colors'

describe('universal stage ring colors', () => {
  it('maps operational states to canonical ring keys', () => {
    expect(resolveSellerStateRingKey({ seller_state: 'not_contacted' })).toBe('uncontacted')
    expect(resolveSellerStateRingKey({ seller_state: 'hot', lead_temperature: 'hot' })).toBe('hot_urgent')
    expect(resolveSellerStateRingKey({ operational_status: 'follow_up_due' })).toBe('follow_up_due')
    expect(resolveSellerStateRingKey({ seller_state: 'negotiating' })).toBe('negotiating')
    expect(getUniversalRingColor('active_communication')).toBe(UNIVERSAL_STAGE_RING_COLORS.active_communication)
  })
})

describe('theme identity tokens', () => {
  it('gives each theme a distinct pin glow hue', () => {
    const satellite = getCommandMapThemeIdentity('satellite')
    const redOps = getCommandMapThemeIdentity('red_ops')
    const matrix = getCommandMapThemeIdentity('matrix')
    expect(satellite.pinGlowHue).not.toBe(redOps.pinGlowHue)
    expect(matrix.pinGlowHue).not.toBe(satellite.pinGlowHue)
    expect(satellite.mapAccentTint).toBeTruthy()
    expect(redOps.clusterTint).toContain('rgba')
  })
})

describe('intelligence mode modifiers', () => {
  it('dims low-signal pins in command mode while elevating priority pins', () => {
    const low = computePinModeModifiers('command', { seller_state: 'not_contacted' })
    const high = computePinModeModifiers('command', {
      seller_state: 'hot',
      priority_score: 90,
    })
    expect(low.focusOpacity).toBeLessThan(0.5)
    expect(high.focusOpacity).toBe(1)
    expect(high.glowStrength).toBeGreaterThan(low.glowStrength)
  })

  it('fades seller pins in buyer demand mode', () => {
    const mode = getIntelligenceMode('buyer_demand')
    expect(mode.sellerPinBaseOpacity).toBeGreaterThanOrEqual(0.35)
    expect(mode.sellerPinBaseOpacity).toBeLessThanOrEqual(0.45)
  })
})

describe('universal seller pin visuals', () => {
  it('builds ring-forward visuals with glass body and pulse for hot pins', () => {
    const visuals = buildUniversalSellerPinVisuals(
      {
        property_id: 'p1',
        seller_state: 'hot',
        execution_state: 'active',
        priority_score: 88,
        lat: 1,
        lng: 1,
      },
      'dark_ops',
      'acquisition',
    )
    expect(visuals.ring_color).toBe(UNIVERSAL_STAGE_RING_COLORS.hot_urgent)
    expect(visuals.glass_color).toContain('rgba')
    expect(visuals.pulse_style).not.toBe('none')
    expect(visuals.glow_strength).toBeGreaterThan(0.5)
  })

  it('uses execution ring colors in execution live mode', () => {
    const visuals = buildUniversalSellerPinVisuals(
      {
        property_id: 'p2',
        seller_state: 'contacted',
        execution_state: 'delivered',
        lat: 1,
        lng: 1,
      },
      'red_ops',
      'execution',
    )
    expect(visuals.ring_color).toBe('#30d158')
  })
})

describe('command pin ring resolver', () => {
  it('aligns thread pins with universal stage colors', () => {
    expect(resolveCommandPinRingColor({ operational_status: 'needs_review' }))
      .toBe(UNIVERSAL_STAGE_RING_COLORS.needs_review)
    expect(resolveEffectiveSellerState({ seller_state: 'new_replies' })).toBe('new_reply')
  })
})