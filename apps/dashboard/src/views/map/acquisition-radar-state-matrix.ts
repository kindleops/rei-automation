/**
 * Canonical Acquisition Radar semantic state matrix.
 * Ring colors and visual treatment — shared meaning across presets.
 */

export type AcquisitionRadarSemanticKey =
  | 'uncontacted'
  | 'ownership_check'
  | 'needs_review'
  | 'active_communication'
  | 'waiting_on_seller'
  | 'follow_up_due'
  | 'negotiating'
  | 'new_reply'
  | 'hot_urgent'
  | 'delivery_failed'
  | 'suppressed_dnc'
  | 'closed_resolved'
  | 'dead_archived'

export type AcquisitionRadarMotion = 'static' | 'breathing' | 'follow_up_pulse' | 'reply_ripple' | 'urgent_pulse' | 'failure_flicker'

export type AcquisitionRadarStateSpec = {
  key: AcquisitionRadarSemanticKey
  ring: string
  highlight: string
  baseOpacity: number
  haloOpacity: number
  bodySaturation: number
  motion: AcquisitionRadarMotion
  badge: 'none' | 'warning' | 'lock' | 'target' | 'unread'
}

export const ACQUISITION_RADAR_STATE_MATRIX: Record<AcquisitionRadarSemanticKey, AcquisitionRadarStateSpec> = {
  uncontacted: {
    key: 'uncontacted',
    ring: '#7A8FA8',
    highlight: '#A8B8CC',
    baseOpacity: 0.82,
    haloOpacity: 0.10,
    bodySaturation: 1,
    motion: 'static',
    badge: 'none',
  },
  ownership_check: {
    key: 'ownership_check',
    ring: '#42C4FF',
    highlight: '#9BE4FF',
    baseOpacity: 0.82,
    haloOpacity: 0.24,
    bodySaturation: 1,
    motion: 'static',
    badge: 'none',
  },
  needs_review: {
    key: 'needs_review',
    ring: '#FFB84C',
    highlight: '#FFE0A3',
    baseOpacity: 0.84,
    haloOpacity: 0.28,
    bodySaturation: 1,
    motion: 'static',
    badge: 'warning',
  },
  active_communication: {
    key: 'active_communication',
    ring: '#29E68B',
    highlight: '#9CFFD0',
    baseOpacity: 0.88,
    haloOpacity: 0.34,
    bodySaturation: 1,
    motion: 'breathing',
    badge: 'none',
  },
  waiting_on_seller: {
    key: 'waiting_on_seller',
    ring: '#FFD34F',
    highlight: '#FFF0A1',
    baseOpacity: 0.86,
    haloOpacity: 0.32,
    bodySaturation: 1,
    motion: 'breathing',
    badge: 'none',
  },
  follow_up_due: {
    key: 'follow_up_due',
    ring: '#FF4FD8',
    highlight: '#FFB6F0',
    baseOpacity: 0.9,
    haloOpacity: 0.42,
    bodySaturation: 1,
    motion: 'follow_up_pulse',
    badge: 'none',
  },
  negotiating: {
    key: 'negotiating',
    ring: '#FF893D',
    highlight: '#FFD0AC',
    baseOpacity: 0.9,
    haloOpacity: 0.44,
    bodySaturation: 1,
    motion: 'static',
    badge: 'none',
  },
  new_reply: {
    key: 'new_reply',
    ring: '#22D9FF',
    highlight: '#B5F5FF',
    baseOpacity: 0.92,
    haloOpacity: 0.54,
    bodySaturation: 1,
    motion: 'reply_ripple',
    badge: 'unread',
  },
  hot_urgent: {
    key: 'hot_urgent',
    ring: '#FF4C55',
    highlight: '#FFB0A8',
    baseOpacity: 0.94,
    haloOpacity: 0.58,
    bodySaturation: 1,
    motion: 'urgent_pulse',
    badge: 'none',
  },
  delivery_failed: {
    key: 'delivery_failed',
    ring: '#FF5B57',
    highlight: '#FFB020',
    baseOpacity: 0.9,
    haloOpacity: 0.44,
    bodySaturation: 1,
    motion: 'failure_flicker',
    badge: 'warning',
  },
  suppressed_dnc: {
    key: 'suppressed_dnc',
    ring: '#C7475D',
    highlight: '#E88A98',
    baseOpacity: 0.56,
    haloOpacity: 0.12,
    bodySaturation: 0.55,
    motion: 'static',
    badge: 'lock',
  },
  closed_resolved: {
    key: 'closed_resolved',
    ring: '#3BC9B5',
    highlight: '#9CEEDF',
    baseOpacity: 0.66,
    haloOpacity: 0.16,
    bodySaturation: 1,
    motion: 'static',
    badge: 'none',
  },
  dead_archived: {
    key: 'dead_archived',
    ring: '#697486',
    highlight: '#9AA3B2',
    baseOpacity: 0.46,
    haloOpacity: 0,
    bodySaturation: 1,
    motion: 'static',
    badge: 'none',
  },
}

export type PriorityGlowTier = {
  min: number
  max: number
  haloScale: number
  haloOpacityMultiplier: number
  markerScale: number
  breathing: boolean
  doubleRing: boolean
  dashedSecondary: boolean
}

export const PRIORITY_GLOW_TIERS: PriorityGlowTier[] = [
  { min: -1, max: -1, haloScale: 1, haloOpacityMultiplier: 0.55, markerScale: 1, breathing: false, doubleRing: false, dashedSecondary: true },
  { min: 0, max: 24, haloScale: 1, haloOpacityMultiplier: 0.55, markerScale: 1, breathing: false, doubleRing: false, dashedSecondary: false },
  { min: 25, max: 49, haloScale: 1.08, haloOpacityMultiplier: 0.75, markerScale: 1, breathing: false, doubleRing: false, dashedSecondary: false },
  { min: 50, max: 69, haloScale: 1.16, haloOpacityMultiplier: 1, markerScale: 1.03, breathing: false, doubleRing: false, dashedSecondary: false },
  { min: 70, max: 84, haloScale: 1.28, haloOpacityMultiplier: 1.3, markerScale: 1.07, breathing: true, doubleRing: false, dashedSecondary: false },
  { min: 85, max: 100, haloScale: 1.42, haloOpacityMultiplier: 1.55, markerScale: 1.12, breathing: true, doubleRing: true, dashedSecondary: false },
]

const lower = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')

/** Map API markerState + row fields → canonical semantic key (priority order from spec) */
export const resolveAcquisitionRadarSemanticKey = (props: {
  markerState?: string | null
  contactStatus?: string | null
  activityStatus?: string | null
  acquisitionScore?: number | null
  isArchived?: boolean | null
}): AcquisitionRadarSemanticKey => {
  if (props.isArchived) return 'dead_archived'

  const ms = lower(props.markerState)
  const cs = lower(props.contactStatus)
  const as_ = lower(props.activityStatus)
  const combined = `${cs} ${as_} ${ms}`

  if (ms === 'suppressed' || /dnc|opt_out|do_not_contact|blacklist/.test(combined)) {
    return 'suppressed_dnc'
  }
  if (ms === 'blocked' || /failed|delivery_failed|automation_blocked|queue_blocked/.test(combined)) {
    return 'delivery_failed'
  }
  if (ms === 'new_reply' || /new_reply|unread|inbound/.test(combined)) {
    return 'new_reply'
  }
  if (ms === 'hot') {
    return 'hot_urgent'
  }
  if (ms === 'negotiating' || /negotiat/.test(combined)) {
    return 'negotiating'
  }
  if (/follow_up_due|followup_due/.test(combined)) {
    return 'follow_up_due'
  }
  if (/waiting_on_seller|waiting/.test(combined)) {
    return 'waiting_on_seller'
  }
  if (
    ms !== 'not_contacted'
    && ms !== 'base_property'
    && (ms === 'positive' || ms === 'active_communication' || /active_communication/.test(combined) || ms === 'contacted')
  ) {
    return 'active_communication'
  }
  if (ms === 'needs_review' || /needs_review/.test(combined)) {
    return 'needs_review'
  }
  if (/ownership_check|ownership_confirmation/.test(combined)) {
    return 'ownership_check'
  }
  if (ms === 'not_contacted' || ms === 'base_property' || !cs || cs === 'uncontacted' || cs === 'not_contacted') {
    return 'uncontacted'
  }
  if (/closed|resolved|sold_comp/.test(combined)) {
    return 'closed_resolved'
  }
  if (/archived|dead|not_interested/.test(combined)) {
    return 'dead_archived'
  }
  return 'uncontacted'
}

export const getPriorityGlowTier = (score: number | null | undefined, unscored = false): PriorityGlowTier => {
  if (unscored || score === null || score === undefined || !Number.isFinite(score)) {
    return PRIORITY_GLOW_TIERS[0]
  }
  const s = Math.max(0, Math.min(100, score))
  return PRIORITY_GLOW_TIERS.find((t) => t.min >= 0 && s >= t.min && s <= t.max)
    ?? PRIORITY_GLOW_TIERS[PRIORITY_GLOW_TIERS.length - 1]
}

export const isPriorityBreakoutPin = (semanticKey: AcquisitionRadarSemanticKey): boolean =>
  semanticKey === 'new_reply'
  || semanticKey === 'hot_urgent'
  || semanticKey === 'negotiating'
  || semanticKey === 'follow_up_due'

export const ACQUISITION_RADAR_ZOOM = {
  regionalMax: 7.99,
  metroMin: 8,
  metroMax: 10.99,
  cityMin: 11,
  cityMax: 12.49,
  neighborhoodMin: 12.5,
  neighborhoodMax: 13.74,
  streetMin: 13.75,
  clusterMaxZoom: 14,
  fetchMinZoom: 4,
} as const

export type AcquisitionRadarZoomBand = 'regional' | 'metro' | 'city' | 'neighborhood' | 'street'

export const getAcquisitionRadarZoomBand = (zoom: number): AcquisitionRadarZoomBand => {
  if (zoom < ACQUISITION_RADAR_ZOOM.metroMin) return 'regional'
  if (zoom < ACQUISITION_RADAR_ZOOM.cityMin) return 'metro'
  if (zoom < ACQUISITION_RADAR_ZOOM.neighborhoodMin) return 'city'
  if (zoom < ACQUISITION_RADAR_ZOOM.streetMin) return 'neighborhood'
  return 'street'
}