/**
 * PIPELINE DESK · OFFERS — the engine's offer picture, by who resolves it.
 *
 *   Autonomous        the engine may present the number itself
 *   System resolving  not spendable yet; the engine resolves it without you
 *   Exception         only a human resolves it
 *   Not being worked  no live conversation; nothing re-prices it
 *
 * The state is the server's (deriveOfferAutonomy over the engine's own
 * authority and re-evaluation rules). Figures are never collapsed: the engine
 * offer is modeled, the ask is stated, the value is estimated, a sent offer is
 * actual. Nothing here can authorize, send or accept an offer — Deal
 * Intelligence (the existing hand-off) is where the evidence and re-run live.
 */
import { useState } from 'react'
import { Icon } from '../../../shared/icons'
import { LCButton, LCEmpty, LCError, LCSkeleton, LCStatus, cx, type LCRowActivationEvent } from '../../../shared/lc'
import { compactMoney } from '../../../domain/pipeline/pipeline-command-api'
import type { AutonomyState, DeskCard, DeskOfferRow, DeskOffers } from './pipeline-desk-api'
import { AUTONOMY_META, OWNER_META, REPRICES_TEXT, autonomyCause, fmtInt, groupOffers, moneyRange, relShort, stageTag } from './pipeline-desk-model'

const LANES: AutonomyState[] = ['autonomous', 'resolving', 'exception']
const STRATEGY: Record<string, string> = {
  CASH_ASSIGNMENT: 'Cash assignment', SELLER_FINANCE: 'Seller finance', SUBJECT_TO: 'Subject-to',
  LEASE_OPTION: 'Lease option', NOVATION: 'Novation', NURTURE: 'Nurture',
}

export function DeskOffersView({ offers, loading, error, onRetry, onOpen, onDealIntelligence, now }: {
  offers: DeskOffers | null
  loading: boolean
  error: string | null
  onRetry: () => void
  onOpen: (card: DeskCard, e?: LCRowActivationEvent) => void
  onDealIntelligence: (card: DeskCard) => void
  now: number
}) {
  const [showParked, setShowParked] = useState(false)
  if (!offers) {
    if (error) return <LCError what="The offer picture didn’t load" onRetry={onRetry} />
    return (
      <section className="pd2-offers" aria-busy="true">
        <div className="pd2-offlanes">{LANES.map((k) => <div key={k} className="pd2-offlane"><LCSkeleton shape="block" height={260} /></div>)}</div>
      </section>
    )
  }
  const grouped = groupOffers(offers.rows)
  const t = offers.totals
  return (
    <section className={cx('pd2-offers', loading && 'is-refreshing')} aria-label="Offers by who resolves them">
      <header className="pd2-offers__head">
        <div className="pd2-offers__sum">
          <b className="lc-num">{fmtInt(t.priced)}</b><span>engine-priced deals</span>
          <i />
          <b className="lc-num">{fmtInt(t.authorized)}</b><span>spendable by the engine’s rule</span>
          <i />
          <b className="lc-num">{fmtInt(t.sent)}</b><span>offers sent{t.offerRecords ? ` · ${fmtInt(t.offerRecords)} on record` : ''}</span>
          {t.countered ? <><i /><b className="lc-num">{fmtInt(t.countered)}</b><span>seller counter</span></> : null}
        </div>
        <p className="pd2-offers__rule">
          <Icon name="shield" size={13} />
          The engine may spend a number only from an offer tier (hard or range offer) backed by a contamination defense. Every other priced deal is resolved by the autopilot — still qualifying, or negotiating a large gap without a number — or handed to you.
        </p>
      </header>

      <div className="pd2-offlanes">
        {LANES.map((k) => (
          <div key={k} className={cx('pd2-offlane', `is-${k}`)}>
            <header className="pd2-offlane__head">
              <LCStatus label={AUTONOMY_META[k].label} tone={AUTONOMY_META[k].tone} />
              <b className="lc-num">{fmtInt(grouped[k].length)}</b>
              <p>{AUTONOMY_META[k].definition}</p>
            </header>
            <div className="pd2-offlane__list">
              {grouped[k].length ? grouped[k].map((r) => <OfferCard key={r.card.id} row={r} now={now} onOpen={onOpen} onDealIntelligence={onDealIntelligence} />) : (
                <LCEmpty compact title={k === 'autonomous' ? 'No offer the engine may present' : k === 'resolving' ? 'Nothing for the engine to resolve' : 'No offer exceptions'} tone={k === 'exception' ? 'calm' : 'neutral'} />
              )}
            </div>
          </div>
        ))}
      </div>

      {grouped.parked.length ? (
        <section className="pd2-parked">
          <button type="button" className="pd2-parked__toggle" onClick={() => setShowParked((v) => !v)} aria-expanded={showParked}>
            <LCStatus label={AUTONOMY_META.parked.label} tone="neutral" quiet />
            <b className="lc-num">{fmtInt(grouped.parked.length)}</b>
            <span>{AUTONOMY_META.parked.definition}</span>
            <Icon name={showParked ? 'chevron-up' : 'chevron-down'} size={13} />
          </button>
          {showParked ? (
            <div className="pd2-parked__list">
              {grouped.parked.map((r) => <OfferCard key={r.card.id} row={r} now={now} onOpen={onOpen} onDealIntelligence={onDealIntelligence} compact />)}
            </div>
          ) : null}
        </section>
      ) : null}

      <aside className="pd2-cover" aria-label="Comp coverage by market">
        <header><span className="lc-eyebrow">Comp coverage by market</span><small>Median qualified comps per priced deal · under {offers.thresholds.compCoverageMin} is thin</small></header>
        <ul>
          {offers.markets.map((m) => (
            <li key={m.market} className={cx(m.thinCoverage && 'is-thin')}>
              <span><b>{m.market}</b><small>{fmtInt(m.deals)} deal{m.deals === 1 ? '' : 's'}{m.authorized ? ` · ${fmtInt(m.authorized)} spendable` : ''}</small></span>
              <span className="lc-num"><b>{m.medianComps ?? '—'}</b><small>{m.thinCoverage ? 'thin' : 'comps'}</small></span>
            </li>
          ))}
        </ul>
      </aside>
    </section>
  )
}

function OfferCard({ row, now, onOpen, onDealIntelligence, compact }: { row: DeskOfferRow; now: number; onOpen: (card: DeskCard, e?: LCRowActivationEvent) => void; onDealIntelligence: (card: DeskCard) => void; compact?: boolean }) {
  const { card, engine, offer, autonomy, readiness } = row
  if (!autonomy) return null
  const implausible = autonomy.implausible
  const engineFig = moneyRange(engine?.floor ?? null, engine?.recommended ?? null)
  const value = engine?.mid && !row.plausibility.engineValueOff ? engine.mid : card.money.value
  const evidence = [
    engine?.tierLabel,
    engine?.compCount !== null && engine?.compCount !== undefined ? `${engine.compCount} comp${engine.compCount === 1 ? '' : 's'}` : null,
    engine?.confidence !== null && engine?.confidence !== undefined ? `confidence ${Math.round(engine.confidence)}` : null,
    engine?.valuationConfidence !== null && engine?.valuationConfidence !== undefined ? `valuation ${Math.round(engine.valuationConfidence)}` : null,
    engine?.strategy ? STRATEGY[engine.strategy] ?? engine.strategy.toLowerCase().replace(/_/g, ' ') : null,
  ].filter(Boolean)
  return (
    <article className={cx('pd2-offer', `is-${autonomy.state}`, compact && 'is-compact')}>
      <header className="pd2-offer__head">
        <span className="pd2-offer__stage">{stageTag(card.stageIndex, card.stage)}</span>
        <span className="pd2-offer__cause">{autonomyCause(row)}</span>
      </header>
      <button type="button" className="pd2-offer__title" onClick={(e) => onOpen(card, e)} data-pd2-deal={card.id}>
        <b>{card.address || card.seller || 'Unaddressed deal'}</b>
        <small>{[card.address ? card.seller : null, card.market].filter(Boolean).join(' · ') || OWNER_META[card.owner].label}</small>
      </button>
      {!compact ? (
        <dl className="pd2-offer__figs">
          <div className={cx(implausible && 'is-flag')}><dt>Engine offer<em>modeled</em></dt><dd className="lc-num">{implausible ? 'Out of range' : engineFig ?? '—'}</dd></div>
          <div className={cx(row.askImplausible && 'is-flag')}><dt>Seller ask<em>stated</em></dt><dd className="lc-num">{row.askImplausible ? 'Mis-captured' : compactMoney(card.money.asking) ?? '—'}</dd></div>
          <div><dt>Value<em>estimated</em></dt><dd className="lc-num">{compactMoney(value) ?? '—'}</dd></div>
          <div><dt>Offer sent<em>actual</em></dt><dd className="lc-num">{offer?.price && offer.status && /sent|presented|pending|countered|accepted/i.test(offer.status) ? compactMoney(offer.price) : 'None'}</dd></div>
        </dl>
      ) : null}
      <p className="pd2-offer__why">{autonomy.why}</p>
      <p className="pd2-offer__meta">
        <span><Icon name="refresh-cw" size={11} />{REPRICES_TEXT[autonomy.reprices]}</span>
        {engine?.computedAt ? <span className={cx(autonomy.stale && 'is-stale')}><Icon name="clock" size={11} />priced {relShort(engine.computedAt, now)}{autonomy.stale ? ' · stale' : ''}</span> : null}
      </p>
      {!compact && evidence.length ? <p className="pd2-offer__evidence">{evidence.join(' · ')}</p> : null}
      {!compact && readiness.thinCoverage ? (
        <p className="pd2-offer__notes"><span>Thin comp coverage — fewer than 4 qualified comps</span></p>
      ) : null}
      {!compact ? (
        <footer className="pd2-offer__foot">
          <LCButton variant="quiet" size="sm" onClick={(e) => onOpen(card, e)}>Open deal</LCButton>
          <LCButton variant={autonomy.state === 'exception' ? 'secondary' : 'ghost'} size="sm" trailingIcon="arrow-up-right" onClick={() => onDealIntelligence(card)} disabled={!card.threadKey && !card.propertyId}>Deal Intelligence</LCButton>
        </footer>
      ) : null}
    </article>
  )
}
