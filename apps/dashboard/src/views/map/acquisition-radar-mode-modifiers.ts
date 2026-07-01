/**
 * Intelligence-mode modifiers for Acquisition Radar property universe pins.
 * Modes affect emphasis/opacity — semantic ring colors stay unchanged.
 */

import type { CommandMapIntelligenceModeId } from './command-map-intelligence-modes'
import { getIntelligenceMode } from './command-map-intelligence-modes'
import type { AcquisitionRadarSemanticKey } from './acquisition-radar-state-matrix'
import { isPriorityBreakoutPin } from './acquisition-radar-state-matrix'

export type AcquisitionRadarModeModifiers = {
  baseOpacity: number
  ringOpacity: number
  glassOpacity: number
  haloOpacityMultiplier: number
  iconScale: number
  showMotion: boolean
  motionIntensity: number
  simplifyPin: boolean
}

const isHighPrioritySemantic = (
  key: AcquisitionRadarSemanticKey,
  score: number,
): boolean =>
  isPriorityBreakoutPin(key)
  || key === 'active_communication'
  || key === 'needs_review'
  || key === 'delivery_failed'
  || score >= 75

const isPassiveSemantic = (key: AcquisitionRadarSemanticKey): boolean =>
  key === 'uncontacted'
  || key === 'ownership_check'
  || key === 'dead_archived'
  || key === 'closed_resolved'

export const computeAcquisitionRadarModeModifiers = (
  modeId: CommandMapIntelligenceModeId,
  semanticKey: AcquisitionRadarSemanticKey,
  acquisitionScore: number,
): AcquisitionRadarModeModifiers => {
  const mode = getIntelligenceMode(modeId)
  const highPriority = isHighPrioritySemantic(semanticKey, acquisitionScore)
  const passive = isPassiveSemantic(semanticKey)

  let baseOpacity = mode.sellerPinBaseOpacity
  let ringOpacity = 0.92
  let glassOpacity = 0.88
  let haloOpacityMultiplier = 1
  let iconScale = 1
  let showMotion = semanticKey !== 'uncontacted' && semanticKey !== 'dead_archived'
  let motionIntensity = 1
  let simplifyPin = mode.simplifyPins

  switch (mode.id) {
    case 'command':
      baseOpacity = highPriority ? 1 : 0.28
      ringOpacity = highPriority ? 1 : 0.55
      glassOpacity = highPriority ? 0.94 : 0.62
      haloOpacityMultiplier = highPriority ? 1.35 : 0.45
      iconScale = highPriority ? 1.08 : 0.92
      showMotion = highPriority
      motionIntensity = highPriority ? 1.25 : 0
      break
    case 'execution':
      showMotion = !passive
      motionIntensity = 1.2
      if (!highPriority && passive) baseOpacity *= 0.5
      else if (highPriority) baseOpacity = Math.max(baseOpacity, 0.95)
      break
    case 'buyer_demand':
      if (highPriority) {
        baseOpacity = Math.max(baseOpacity, 0.88)
        haloOpacityMultiplier = 1.25
        ringOpacity = 1
      } else if (passive) {
        baseOpacity = Math.min(baseOpacity, 0.38)
        haloOpacityMultiplier = 0.55
      }
      break
    case 'opportunity_heat': {
      const heat = acquisitionScore >= 85 ? 1 : acquisitionScore >= 70 ? 0.82 : acquisitionScore >= 40 ? 0.58 : 0.38
      baseOpacity *= heat
      haloOpacityMultiplier = acquisitionScore >= 70 ? 1.45 : acquisitionScore >= 40 ? 0.85 : 0.5
      if (passive && acquisitionScore < 50) baseOpacity = Math.min(baseOpacity, 0.42)
      break
    }
    case 'comps':
      baseOpacity *= 0.52
      ringOpacity = 0.72
      haloOpacityMultiplier = 0.6
      showMotion = false
      if (highPriority) baseOpacity = Math.max(baseOpacity, 0.78)
      break
    case 'census':
      baseOpacity *= 0.42
      ringOpacity = 0.7
      haloOpacityMultiplier = 0.52
      showMotion = false
      if (highPriority) baseOpacity = Math.max(baseOpacity, 0.82)
      break
    case 'territory':
      simplifyPin = true
      haloOpacityMultiplier = 0.68
      ringOpacity = 0.84
      showMotion = false
      break
    case 'acquisition':
    default:
      if (mode.dimUncontacted && passive) {
        baseOpacity = Math.min(baseOpacity, 0.72)
        haloOpacityMultiplier = 0.68
        ringOpacity = 0.82
      } else if (highPriority) {
        baseOpacity = Math.max(baseOpacity, 0.96)
        haloOpacityMultiplier = 1.18
      }
      break
  }

  if (mode.overlayPrimary) {
    haloOpacityMultiplier *= 0.62
    ringOpacity *= 0.74
    baseOpacity *= 0.85
  }

  if (simplifyPin) {
    haloOpacityMultiplier *= 0.7
    ringOpacity *= 0.8
    glassOpacity *= 0.9
  }

  if (acquisitionScore >= 90) haloOpacityMultiplier = Math.max(haloOpacityMultiplier, 1.1)
  else if (acquisitionScore >= 70) haloOpacityMultiplier = Math.max(haloOpacityMultiplier, 0.92)

  return {
    baseOpacity: Math.min(1, Math.max(0.18, baseOpacity)),
    ringOpacity,
    glassOpacity,
    haloOpacityMultiplier,
    iconScale,
    showMotion,
    motionIntensity,
    simplifyPin,
  }
}