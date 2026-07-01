import { describe, expect, it } from 'vitest'
import { computeAcquisitionRadarModeModifiers } from '../../src/views/map/acquisition-radar-mode-modifiers'

describe('acquisition radar mode modifiers', () => {
  it('elevates priority pins in command mode and dims uncontacted', () => {
    const uncontacted = computeAcquisitionRadarModeModifiers('command', 'uncontacted', 10)
    const hot = computeAcquisitionRadarModeModifiers('command', 'hot_urgent', 92)
    expect(uncontacted.baseOpacity).toBeLessThan(0.4)
    expect(hot.baseOpacity).toBe(1)
    expect(hot.showMotion).toBe(true)
    expect(uncontacted.showMotion).toBe(false)
  })

  it('amplifies motion in execution live mode', () => {
    const active = computeAcquisitionRadarModeModifiers('execution', 'active_communication', 55)
    expect(active.showMotion).toBe(true)
    expect(active.motionIntensity).toBeGreaterThan(1)
  })

  it('subdues pins in census intel while keeping priority readable', () => {
    const passive = computeAcquisitionRadarModeModifiers('census', 'uncontacted', 20)
    const priority = computeAcquisitionRadarModeModifiers('census', 'new_reply', 80)
    expect(passive.baseOpacity).toBeLessThan(priority.baseOpacity)
    expect(priority.baseOpacity).toBeGreaterThan(0.65)
  })
})