import { useState, type ReactNode } from 'react'
import { LCIconButton, LCTooltip, cx } from '../../../shared/lc'
import { fmtAge, fmtDate, fmtInt, fmtMoney, fmtPct, fmtUnitValue, subjectImplied } from '../../../domain/comp-intelligence/comps-workstation-model'
import { staticStreetViewUrl } from '../../../modules/entity-graph/mobile/EntityGraphPropertyVisual'
import type { Workstation } from './derive-workstation'
import { MorphValue } from './MorphValue'

interface Props {
  m: Workstation
  pinLabel: string | null
  pinned: boolean
  onOpenDeal: () => void
  onOpenGraph: () => void
  onOpenMap: () => void
  onStreetView: (() => void) | null
  refreshing: boolean
}

const money = (v: number) => fmtMoney(v) ?? '—'

/**
 * SUBJECT INTELLIGENCE STRIP — the anchor. Identity and record facts on the
 * left, then the valuation context, every figure labelled for what it is:
 * the engine's comp-weighted range is valuation; the record estimate, the
 * ask and the last sale are context. Only values that exist are shown.
 */
export function SubjectStrip({ m, pinLabel, pinned, onOpenDeal, onOpenGraph, onOpenMap, onStreetView, refreshing }: Props) {
  const s = m.w.subject
  const c = m.w.conclusion
  const [photoFailed, setPhotoFailed] = useState<string | null>(null)
  const photo = staticStreetViewUrl(s.address, s.lat, s.lng)
  const [street, ...rest] = (s.address ?? 'Subject property').split(',')
  const place = [rest.join(',').trim(), s.county ? `${s.county} County` : null, s.subdivision ? titleCase(s.subdivision) : null].filter(Boolean).join(' · ')
  const specs = [
    s.familyLabel ?? s.propertyType,
    s.units && s.units > 1 ? `${s.units} units` : null,
    s.beds !== null && m.kind !== 'land' ? `${s.beds} bd` : null,
    s.baths !== null && m.kind !== 'land' ? `${s.baths} ba` : null,
    s.sqft ? `${fmtInt(s.sqft)} sf` : null,
    s.yearBuilt ? `Built ${s.yearBuilt}` : null,
    s.lotSqft ? (m.kind === 'land' ? `${(s.lotSqft / 43_560).toFixed(2)} ac` : `${fmtInt(s.lotSqft)} sf lot`) : null,
    s.zoning && m.kind === 'land' ? `Zoned ${s.zoning}` : null,
    s.condition ? `${s.condition} condition` : null,
  ].filter(Boolean) as string[]
  const implied = m.comparableValuation ? subjectImplied(c?.valueMid ?? null, s, m.metric) : null
  const op = m.lens === 'operator' ? m.operatorReplay?.result ?? null : null
  const sys = m.systemReplay.result
  const depth = m.depth

  return (
    <header className={cx('ciw-strip', refreshing && 'is-refreshing')} aria-label="Subject">
      <div className="ciw-strip__photo" aria-hidden={!onStreetView}>
        {photo && photoFailed !== photo ? <img src={photo} alt="" onError={() => setPhotoFailed(photo)} /> : <span className="ciw-strip__nophoto">No street imagery</span>}
        {onStreetView && photo && photoFailed !== photo ? <button type="button" className="ciw-strip__look" onClick={onStreetView} aria-label="Look around in Street View">Street View</button> : null}
      </div>

      <div className="ciw-strip__identity">
        <span className="ciw-strip__eyebrow">
          <i className="ciw-strip__diamond" aria-hidden="true" />Subject
          {s.market ? <span> · {s.market}</span> : null}
          {pinned ? <span className="ciw-pin" title="This pane stays on this property while linked panes move">Pinned{pinLabel ? ` · ${pinLabel}` : ''}</span> : null}
        </span>
        <h1 className="ciw-strip__address">{street}</h1>
        {place ? <p className="ciw-strip__place">{place}</p> : null}
        <p className="ciw-strip__specs lc-num">{specs.join(' · ')}</p>
      </div>

      <div className="ciw-strip__value">
        {m.comparableValuation && c?.valueLow && c.valueHigh && c.valueMid ? (
          <>
            <LCTooltip content={`Engine value range — weighted 25th–75th percentile of ${m.systemKeys.size} adjusted comps, widened to the minimum spread. Acquisition engine ${m.run?.version ?? ''}, ${fmtDate(m.run?.computedAt ?? c.computedAt, 'long') ?? ''}.`}>
              <span className="ciw-strip__eyebrow" tabIndex={0}>Engine value · comp-weighted</span>
            </LCTooltip>
            <div className="ciw-strip__range lc-num"><MorphValue value={c.valueLow} format={money} /><i>–</i><MorphValue value={c.valueHigh} format={money} /></div>
            <div className="ciw-strip__central lc-num">central <b>{fmtMoney(c.valueMid, { exact: true })}</b>{op && sys ? <em className={cx(op.mid > sys.mid ? 'is-up' : op.mid < sys.mid ? 'is-down' : null)}> · your set {fmtMoney(op.mid)} {fmtPct((op.mid - sys.mid) / sys.mid, 1, true)}</em> : null}</div>
          </>
        ) : (
          <>
            <span className="ciw-strip__eyebrow">Valuation</span>
            <div className="ciw-strip__novalue">{c?.method && c.method !== 'weighted_adjusted_comp_value' ? 'No comp-supported value' : 'Not yet valued by the engine'}</div>
            <div className="ciw-strip__central">{op ? <>your set central <b className="lc-num">{fmtMoney(op.mid)}</b></> : 'Comparable evidence below'}</div>
          </>
        )}
      </div>

      <dl className="ciw-strip__metrics lc-num">
        {implied !== null ? <Metric label={`Implied ${m.metric.label}`} value={`${fmtUnitValue(implied, m.metric)}`} note={depth.unitSpread !== null ? `set spread ${fmtPct(depth.unitSpread, 0)}` : undefined} hint={`Engine central value ÷ the subject’s ${m.metric.basis}`} /> : null}
        {c?.ask ? <Metric label="Seller ask" value={money(c.ask)} note={m.comparableValuation && c.valueMid ? `${fmtPct((c.ask - c.valueMid) / c.valueMid, 0, true)} vs central` : undefined} hint="What the seller asked — not a valuation" /> : null}
        {s.estimatedValue ? <Metric label="Record estimate" value={money(s.estimatedValue)} hint="The data provider’s estimate on the property record — not comp evidence" /> : null}
        {s.lastSale ? <Metric label="Last sale" value={money(s.lastSale.price)} note={fmtDate(s.lastSale.date) ?? undefined} hint={`Last recorded sale, ${fmtDate(s.lastSale.date, 'long')}`} /> : null}
        <Metric
          label="Evidence"
          value={`${depth.count} ${m.lens === 'operator' ? 'in your set' : 'priced'}`}
          note={depth.count ? `${depth.within1mi} within 1 mi · ${depth.within12mo} within 12 mo` : `${m.universeCount} in the universe`}
          hint={`${m.universeCount} admissible sales in the search · median distance ${depth.medianDistance ?? '—'} mi · median age ${fmtAge(depth.medianAgeDays) ?? '—'}`}
        />
        {(op ?? (m.comparableValuation ? sys : null)) ? (
          <Metric
            label="Confidence"
            value={<MorphValue value={(op ?? sys)!.confidence} format={(v) => `${Math.round(v)}`} />}
            note={m.lens === 'operator' ? 'your set · engine formula' : 'engine valuation'}
            hint="The engine’s valuation confidence: depth, comparability, completeness, consistency and source mix (Model shows why)"
            tone={(op ?? sys)!.confidence >= 75 ? 'ok' : (op ?? sys)!.confidence >= 55 ? null : 'attn'}
          />
        ) : null}
      </dl>

      <div className="ciw-strip__actions">
        <LCIconButton icon="target" label="Open Deal Intelligence for this property" onClick={onOpenDeal} variant="glass" />
        <LCIconButton icon="radar" label="Open in Entity Graph" onClick={onOpenGraph} variant="glass" />
        <LCIconButton icon="map" label="Open the subject and set in Map" onClick={onOpenMap} variant="glass" />
      </div>
    </header>
  )
}

function Metric({ label, value, note, hint, tone }: { label: string; value: ReactNode; note?: string; hint: string; tone?: 'ok' | 'attn' | null }) {
  return (
    <LCTooltip content={hint}>
      <div className={cx('ciw-metric', tone && `is-${tone}`)} tabIndex={0}>
        <dt>{label}</dt>
        <dd><b>{value}</b>{note ? <span>{note}</span> : null}</dd>
      </div>
    </LCTooltip>
  )
}

function titleCase(s: string) {
  return s.toLowerCase().replace(/\b\w/g, (x) => x.toUpperCase())
}
