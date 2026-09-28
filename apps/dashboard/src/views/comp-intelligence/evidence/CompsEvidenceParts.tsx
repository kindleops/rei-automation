/**
 * COMPS EVIDENCE — presentational parts: subject hero, evidence readout,
 * evidence range, $/sq ft distribution, comp card. No data fetching and no
 * valuation arithmetic beyond medians/ranges of the operator's chosen set.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '../../../shared/icons'
import type { CompsWorkspace, EvidenceComp, SetStats } from '../../../domain/comp-intelligence/comps-evidence-api'
import { ageLabel, money } from '../../../domain/comp-intelligence/comps-evidence-api'
import { staticStreetViewUrl } from '../../../modules/entity-graph/mobile/EntityGraphPropertyVisual'

export const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

/** Animated number — glides between values, instant under reduced motion. */
export function useGlide(target: number | null, ms = 700): number | null {
  const [v, setV] = useState(target)
  const from = useRef(target ?? 0)
  useEffect(() => {
    if (target === null) { setV(null); return }
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setV(target); from.current = target; return }
    const a = from.current
    const t0 = performance.now()
    let raf = 0
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / ms)
      const e = 1 - (1 - p) ** 3
      setV(a + (target - a) * e)
      if (p < 1) raf = requestAnimationFrame(tick)
      else from.current = target
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return v
}

export const Glide = ({ value, fmt }: { value: number | null; fmt: (n: number) => string }) => {
  const v = useGlide(value)
  return <>{v === null ? '—' : fmt(v)}</>
}

/* ── subject hero ─────────────────────────────────────────────────────── */

export function SubjectHero({ w, onMap, onGraph, onDeal, onLookAround }: { w: CompsWorkspace; onMap: () => void; onGraph: () => void; onDeal: () => void; onLookAround: () => void }) {
  const s = w.subject
  const photo = staticStreetViewUrl(s.address, s.lat, s.lng)
  const [ok, setOk] = useState<boolean | null>(null)
  const [street, ...rest] = (s.address ?? '').split(',')
  const specs = [
    s.familyLabel ?? s.propertyType,
    s.units && s.units > 1 ? `${s.units} units` : null,
    s.beds ? `${s.beds} bd` : null,
    s.baths ? `${s.baths} ba` : null,
    s.sqft ? `${s.sqft.toLocaleString('en-US')} sf` : null,
    s.yearBuilt ? `Built ${s.yearBuilt}` : null,
    s.lotSqft ? `${Math.round(s.lotSqft).toLocaleString('en-US')} sf lot` : null,
  ].filter(Boolean) as string[]
  return (
    <header className="cev-subject">
      <div className={cls('cev-subject__photo', ok === true && 'is-ready')} aria-hidden="true">
        <div className="cev-subject__mesh" />
        {photo && ok !== false ? <img src={photo} alt="" onLoad={() => setOk(true)} onError={() => setOk(false)} /> : null}
        <div className="cev-subject__scrim" />
        <div className="cev-subject__leak" />
        <div className="cev-subject__caustic" />
        <div className="cev-subject__grain" />
      </div>
      <div className="cev-subject__body">
        <span className="cev-eyebrow"><i />Subject</span>
        <button type="button" className="cev-lookbtn" onClick={onLookAround}><Icon name="eye" />Look around</button>
        <h2>{street || 'Subject property'}</h2>
        {rest.length ? <p>{rest.join(',').trim()}</p> : null}
        <div className="cev-subject__specs">{specs.map((x) => <span key={x}>{x}</span>)}</div>
        <div className="cev-subject__values">
          {w.conclusion?.valueMid ? <div><span>Deal value</span><b>{money(w.conclusion.valueMid)}</b><em>engine</em></div> : null}
          {s.estimatedValue ? <div><span>AVM</span><b>{money(s.estimatedValue)}</b><em>record</em></div> : null}
          {w.conclusion?.ask ? <div><span>Seller ask</span><b>{money(w.conclusion.ask)}</b><em>seller said</em></div> : null}
          {s.mlsStatus ? <div><span>MLS</span><b>{s.mlsStatus}</b><em>{money(s.mlsListPrice) ?? ''}</em></div> : null}
        </div>
        <div className="cev-subject__actions">
          <button type="button" onClick={onMap}><Icon name="map" />Map</button>
          <button type="button" onClick={onGraph}><Icon name="radar" />Record</button>
          <button type="button" onClick={onDeal}><Icon name="target" />Deal Intel</button>
        </div>
      </div>
    </header>
  )
}

/* ── evidence readout ─────────────────────────────────────────────────── */

const SUFFICIENCY: Record<string, { label: string; tone: string }> = {
  strong: { label: 'Strong local evidence', tone: 'good' },
  moderate: { label: 'Moderate local evidence', tone: 'ok' },
  limited: { label: 'Limited local evidence', tone: 'warn' },
  thin: { label: 'Thin local evidence', tone: 'bad' },
}

export function EvidenceReadout({ w, stats, isSystem, hasSystem, onReset, setCount }: { w: CompsWorkspace; stats: SetStats; isSystem: boolean; hasSystem: boolean; onReset: () => void; setCount: number }) {
  const suf = SUFFICIENCY[w.sufficiency.level]
  const multi = ['multifamily', 'apartment'].includes(w.subject.family ?? '')
  return (
    <section className="cev-readout">
      <div className="cev-readout__head">
        <div className={cls('cev-setpill', isSystem ? 'is-system' : 'is-yours')}>
          <span>{isSystem ? (hasSystem ? 'System set' : 'Starter set') : 'Your set'}</span>
          <b>{setCount}</b>
          {isSystem ? <em>{hasSystem ? 'engine priced from' : 'top engine-ranked · no engine analysis yet'}</em> : <em>{hasSystem ? `vs ${w.counts.system} system` : 'custom'}</em>}
        </div>
        {!isSystem ? <button type="button" className="cev-reset" onClick={onReset}><Icon name="refresh-cw" />Reset</button> : null}
      </div>
      <div className="cev-readout__main">
        <div className="cev-readout__hero">
          <span>Median sale</span>
          <strong><Glide value={stats.medianPrice} fmt={(n) => money(n, true) ?? '—'} /></strong>
          <em>{stats.low && stats.high ? `${money(stats.low)} – ${money(stats.high)} observed` : 'no priced sales'}</em>
          {stats.low && stats.high && stats.medianPrice && stats.high > stats.low ? (
            <div className="cev-meter" aria-hidden="true"><i style={{ left: `${Math.max(4, Math.min(96, ((stats.medianPrice - stats.low) / (stats.high - stats.low)) * 100))}%` }} /></div>
          ) : null}
        </div>
        <div className="cev-readout__grid">
          <div><span>{multi ? '$/unit' : '$/sq ft'}</span><b><Glide value={multi ? stats.medianPpu : stats.medianPpsf} fmt={(n) => (multi ? money(n) ?? '—' : `$${Math.round(n)}`)} /></b></div>
          <div><span>Adjusted</span><b><Glide value={stats.medianAdjusted} fmt={(n) => money(n) ?? '—'} /></b></div>
          <div><span>Distance</span><b><Glide value={stats.medianDistance} fmt={(n) => `${n.toFixed(2)} mi`} /></b></div>
          <div><span>Recency</span><b>{ageLabel(stats.medianAgeDays) ?? '—'}</b></div>
        </div>
      </div>
      <div className={cls('cev-suff', `is-${suf.tone}`)}>
        <i />
        <span><b>{suf.label}</b> — {w.sufficiency.withinMileLastYear} same-type sale{w.sufficiency.withinMileLastYear === 1 ? '' : 's'} within 1 mi in the last 12 months · {w.sufficiency.usable} usable in {w.query.radiusMiles} mi / {w.query.months} mo</span>
      </div>
      <p className="cev-footnote">
        Medians of the {isSystem ? (hasSystem ? 'engine’s pricing set' : 'engine’s top-ranked candidates') : 'comps you selected'} — evidence, not a valuation.
        {w.conclusion?.valueMid ? <> Deal Intelligence value <b>{money(w.conclusion.valueMid)}</b> comes from the engine’s weighted, adjusted model.</> : null}
      </p>
    </section>
  )
}

/* ── evidence range + distribution ───────────────────────────────────── */

type Dot = { key: string; v: number; inSet: boolean; excluded: boolean }

export function EvidenceStrip({ title, dots, markers, fmt, focusKey, onFocus, note }: {
  title: string
  dots: Dot[]
  markers: Array<{ key: string; label: string; v: number | null; tone: string }>
  fmt: (n: number) => string
  focusKey: string | null
  onFocus: (key: string) => void
  note?: ReactNode
}) {
  const vals = [...dots.filter((d) => !d.excluded).map((d) => d.v), ...markers.map((m) => m.v ?? NaN)].filter((v) => Number.isFinite(v) && v > 0)
  // No sales, no distribution — markers alone would draw an empty chart.
  if (!dots.length || vals.length < 1) return null
  const sorted = [...vals].sort((a, b) => a - b)
  const lo = sorted[Math.floor(sorted.length * 0.02)] ?? sorted[0]
  const hi = sorted[Math.ceil(sorted.length * 0.98) - 1] ?? sorted[sorted.length - 1]
  const pad = (hi - lo) * 0.08 || hi * 0.1
  const min = Math.max(0, lo - pad)
  const max = hi + pad
  const at = (v: number) => Math.max(1.5, Math.min(98.5, ((v - min) / (max - min || 1)) * 100))
  const setVals = dots.filter((d) => d.inSet).map((d) => d.v).sort((a, b) => a - b)
  const band = setVals.length ? { from: at(setVals[0]), to: at(setVals[setVals.length - 1]) } : null
  const med = setVals.length ? setVals[Math.floor((setVals.length - 1) / 2)] : null
  // Sales beyond the scale are counted at its ends, not stacked on its edge.
  const below = dots.filter((d) => d.v < min).length
  const above = dots.filter((d) => d.v > max).length
  // Jitter rows so coincident dots stay tappable.
  const rows = new Map<number, number>()
  return (
    <section className="cev-strip">
      <div className="cev-strip__head"><span>{title}</span>{med !== null ? <b>median {fmt(med)}</b> : null}</div>
      <div className="cev-strip__stage">
        <div className="cev-strip__rail" />
        {band ? <div className="cev-strip__band" style={{ left: `${band.from}%`, width: `${Math.max(1.5, band.to - band.from)}%` }} /> : null}
        {dots.filter((d) => d.v >= min && d.v <= max).map((d) => {
          const x = at(d.v)
          const bucket = Math.round(x / 3)
          const row = rows.get(bucket) ?? 0
          rows.set(bucket, row + 1)
          return (
            <button
              key={d.key}
              type="button"
              className={cls('cev-dot', d.inSet ? 'is-set' : d.excluded ? 'is-excl' : 'is-cand', focusKey === d.key && 'is-focus')}
              style={{ left: `${x}%`, top: `${50 + (row % 2 ? 1 : -1) * Math.ceil(row / 2) * 9}%` }}
              onClick={() => onFocus(d.key)}
              aria-label={fmt(d.v)}
            />
          )
        })}
        {markers.filter((m) => m.v).map((m, i) => (
          <span key={m.key} className={cls('cev-mark', `tone-${m.tone}`, i % 2 ? 'is-low' : 'is-high', at(m.v as number) > 80 && 'is-end', at(m.v as number) < 20 && 'is-start')} style={{ left: `${at(m.v as number)}%` }}>
            <i /><em>{m.label} {fmt(m.v as number)}</em>
          </span>
        ))}
      </div>
      <div className="cev-strip__scale">
        <span>{fmt(min)}{below ? <em> · {below} lower</em> : null}</span>
        <span>{above ? <em>{above} higher · </em> : null}{fmt(max)}</span>
      </div>
      {note ? <p className="cev-footnote">{note}</p> : null}
    </section>
  )
}

/* ── comp card ────────────────────────────────────────────────────────── */

const pct = (n: number | null, unit = '%') => (n === null ? null : `${n > 0 ? '+' : ''}${n}${unit}`)

export function CompCard({ c, inSet, focus, near, onToggle, onOpen, multi }: { c: EvidenceComp; inSet: boolean; focus: boolean; near: boolean; onToggle: () => void; onOpen: () => void; multi: boolean }) {
  // Stored imagery first; otherwise Street View, requested only for cards near
  // the focused one (no fan-out across the whole gallery).
  const [photoFailed, setPhotoFailed] = useState(false)
  const photo = c.photo ?? (near ? staticStreetViewUrl(c.address, c.lat, c.lng) : null)
  const specCells: Array<[string, string]> = (multi
    ? [['Units', c.units ? String(c.units) : '—'], ['Sq ft', c.sqft ? Math.round(c.sqft).toLocaleString('en-US') : '—'], ['Built', c.yearBuilt ? String(c.yearBuilt) : '—'], ['Beds', c.beds !== null ? String(c.beds) : '—']]
    : [['Beds', c.beds !== null ? String(c.beds) : '—'], ['Baths', c.baths !== null ? String(c.baths) : '—'], ['Sq ft', c.sqft ? Math.round(c.sqft).toLocaleString('en-US') : '—'], ['Built', c.yearBuilt ? String(c.yearBuilt) : '—']]) as Array<[string, string]>
  const why = [
    c.distanceMiles !== null ? { k: 'mi', v: `${c.distanceMiles.toFixed(2)} mi`, good: c.distanceMiles <= 1 } : null,
    c.compare.days !== null ? { k: 'age', v: `${ageLabel(c.compare.days)} ago`, good: c.compare.days <= 365 } : null,
    multi ? (c.compare.units !== null ? { k: 'units', v: c.compare.units === 0 ? 'same units' : `${pct(c.compare.units, 'u')}`, good: Math.abs(c.compare.units) <= 1 } : null)
      : (c.compare.sqftPct !== null ? { k: 'size', v: c.compare.sqftPct === 0 ? 'same size' : `${pct(c.compare.sqftPct)} size`, good: Math.abs(c.compare.sqftPct) <= 15 } : null),
    c.compare.years !== null ? { k: 'yr', v: c.compare.years === 0 ? 'same year' : `${pct(c.compare.years, 'y')}`, good: Math.abs(c.compare.years) <= 10 } : null,
    { k: 'type', v: c.assetMatch ? 'same type' : 'other type', good: c.assetMatch },
  ].filter(Boolean) as Array<{ k: string; v: string; good: boolean }>
  return (
    <article className={cls('cev-card', `is-${c.state}`, inSet && 'in-set', focus && 'is-focus')} data-key={c.key}>
      <button type="button" className="cev-card__open" onClick={onOpen} aria-label={`Inspect ${c.address ?? 'comp'}`}>
        <div className="cev-card__media">
          {photo && !photoFailed ? <img src={photo} alt="" loading="lazy" decoding="async" onError={() => setPhotoFailed(true)} /> : <div className="cev-card__mono">{(c.address ?? '•').slice(0, 1)}</div>}
          <div className="cev-card__shade" />
          <span className={cls('cev-card__src', c.mls && 'is-mls', c.corpus === 'transaction_corpus' && 'is-deed')}>{c.source ?? 'Sale'}</span>
          <span className={cls('cev-card__state', `is-${c.state}`)}>{c.state === 'system' ? 'System' : c.state === 'excluded' ? 'Excluded' : 'Candidate'}</span>
          <div className="cev-card__price">
            <b>{money(c.salePrice) ?? '—'}</b>
            {multi ? (c.ppu ? <em>{money(c.ppu)}/unit</em> : null) : (c.ppsf ? <em>${c.ppsf}/sf</em> : null)}
          </div>
        </div>
        <div className="cev-card__body">
          <p className="cev-card__addr">{c.address}</p>
          <div className="cev-card__kind">{c.propertyType ?? 'Sale'}{c.units && c.units > 1 ? ` · ${c.units} units` : ''}</div>
          <dl className="cev-card__spec">
            {specCells.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          </dl>
          <div className="cev-card__why">{why.map((x) => <span key={x.k} className={x.good ? 'is-good' : 'is-off'}>{x.v}</span>)}</div>
          {c.state === 'excluded' && c.reasons.length ? <p className="cev-card__reason"><Icon name="slash" />{c.reasons[0].label}{c.reasons.length > 1 ? ` +${c.reasons.length - 1}` : ''}</p> : null}
          <div className="cev-card__tx">
            {c.armsLength === true ? <span className="is-good">Arm’s-length</span> : c.armsLength === false ? <span className="is-bad">Non-arm’s-length</span> : null}
            {c.cash === true ? <span>Cash</span> : c.cash === false ? <span>Financed</span> : null}
            {c.buyerKind === 'company' ? <span className="is-co">{c.buyerCompany ?? 'Company buyer'}{c.buyerAcquisitions && c.buyerAcquisitions > 1 ? ` · ${c.buyerAcquisitions} buys` : ''}</span> : c.buyerKind === 'person' ? <span>Individual buyer</span> : null}
            {c.engine?.eligible && c.engine.score !== null && c.engine.score !== undefined ? <span className="is-eng">Engine {Math.round(c.engine.score)}</span> : null}
          </div>
        </div>
      </button>
      <button type="button" className={cls('cev-card__toggle', inSet && 'is-on')} onClick={onToggle} aria-pressed={inSet}>
        <Icon name={inSet ? 'check' : 'bolt'} />{inSet ? 'In your set' : 'Add to set'}
      </button>
    </article>
  )
}
