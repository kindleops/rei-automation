import { cx, LCTooltip } from '../../../../shared/lc'
import { usd } from '../di-format'
import { niceTicks, polarOf, type CompStats } from '../di-model'
import type { DiComp, DiDecision } from '../di-types'
import { useWidth } from '../useWidth'

/**
 * COMP VALUE DISTRIBUTION — each qualified comp's adjusted value on one
 * axis (dot area = engine weight), with the low and high comp, the median
 * adjusted comp, the engine's weighted value, the supported range, the AVM
 * and the seller's ask. A beeswarm keeps close values legible.
 */
export function CompDistribution({ d, stats, selectedId, onSelect }: { d: DiDecision; stats: CompStats; selectedId: string | null; onSelect: (id: string) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const comps = (d.comps?.top ?? []).filter((c) => (c.adjustedValue ?? c.salePrice))
  const v = d.valuation
  const ask = d.offer?.negotiation.ask ?? null
  const vals = [...comps.map((c) => (c.adjustedValue ?? c.salePrice) as number), v?.low, v?.high, v?.mid, v?.avm, ask].filter((x): x is number => typeof x === 'number' && x > 0)
  if (vals.length < 2) return null
  const lo = Math.min(...vals)
  const hi = Math.max(...vals)
  const pad = (hi - lo) * 0.06 || hi * 0.1
  const min = Math.max(0, lo - pad)
  const max = hi + pad
  const W = Math.max(320, width || 640)
  const H = 150
  const x = (val: number) => 14 + ((val - min) / (max - min)) * (W - 28)
  // beeswarm: rows by collision, centred on the axis
  const placed: Array<{ c: DiComp; cx: number; cy: number; r: number }> = []
  const sorted = [...comps].sort((a, b) => ((a.adjustedValue ?? a.salePrice) as number) - ((b.adjustedValue ?? b.salePrice) as number))
  for (const c of sorted) {
    const cx0 = x((c.adjustedValue ?? c.salePrice) as number)
    const r = 4 + Math.sqrt(Math.max(0.02, c.weight ?? 0.2)) * 7
    let cy = 78
    for (let k = 0; k < 14; k++) {
      const off = k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 11
      cy = 78 + off
      if (!placed.some((p) => Math.hypot(p.cx - cx0, p.cy - cy) < p.r + r + 1.5)) break
    }
    placed.push({ c, cx: cx0, cy, r })
  }
  const ticks = niceTicks(min, max, Math.max(3, Math.min(7, Math.round(W / 140))))
  const vline = (val: number | null | undefined, cls: string, label: string, top = true) => (val ? (
    <g className={cx('dr-dist__mark', cls)}>
      <line x1={x(val)} x2={x(val)} y1={44} y2={128} />
      <text x={x(val)} y={top ? 16 : 34} textAnchor={x(val) < 60 ? 'start' : x(val) > W - 60 ? 'end' : 'middle'}>{label} {usd(val)}</text>
    </g>
  ) : null)
  return (
    <div className="dr-dist" ref={ref}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Distribution of ${comps.length} qualified comps from ${usd(stats.low)} to ${usd(stats.high)}`}>
        {v?.low && v?.high ? <rect className="dr-dist__band" x={x(v.low)} y={48} width={Math.max(2, x(v.high) - x(v.low))} height={60} rx={8} /> : null}
        <line className="dr-dist__axis" x1={14} x2={W - 14} y1={128} y2={128} />
        {ticks.map((t) => (
          <g key={t.v} className="dr-dist__tick"><line x1={x(t.v)} x2={x(t.v)} y1={128} y2={132} /><text x={x(t.v)} y={145} textAnchor="middle">{t.label}</text></g>
        ))}
        {vline(stats.median, 'is-median', 'Median comp', false)}
        {vline(v?.mid, 'is-engine', 'Engine')}
        {vline(v?.avm, 'is-avm', 'AVM', false)}
        {vline(ask, 'is-ask', 'Ask')}
        {placed.map(({ c, cx: px, cy, r }) => {
          const id = c.id ?? c.address ?? ''
          return (
            <LCTooltip key={id} content={`${c.address ?? 'Comp'} · adjusted ${usd(c.adjustedValue)} · sold ${usd(c.salePrice)} · weight ${c.weight !== null ? `${Math.round(c.weight * 100)}%` : '—'}`}>
              <circle
                className={cx('dr-dist__dot', c.assetMatch ? 'is-match' : 'is-off', selectedId === id && 'is-selected')}
                cx={px}
                cy={cy}
                r={r}
                tabIndex={0}
                role="button"
                aria-label={`${c.address ?? 'Comp'} ${usd(c.adjustedValue)}`}
                onClick={() => onSelect(id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(id) } }}
              />
            </LCTooltip>
          )
        })}
      </svg>
    </div>
  )
}

/**
 * EVIDENCE PLOT — the subject at the centre, each qualified comp at its real
 * bearing and distance, with distance rings. Not a map: no tiles, no
 * unrelated layers, one honest picture of where the evidence sits.
 */
export function CompRadar({ d, selectedId, onSelect }: { d: DiDecision; selectedId: string | null; onSelect: (id: string) => void }) {
  const comps = (d.comps?.top ?? []).map((c) => ({ c, p: polarOf(d.subject, c) })).filter((x) => x.p)
  if (!comps.length) return null
  const far = Math.max(...comps.map((x) => x.p!.miles), 0.25)
  // three inner rings at most, plus one that encloses the farthest comp
  const rings = [0.25, 0.5, 1, 2, 5, 10].filter((r) => r < far * 0.95).slice(-3)
  rings.push(far <= 1 ? Math.ceil(far * 4) / 4 : Math.ceil(far))
  const outer = rings[rings.length - 1]
  const S = 220
  const R = S / 2 - 18
  const scale = (mi: number) => (Math.sqrt(mi) / Math.sqrt(outer)) * R
  return (
    <div className="dr-radar">
      <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} role="img" aria-label={`Qualified comps by bearing and distance, out to ${outer} miles`}>
        {rings.map((r) => (
          <g key={r} className="dr-radar__ring">
            <circle cx={S / 2} cy={S / 2} r={scale(r)} />
            <text x={S / 2 + scale(r) * 0.7071 + 2} y={S / 2 - scale(r) * 0.7071 - 2}>{r} mi</text>
          </g>
        ))}
        <line className="dr-radar__axis" x1={S / 2} x2={S / 2} y1={8} y2={S - 8} />
        <line className="dr-radar__axis" x1={8} x2={S - 8} y1={S / 2} y2={S / 2} />
        <text className="dr-radar__n" x={S / 2} y={10} textAnchor="middle">N</text>
        {comps.map(({ c, p }) => {
          const id = c.id ?? c.address ?? ''
          const rr = scale(p!.miles)
          const px = S / 2 + Math.sin(p!.angle) * rr
          const py = S / 2 - Math.cos(p!.angle) * rr
          return (
            <LCTooltip key={id} content={`${c.address ?? 'Comp'} · ${p!.miles.toFixed(2)} mi · ${usd(c.adjustedValue)}`}>
              <circle
                className={cx('dr-radar__dot', c.assetMatch ? 'is-match' : 'is-off', selectedId === id && 'is-selected')}
                cx={px}
                cy={py}
                r={3.5 + Math.sqrt(Math.max(0.02, c.weight ?? 0.2)) * 5}
                tabIndex={0}
                role="button"
                aria-label={`${c.address ?? 'Comp'}, ${p!.miles.toFixed(2)} miles`}
                onClick={() => onSelect(id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(id) } }}
              />
            </LCTooltip>
          )
        })}
        <circle className="dr-radar__subject" cx={S / 2} cy={S / 2} r={6} />
      </svg>
      <p className="dr-quiet">Subject at centre · rings in miles (square-root scale) · dot size = engine weight</p>
    </div>
  )
}
