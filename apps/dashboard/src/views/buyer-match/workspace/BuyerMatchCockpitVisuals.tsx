/**
 * BUYER MATCH · COCKPIT VISUALS — the selected buyer's footprint, price and
 * activity. Every mark is one recorded purchase (a Receipt) or one holding
 * the model links to the buyer; nothing is interpolated, smoothed or
 * decorated with invented points. Positions are true offsets from the subject
 * (equirectangular miles); a mark beyond the frame is pinned to its edge at
 * its true bearing and says so.
 *
 * The plots draw in CSS pixels (the viewBox tracks the measured width), so
 * labels hold their type size at every pane width instead of scaling down.
 */
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react'
import type { BuyerMatchWorkspace } from '../../../domain/buyer-match/buyer-match-workspace-api'
import { money } from '../../../domain/buyer-match/buyer-match-workspace-api'
import type { Holding, Receipt, ReceiptSet } from './buyer-match-cockpit-model'
import { ageShort, daysFrom, offsetMiles, shortFamily, street } from './buyer-match-cockpit-model'
import { cls } from './BuyerMatchParts'

export type Mark = { kind: 'receipt'; r: Receipt } | { kind: 'holding'; h: Holding }
export type OpenMark = (m: Mark) => void
/** what opening a mark does, if anything (Entity Graph when the property is in our universe, else the Map) */
export type MarkAction = (m: Mark) => { label: string; icon: 'radar' | 'map' } | null

const fmtDate = (iso: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null)
const miles = (m: number | null) => (m === null ? null : m < 10 ? `${m.toFixed(1)} mi` : `${Math.round(m)} mi`)
const sf = (n: number | null) => (n ? `${Math.round(n).toLocaleString('en-US')} sf` : null)

/** The element's content width in CSS px, tracked. */
function useWidth<T extends HTMLElement>(fallback = 640): [RefObject<T>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(Math.round(el.getBoundingClientRect().width))
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => { const w = Math.round(entries[0]?.contentRect.width ?? 0); if (w) setWidth(w) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width || fallback]
}

/* ── L3: the transaction / property card over a mark ─────────────────── */

function MarkCard({ m, action, asOf }: { m: Mark; action: MarkAction; asOf: number | null }) {
  const act = action(m)
  if (m.kind === 'holding') {
    const h = m.h
    return (
      <>
        <span className="bmc-pop__k">{h.basis}</span>
        <b className="bmc-pop__t">{street(h.address) ?? 'Property on record'}</b>
        <span className="bmc-pop__s">{[h.address?.split(',').slice(1).join(',').trim(), h.propertyType].filter(Boolean).join(' · ')}</span>
        <span className="bmc-pop__s">{[h.value ? `${money(h.value)} value` : null, h.miles !== null ? `${miles(h.miles)} from subject` : null].filter(Boolean).join(' · ')}</span>
        {act ? <span className="bmc-pop__a">{act.label} ↵</span> : null}
      </>
    )
  }
  const r = m.r
  const age = ageShort(daysFrom(r.date, asOf ?? undefined))
  return (
    <>
      <span className="bmc-pop__k">{[fmtDate(r.date), age ? `${age} ago` : null].filter(Boolean).join(' · ') || 'Undated purchase'}</span>
      <b className="bmc-pop__t">{street(r.address) ?? 'Recorded purchase'}</b>
      {r.address ? <span className="bmc-pop__s">{[r.city, r.zip].filter(Boolean).join(' ')}</span> : null}
      <span className="bmc-pop__s is-ink">{[r.price ? (r.nominal ? `${money(r.price)} · nominal transfer` : money(r.price)) : 'No price recorded', r.family, r.beds ? `${r.beds} bd` : null, sf(r.sqft), r.yearBuilt ? `${r.yearBuilt}` : null].filter(Boolean).join(' · ')}</span>
      <span className="bmc-pop__s">{[r.miles !== null ? `${miles(r.miles)} from subject` : 'Not mapped — no location in this read', r.cash === true ? 'cash' : r.cash === false ? 'financed' : null, r.docType].filter(Boolean).join(' · ')}</span>
      {act ? <span className="bmc-pop__a">{act.label} ↵</span> : null}
    </>
  )
}

type Hot = { m: Mark; x: number; y: number } | null

/** Hover/focus card state shared by the two plots: which mark, and where (as % of the plot). */
function usePopover() {
  const [hot, setHot] = useState<Hot>(null)
  return { hot, show: (m: Mark, x: number, y: number) => setHot({ m, x, y }), hide: () => setHot(null) }
}

function Popover({ hot, action, asOf }: { hot: Hot; action: MarkAction; asOf: number | null }) {
  if (!hot) return null
  const below = hot.y < 38
  const side = hot.x < 20 ? 'is-left' : hot.x > 80 ? 'is-right' : ''
  return (
    <div className={cls('bmc-pop', below && 'is-below', side)} style={{ left: `${hot.x}%`, top: `${hot.y}%` } as CSSProperties} role="tooltip">
      <MarkCard m={hot.m} action={action} asOf={asOf} />
    </div>
  )
}

const markLabel = (m: Mark) => {
  if (m.kind === 'holding') return `${m.h.basis}: ${m.h.address ?? m.h.propertyId}`
  const r = m.r
  return [r.date ? `Purchased ${fmtDate(r.date)}` : 'Recorded purchase', street(r.address), r.price ? money(r.price) : null, r.family, miles(r.miles)].filter(Boolean).join(', ')
}

function markKeys(e: ReactKeyboardEvent, open: () => void) {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() }
}

/** One interactive mark: hover/focus shows its card; Enter/click opens it where it can be opened. */
function MarkG({ m, x, y, i, className, action, open, pop, W, H, children }: {
  m: Mark; x: number; y: number; i: number; className: string; action: MarkAction; open: OpenMark
  pop: ReturnType<typeof usePopover>; W: number; H: number; children: ReactNode
}) {
  const act = action(m)
  const enter = () => pop.show(m, (x / W) * 100, (y / H) * 100)
  return (
    <g
      className={cls('bmc-mark', className, act && 'is-live')}
      style={{ '--i': Math.min(i, 24) } as CSSProperties}
      role={act ? 'button' : 'img'}
      tabIndex={act ? 0 : -1}
      aria-label={markLabel(m)}
      onPointerEnter={enter}
      onPointerLeave={pop.hide}
      onFocus={enter}
      onBlur={pop.hide}
      onClick={act ? () => open(m) : undefined}
      onKeyDown={act ? (e) => markKeys(e, () => open(m)) : undefined}
    >
      <circle className="hit" cx={x} cy={y} r="12" />
      {children}
    </g>
  )
}

const toneOf = (r: Receipt) => (r.sameFamily === true ? 'is-same' : r.sameFamily === false ? 'is-other' : 'is-unknown')

/* ── GEOGRAPHY — the footprint around the subject ─────────────────────── */

const RINGS = [0.5, 1, 2, 5, 10, 25]
const SCALES = [0.25, 0.5, 1, 2, 5, 10, 25]

export function Footprint({ w, set, holdings, open, action, windowLabel, loading, asOf }: {
  w: BuyerMatchWorkspace; set: ReceiptSet; holdings: Holding[]; open: OpenMark; action: MarkAction; windowLabel: string; loading: boolean; asOf: number | null
}) {
  const clip = `bmc${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const pop = usePopover()
  const [ref, W] = useWidth<HTMLDivElement>()
  const H = Math.round(Math.max(240, Math.min(340, W * 0.46)))
  const s = w.subject
  const R = w.query.radiusMiles
  const cx = W / 2
  const cy = H / 2
  const k = (H / 2 - 16) / (R * 1.22) // px per mile
  const pad = 12
  const located = s.lat !== null && s.lng !== null
  const marks = useMemo(() => {
    if (!located) return []
    const place = (lat: number, lng: number) => {
      const o = offsetMiles({ lat: s.lat as number, lng: s.lng as number }, lat, lng)
      const dx = o.east * k
      const dy = -o.north * k
      const lim = Math.min(1, (cx - pad) / Math.max(Math.abs(dx), 1e-9), (cy - pad) / Math.max(Math.abs(dy), 1e-9))
      return { x: cx + dx * lim, y: cy + dy * lim, beyond: lim < 1, angle: (Math.atan2(dy, dx) * 180) / Math.PI }
    }
    const out: Array<{ key: string; m: Mark; x: number; y: number; beyond: boolean; angle: number; i: number }> = []
    set.receipts.forEach((r, i) => { if (r.lat !== null && r.lng !== null) out.push({ key: r.key, m: { kind: 'receipt', r }, ...place(r.lat, r.lng), i }) })
    holdings.forEach((h, i) => { if (h.lat !== null && h.lng !== null) out.push({ key: h.key, m: { kind: 'holding', h }, ...place(h.lat, h.lng), i: set.receipts.length + i }) })
    // the far-away first, the nearest drawn on top
    return out.sort((a, b) => Number(b.beyond) - Number(a.beyond))
  }, [set, holdings, located, s.lat, s.lng, k, cx, cy])

  if (!located) return <figure className="bmc-vis is-geo"><p className="bmc-vis__none">The subject has no coordinates, so there is no footprint to draw.</p></figure>

  // inner rings, each at least 16px from the last so their labels (stacked down the south axis) never collide
  const rings = RINGS.filter((m) => m < R && m * k >= 18).filter((m, i, all) => i === 0 || (m - all[i - 1]) * k >= 16)
  const scaleMi = [...SCALES].reverse().find((m) => m * k <= 120) ?? SCALES[0]
  const step = R <= 2 ? 0.25 : R <= 5 ? 1 : R <= 10 ? 2 : 5
  const dot = Math.max(10, step * k)
  const beyond = marks.filter((x) => x.beyond).length
  const hasHoldings = holdings.some((h) => h.lat !== null && h.lng !== null)

  return (
    <figure className="bmc-vis is-geo">
      <div className="bmc-vis__plot" ref={ref}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ height: H }} role="group" aria-label={`Recorded purchases around ${s.address ?? 'the subject'} at their true positions, ${R} mi evidence radius`}>
          <defs>
            <clipPath id={`${clip}f`}><rect x="0" y="0" width={W} height={H} rx="10" /></clipPath>
            <pattern id={`${clip}g`} width={dot} height={dot} patternUnits="userSpaceOnUse" x={cx % dot} y={cy % dot}>
              <circle cx="0" cy="0" r="0.8" className="bmc-geo__grid" />
              <circle cx={dot} cy="0" r="0.8" className="bmc-geo__grid" />
              <circle cx="0" cy={dot} r="0.8" className="bmc-geo__grid" />
              <circle cx={dot} cy={dot} r="0.8" className="bmc-geo__grid" />
            </pattern>
            <radialGradient id={`${clip}r`} cx="50%" cy="50%" r="50%">
              <stop offset="0%" className="bmc-geo__field-0" />
              <stop offset="100%" className="bmc-geo__field-1" />
            </radialGradient>
          </defs>
          <g clipPath={`url(#${clip}f)`}>
            <rect x="0" y="0" width={W} height={H} fill={`url(#${clip}g)`} />
            <circle cx={cx} cy={cy} r={R * k} fill={`url(#${clip}r)`} />
            <line className="bmc-geo__axis" x1={cx} y1="0" x2={cx} y2={H} />
            <line className="bmc-geo__axis" x1="0" y1={cy} x2={W} y2={cy} />
            {rings.map((m) => <circle key={m} className="bmc-geo__ring" cx={cx} cy={cy} r={m * k} />)}
            <circle className="bmc-geo__radius" cx={cx} cy={cy} r={R * k} />
            <text className="bmc-geo__lbl is-radius" x={cx} y={cy - R * k - 7} textAnchor="middle">{R} mi evidence radius</text>
            {marks.map(({ key, m, x, y, beyond: far, angle, i }) => (
              <MarkG key={key} m={m} x={x} y={y} i={i} W={W} H={H} action={action} open={open} pop={pop}
                className={cls(m.kind === 'holding' ? 'is-held' : toneOf(m.r), far && 'is-beyond')}>
                {far ? (
                  <path className="edge" d="M -5.5 -5 L 5.5 0 L -5.5 5 Z" transform={`translate(${x} ${y}) rotate(${angle})`} />
                ) : m.kind === 'holding' ? (
                  <rect className="held" x={x - 4.5} y={y - 4.5} width="9" height="9" rx="2" />
                ) : (
                  <>
                    <circle className="glow" cx={x} cy={y} r="10" />
                    <circle className="dot" cx={x} cy={y} r="4.8" />
                  </>
                )}
              </MarkG>
            ))}
            {rings.map((m) => <text key={m} className="bmc-geo__lbl is-ring" x={cx + 5} y={cy + m * k - 5}>{m} mi</text>)}
            <circle className="bmc-geo__halo" cx={cx} cy={cy} r="12" />
            <circle className="bmc-geo__subject" cx={cx} cy={cy} r="5.5" />
            <g className="bmc-geo__north" transform={`translate(${W - 24} 26)`}>
              <path d="M 0 -10 L 4.5 3 L 0 0.5 L -4.5 3 Z" />
              <text y="17" textAnchor="middle">N</text>
            </g>
            <g className="bmc-geo__scale" transform={`translate(16 ${H - 16})`}>
              <line x1="0" y1="0" x2={scaleMi * k} y2="0" />
              <line x1="0" y1="-3.5" x2="0" y2="3.5" />
              <line x1={scaleMi * k} y1="-3.5" x2={scaleMi * k} y2="3.5" />
              <text x={scaleMi * k + 7} y="4">{scaleMi} mi</text>
            </g>
          </g>
        </svg>
        <Popover hot={pop.hot} action={action} asOf={asOf} />
      </div>
      <figcaption className="bmc-vis__legend">
        <span><i className="k-same" />Same type</span>
        <span><i className="k-other" />Other type</span>
        {hasHoldings ? <span><i className="k-held" />Holdings</span> : null}
        <span><i className="k-subject" />Subject</span>
        {beyond ? <span><i className="k-edge" />{beyond} beyond this view</span> : null}
        {loading ? <em className="bmc-vis__note">Loading the buyer’s full purchase list…</em>
          : set.unmapped ? <em className="bmc-vis__note" title={`Locations come from the ${windowLabel} market read and the property record; the rest are listed under Activity.`}>{set.unmapped} {set.unmapped === 1 ? 'purchase' : 'purchases'} without location</em> : null}
      </figcaption>
    </figure>
  )
}

/* ── PRICE — every priced purchase against the disposition window ─────── */

const NICE_MI = [1, 2, 5, 10, 15, 25, 50, 100, 250, 500, 1000, 2500]
const TICKS_MI = [0, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500]
const STEPS = [5_000, 10_000, 20_000, 25_000, 50_000, 100_000, 200_000, 250_000, 500_000, 1_000_000, 2_000_000, 5_000_000]

export function PriceScatter({ w, set, open, action, loading, asOf }: { w: BuyerMatchWorkspace; set: ReceiptSet; open: OpenMark; action: MarkAction; loading: boolean; asOf: number | null }) {
  const pop = usePopover()
  const [ref, W] = useWidth<HTMLDivElement>()
  const H = 290
  const win = w.subject.window
  const R = w.query.radiusMiles
  const priced = set.receipts.filter((r) => r.price !== null && !r.nominal)
  const nominal = set.receipts.filter((r) => r.price !== null && r.nominal).length
  const unpriced = set.receipts.filter((r) => r.price === null).length
  const placed = priced.filter((r) => r.miles !== null)
  const lane = priced.filter((r) => r.miles === null)

  const X0 = 58
  const LANE = lane.length ? 86 : 0
  const X1 = W - 18 - LANE
  const Y0 = 20
  const Y1 = H - 32
  const maxMi = Math.max(R, ...placed.map((r) => r.miles as number))
  const xMax = NICE_MI.find((n) => n >= maxMi) ?? maxMi
  const sx = (m: number) => X0 + Math.sqrt(Math.max(0, m) / xMax) * (X1 - X0)
  const values = [...priced.map((r) => r.price as number), ...(win ? [win.low, win.high] : [])]
  const lo = values.length ? Math.min(...values) : 0
  const hi = values.length ? Math.max(...values) : 1
  const span = Math.max(hi - lo, hi * 0.2, 1)
  const step = STEPS.find((st) => span / st <= 5) ?? STEPS[STEPS.length - 1]
  const yMin = Math.max(0, Math.floor((lo - span * 0.1) / step) * step)
  const yMax = Math.ceil((hi + span * 0.1) / step) * step
  const sy = (p: number) => Y1 - ((p - yMin) / (yMax - yMin || 1)) * (Y1 - Y0)
  const yTicks: number[] = []
  for (let v = yMin; v <= yMax + 1; v += step) yTicks.push(v)
  const xTicks = TICKS_MI.filter((t) => t <= xMax && (t === 0 || sx(t) - sx(TICKS_MI[Math.max(0, TICKS_MI.indexOf(t) - 1)]) >= 30))
  const laneX = (i: number) => X1 + 22 + ((i * 23) % Math.max(1, LANE - 40)) + 8

  if (!priced.length) {
    return (
      <figure className="bmc-vis is-price">
        <div className="bmc-vis__plot" ref={ref}>
          <p className="bmc-vis__none">{loading ? 'Loading the buyer’s full purchase list…' : 'No priced purchase is recorded for this buyer, so there is nothing to plot against the window.'}</p>
        </div>
      </figure>
    )
  }

  const pts = [
    ...placed.map((r, i) => ({ r, x: sx(r.miles as number), y: sy(r.price as number), i })),
    ...lane.map((r, i) => ({ r, x: laneX(i), y: sy(r.price as number), i: placed.length + i })),
  ]

  return (
    <figure className="bmc-vis is-price">
      <div className="bmc-vis__plot" ref={ref}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ height: H }} role="group" aria-label="Purchase price against distance from the subject; the band is this deal’s disposition window">
          {yTicks.map((v) => (
            <g key={v} className="bmc-ax">
              <line x1={X0} x2={X1 + (LANE ? LANE + 4 : 0)} y1={sy(v)} y2={sy(v)} />
              <text x={X0 - 10} y={sy(v) + 4} textAnchor="end">{money(v)}</text>
            </g>
          ))}
          {win ? (
            <g className="bmc-band">
              <rect x={X0} width={X1 - X0 + (LANE ? LANE + 4 : 0)} y={sy(win.high)} height={Math.max(3, sy(win.low) - sy(win.high))} rx="5" />
              <text x={X0 + 10} y={Math.max(sy(win.high) - 7, Y0 - 4)}>Dispo window</text>
            </g>
          ) : null}
          {xTicks.map((t) => (
            <g key={t} className="bmc-ax is-x">
              <line x1={sx(t)} x2={sx(t)} y1={Y1} y2={Y1 + 5} />
              <text x={sx(t)} y={Y1 + 20} textAnchor="middle">{t === 0 ? '0' : `${t} mi`}</text>
            </g>
          ))}
          <line className="bmc-ax__base" x1={X0} x2={X1} y1={Y1} y2={Y1} />
          {R < xMax ? (
            <g className="bmc-radius">
              <line x1={sx(R)} x2={sx(R)} y1={Y0} y2={Y1} />
              <text x={sx(R) + 6} y={Y0 + 12}>{R} mi radius</text>
            </g>
          ) : null}
          {LANE ? (
            <g className="bmc-lane">
              <rect x={X1 + 14} y={Y0} width={LANE - 10} height={Y1 - Y0} rx="8" />
              <text x={X1 + 14 + (LANE - 10) / 2} y={Y1 + 20} textAnchor="middle">no location</text>
            </g>
          ) : null}
          {pts.map(({ r, x, y, i }) => (
            <MarkG key={r.key} m={{ kind: 'receipt', r }} x={x} y={y} i={i} W={W} H={H} action={action} open={open} pop={pop} className={cls(toneOf(r), r.miles === null && 'is-lane')}>
              <circle className="glow" cx={x} cy={y} r="10" />
              <circle className="dot" cx={x} cy={y} r="4.8" />
            </MarkG>
          ))}
        </svg>
        <Popover hot={pop.hot} action={action} asOf={asOf} />
      </div>
      <figcaption className="bmc-vis__legend">
        <span><i className="k-same" />Same type</span>
        <span><i className="k-other" />Other type</span>
        <span><i className="k-band" />Dispo window</span>
        <em className="bmc-vis__note">Distance on a square-root scale{nominal ? ` · ${nominal} nominal ${nominal === 1 ? 'transfer' : 'transfers'} not plotted` : ''}{unpriced && !loading ? ` · ${unpriced} without a price` : ''}</em>
        {loading ? <em className="bmc-vis__note">Loading the buyer’s full purchase list…</em> : null}
      </figcaption>
    </figure>
  )
}

/* ── ACTIVITY — the receipts, newest first ────────────────────────────── */

export function ActivityReceipts({ w, set, open, action, windowLabel, loading, loadFailed, asOf, asOfText }: {
  w: BuyerMatchWorkspace; set: ReceiptSet; open: OpenMark; action: MarkAction; windowLabel: string; loading: boolean; loadFailed: boolean
  asOf: number | null; asOfText: string | null
}) {
  const [ref, W] = useWidth<HTMLDivElement>()
  const [hot, setHot] = useState<string | null>(null)
  const now = Date.now()
  const months = w.query.months
  const dated = set.receipts.filter((r) => r.date)
  const first = dated.length ? Math.min(...dated.map((r) => Date.parse(r.date as string))) : now
  const windowStart = now - months * 30.44 * 86_400_000
  const t0 = Math.min(first, windowStart)
  const X0 = 14
  const X1 = W - 14
  const tx = (t: number) => X0 + ((t - t0) / Math.max(1, now - t0)) * (X1 - X0)
  const years: number[] = []
  for (let y = new Date(t0).getFullYear() + 1; y <= new Date(now).getFullYear(); y += 1) years.push(y)

  return (
    <figure className="bmc-vis is-activity">
      <div className="bmc-vis__axis" ref={ref}>
        <svg viewBox={`0 0 ${W} 62`} style={{ height: 62 }} role="img" aria-label={`${set.receipts.length} recorded purchases on a timeline`}>
          <rect className="bmc-tl__window" x={tx(windowStart)} y="16" width={Math.max(0, X1 - tx(windowStart))} height="24" rx="6" />
          <text className="bmc-tl__lbl is-window" x={X1 - 4} y="11" textAnchor="end">{months} mo window</text>
          <line className="bmc-tl__base" x1={X0} x2={X1} y1="28" y2="28" />
          {years.map((y) => {
            const x = tx(new Date(y, 0, 1).getTime())
            return <g key={y}><line className="bmc-tl__tick" x1={x} x2={x} y1="22" y2="34" /><text className="bmc-tl__lbl" x={x} y="56" textAnchor="middle">{y}</text></g>
          })}
          {asOf !== null && asOf < now - 86_400_000 * 3 ? (
            <g className="bmc-tl__asof">
              <line x1={tx(asOf)} x2={tx(asOf)} y1="14" y2="42" />
            </g>
          ) : null}
          {dated.map((r, i) => (
            <circle
              key={r.key}
              className={cls('bmc-tl__dot', toneOf(r), hot === r.key && 'is-hot')}
              style={{ '--i': Math.min(i, 24) } as CSSProperties}
              cx={tx(Date.parse(r.date as string))}
              cy="28"
              r={hot === r.key ? 6.5 : 4.6}
            />
          ))}
        </svg>
      </div>
      <ol className="bmc-receipts">
        {set.receipts.map((r, i) => {
          const m: Mark = { kind: 'receipt', r }
          const act = action(m)
          const age = ageShort(daysFrom(r.date, asOf ?? undefined))
          const body: ReactNode = (
            <>
              <span className="bmc-rc__age">{age ? `${age} ago` : '—'}</span>
              <span className="bmc-rc__what">
                <b>{street(r.address) ? `Purchased ${street(r.address)}` : 'Recorded purchase'}</b>
                <em>{[r.address ? r.city : null, r.docType, r.cash === true ? 'cash' : null, r.lat === null ? 'no location in this read' : null].filter(Boolean).join(' · ') || '—'}</em>
              </span>
              <span className="bmc-rc__price">{r.price ? money(r.price) : '—'}{r.nominal ? <em>nominal</em> : null}</span>
              <span className="bmc-rc__type">{shortFamily(r.family) ?? '—'}</span>
              <span className="bmc-rc__mi">{miles(r.miles) ?? '—'}</span>
            </>
          )
          return (
            <li key={r.key} style={{ '--i': Math.min(i, 16) } as CSSProperties} onPointerEnter={() => setHot(r.key)} onPointerLeave={() => setHot(null)}>
              {act ? (
                <button type="button" className="bmc-rc" onClick={() => open(m)} onFocus={() => setHot(r.key)} onBlur={() => setHot(null)} title={act.label}>{body}</button>
              ) : (
                <div className="bmc-rc is-static">{body}</div>
              )}
            </li>
          )
        })}
        {loading ? <li className="bmc-receipts__more" aria-busy="true"><span /><span /></li> : null}
      </ol>
      <figcaption className="bmc-vis__legend">
        {asOfText ? <span className="bmc-tl__key"><i className="k-asof" />Buyer records through {asOfText} — ages are counted to that date</span> : null}
        {loadFailed ? <em className="bmc-vis__note">The buyer’s full purchase list couldn’t load — only purchases located inside {windowLabel} are shown.</em> : null}
        {set.complete && set.receipts.length < set.recorded ? <em className="bmc-vis__note">{set.listCapped ? `The ${set.receipts.length} most recent of ${set.recorded} recorded purchases` : `${set.receipts.length} of ${set.recorded} recorded purchases carry a linked transaction`}</em> : null}
      </figcaption>
    </figure>
  )
}
