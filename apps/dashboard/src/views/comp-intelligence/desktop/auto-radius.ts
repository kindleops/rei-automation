import type { CompsWorkspace } from '../../../domain/comp-intelligence/comps-evidence-api'

/**
 * AUTO SEARCH RADIUS — the review opens at a radius that fits the market's
 * density instead of always at the engine's residential window (4 mi), which
 * in a dense city pulls in sales from other neighbourhoods.
 *
 * The comp engine has no density setting, so density is MEASURED from the
 * search itself, with the engine's own sufficiency number as the bar: the
 * valuation-confidence depth term is full at `depthFullAt` comps (8). The
 * ladder starts at 1 mi:
 *   - ≥ 8 usable same-asset priced comps within 0.5 mi  → 0.5 mi (dense / urban)
 *   - ≥ 8 within 1 mi                                   → stay at 1 mi
 *   - fewer                                             → widen 2 mi, then the
 *     engine window (4 mi SFR · 7 mi multifamily · 10 mi land), and stop there.
 * Each step is one ordinary workspace read; an explicit operator choice
 * (a quick chip, the select, "Engine window") switches auto off.
 */
export const AUTO_START_MILES = 1
export const QUICK_RADII = [0.5, 1, 2, 4] as const
const LADDER = [0.5, 1, 2, 4]

/** usable = not excluded by the engine's rules, same asset family, priced, within r miles */
export function usableWithin(w: Pick<CompsWorkspace, 'comps'>, miles: number): number {
  return w.comps.filter((c) => c.state !== 'excluded' && c.assetMatch && (c.salePrice ?? 0) > 0 && c.distanceMiles !== null && c.distanceMiles <= miles).length
}

export interface AutoStep { next: number | null; reason: string }

/**
 * Given the workspace read at `current` miles, where auto goes next.
 * `next` null = stop here; `next` === the engine window radius = open the engine window.
 */
export function nextAutoRadius(w: Pick<CompsWorkspace, 'comps' | 'query' | 'engineRules'>, current: number): AutoStep {
  const need = w.engineRules?.confidence?.depthFullAt ?? 8
  const ceiling = w.query.engineWindow?.radiusMiles ?? Math.max(...LADDER)
  const here = usableWithin(w, current)
  if (current <= 1 && current > 0.5) {
    const half = usableWithin(w, 0.5)
    if (half >= need) return { next: 0.5, reason: `dense — ${half} comps within 0.5 mi` }
  }
  if (here >= need) return { next: null, reason: `${here} comps within ${current} mi` }
  if (current >= ceiling) return { next: null, reason: `${here} comps at the engine window` }
  const up = [...LADDER, ceiling].filter((r) => r > current && r <= ceiling).sort((a, b) => a - b)[0] ?? ceiling
  return { next: up, reason: `only ${here} comps within ${current} mi — widening` }
}
