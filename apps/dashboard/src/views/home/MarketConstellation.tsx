import type { CSSProperties } from 'react'
import { US_DOTS, US_STATES, US_VIEWBOX } from './us-dot-matrix'
import type { HomeMarket, HomeReplyPin } from './home-signals'

/**
 * The country as a field of light.
 *
 * The dot matrix is sampled from the Census state boundaries (us-atlas, Albers
 * USA) by scripts/generate-us-dot-matrix.mjs, so the outline is the real one,
 * Alaska and Hawaii included as insets. On top of it, only real data:
 *
 *   market heat   states with outreach activity this week (war-room market
 *                 leaderboard), their dots pulsing in accent-coloured waves that
 *                 radiate out from the state, brighter with more replies
 *   beacons       the strongest markets
 *   sparks        where sellers are replying from right now (the inbox's own
 *                 coordinates for the recent-replies bucket)
 *
 * The static dots and the animated dots are separate SVG layers: the animated
 * layer repaints each frame, and it holds only the few hundred lit dots.
 */

interface Dot { x: number; y: number; state: number }

let cachedDots: Dot[] | null = null
function dots(): Dot[] {
  if (cachedDots) return cachedDots
  const out: Dot[] = []
  for (let i = 0; i < US_DOTS.length; i += 3) out.push({ x: US_DOTS[i] / 10, y: US_DOTS[i + 1] / 10, state: US_DOTS[i + 2] })
  cachedDots = out
  return out
}

const STATE_INDEX = new Map(US_STATES.map((state, i) => [state.abbr, i]))

const stateOfMarket = (market: HomeMarket): number | null => {
  const direct = market.state?.toUpperCase()
  if (direct && STATE_INDEX.has(direct)) return STATE_INDEX.get(direct) as number
  const parsed = market.market.split(',').pop()?.trim().toUpperCase()
  return parsed && STATE_INDEX.has(parsed) ? (STATE_INDEX.get(parsed) as number) : null
}

const VIEW = `0 0 ${US_VIEWBOX.width} ${US_VIEWBOX.height}`
const DOT_R = 3.5
const MAX_PINS = 60

export function MarketConstellation({ markets, pins }: { markets: HomeMarket[]; pins: HomeReplyPin[] }) {
  const all = dots()

  const heat = new Map<number, number>()
  for (const market of markets) {
    const state = stateOfMarket(market)
    if (state == null) continue
    heat.set(state, (heat.get(state) ?? 0) + market.replied + market.positive * 4)
  }
  const peak = Math.max(1, ...heat.values())

  const beacons: Array<{ state: number; label: string }> = []
  for (const market of markets) {
    const state = stateOfMarket(market)
    if (state == null || beacons.some((b) => b.state === state)) continue
    beacons.push({ state, label: market.market.split(',')[0] })
    if (beacons.length === 4) break
  }

  const lit = all.filter((dot) => heat.has(dot.state))
  const shownPins = pins.slice(0, MAX_PINS)

  return (
    <div className="nx-home-usmap" role="img" aria-label={`United States. Active markets: ${beacons.map((b) => b.label).join(', ') || 'none this week'}. ${pins.length} recent seller replies located.`}>
      {/* Layer 1 — the country: painted once. */}
      <svg className="nx-home-usmap__base" viewBox={VIEW} aria-hidden>
        {all.map((dot, i) => <circle key={i} cx={dot.x} cy={dot.y} r={DOT_R} />)}
      </svg>

      {/* Layer 2 — heat: a soft bloom under each active state, then its dots
          pulsing in a wave that travels outward from the state's centre. */}
      <svg className="nx-home-usmap__heat" viewBox={VIEW} aria-hidden>
        <defs>
          <radialGradient id="nx-home-bloom">
            <stop className="nx-home-usmap__bloom-stop" offset="0%" stopOpacity="0.5" />
            <stop className="nx-home-usmap__bloom-stop" offset="100%" stopOpacity="0" />
          </radialGradient>
        </defs>
        {[...heat].map(([state, value]) => {
          const anchor = US_STATES[state]
          return (
            <circle
              key={`bloom-${state}`}
              className="nx-home-usmap__bloom"
              cx={anchor.x}
              cy={anchor.y}
              r={40 + 70 * Math.sqrt(value / peak)}
              fill="url(#nx-home-bloom)"
              style={{ '--lvl': (value / peak).toFixed(2) } as CSSProperties}
            />
          )
        })}
        {lit.map((dot, i) => {
          const anchor = US_STATES[dot.state]
          const distance = Math.hypot(dot.x - anchor.x, dot.y - anchor.y)
          const level = (heat.get(dot.state) ?? 0) / peak
          return (
            <circle
              key={i}
              className="nx-home-usmap__lit"
              cx={dot.x}
              cy={dot.y}
              r={DOT_R + 0.6}
              style={{ '--lvl': (0.35 + level * 0.65).toFixed(2), '--d': `${Math.round(distance * 11)}ms` } as CSSProperties}
            />
          )
        })}
      </svg>

      {/* Layer 3 — beacons over the strongest markets, and live reply sparks. */}
      <svg className="nx-home-usmap__signals" viewBox={VIEW} aria-hidden>
        {shownPins.map((pin, i) => (
          <g key={pin.id} className={pin.hot ? 'nx-home-spark is-hot' : 'nx-home-spark'} transform={`translate(${pin.x.toFixed(1)} ${pin.y.toFixed(1)})`}>
            <circle className="nx-home-spark__ring" r="5" style={{ animationDelay: `${(i * 373) % 4000}ms` } as CSSProperties} />
            <circle className="nx-home-spark__core" r="3.2" />
          </g>
        ))}
        {beacons.map(({ state, label }, i) => {
          const anchor = US_STATES[state]
          return (
            <g key={state} className={i === 0 ? 'nx-home-beacon is-top' : 'nx-home-beacon'} transform={`translate(${anchor.x} ${anchor.y})`}>
              <circle className="nx-home-beacon__ring" r="9" style={{ animationDelay: `${i * 500}ms` } as CSSProperties} />
              <circle className="nx-home-beacon__ring" r="9" style={{ animationDelay: `${i * 500 + 1300}ms` } as CSSProperties} />
              <circle className="nx-home-beacon__core" r={i === 0 ? 6.5 : 5} />
              {i < 2 ? <text y={-18} textAnchor="middle">{label}</text> : null}
            </g>
          )
        })}
      </svg>

      <span className="nx-home-usmap__scan" aria-hidden />
    </div>
  )
}
