import type { CSSProperties } from 'react'
import { USA_STATE_PATHS } from '../../lib/data/usaStatePaths'
import type { HomeMarket } from './home-signals'

/**
 * The country as a field of light.
 *
 * A dot matrix sampled from the same simplified state geometry the Analytics map
 * uses, with every state that has market activity this week lit in proportion to
 * its replies, and a beacon over the strongest. The geometry is reference data;
 * the only business data drawn here is the market leaderboard passed in.
 */

type Polygon = Array<[number, number]>

const SPACING = 15

const parsePolygon = (path: string): Polygon =>
  (path.match(/-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?/g) ?? []).map((pair) => {
    const [x, y] = pair.split(',').map(Number)
    return [x, y]
  })

const inside = (x: number, y: number, poly: Polygon) => {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

interface Dot { x: number; y: number; state: string }

let cachedDots: Dot[] | null = null

/** Sampled once per session: ~1,200 points, a few milliseconds of work. */
function matrix(): Dot[] {
  if (cachedDots) return cachedDots
  const polygons = Object.entries(USA_STATE_PATHS).map(([state, shape]) => ({ state, poly: parsePolygon(shape.path) }))
  const dots: Dot[] = []
  for (let row = 0, y = 60; y < 590; y += SPACING * 0.866, row++) {
    for (let x = 20 + (row % 2) * (SPACING / 2); x < 950; x += SPACING) {
      const owner = polygons.find(({ poly }) => inside(x, y, poly))
      if (owner) dots.push({ x, y, state: owner.state })
    }
  }
  cachedDots = dots
  return dots
}

const stateOfMarket = (market: HomeMarket): string | null => {
  const direct = market.state?.toUpperCase()
  if (direct && USA_STATE_PATHS[direct]) return direct
  const parsed = market.market.split(',').pop()?.trim().toUpperCase()
  return parsed && USA_STATE_PATHS[parsed] ? parsed : null
}

export function MarketConstellation({ markets }: { markets: HomeMarket[] }) {
  // Cached at module level after the first call; recomputing per render is free.
  const dots = matrix()

  const heat = (() => {
    const byState = new Map<string, number>()
    for (const market of markets) {
      const state = stateOfMarket(market)
      if (!state) continue
      byState.set(state, (byState.get(state) ?? 0) + market.replied + market.positive * 4)
    }
    const peak = Math.max(1, ...byState.values())
    return new Map([...byState].map(([state, value]) => [state, value / peak]))
  })()

  const beacons = (() => {
    const seen = new Set<string>()
    return markets
      .map((market) => ({ market, state: stateOfMarket(market) }))
      .filter((entry): entry is { market: HomeMarket; state: string } => {
        if (!entry.state || seen.has(entry.state)) return false
        seen.add(entry.state)
        return true
      })
      .slice(0, 4)
  })()

  return (
    <svg className="nx-home-constellation" viewBox="40 70 900 510" role="img" aria-label={`Market activity: ${beacons.map((b) => b.market.market).join(', ') || 'none this week'}`}>
      <defs>
        <radialGradient id="nx-home-beacon" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgb(var(--home-accent-rgb))" stopOpacity="0.55" />
          <stop offset="100%" stopColor="rgb(var(--home-accent-rgb))" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g className="nx-home-constellation__dots">
        {dots.map((dot, i) => {
          const level = heat.get(dot.state) ?? 0
          return (
            <circle
              key={i}
              cx={dot.x}
              cy={dot.y}
              r={level > 0 ? 3.3 + level * 1.4 : 2.6}
              className={level > 0 ? 'is-lit' : undefined}
              style={level > 0 ? ({ '--lvl': level.toFixed(2), '--tw': `${(i * 137) % 3000}ms` } as CSSProperties) : undefined}
            />
          )
        })}
      </g>
      {beacons.map(({ market, state }, i) => {
        const { cx, cy } = USA_STATE_PATHS[state]
        return (
          <g key={state} className={i === 0 ? 'nx-home-beacon is-top' : 'nx-home-beacon'} transform={`translate(${cx} ${cy})`}>
            <circle r="46" fill="url(#nx-home-beacon)" />
            <circle className="nx-home-beacon__ring" r="10" style={{ animationDelay: `${i * 600}ms` } as CSSProperties} />
            <circle className="nx-home-beacon__ring" r="10" style={{ animationDelay: `${i * 600 + 1300}ms` } as CSSProperties} />
            <circle className="nx-home-beacon__core" r={i === 0 ? 6 : 4.5} />
            {i === 0 ? <text y="-20" textAnchor="middle">{market.market.split(',')[0]}</text> : null}
          </g>
        )
      })}
    </svg>
  )
}
