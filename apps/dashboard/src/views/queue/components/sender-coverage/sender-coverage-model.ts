import type { AffinityTier, CoverageStatus, CoverageRoute } from './sender-coverage-api'
import type { LCTone } from '../../../../shared/lc'

/** Copy + tone for the coverage vocabulary. Red only for UNCOVERED (a real blocker). */
export const STATUS_META: Record<CoverageStatus, { label: string; tone: LCTone }> = {
  LOCAL: { label: 'Local', tone: 'ok' },
  REGIONAL: { label: 'Regional', tone: 'exec' },
  DEGRADED: { label: 'Degraded', tone: 'attn' },
  UNCOVERED: { label: 'Uncovered', tone: 'crit' },
}

export const TIER_LABEL: Record<AffinityTier, string> = {
  primary: 'Primary',
  preferred_fallback: 'Preferred',
  regional_fallback: 'Regional',
  last_resort: 'Last resort',
  blocked_never: 'Never',
}

export const TIER_ORDER: AffinityTier[] = ['primary', 'preferred_fallback', 'regional_fallback', 'last_resort', 'blocked_never']

/** Plain words for the eligibility reasons the policy returns. */
const REASON_WORDS: Record<string, string> = {
  blocked_by_operator: 'operator-blocked',
  status_paused: 'paused',
  health_cooling: 'cooling',
  cooling_until: 'cooling',
  health_blocked: 'health-blocked',
  unregistered: 'registration not recorded',
  webhook_unverified: 'inbound webhook unverified',
  onboarding_incomplete: 'onboarding',
  retired: 'retired',
  daily_limit_reached: 'at daily limit',
  pool_member_inactive: 'removed from pool',
  not_in_fleet: 'not in fleet yet',
}
export const reasonWords = (reason: string | null) => (reason ? REASON_WORDS[reason] || reason.replace(/_/g, ' ') : 'eligible')

export function routeHealthTone(route: Pick<CoverageRoute, 'health'>): LCTone {
  if (route.health === 'healthy') return 'ok'
  if (route.health === 'partial') return 'attn'
  return 'neutral'
}

export const STATUS_FILTERS: Array<{ value: 'ALL' | CoverageStatus; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'LOCAL', label: 'Local' },
  { value: 'REGIONAL', label: 'Regional' },
  { value: 'DEGRADED', label: 'Degraded' },
  { value: 'UNCOVERED', label: 'Uncovered' },
]
