/**
 * SAFE render mode map (§10): a static SVG national atlas — the shipped
 * /geo/us-states.json outlines, live campaign markets, and one-shot fades for
 * real high-value arrivals. Needs no WebGL, no canvas and no animation frame
 * loop, so it renders on any TV browser that can render SVG. Never blank: the
 * outline file failing to load still leaves the market dots on a plain field.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { WallEvent } from '../wall-types'
import { toneVar } from './wall-map-model'

type Ring = [number, number][]
interface StateFeature { id?: string; geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: Ring[] | Ring[][] } }

const W = 1000
const LNG0 = -125
const LAT0 = 49.6
const KX = 1000 / 58 // CONUS ≈ 58° of longitude across the box
const KY = KX / Math.cos((38 * Math.PI) / 180)
const atlasProject = (lng: number, lat: number): [number, number] => [(lng - LNG0) * KX, (LAT0 - lat) * KY]
const H = Math.round((LAT0 - 24) * KY)

let statesCache: Promise<StateFeature[]> | null = null
function loadStates(): Promise<StateFeature[]> {
  if (!statesCache) {
    statesCache = fetch('/geo/us-states.json', { cache: 'force-cache' })
      .then((r) => (r.ok ? r.json() : { features: [] }))
      .then((j: { features?: StateFeature[] }) => (j.features || []).filter((f) => !['AK', 'HI', 'PR'].includes(String(f.id))))
      .catch(() => { statesCache = null; return [] })
  }
  return statesCache
}

function ringPath(r: Ring): string {
  let d = ''
  for (let i = 0; i < r.length; i += 1) {
    const [x, y] = atlasProject(r[i][0], r[i][1])
    d += `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`
  }
  return `${d}Z`
}

function featurePath(f: StateFeature): string {
  const g = f.geometry
  if (g.type === 'Polygon') return (g.coordinates as Ring[]).map(ringPath).join('')
  return (g.coordinates as Ring[][]).map((poly) => poly.map(ringPath).join('')).join('')
}

export interface AtlasMarket { id: string; name: string; lng: number; lat: number; active: boolean; energy: number }

export function WallAtlas({ markets, subscribeArrivals, pulseFilter }: { markets: AtlasMarket[]; subscribeArrivals: (fn: (evs: WallEvent[]) => void) => () => void; pulseFilter: (evs: WallEvent[]) => WallEvent[] }) {
  const [paths, setPaths] = useState<string[]>([])
  const [pulses, setPulses] = useState<{ id: string; x: number; y: number; rgb: string; born: number }[]>([])
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())

  useEffect(() => {
    let live = true
    void loadStates().then((fs) => { if (live) setPaths(fs.map(featurePath)) })
    return () => { live = false }
  }, [])

  useEffect(() => {
    const pending = timers.current
    const off = subscribeArrivals((evs) => {
      const add = pulseFilter(evs).slice(0, 4).map((ev) => {
        const [x, y] = atlasProject(ev.geo!.lng as number, ev.geo!.lat as number)
        return { id: `${ev.id}:${ev.seq}`, x, y, rgb: toneVar(ev.tone), born: Date.now() }
      })
      if (!add.length) return
      setPulses((p) => [...p, ...add].slice(-12))
      const t = setTimeout(() => { setPulses((p) => p.filter((x) => Date.now() - x.born < 4_000)); pending.delete(t) }, 4_200)
      pending.add(t)
    })
    return () => { off(); for (const t of pending) clearTimeout(t); pending.clear() }
  }, [subscribeArrivals, pulseFilter])

  const dots = useMemo(() => markets.map((m) => ({ ...m, xy: atlasProject(m.lng, m.lat) })), [markets])

  return (
    <svg className="cw-atlas" viewBox={`-20 -20 ${W + 40} ${H + 40}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <g className="cw-atlas__states">{paths.map((d, i) => <path key={i} d={d} />)}</g>
      <g className="cw-atlas__markets">
        {dots.map((m) => (
          <g key={m.id} transform={`translate(${m.xy[0].toFixed(1)} ${m.xy[1].toFixed(1)})`} className={m.active ? 'is-active' : ''}>
            {m.active ? <circle className="cw-atlas__halo" r={10 + m.energy * 18} /> : null}
            <circle className="cw-atlas__dot" r={m.active ? 4.2 : 3} />
          </g>
        ))}
      </g>
      <g className="cw-atlas__pulses">
        {pulses.map((p) => <circle key={p.id} className="cw-atlas__pulse" cx={p.x} cy={p.y} r={9} style={{ ['--cw-pulse-rgb' as string]: p.rgb }} />)}
      </g>
    </svg>
  )
}
