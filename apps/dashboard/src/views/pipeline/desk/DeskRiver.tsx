/**
 * THE ACQUISITION RIVER — S1 → S10 as one body of water.
 *
 * Band thickness is √(live deals) per stage (printed exactly beside it); an
 * empty stage is a dry 2px channel. Lenses re-project the same live deals:
 * by stage, by whose move it is, or by age against each stage's own clock.
 * Every number is the server's. A pulse travels the river once for each real
 * movement that arrives while the page is open — never on first paint, never
 * for a period switch, never under reduced motion.
 */
import { useId, useMemo, useRef } from 'react'
import { motion } from 'framer-motion'
import { LCSegmented, LCTooltip, cx, useLcReducedMotion } from '../../../shared/lc'
import { compactMoney } from '../../../domain/pipeline/pipeline-command-api'
import type { DeskMove, DeskStage, StageFlow } from './pipeline-desk-api'
import {
  LIVE_OWNERS,
  OWNER_META,
  STAGE_CODES,
  STAGE_GROUPS,
  STAGE_SHORT_LABEL,
  fmtInt,
  liveCount,
  pulseRoute,
  riverReaches,
  riverStrata,
  stackStrata,
  stratumPath,
  type Reach,
  type RiverLens,
} from './pipeline-desk-model'
import { useElementWidth } from './use-pipeline-desk'

const LENSES: ReadonlyArray<{ value: RiverLens; label: string }> = [
  { value: 'stage', label: 'Live' },
  { value: 'owner', label: 'Whose move' },
  { value: 'age', label: 'Aging' },
]

type Props = {
  stages: DeskStage[] | null
  flows: StageFlow[] | null
  periodLabel: string
  lens: RiverLens
  onLens: (lens: RiverLens) => void
  arrivals: DeskMove[]
  arrivedAt: number | null
  selectedStage: string | null
  onPickStage: (code: string) => void
  dimmed?: boolean
}

export function DeskRiver({ stages, flows, periodLabel, lens, onLens, arrivals, arrivedAt, selectedStage, onPickStage, dimmed }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const width = useElementWidth(bodyRef)
  const orient: 'horizontal' | 'vertical' = width && width < 700 ? 'vertical' : 'horizontal'
  const ordered = useMemo(() => STAGE_CODES.map((code) => stages?.find((s) => s.code === code) ?? null), [stages])
  const totals = useMemo(() => ordered.map((s) => liveCount(s)), [ordered])
  const strata = useMemo(() => (stages ? riverStrata(stages, lens) : []), [stages, lens])
  const live = totals.reduce((n, v) => n + v, 0)
  const dormant = ordered.reduce((n, s) => n + (s?.dormant ?? 0), 0)

  return (
    <section className={cx('pd2-river', dimmed && 'is-refreshing')} aria-label="Acquisition river, S1 to S10">
      <header className="pd2-river__head">
        <div className="pd2-river__title">
          <span className="lc-eyebrow">Acquisition river · S1 → S10</span>
          <h2>
            {stages ? <><b className="lc-num">{fmtInt(live)}</b> live deals flowing{dormant ? <small> · {fmtInt(dormant)} dormant beneath the surface</small> : null}</> : 'Reading the pipeline…'}
          </h2>
        </div>
        <LCSegmented options={LENSES} value={lens} onChange={onLens} label="River lens" size="sm" className="pd2-river__lens" />
      </header>

      <div className="pd2-river__body" ref={bodyRef} data-orient={orient}>
        {!stages || !width ? (
          <div className="pd2-river__ghost" aria-hidden="true"><i /></div>
        ) : orient === 'horizontal' ? (
          <HorizontalRiver width={width} ordered={ordered} totals={totals} strata={strata} flows={flows} periodLabel={periodLabel} arrivals={arrivals} arrivedAt={arrivedAt} selectedStage={selectedStage} onPickStage={onPickStage} />
        ) : (
          <VerticalRiver width={width} ordered={ordered} totals={totals} strata={strata} flows={flows} periodLabel={periodLabel} arrivedAt={arrivedAt} arrivals={arrivals} selectedStage={selectedStage} onPickStage={onPickStage} />
        )}
      </div>

      <footer className="pd2-river__legend">
        {lens === 'stage' ? (
          <>
            <span className="pd2-key"><i style={{ background: 'var(--pd2-river)' }} />Live deals</span>
            <span className="pd2-key is-dry"><i />No live deals</span>
          </>
        ) : strata.map((s) => (
          <span key={s.key} className={cx('pd2-key', !s.values.some((v) => v > 0) && 'is-zero')}>
            <i style={{ background: s.color }} />{s.label}<b className="lc-num">{fmtInt(s.values.reduce((n, v) => n + v, 0))}</b>
          </span>
        ))}
        <span className="pd2-river__scale">Width ∝ √ deals · ± entered / left over the {periodLabel} · median days in stage · “late” = past the stage clock</span>
      </footer>
    </section>
  )
}

type InnerProps = {
  width: number
  ordered: Array<DeskStage | null>
  totals: number[]
  strata: ReturnType<typeof riverStrata>
  flows: StageFlow[] | null
  periodLabel: string
  arrivals: DeskMove[]
  arrivedAt: number | null
  selectedStage: string | null
  onPickStage: (code: string) => void
}

/** The tooltip that carries everything a reach knows (the table view keeps it reachable too). */
function ReachTip({ s, flow, periodLabel }: { s: DeskStage | null; flow: StageFlow | undefined; periodLabel: string }) {
  if (!s) return null
  const owners = LIVE_OWNERS.map((k) => [k, s.owners?.[k] ?? 0] as const).filter(([, n]) => n > 0)
  return (
    <span className="pd2-tip">
      <b>{s.short} · {s.label}</b>
      <span>{fmtInt(liveCount(s))} live{s.dormant ? ` · ${fmtInt(s.dormant)} dormant` : ''}</span>
      {owners.length ? <span>{owners.map(([k, n]) => `${fmtInt(n)} ${OWNER_META[k].short.toLowerCase()}`).join(' · ')}</span> : null}
      {s.value ? <span>{compactMoney(s.value)} est. value{s.valued ? ` (${fmtInt(s.valued)} valued)` : ''}{s.asking ? ` · ${compactMoney(s.asking)} seller asks` : ''}</span> : null}
      {flow ? <span>{periodLabel}: {fmtInt(flow.entered)} in ({fmtInt(flow.system)} autopilot · {fmtInt(flow.human)} you) · {fmtInt(flow.left)} out{flow.exited ? ` (${fmtInt(flow.exited)} left the pipeline)` : ''}</span> : null}
      {s.aging && s.aging.median !== null ? <span>Median {s.aging.median}d in stage{s.aging.clockDays ? ` · ${fmtInt(s.aging.overClock)} past the ${s.aging.clockDays}-day clock` : ''}</span> : null}
      {s.code === 'closed' ? <span>S10 counts closings finalized through the Closing Desk only.</span> : null}
    </span>
  )
}

function Pulses({ reaches, arrivals, arrivedAt, mid, orientation }: { reaches: Reach[]; arrivals: DeskMove[]; arrivedAt: number | null; mid: number; orientation: 'horizontal' | 'vertical' }) {
  const reduced = useLcReducedMotion()
  if (reduced || !arrivedAt || !arrivals.length) return null
  const P = (along: number, across: number) => (orientation === 'horizontal' ? { x: along, y: across } : { x: across, y: along })
  return (
    <g className="pd2-pulses" key={arrivedAt}>
      {arrivals.slice(0, 6).map((m, k) => {
        const route = pulseRoute(m)
        if (!route) return null
        const from = route.from !== null ? reaches[route.from] : null
        const to = route.to !== null ? reaches[route.to] : null
        const start = from ? P(from.c, mid) : to ? P(to.x0 + 6, mid - to.t / 2 - 14) : null
        const end = to ? P(to.c, mid) : from ? P(from.c, mid + from.t / 2 + 16) : null
        if (!start || !end) return null
        const delay = k * 0.35
        return (
          <g key={m.id}>
            <motion.circle
              className="pd2-pulse"
              r={3.5}
              initial={{ cx: start.x, cy: start.y, opacity: 0 }}
              animate={{ cx: [start.x, end.x], cy: [start.y, end.y], opacity: [0, 1, 1, 0] }}
              transition={{ duration: 1.5, delay, ease: [0.22, 1, 0.36, 1], times: [0, 0.12, 0.82, 1] }}
            />
            {to ? (
              <motion.circle
                className="pd2-pulse-ring"
                cx={end.x}
                cy={end.y}
                initial={{ r: 4, opacity: 0 }}
                animate={{ r: [4, Math.max(14, Math.min(28, to.t / 2 + 6))], opacity: [0, 0.55, 0] }}
                transition={{ duration: 1.1, delay: delay + 1.2, ease: 'easeOut' }}
              />
            ) : null}
          </g>
        )
      })}
    </g>
  )
}

function RiverSvg({ reaches, strata, along, across, mid, orientation, arrivals, arrivedAt, selectedIndex }: {
  reaches: Reach[]
  strata: ReturnType<typeof riverStrata>
  along: number
  across: number
  mid: number
  orientation: 'horizontal' | 'vertical'
  arrivals: DeskMove[]
  arrivedAt: number | null
  selectedIndex: number
}) {
  const uid = useId().replace(/:/g, '')
  const stacked = useMemo(() => stackStrata(reaches, strata), [reaches, strata])
  const bed = useMemo(() => stratumPath(reaches, reaches.map((r) => [0, r.t] as [number, number]), { mid, orientation }), [reaches, mid, orientation])
  const w = orientation === 'horizontal' ? along : across
  const h = orientation === 'horizontal' ? across : along
  const sel = selectedIndex >= 0 ? reaches[selectedIndex] : null
  return (
    // Sized inline: the host shell sizes every svg to 16px (.nx-premium-inbox svg).
    <svg className="pd2-river__svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ width: w, height: h }} aria-hidden="true">
      <defs>
        <linearGradient id={`pd2-sheen-${uid}`} x1="0" y1="0" x2={orientation === 'horizontal' ? '0' : '1'} y2={orientation === 'horizontal' ? '1' : '0'}>
          <stop offset="0" stopColor="#fff" stopOpacity="0.2" />
          <stop offset="0.45" stopColor="#fff" stopOpacity="0.02" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={bed} className="pd2-river__glow" />
      <path d={bed} className="pd2-river__bed" />
      {sel ? (
        orientation === 'horizontal'
          ? <rect className="pd2-river__sel" x={sel.x0 + 2} y={2} width={sel.x1 - sel.x0 - 4} height={h - 4} rx={12} />
          : <rect className="pd2-river__sel" x={2} y={sel.x0 + 2} width={w - 4} height={sel.x1 - sel.x0 - 4} rx={10} />
      ) : null}
      {stacked.map(({ stratum, edges, present }) => (present ? (
        <path key={stratum.key} d={stratumPath(reaches, edges, { mid, orientation })} style={{ fill: stratum.color }} className="pd2-river__stratum" data-k={stratum.key} />
      ) : null))}
      <path d={bed} style={{ fill: `url(#pd2-sheen-${uid})` }} className="pd2-river__sheen" />
      <Pulses reaches={reaches} arrivals={arrivals} arrivedAt={arrivedAt} mid={mid} orientation={orientation} />
    </svg>
  )
}

function arrivedAtStage(arrivals: DeskMove[], index: number): boolean {
  return arrivals.some((m) => {
    const r = pulseRoute(m)
    return r !== null && (r.to === index || (r.to === null && r.from === index))
  })
}

function HorizontalRiver({ width, ordered, totals, strata, flows, periodLabel, arrivals, arrivedAt, selectedStage, onPickStage }: InnerProps) {
  const bandH = Math.round(Math.max(112, Math.min(196, width * 0.118)))
  const reaches = useMemo(() => riverReaches(totals, { along: width, across: bandH - 14, minT: 12 }), [totals, width, bandH])
  const selectedIndex = selectedStage ? STAGE_CODES.indexOf(selectedStage as typeof STAGE_CODES[number]) : -1
  return (
    <div className="pd2-reaches" style={{ ['--pd2-band-h' as string]: `${bandH}px` }}>
      <div className="pd2-reaches__groups" aria-hidden="true">
        {STAGE_GROUPS.map((g) => <span key={g.key} style={{ gridColumn: `${g.from} / ${g.to + 1}` }}>{g.label}</span>)}
      </div>
      <div className="pd2-reaches__band">
        <RiverSvg reaches={reaches} strata={strata} along={width} across={bandH} mid={bandH / 2} orientation="horizontal" arrivals={arrivals} arrivedAt={arrivedAt} selectedIndex={selectedIndex} />
      </div>
      <ol className="pd2-reaches__cols">
        {ordered.map((s, i) => {
          const code = STAGE_CODES[i]
          const flow = flows?.find((f) => f.code === code)
          const total = totals[i]
          const arrived = Boolean(arrivedAt) && arrivedAtStage(arrivals, i)
          return (
            <li key={code} className={cx('pd2-reach', !total && 'is-dry', selectedStage === code && 'is-on')}>
              <LCTooltip content={<ReachTip s={s} flow={flow} periodLabel={periodLabel} />} side="top">
                <button type="button" className="pd2-reach__hit" onClick={() => onPickStage(code)} aria-label={`S${i + 1} ${STAGE_SHORT_LABEL[code]}: ${total} live deals. Open in Flow.`} data-pd2-stage={code}>
                  <span className="pd2-reach__name"><em>S{i + 1}</em>{STAGE_SHORT_LABEL[code]}</span>
                  <span key={arrived ? `a${arrivedAt}` : 'n'} className={cx('pd2-reach__count lc-num', arrived && 'is-arrived')}>{fmtInt(total)}</span>
                  <span className="pd2-reach__gap" aria-hidden="true" />
                  <span className="pd2-reach__value">{s?.value ? <>{compactMoney(s.value)}<small> est.</small></> : <small>—</small>}</span>
                  <span className="pd2-reach__flow">
                    {flow && (flow.entered || flow.left) ? (
                      <><span className="is-in">+{fmtInt(flow.entered)}</span><span className="is-out">−{fmtInt(flow.left)}</span>{flow.human ? <span className="is-you" title="moved by you">{fmtInt(flow.human)} you</span> : null}</>
                    ) : <small>no movement</small>}
                  </span>
                  <span className="pd2-reach__age">
                    {s?.aging && s.aging.median !== null ? <><span className="lc-num" title="Median days in stage">{s.aging.median}d</span>{s.aging.overClock ? <i className="pd2-clock" title={`${s.aging.overClock} past the ${s.aging.clockDays}-day stage clock`}>{fmtInt(s.aging.overClock)} late</i> : null}</> : <small>&nbsp;</small>}
                  </span>
                  <span className="pd2-reach__dormant">{s?.dormant ? `${fmtInt(s.dormant)} dormant` : ' '}</span>
                </button>
              </LCTooltip>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function VerticalRiver({ width, ordered, totals, strata, flows, periodLabel, arrivals, arrivedAt, selectedStage, onPickStage }: InnerProps) {
  const rowH = 48
  const bandW = Math.round(Math.max(72, Math.min(132, width * 0.26)))
  const along = rowH * STAGE_CODES.length
  const reaches = useMemo(() => riverReaches(totals, { along, across: bandW - 10, minT: 10 }), [totals, along, bandW])
  const selectedIndex = selectedStage ? STAGE_CODES.indexOf(selectedStage as typeof STAGE_CODES[number]) : -1
  return (
    <div className="pd2-ladder" style={{ ['--pd2-band-w' as string]: `${bandW}px`, ['--pd2-row-h' as string]: `${rowH}px` }}>
      <div className="pd2-ladder__band">
        <RiverSvg reaches={reaches} strata={strata} along={along} across={bandW} mid={bandW / 2} orientation="vertical" arrivals={arrivals} arrivedAt={arrivedAt} selectedIndex={selectedIndex} />
      </div>
      <ol className="pd2-ladder__rows">
        {ordered.map((s, i) => {
          const code = STAGE_CODES[i]
          const flow = flows?.find((f) => f.code === code)
          const arrived = Boolean(arrivedAt) && arrivedAtStage(arrivals, i)
          return (
            <li key={code} className={cx('pd2-rung', !totals[i] && 'is-dry', selectedStage === code && 'is-on')}>
              <LCTooltip content={<ReachTip s={s} flow={flow} periodLabel={periodLabel} />} side="left">
                <button type="button" className="pd2-rung__hit" onClick={() => onPickStage(code)} data-pd2-stage={code} aria-label={`S${i + 1} ${STAGE_SHORT_LABEL[code]}: ${totals[i]} live deals. Open in Flow.`}>
                  <span className="pd2-rung__name"><em>S{i + 1}</em>{STAGE_SHORT_LABEL[code]}</span>
                  <span key={arrived ? `a${arrivedAt}` : 'n'} className={cx('pd2-rung__count lc-num', arrived && 'is-arrived')}>{fmtInt(totals[i])}</span>
                  <span className="pd2-rung__meta">
                    {s?.value ? <>{compactMoney(s.value)} est.</> : null}
                    {flow && (flow.entered || flow.left) ? <> · +{fmtInt(flow.entered)} −{fmtInt(flow.left)}</> : null}
                    {s?.dormant ? <> · {fmtInt(s.dormant)} dormant</> : null}
                  </span>
                </button>
              </LCTooltip>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
