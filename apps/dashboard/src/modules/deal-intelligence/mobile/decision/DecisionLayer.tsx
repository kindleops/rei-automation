/**
 * DECISION LAYER — what the engine concluded, what supports it, what could
 * break it. Every number is from the canonical projection; nothing here is a
 * binding offer, and nothing here can send one.
 */
import { useMemo, useState } from 'react'
import { Icon } from '../../../../shared/icons'
import type { DealDecision, SpectrumMarker } from '../../../../domain/deal-intelligence/deal-decision-api'
import { ago, money } from '../../../../domain/deal-intelligence/deal-decision-api'
import { cls, DdCard, Meter, ProvenanceChip, Ring, useCountUp } from './dd-primitives'
import { staticStreetViewUrl } from '../../../entity-graph/mobile/EntityGraphPropertyVisual'

type Available = Extract<DealDecision['decision'], { status: 'available' }>

const STAGE_MODE: Record<string, string> = {
  ownership_confirmation: 'Pre-offer underwriting',
  offer_interest: 'Pre-offer underwriting',
  asking_price: 'Qualifying the ask',
  property_condition: 'Qualifying condition',
  offer: 'Negotiating',
  formal_contract: 'Contracting',
  disposition: 'Disposition',
  under_contract: 'Under contract',
  prepared_to_close: 'Closing',
  closed: 'Closed',
}

/* ── hero ──────────────────────────────────────────────────────────────── */

export function DecisionHero({ d }: { d: DealDecision }) {
  const dec = d.decision.status === 'available' ? (d.decision as Available) : null
  const accepted = d.offer?.offers.find((o) => o.acceptedAt && !o.supersededAt) ?? null
  const actual = d.actuals
  const heroValue = actual?.contractPrice ?? accepted?.price ?? d.valuation?.mid ?? d.valuation?.avm ?? null
  const heroLabel = actual ? 'Contract price · actual' : accepted ? 'Accepted price' : d.valuation?.mid ? 'Engine value' : d.valuation?.avm ? 'AVM · not analysed' : 'Value'
  const shown = useCountUp(heroValue, 1400)
  const mode = actual ? 'Closed · actuals' : STAGE_MODE[d.pipeline?.stage ?? ''] ?? (d.pipeline ? 'Underwriting' : 'Property underwriting')
  const conf = dec?.confidence ?? null
  const ask = d.offer?.negotiation.ask ?? null
  const photo = useMemo(() => staticStreetViewUrl(d.subject.address, d.subject.lat, d.subject.lng), [d.subject.address, d.subject.lat, d.subject.lng])
  const [photoOk, setPhotoOk] = useState<boolean | null>(null)
  const specs = [
    d.subject.propertyType,
    d.subject.units && d.subject.units > 1 ? `${d.subject.units} units` : null,
    d.subject.beds ? `${d.subject.beds} bd` : null,
    d.subject.baths ? `${d.subject.baths} ba` : null,
    d.subject.sqft ? `${d.subject.sqft.toLocaleString('en-US')} sf` : null,
    d.subject.yearBuilt ? `${d.subject.yearBuilt}` : null,
  ].filter(Boolean)
  const [street, ...rest] = (d.subject.address ?? '').split(',')

  return (
    <header className={cls('ddx-hero', dec && `tone-${dec.tierTone}`)}>
      <div className={cls('ddx-hero__media', photoOk === true && 'is-ready', photoOk === false && 'is-failed')} aria-hidden="true">
        <div className="ddx-hero__mesh" />
        {photo && photoOk !== false ? (
          <img src={photo} alt="" loading="eager" decoding="async" onLoad={() => setPhotoOk(true)} onError={() => setPhotoOk(false)} />
        ) : null}
        <div className="ddx-hero__scrim" />
        <div className="ddx-hero__grain" />
      </div>
      <div className="ddx-hero__top">
        <span className="ddx-hero__mode"><i />{mode}</span>
        {dec?.tierLabel ? <span className={cls('ddx-hero__tier', `tone-${dec.tierTone}`)}>{dec.tierLabel}</span> : null}
      </div>
      <div className="ddx-hero__title">
        <h2>{street || 'Property'}</h2>
        {rest.length ? <p>{rest.join(',').trim()}</p> : null}
        {specs.length ? <div className="ddx-hero__specs">{specs.map((x) => <span key={x as string}>{x}</span>)}</div> : null}
      </div>
      <div className="ddx-hero__panel">
        <span className="ddx-hero__label">{heroLabel}</span>
        <strong className="ddx-hero__value">{shown !== null ? money(shown, { exact: true }) : '—'}</strong>
        {d.valuation?.low && d.valuation.high && !actual ? (
          <span className="ddx-hero__range"><i />Supported {money(d.valuation.low)} – {money(d.valuation.high)}</span>
        ) : null}
        {actual ? (
          <div className="ddx-hero__tiles">
            <div className="ddx-tile"><span>Assignment fee</span><strong>{money(actual.assignmentFee) ?? '—'}</strong><em>actual</em></div>
            <div className="ddx-tile"><span>Buyer price</span><strong>{money(actual.buyerPrice) ?? '—'}</strong><em>actual</em></div>
          </div>
        ) : (
          <div className="ddx-hero__tiles">
            <div className="ddx-tile is-offer">
              <span>Supported offer</span>
              <strong>{d.offer?.recommended ? `${money(d.offer.floor)}–${money(d.offer.recommended)}` : d.offer ? '$0' : '—'}</strong>
              <em>engine · not an offer</em>
            </div>
            <div className="ddx-tile is-ask">
              <span>Seller ask</span>
              <strong>{money(ask) ?? '—'}</strong>
              <em>{ask ? 'seller said' : 'not stated'}</em>
            </div>
            <div className="ddx-tile">
              <span>Equity</span>
              <strong>{d.economics.equityPercent !== null ? `${Math.round(d.economics.equityPercent)}%` : '—'}</strong>
              <em>{money(d.economics.equityEstimate) ? `${money(d.economics.equityEstimate)} est.` : 'record'}</em>
            </div>
            <div className="ddx-tile is-conf">
              <Ring value={conf} size={46} stroke={4} />
              <div><span>Confidence</span><em>{dec?.valuationConfidence !== null && dec?.valuationConfidence !== undefined ? `valuation ${Math.round(dec.valuationConfidence)}` : 'engine'}</em></div>
            </div>
          </div>
        )}
      </div>
    </header>
  )
}

/* ── signature valuation spectrum ──────────────────────────────────────── */

type Placed = SpectrumMarker & { lane: number; text: string }

/**
 * Labels go into four lanes (up, down, up-2, down-2). Each marker takes the
 * first lane whose previous label is far enough left, so nothing overlaps at
 * 375px. Floor + recommended collapse into one "Offer" range label — they are
 * one recommendation, and two tags a few pixels apart only read as noise.
 */
function layoutMarkers(markers: SpectrumMarker[]): Placed[] {
  const floor = markers.find((m) => m.key === 'floor')
  const rec = markers.find((m) => m.key === 'recommended')
  const list: Array<SpectrumMarker & { text: string }> = markers
    .filter((m) => m.key !== 'floor')
    .map((m) => ({ ...m, text: m.key === 'recommended' && floor ? `${money(floor.value)}–${money(m.value)}` : money(m.value) ?? '' , label: m.key === 'recommended' && floor ? 'Offer range' : m.label }))
  if (!rec && floor) list.push({ ...floor, text: money(floor.value) ?? '' })
  const GAP = 0.3
  const lastAt = [-1, -1, -1, -1]
  return list
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    .map((m) => {
      const at = m.at ?? 0
      let lane = lastAt.findIndex((x) => at - x >= GAP)
      if (lane < 0) lane = lastAt.indexOf(Math.min(...lastAt))
      lastAt[lane] = at
      return { ...m, lane }
    })
}

export function ValuationSpectrum({ d }: { d: DealDecision }) {
  const s = d.valuation?.spectrum
  const [focus, setFocus] = useState<string | null>(null)
  if (!s) return null
  const placed = layoutMarkers(s.markers)
  const floor = s.markers.find((m) => m.key === 'floor')
  const rec = s.markers.find((m) => m.key === 'recommended')
  const active = placed.find((m) => m.key === focus) ?? null
  const pct = (v: number | null) => `${Math.round((v ?? 0) * 1000) / 10}%`
  const lanesUsed = Math.max(...placed.map((m) => m.lane), 0)

  return (
    <section className="ddx-spectrum" aria-label="Valuation spectrum">
      <div className="ddx-spectrum__head">
        <span>Valuation spectrum</span>
        {d.valuation?.confidence !== null && d.valuation?.confidence !== undefined ? <em>valuation confidence {Math.round(d.valuation.confidence)}</em> : null}
      </div>
      <div className={cls('ddx-spectrum__stage', lanesUsed >= 2 && 'has-outer', !placed.some((m) => m.lane % 2 === 1) && 'no-down')}>
        <div className="ddx-spectrum__rail">
          {s.comps ? <span className="ddx-spectrum__comps" style={{ left: pct(s.comps.from), width: pct((s.comps.to ?? 0) - (s.comps.from ?? 0)) }} /> : null}
          {s.band ? (
            <span className="ddx-spectrum__band" style={{ left: pct(s.band.from), width: pct((s.band.to ?? 0) - (s.band.from ?? 0)) }}>
              <span className="ddx-spectrum__sheen" />
            </span>
          ) : null}
          {floor && rec ? <span className="ddx-spectrum__offer" style={{ left: pct(floor.at), width: `max(6px, ${pct((rec.at ?? 0) - (floor.at ?? 0))})` }} /> : null}
          {s.band?.at !== null && s.band?.at !== undefined ? <span className="ddx-spectrum__mid" style={{ left: pct(s.band.at) }} /> : null}
        </div>
        {placed.map((m, i) => (
          <SpectrumPin key={m.key} m={m} delay={i} active={focus === m.key} onTap={() => setFocus((f) => (f === m.key ? null : m.key))} />
        ))}
      </div>
      <div className="ddx-spectrum__scale">
        <span>{money(s.min)}</span>
        {s.band ? <span className="is-band">{money(s.band.low)} · <b>{money(s.band.mid)}</b> · {money(s.band.high)}</span> : null}
        <span>{money(s.max)}</span>
      </div>
      <div className="ddx-spectrum__legend">
        {s.band ? <span><i className="k-band" />Engine range</span> : null}
        {s.comps ? <span><i className="k-comps" />Comp range</span> : null}
        {floor && rec ? <span><i className="k-offer" />Offer range</span> : null}
      </div>
      {active ? (
        <p className="ddx-spectrum__focus">
          <ProvenanceChip p={active.source} /> <b>{active.label}</b> {active.key === 'recommended' && floor ? `${money(floor.value, { exact: true })} – ${money(active.value, { exact: true })}` : money(active.value, { exact: true })}
          {active.clamped ? <em> — off this scale; shown at the edge</em> : null}
        </p>
      ) : <p className="ddx-spectrum__hint">Tap a marker for its source.</p>}
    </section>
  )
}

function SpectrumPin({ m, delay, active, onTap }: { m: Placed; delay: number; active: boolean; onTap: () => void }) {
  const left = `${Math.round((m.at ?? 0) * 1000) / 10}%`
  const side = m.lane % 2 === 0 ? 'up' : 'down'
  const outer = m.lane >= 2
  return (
    <button
      type="button"
      className={cls('ddx-pin', `is-${m.key}`, `side-${side}`, outer && 'is-outer', m.clamped && 'is-clamped', active && 'is-active', (m.at ?? 0) < 0.14 && 'edge-l', (m.at ?? 0) > 0.86 && 'edge-r')}
      style={{ left, animationDelay: `${120 + delay * 70}ms` }}
      onClick={onTap}
      aria-label={`${m.label} ${m.text}`}
    >
      <span className="ddx-pin__stem" />
      <span className="ddx-pin__dot" />
      <span className="ddx-pin__tag">
        <b>{m.label}</b>
        <em>{m.clamped ? `${m.at === 0 ? '◂ ' : ''}${m.text}${m.at === 1 ? ' ▸' : ''}` : m.text}</em>
      </span>
    </button>
  )
}

/* ── decision summary + gates ──────────────────────────────────────────── */

export function DecisionSummary({ d, onRunEngine, engineBusy }: { d: DealDecision; onRunEngine?: (() => void) | null; engineBusy?: boolean }) {
  if (d.decision.status !== 'available') {
    return (
      <section className="ddx-verdict is-empty">
        <h3>Not analysed</h3>
        <p>The decision engine has never priced this property, so there is no valuation, offer range or strategy. {d.valuation?.avm ? `The only value on record is the ${money(d.valuation.avm)} AVM.` : ''}</p>
        {onRunEngine ? (
          <button type="button" className="ddx-btn is-primary" onClick={onRunEngine} disabled={engineBusy}>
            <Icon name="zap" /> {engineBusy ? 'Analysing…' : 'Run decision engine'}
          </button>
        ) : null}
      </section>
    )
  }
  const dec = d.decision as Available
  const auth = dec.authorization
  return (
    <section className={cls('ddx-verdict', `tone-${dec.tierTone}`)}>
      <div className="ddx-verdict__head">
        <span className="ddx-tier">{dec.tierLabel}</span>
        {dec.bestStrategyLabel ? <span className="ddx-verdict__strategy">Best: {dec.bestStrategyLabel}</span> : null}
        <span className="ddx-verdict__age">{ago(dec.computedAt)}</span>
      </div>
      <ul className="ddx-verdict__lines">
        {dec.summary.map((l) => <li key={l}>{l}</li>)}
      </ul>
      {auth && auth.presentable !== null ? (
        <div className={cls('ddx-auth', auth.presentable ? 'is-yes' : 'is-no')}>
          <Icon name={auth.presentable ? 'check' : 'shield'} />
          <div>
            <b>{auth.presentable ? 'Automation may present this range' : 'Withheld from the seller'}</b>
            {auth.withheldText ? <span>{auth.withheldText}</span> : null}
            {[auth.zone && `Zone: ${auth.zone}`, auth.economicFit && `Fit: ${auth.economicFit}`, auth.nextMove && `Next: ${auth.nextMove}`].filter(Boolean).length ? (
              <em>{[auth.zone && `Zone: ${auth.zone}`, auth.economicFit && `Fit: ${auth.economicFit}`, auth.nextMove && `Next: ${auth.nextMove}`].filter(Boolean).join(' · ')}</em>
            ) : null}
          </div>
        </div>
      ) : null}
      {dec.gates.length ? (
        <div className="ddx-gates" aria-label="Hard gates for automated offers">
          {dec.gates.map((g) => (
            <span key={g.key} className={cls('ddx-gate', g.pass ? 'is-pass' : 'is-fail')}>
              <Icon name={g.pass ? 'check' : 'x'} />{g.label}
            </span>
          ))}
        </div>
      ) : null}
      {dec.why ? <p className="ddx-verdict__why"><b>{dec.conversationAngle ?? 'Angle'}:</b> {dec.why}</p> : null}
    </section>
  )
}

/* ── risks ─────────────────────────────────────────────────────────────── */

export function RiskList({ d }: { d: DealDecision }) {
  const [all, setAll] = useState(false)
  const risks = d.risks
  if (!risks.length) {
    return (
      <DdCard id="risks" title="Risks" icon="shield" meta="none on record" defaultOpen={false}>
        <p className="ddx-empty">No recorded liens, foreclosure, debt gap, data conflict or thin comp set was found. Absence of evidence — not a guarantee.</p>
      </DdCard>
    )
  }
  const worst = risks[0].severity
  const shown = all ? risks : risks.slice(0, 4)
  return (
    <DdCard id="risks" title="Risks" icon="alert" tone={worst === 'critical' ? 'bad' : worst === 'high' ? 'warn' : undefined}
      meta={<>{risks.filter((r) => r.severity === 'critical' || r.severity === 'high').length ? <b>{risks.filter((r) => r.severity === 'critical' || r.severity === 'high').length} serious · </b> : null}{risks.length} total</>}>
      <ul className="ddx-risks">
        {shown.map((r) => (
          <li key={r.key} className={cls('ddx-risk', `sev-${r.severity}`)}>
            <span className="ddx-risk__sev">{r.severity}</span>
            <div>
              <strong>{r.title}</strong>
              {r.detail ? <p>{r.detail}</p> : null}
              <em>{r.source}</em>
            </div>
          </li>
        ))}
      </ul>
      {risks.length > 4 ? <button type="button" className="ddx-more" onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${risks.length}`}</button> : null}
    </DdCard>
  )
}

/* ── offer intelligence ────────────────────────────────────────────────── */

export function OfferIntelligence({ d }: { d: DealDecision }) {
  const o = d.offer
  if (!o) return null
  const neg = o.negotiation
  const top = Math.max(o.effectiveCeiling ?? 0, o.recommended ?? 0, 1)
  const w = (v: number | null) => `${Math.max(2, Math.min(100, ((v ?? 0) / top) * 100))}%`
  const binding = o.offers.filter((x) => !x.supersededAt)
  return (
    <DdCard id="offer" title="Offer intelligence" icon="target" meta={o.binding ? 'binding offer out' : 'recommendation only'}>
      <div className="ddx-ladder">
        <div className="ddx-ladder__row is-ceiling"><span>Buyer ceiling</span><i style={{ width: w(o.effectiveCeiling) }} /><b>{money(o.effectiveCeiling)}</b></div>
        <div className="ddx-ladder__row is-rec"><span>Recommended</span><i style={{ width: w(o.recommended) }} /><b>{money(o.recommended)}</b></div>
        <div className="ddx-ladder__row is-floor"><span>Floor</span><i style={{ width: w(o.floor) }} /><b>{money(o.floor)}</b></div>
      </div>
      <dl className="ddx-kv">
        <div><dt>Target margin</dt><dd>{money(o.targetMargin)}{o.marginPct ? ` · ${Math.round(o.marginPct * 100)}%` : ''}</dd></div>
        <div><dt>Protected margin</dt><dd>{money(o.protectedMargin)}{o.protectedMarginEnforced ? ' · enforced' : ''}</dd></div>
        <div><dt>Expected fee</dt><dd>{money(o.expectedFee)} <small>estimate</small></dd></div>
        <div><dt>Ceiling basis</dt><dd>{o.buyerCeilingAuthoritative ? 'Observed buyer behavior' : 'Modelled from value'}</dd></div>
        {neg.ask ? <div><dt>Seller ask</dt><dd>{money(neg.ask)}{neg.initialAsk && neg.initialAsk !== neg.ask ? <small> from {money(neg.initialAsk)}</small> : null}</dd></div> : null}
        {neg.ask && o.recommended ? <div><dt>Gap to ask</dt><dd>{money(neg.ask - o.recommended)}</dd></div> : null}
        {neg.counter ? <div><dt>Seller counter</dt><dd>{money(neg.counter)}</dd></div> : null}
      </dl>
      <div className="ddx-lineage">
        <span className="ddx-lineage__pill"><Icon name="link" /> Snapshot {o.lineage.snapshotId ? o.lineage.snapshotId.slice(0, 8) : 'not recorded'}</span>
        {o.lineage.negotiationSnapshotId ? (
          <span className={cls('ddx-lineage__pill', o.lineage.negotiationUsesLatest === false && 'is-warn')}>
            Negotiation {o.lineage.negotiationUsesLatest ? 'uses this analysis' : `uses ${o.lineage.negotiationSnapshotId.slice(0, 8)}`}
          </span>
        ) : null}
      </div>
      {binding.length ? (
        <ul className="ddx-offers">
          {binding.map((x) => (
            <li key={x.id}>
              <b>{money(x.price)}</b>
              <span>{x.direction === 'inbound' ? 'Seller' : 'Us'} · {x.status}</span>
              <em>{x.snapshotId ? `snapshot ${x.snapshotId.slice(0, 8)}` : 'no engine lineage'}</em>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ddx-note">No binding offer is out. The engine range is a recommendation; offers are made by the seller workflow, never from this screen.</p>
      )}
      {o.quotes?.status === 'captured' && o.quotes.anchors.length ? (
        // Negotiation anchors quoted to the seller — kept apart from formal offers.
        <ul className="ddx-offers ddx-quotes" aria-label="Anchors quoted">
          {o.quotes.anchors.map((q) => (
            <li key={`${q.quotedAt}:${q.templateId ?? ''}`}>
              <b>{money(q.amount)}</b>
              <span>{q.label}</span>
              <em>{q.maxOffer ? `max ${money(q.maxOffer)}` : 'max not recorded'}{q.compIds.length ? ` · ${q.compIds.length} comp${q.compIds.length === 1 ? '' : 's'}` : ''}</em>
            </li>
          ))}
        </ul>
      ) : null}
    </DdCard>
  )
}

/* ── strategies ────────────────────────────────────────────────────────── */

export function StrategyStack({ d }: { d: DealDecision }) {
  const [open, setOpen] = useState<string | null>(null)
  if (!d.strategies.length) return null
  return (
    <DdCard id="strategies" title="Strategies" icon="layers" meta={`${d.strategies.length} engine-scored`} defaultOpen={false}>
      <ul className="ddx-strats">
        {d.strategies.map((s) => (
          <li key={s.key} className={cls('ddx-strat', s.isBest && 'is-best')}>
            <button type="button" onClick={() => setOpen((k) => (k === s.key ? null : s.key))} aria-expanded={open === s.key}>
              <span className="ddx-strat__name">{s.label}{s.isBest ? <em>engine best</em> : null}</span>
              <Meter value={s.score} />
              <b>{s.score ?? '—'}</b>
            </button>
            {open === s.key ? (
              <div className="ddx-strat__why">
                {s.detail ? <p>{s.detail}</p> : null}
                {s.points.length ? <ul>{s.points.map((p) => <li key={p.reason}><span>{p.reason}</span><b>+{p.points}</b></li>)}</ul> : <p>No factor breakdown recorded.</p>}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </DdCard>
  )
}
