import type { ReactNode } from 'react'
import { LCButton, LCStatus, cx } from '../../../shared/lc'
import type { ReplayResult } from '../../../domain/comp-intelligence/comps-valuation-replay'
import { fmtDate, fmtMoment, fmtMoney, fmtPct, fmtUnitValue, setDiff, subjectImplied } from '../../../domain/comp-intelligence/comps-workstation-model'
import type { Workstation } from './derive-workstation'
import type { FocusStore } from './focus-store'
import { MorphValue } from './MorphValue'
import { ValuationSpectrum } from './charts/ValuationSpectrum'
import { COMPONENT_LABEL, money, spectrumInputs } from './valuation-sources'

interface Props {
  m: Workstation
  store: FocusStore
  charts: ReactNode | null
  onBroaden: (() => void) | null
  onShowEvidence: () => void
  onOpenMap: () => void
  onOpenDeal: () => void
}

export function ValuationMode({ m, store, charts, onBroaden, onShowEvidence, onOpenMap, onOpenDeal }: Props) {
  const c = m.w.conclusion
  const sys = m.systemReplay.result
  const op = m.operatorReplay?.result ?? null
  const { bands, markers } = spectrumInputs(m)
  const ticks = m.lensComps.filter((x) => x.engine?.adjustedPrice).map((x) => ({ key: x.key, value: x.engine!.adjustedPrice as number, label: x.address ?? 'comp' }))
  const diff = m.operatorKeys ? setDiff(m.systemKeys, m.operatorKeys) : null
  // only a comparable valuation implies a unit value — never the record-estimate fallback
  const implied = m.comparableValuation ? subjectImplied(c?.valueMid ?? null, m.w.subject, m.metric) : null
  const fallback = c?.method && c.method !== 'weighted_adjusted_comp_value'

  return (
    <div className="ciw-valuation">
      {!m.comparableValuation ? (
        <section className="ciw-callout is-unavailable" aria-label="Valuation not available">
          <span className="lc-eyebrow">Valuation not available</span>
          <h3>{fallback ? 'No comparable sale supported a value' : m.systemKeys.size === 0 && !c ? 'The engine has not valued this property' : 'No comparable valuation'}</h3>
          <p>
            {fallback
              ? <>The acquisition engine found no sale that passed its rules{m.rules ? ` (same asset class, ≤ ${m.rules.radiusMiles} mi, sold ≤ ${m.rules.months} mo)` : ''} and stored the property record’s estimate ±15% instead{m.run?.computedAt ? ` on ${fmtDate(m.run.computedAt, 'long')}` : ''}. That figure is not comparable evidence, so it is not shown as a value here.</>
              : <>There is no stored engine valuation for this subject. The sales in the search can still be reviewed, and an operator set built from them is priced with the engine’s own formula.</>}
          </p>
          <div className="ciw-callout__actions">
            {onBroaden ? <LCButton variant="secondary" size="sm" onClick={onBroaden}>Broaden the search</LCButton> : null}
            <LCButton variant="ghost" size="sm" onClick={onShowEvidence}>View the universe</LCButton>
            <LCButton variant="ghost" size="sm" icon="map" onClick={onOpenMap}>Open in Map</LCButton>
          </div>
        </section>
      ) : null}

      {m.comparableValuation && m.systemKeys.size > 0 && m.systemKeys.size <= 2 ? (
        <section className="ciw-callout is-limited" aria-label="Limited evidence">
          <span className="lc-eyebrow">Limited evidence</span>
          <p>The engine priced this subject from {m.systemKeys.size === 1 ? 'one sale' : 'two sales'}. Its depth component is {sys ? Math.round(sys.components.depth) : '—'} of 100{m.run?.computedAt ? `, and the run is from ${fmtDate(m.run.computedAt, 'long')}` : ''} — every number here leans on very little evidence.</p>
        </section>
      ) : null}

      {(m.comparableValuation && c) || op ? (
        <div className={cx('ciw-vals', op && 'is-pair')}>
          {m.comparableValuation && c?.valueMid ? (
            <ValueCard
              title="System"
              sub={`engine · ${fmtDate(m.run?.computedAt ?? c.computedAt, 'long') ?? 'stored'}`}
              mid={c.valueMid}
              low={c.valueLow}
              high={c.valueHigh}
              confidence={c.valuationConfidence}
              count={m.systemKeys.size}
              status={m.parity.state === 'exact' ? <LCStatus tone="ok" label="Replay matches the stored run" quiet /> : m.parity.state === 'differs' ? <LCStatus tone="attn" label="Replay differs from the stored run" /> : null}
            />
          ) : null}
          {op ? (
            <ValueCard
              title="Your set"
              sub="engine formula · this session"
              mid={op.mid}
              low={op.low}
              high={op.high}
              confidence={op.confidence}
              count={op.count}
              delta={sys && m.comparableValuation ? { mid: (op.mid - sys.mid) / sys.mid, confidence: op.confidence - sys.confidence } : null}
              status={m.operatorReplay?.unpriced.length ? <LCStatus tone="attn" label={`${m.operatorReplay.unpriced.length} comp${m.operatorReplay.unpriced.length === 1 ? '' : 's'} the engine cannot price`} /> : null}
            />
          ) : null}
        </div>
      ) : null}

      {diff && (diff.added.length || diff.removed.length) && sys && op ? (
        <section className="ciw-why-moved">
          <span className="lc-eyebrow">Why it moved</span>
          <ul>
            {diff.removed.map((k) => { const x = m.byKey.get(k); return x ? <li key={k} data-tone="out" onPointerEnter={() => store.hover(k, 'chart')} onPointerLeave={() => store.hover(null, null)}><b>−</b> {x.address} <span className="lc-num">adj {fmtMoney(x.engine?.adjustedPrice ?? null)} · weight {x.engine?.weight?.toFixed(3) ?? '—'}</span></li> : null })}
            {diff.added.map((k) => { const x = m.byKey.get(k); return x ? <li key={k} data-tone="in" onPointerEnter={() => store.hover(k, 'chart')} onPointerLeave={() => store.hover(null, null)}><b>+</b> {x.address} <span className="lc-num">adj {fmtMoney(x.engine?.adjustedPrice ?? null)} · weight {x.engine?.weight?.toFixed(3) ?? '—'}</span></li> : null })}
          </ul>
          <div className="ciw-why-moved__conf">
            <span className="lc-eyebrow">Confidence {sys.confidence} → {op.confidence}</span>
            <div className="ciw-comp-deltas lc-num">
              {(Object.keys(COMPONENT_LABEL) as Array<keyof ReplayResult['components']>).map((k) => {
                const a = sys.components[k]
                const b = op.components[k]
                const d = b - a
                return (
                  <span key={k} title={`${COMPONENT_LABEL[k].label} (${Math.round(COMPONENT_LABEL[k].weight * 100)}% of confidence): ${COMPONENT_LABEL[k].hint}`} className={cx('ciw-comp-delta', Math.abs(d) >= 0.05 && (d > 0 ? 'is-up' : 'is-down'))}>
                    {COMPONENT_LABEL[k].label} <b>{a.toFixed(1)} → {b.toFixed(1)}</b>
                  </span>
                )
              })}
            </div>
          </div>
        </section>
      ) : null}

      {bands.length || markers.length ? (
        <section className="ciw-block">
          <header className="ciw-block__head">
            <span className="ciw-block__title">Valuation spectrum</span>
            <span className="ciw-block__aside">bands = valuation · hairlines = context</span>
          </header>
          <ValuationSpectrum bands={bands} markers={markers} ticks={ticks} store={store} />
        </section>
      ) : null}

      <section className="ciw-block">
        <header className="ciw-block__head"><span className="ciw-block__title">Value provenance</span></header>
        <dl className="ciw-prov">
          {m.comparableValuation && c?.valueMid ? <Prov label="Engine value" value={`${money(c.valueLow ?? 0)} – ${money(c.valueHigh ?? 0)}`} detail={`Acquisition engine ${m.run?.version ?? ''} · ${m.run?.formula ?? 'weighted adjusted comp value'} · ${m.systemKeys.size} comps · confidence ${c.valuationConfidence ?? '—'} · ${fmtMoment(m.run?.computedAt ?? c.computedAt) ?? ''}`} /> : null}
          {implied !== null ? <Prov label={`Implied ${m.metric.label}`} value={`${fmtUnitValue(implied, m.metric)}${m.metric.short}`} detail={`Engine central value ÷ the subject’s ${m.metric.basis}`} /> : null}
          {op ? <Prov label="Your set" value={`${money(op.low)} – ${money(op.high)}`} detail={`The engine’s formula over your ${op.count} comps · replayed in this session · not stored`} /> : null}
          {m.w.subject.estimatedValue ? <Prov label="Record estimate" value={money(m.w.subject.estimatedValue)} detail="Data provider estimate on the property record — not comp evidence" /> : null}
          {c?.ask ? <Prov label="Seller ask" value={money(c.ask)} detail="Acquisition negotiation record — what the seller asked" /> : null}
          {c?.recommendedOffer ? <Prov label="Engine offer" value={money(c.recommendedOffer)} detail={<>Deal Intelligence’s recommended offer — context, not value · <button type="button" className="lc-link" onClick={onOpenDeal}>Open Deal Intelligence</button></>} /> : null}
          {m.w.subject.lastSale ? <Prov label="Last recorded sale" value={money(m.w.subject.lastSale.price)} detail={fmtDate(m.w.subject.lastSale.date, 'long') ?? ''} /> : null}
          {m.w.subject.assessedValue ? <Prov label="Assessed value" value={money(m.w.subject.assessedValue)} detail="Tax assessment on the property record" /> : null}
        </dl>
      </section>

      {charts}
    </div>
  )
}

function ValueCard({ title, sub, mid, low, high, confidence, count, delta, status }: { title: string; sub: string; mid: number; low: number | null; high: number | null; confidence: number | null; count: number; delta?: { mid: number; confidence: number } | null; status?: ReactNode }) {
  return (
    <article className="ciw-valcard">
      <header><span className="lc-eyebrow">{title}</span><span className="ciw-valcard__sub">{sub}</span></header>
      <div className="ciw-valcard__mid">
        <MorphValue value={mid} format={money} className="ciw-valcard__figure" />
        {delta ? <span className={cx('ciw-delta', delta.mid > 0 ? 'is-up' : delta.mid < 0 ? 'is-down' : null)}>{fmtPct(delta.mid, 1, true)}</span> : null}
      </div>
      <div className="ciw-valcard__range lc-num">
        {low !== null && high !== null ? <><MorphValue value={low} format={money} /> – <MorphValue value={high} format={money} /></> : '—'}
      </div>
      <div className="ciw-valcard__facts lc-num">
        <span>Confidence <b>{confidence ?? '—'}</b>{delta && delta.confidence !== 0 ? <em className={delta.confidence > 0 ? 'is-up' : 'is-down'}> {delta.confidence > 0 ? '+' : '−'}{Math.abs(delta.confidence)}</em> : null}</span>
        <span>{count} comp{count === 1 ? '' : 's'}</span>
      </div>
      {status ? <div className="ciw-valcard__status">{status}</div> : null}
    </article>
  )
}

function Prov({ label, value, detail }: { label: string; value: string; detail: ReactNode }) {
  return (
    <div className="ciw-prov__row">
      <dt>{label}</dt>
      <dd><b className="lc-num">{value}</b><span>{detail}</span></dd>
    </div>
  )
}
