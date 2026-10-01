import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { pushRoutePath } from '../../../app/router'
import { writeMapFocusSet } from '../../../domain/map/map-focus-set'
import { LCButton, LCSegmented, LCSkeleton, useLcReducedMotion } from '../../../shared/lc'
import { sound } from '../../../shared/sound'
import { fetchCampaignGeo, type CampaignGeo, type GeoStateKey } from './war-room-api'
import { useResource } from './war-room-hooks'
import { nf, plural } from './war-room-model'
import { Plane } from './WarPlanes'

/**
 * GEOGRAPHY — where this campaign's sellers are and how far each got.
 *
 * Not the Map: a plot of the exact cohort (every target with coordinates,
 * up to 5,000 — beyond that it says SAMPLE), drawn without tiles so it costs
 * nothing to keep on screen. Modes only exist where data does. "Open full
 * Map" hands the Map the exact points of the current mode.
 */

type Mode = 'targets' | 'sent' | 'delivered' | 'replies' | 'failures' | 'opportunities'
const MODE_STATES: Record<Mode, GeoStateKey[]> = {
  targets: ['held', 'ready', 'planned', 'queued', 'sent', 'delivered', 'failed', 'replied', 'opportunity'],
  sent: ['sent', 'delivered', 'failed', 'replied', 'opportunity'],
  delivered: ['delivered', 'replied', 'opportunity'],
  replies: ['replied', 'opportunity'],
  failures: ['failed'],
  opportunities: ['opportunity'],
}
const MODE_LABEL: Record<Mode, string> = { targets: 'Targets', sent: 'Sent', delivered: 'Delivered', replies: 'Replies', failures: 'Failures', opportunities: 'Opportunities' }
/** colour by how far the seller got (semantic tokens, read from CSS) */
const STATE_TONE: Record<GeoStateKey, string> = {
  held: 'attn', ready: 'neutral', planned: 'neutral', queued: 'exec', sent: 'exec', delivered: 'ok', failed: 'crit', replied: 'flow', opportunity: 'ok',
}

const fetchGeo = (id: string, signal: AbortSignal) => fetchCampaignGeo(id, signal)

function hull(pts: Array<[number, number]>): Array<[number, number]> {
  if (pts.length < 3) return pts
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Array<[number, number]> = []
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q) }
  const upper: Array<[number, number]> = []
  for (let i = p.length - 1; i >= 0; i -= 1) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q) }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))

function Field({ geo, mode }: { geo: CampaignGeo; mode: Mode }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const reduced = useLcReducedMotion()
  const [size, setSize] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver((e) => setSize({ w: Math.round(e[0].contentRect.width), h: Math.round(e[0].contentRect.height) }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const c = canvas.current
    if (!c || !size.w || !size.h) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    c.width = size.w * dpr
    c.height = size.h * dpr
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.w, size.h)
    const css = getComputedStyle(c)
    const rgb = (tone: string) => css.getPropertyValue(`--lc-${tone}-rgb`).trim() || '148, 160, 180'
    const ink = css.getPropertyValue('--cc3-geo-ink').trim() || '226, 232, 244'
    const pts = geo.points
    if (!pts.length) return
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity
    for (const [lat, lng] of pts) {
      const y = mercY(lat)
      if (lng < minX) minX = lng
      if (lng > maxX) maxX = lng
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    const spanX = Math.max(1e-4, (maxX - minX) * (Math.PI / 180))
    const spanY = Math.max(1e-4, maxY - minY)
    const pad = 18
    const scale = Math.min((size.w - pad * 2) / spanX, (size.h - pad * 2) / spanY)
    const ox = (size.w - spanX * scale) / 2
    const oy = (size.h - spanY * scale) / 2
    const X = (lng: number) => ox + (lng - minX) * (Math.PI / 180) * scale
    const Y = (lat: number) => size.h - (oy + (mercY(lat) - minY) * scale)

    // the cohort's outline
    const outline = hull(pts.map(([lat, lng]) => [X(lng), Y(lat)] as [number, number]))
    if (outline.length > 2) {
      ctx.beginPath()
      outline.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
      ctx.closePath()
      ctx.fillStyle = `rgba(${rgb('exec')}, 0.045)`
      ctx.fill()
      ctx.strokeStyle = `rgba(${rgb('exec')}, 0.28)`
      ctx.lineWidth = 1
      ctx.setLineDash([3, 4])
      ctx.stroke()
      ctx.setLineDash([])
    }

    const r = Math.max(1.4, Math.min(3.4, Math.sqrt((size.w * size.h) / Math.max(1, pts.length)) / 9))
    const lit = new Set(MODE_STATES[mode].map((s) => geo.states.indexOf(s)))
    // base layer: every target, quiet
    ctx.fillStyle = `rgba(${ink}, 0.16)`
    for (const [lat, lng, s] of pts) {
      if (lit.has(s) && mode !== 'targets') continue
      ctx.beginPath(); ctx.arc(X(lng), Y(lat), r * 0.85, 0, Math.PI * 2); ctx.fill()
    }
    // lit layer: the mode's sellers, coloured by how far they got
    for (const [lat, lng, s] of pts) {
      if (!lit.has(s)) continue
      const tone = STATE_TONE[geo.states[s]] ?? 'neutral'
      ctx.beginPath(); ctx.arc(X(lng), Y(lat), r, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${rgb(tone)}, ${mode === 'targets' ? 0.7 : 0.92})`
      ctx.fill()
      if (!reduced && (geo.states[s] === 'replied' || geo.states[s] === 'opportunity')) {
        ctx.beginPath(); ctx.arc(X(lng), Y(lat), r * 2.6, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${rgb(tone)}, 0.12)`
        ctx.fill()
      }
    }
  }, [geo, mode, size, reduced])

  return (
    <div className="cc3-geo__field" ref={box}>
      <canvas ref={canvas} style={{ width: '100%', height: '100%' }} aria-hidden="true" />
    </div>
  )
}

export const GeoPlane = memo(function GeoPlane({ campaignId, campaignName, onOpenCounty, demo }: { campaignId: string; campaignName: string; onOpenCounty?: (county: string | null) => void; demo?: CampaignGeo | null }) {
  const res = useResource('geo', campaignId, fetchGeo, { pollMs: 120_000, enabled: demo === undefined })
  const geo = demo === undefined ? res.data : demo
  const [mode, setMode] = useState<Mode>('targets')
  const counts = useMemo(() => {
    const out: Record<Mode, number> = { targets: 0, sent: 0, delivered: 0, replies: 0, failures: 0, opportunities: 0 }
    if (!geo) return out
    for (const [, , s] of geo.points) {
      const key = geo.states[s]
      for (const m of Object.keys(MODE_STATES) as Mode[]) if (MODE_STATES[m].includes(key)) out[m] += 1
    }
    return out
  }, [geo])
  const active: Mode = counts[mode] > 0 ? mode : 'targets'
  const options = (Object.keys(MODE_LABEL) as Mode[]).filter((m) => m === 'targets' || counts[m] > 0).map((m) => ({ value: m, label: MODE_LABEL[m] }))

  const openMap = () => {
    if (!geo) return
    const lit = new Set(MODE_STATES[active].map((s) => geo.states.indexOf(s)))
    const points = geo.points.filter(([, , s]) => lit.has(s)).map(([lat, lng]) => ({ lat, lng }))
    if (writeMapFocusSet({ label: `${active === 'targets' ? 'targets' : MODE_LABEL[active].toLowerCase()} in ${campaignName}`, tone: 'property', points })) pushRoutePath('/map')
  }

  const top = geo?.counties.slice(0, 4) ?? []
  const max = Math.max(1, ...top.map((c) => c.targets))
  return (
    <Plane
      title="Geography"
      meta={geo ? `${nf(geo.located)} located${geo.unlocated ? ` · ${nf(geo.unlocated)} without coordinates` : ''}${geo.sampled ? ' · SAMPLE of the first 5,000' : ''}` : null}
      action={geo && geo.located ? <LCButton size="sm" variant="quiet" icon="map" onClick={openMap}>Open full Map</LCButton> : null}
      className="cc3-geo"
      id="cc3-geo"
    >
      {!geo ? (res.error ? <p className="cc3-muted">Geography didn’t load. Nothing is assumed.</p> : <LCSkeleton shape="block" height={180} />) : !geo.located ? (
        <p className="cc3-muted">{geo.total_targets ? 'None of these properties have map coordinates.' : 'No audience built yet.'}</p>
      ) : (
        <>
          {options.length > 1 ? <LCSegmented size="sm" label="Geography mode" value={active} onChange={(v) => { sound.ui.select(); setMode(v) }} options={options} /> : null}
          <div className="cc3-geo__body">
            <Field geo={geo} mode={active} />
            <ul className="cc3-geo__counties" aria-label="Targets by county">
              {top.map((c) => (
                <li key={`${c.county}-${c.state}`}>
                  <button type="button" onClick={() => onOpenCounty?.(c.county)} disabled={!onOpenCounty}>
                    <span className="cc3-geo__county">{c.county ?? 'Unknown county'}{c.state ? `, ${c.state}` : ''}</span>
                    <span className="cc3-geo__bar"><i style={{ width: `${(c.targets / max) * 100}%` }} /></span>
                    <b className="lc-num">{nf(c.targets)}</b>
                    <span className="cc3-geo__sub lc-num">{c.sent ? `${nf(c.sent)} sent · ${nf(c.replied)} replied` : c.held ? `${nf(c.held)} held` : '—'}</span>
                  </button>
                </li>
              ))}
              {geo.county_count > top.length ? <li className="cc3-muted">+{plural(geo.county_count - top.length, 'county', 'counties')}</li> : null}
            </ul>
          </div>
        </>
      )}
    </Plane>
  )
})
