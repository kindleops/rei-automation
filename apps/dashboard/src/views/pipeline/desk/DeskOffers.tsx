/**
 * PIPELINE DESK · OFFERS — the engine's offer picture as a dense, workable
 * ledger, by who resolves it.
 *
 *   Autonomous        the engine may present the number itself
 *   System resolving  not spendable yet; the engine resolves it without you
 *   Exception         only a human resolves it
 *   Not being worked  no live conversation; nothing re-prices it (collapsed)
 *
 * One row per deal: engine offer (modeled) against value (estimated) and ask
 * (stated), the gap, the offer on record (actual), the engine's tier /
 * confidence / comps and age, the seller's last turn, and the next step.
 * Figures are never collapsed into one number and absent is "—".
 *
 * Actions are navigation and the existing flows only: open the deal, open the
 * conversation / Deal Intelligence BESIDE Pipeline, expand the full breakdown
 * and offer history, copy the offer summary, and the shared bulk Archive (its
 * own confirm → progress → Undo). Nothing here authorizes, sends or changes
 * an offer — that lives in Deal Intelligence.
 *
 * The state is the server's (deriveOfferAutonomy over the engine's own
 * authority and re-evaluation rules).
 */
import { Fragment, useCallback, useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { Icon } from '../../../shared/icons'
import { LCBulkBar, LCContextMenu, LCEmpty, LCError, LCIconButton, LCMenu, LCSegmented, LCSkeleton, LCStatus, cx, lcMenu, lcToast, useLcSelection, type LCMenuEntry, type LCRowActivationEvent } from '../../../shared/lc'
import { compactMoney } from '../../../domain/pipeline/pipeline-command-api'
import { useBulkArchive } from '../../../lib/data/useBulkArchive'
import type { BulkRunReport } from '../../../lib/data/bulkArchiveData'
import type { AutonomyState, DeskCard, DeskOfferRow, DeskOffers } from './pipeline-desk-api'
import { AUTONOMY_META, REPRICES_TEXT, autonomyCause, fmtInt, groupOffers, intentWords, moneyRange, relShort, stageTag, stampCT } from './pipeline-desk-model'
import { useDealStory } from './use-pipeline-desk'
import { gapToAsk, offerShareOfValue, offerSummary, offerValue, signedMoney } from './desk-offer-figures'

const LANES: AutonomyState[] = ['autonomous', 'resolving', 'exception']
const STRATEGY: Record<string, string> = {
  CASH_ASSIGNMENT: 'Cash assignment', SELLER_FINANCE: 'Seller finance', SUBJECT_TO: 'Subject-to',
  LEASE_OPTION: 'Lease option', NOVATION: 'Novation', NURTURE: 'Nurture',
}
const DEAL_NOUN = { one: 'deal', many: 'deals' }
const DEAL_ARCHIVE_EFFECTS = [
  { kind: 'stops' as const, text: 'They leave the Pipeline views, stage counts and the pipeline metrics.' },
  { kind: 'stops' as const, text: 'Automation on an archived deal is reconciled to cancelled. Won deals are refused.' },
  { kind: 'keeps' as const, text: 'Unarchive restores the status each deal had before.' },
]
const LIVE_OFFER = /sent|presented|pending|countered|accepted/i

type Filter = 'all' | AutonomyState

export type OfferActions = {
  onOpen: (card: DeskCard, e?: LCRowActivationEvent) => void
  onDealIntelligence: (card: DeskCard) => void
  onConversation?: (card: DeskCard) => void
  onMap?: (card: DeskCard) => void
}

/* ── view ──────────────────────────────────────────────────────────────── */

export function DeskOffersView({ offers, loading, error, onRetry, actions, now, onBulkChanged }: {
  offers: DeskOffers | null
  loading: boolean
  error: string | null
  onRetry: () => void
  actions: OfferActions
  now: number
  onBulkChanged?: () => void
}) {
  const [filter, setFilter] = useState<Filter>('all')
  const [showParked, setShowParked] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const grouped = useMemo(() => (offers ? groupOffers(offers.rows) : null), [offers])
  const lanes: AutonomyState[] = useMemo(() => {
    const base = filter === 'all' ? LANES : [filter]
    return filter === 'all' && showParked ? [...base, 'parked'] : base
  }, [filter, showParked])
  const order = useMemo(() => (grouped ? lanes.flatMap((k) => grouped[k].map((r) => r.card.id)) : []), [grouped, lanes])
  const selection = useLcSelection(order)
  const rowById = useMemo(() => new Map((offers?.rows ?? []).map((r) => [r.card.id, r])), [offers])
  const labelOf = useCallback((id: string) => { const c = rowById.get(id)?.card; return c?.address || c?.seller || id }, [rowById])
  const onBulkReport = useCallback((report: BulkRunReport) => { if (report.changedIds.length) onBulkChanged?.() }, [onBulkChanged])
  const bulk = useBulkArchive({ objectType: 'opportunity', noun: DEAL_NOUN, consequences: DEAL_ARCHIVE_EFFECTS, labelOf, onChanged: onBulkReport, source: 'pipeline' })
  const { archive: bulkArchive } = bulk
  const { ids: selectedIds, clear: clearSelection } = selection

  const copy = useCallback((rows: DeskOfferRow[]) => {
    const text = rows.map(offerSummary).join('\n')
    void navigator.clipboard?.writeText(text).then(
      () => lcToast({ title: rows.length === 1 ? 'Offer copied' : `${fmtInt(rows.length)} offers copied`, severity: 'success' }),
      () => lcToast({ title: 'Couldn’t copy', detail: 'The browser refused clipboard access.', severity: 'warning' }),
    )
  }, [])
  const archiveSelected = useCallback(async () => {
    const report = await bulkArchive(selectedIds)
    if (report) clearSelection()
  }, [bulkArchive, clearSelection, selectedIds])

  if (!offers || !grouped) {
    if (error) return <LCError what="The offer picture didn’t load" onRetry={onRetry} />
    return (
      <section className="pd2-offers" aria-busy="true">
        <div className="pd2-ledger"><LCSkeleton shape="rows" count={8} /></div>
      </section>
    )
  }
  const t = offers.totals
  const filters = [
    { value: 'all' as const, label: `All · ${fmtInt(LANES.reduce((s, k) => s + grouped[k].length, 0))}` },
    ...LANES.map((k) => ({ value: k, label: `${AUTONOMY_META[k].label} · ${fmtInt(grouped[k].length)}` })),
  ]
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => { selection.onKeyDown(e) }

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

      <div className="pd2-ledger" onKeyDown={onKeyDown}>
        <div className="pd2-ledger__bar">
          <LCSegmented options={filters} value={filter} onChange={setFilter} label="Offer lane" size="sm" />
          {filter === 'all' && grouped.parked.length ? (
            <button type="button" className="pd2-ledger__parked" onClick={() => setShowParked((v) => !v)} aria-pressed={showParked}>
              <Icon name={showParked ? 'eye' : 'moon'} size={12} />{showParked ? 'Hide' : 'Show'} not being worked · {fmtInt(grouped.parked.length)}
            </button>
          ) : null}
        </div>
        <div className="pd2-ledger__head" aria-hidden="true">
          <span /><span>Deal</span><span>Engine offer</span><span>Value · ask</span><span>Gap to ask</span><span>On record</span><span>Engine</span><span>Seller</span><span>Next</span><span />
        </div>
        <div className="pd2-ledger__body" role="list" aria-label="Offers">
          {lanes.map((k) => (
            <section key={k} className={cx('pd2-ledger__lane', `is-${k}`)} aria-label={AUTONOMY_META[k].label}>
              <header className="pd2-ledger__lanehead" title={AUTONOMY_META[k].definition}>
                <LCStatus label={AUTONOMY_META[k].label} tone={AUTONOMY_META[k].tone} quiet={k === 'parked'} />
                <b className="lc-num">{fmtInt(grouped[k].length)}</b>
                <span>{AUTONOMY_META[k].definition}</span>
              </header>
              {grouped[k].length ? grouped[k].map((r) => (
                <OfferRow
                  key={r.card.id}
                  row={r}
                  now={now}
                  actions={actions}
                  selected={selection.isSelected(r.card.id)}
                  selecting={selection.active}
                  onSelect={(e, onCheckbox) => selection.onRowClick(r.card.id, e, onCheckbox)}
                  expanded={expanded === r.card.id}
                  onExpand={() => setExpanded((cur) => (cur === r.card.id ? null : r.card.id))}
                  onCopy={() => copy([r])}
                />
              )) : (
                <LCEmpty compact title={k === 'autonomous' ? 'No offer the engine may present' : k === 'resolving' ? 'Nothing for the engine to resolve' : k === 'exception' ? 'No offer exceptions' : 'Nothing parked'} tone={k === 'exception' ? 'calm' : 'neutral'} />
              )}
            </section>
          ))}
        </div>
      </div>

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

      <LCBulkBar
        className="pd2-bulkbar"
        count={selection.count}
        inView={order.length}
        all={selection.all}
        noun={DEAL_NOUN}
        onSelectAll={selection.selectAll}
        onClear={selection.clear}
        actions={[
          { id: 'copy', label: 'Copy offers', icon: 'file-text', onRun: () => copy(selectedIds.map((id) => rowById.get(id)).filter((r): r is DeskOfferRow => Boolean(r))) },
          { id: 'archive', label: 'Archive', icon: 'archive', onRun: () => { void archiveSelected() }, disabled: bulk.busy },
        ]}
        progress={bulk.progress}
        outcome={bulk.outcome}
        onDismissOutcome={bulk.dismissOutcome}
      />
    </section>
  )
}

function OfferRow({ row, now, actions, selected, selecting, onSelect, expanded, onExpand, onCopy }: {
  row: DeskOfferRow
  now: number
  actions: OfferActions
  selected: boolean
  selecting: boolean
  onSelect: (e: MouseEvent | null, onCheckbox?: boolean) => boolean
  expanded: boolean
  onExpand: () => void
  onCopy: () => void
}) {
  const { card, engine, offer, autonomy } = row
  if (!autonomy) return null
  const implausible = autonomy.implausible
  const engineFig = implausible ? null : moneyRange(engine?.floor ?? null, engine?.recommended ?? null)
  const share = offerShareOfValue(row)
  const gap = gapToAsk(row)
  const live = offer?.price && offer.status ? offer : null
  const next = card.queue?.next
  const menu: LCMenuEntry[] = lcMenu(
    [
      { label: 'Open deal', icon: 'list', onSelect: () => actions.onOpen(card) },
      { label: 'Open conversation beside', icon: 'message', disabled: !card.threadKey || !actions.onConversation, reason: 'No conversation on this deal', onSelect: () => actions.onConversation?.(card) },
      { label: 'Open Deal Intelligence beside', icon: 'brain', disabled: !card.threadKey && !card.propertyId, reason: 'No property or thread to open', onSelect: () => actions.onDealIntelligence(card) },
      ...(actions.onMap && card.propertyId ? [{ label: 'Show on Map', icon: 'map' as const, onSelect: () => actions.onMap?.(card) }] : []),
    ],
    [
      { label: expanded ? 'Hide breakdown & history' : 'Breakdown & offer history', icon: 'clock', onSelect: onExpand },
      { label: 'Copy offer summary', icon: 'file-text', onSelect: onCopy },
    ],
  )
  const activate = (e: MouseEvent) => {
    if (onSelect(e)) return
    actions.onOpen(card, e)
  }
  return (
    <Fragment>
      <LCContextMenu items={menu} label="Offer actions" title={card.address || card.seller || 'Deal'}>
        <div
          role="listitem"
          className={cx('pd2-orow', `is-${autonomy.state}`, selected && 'is-selected', expanded && 'is-expanded')}
          data-pd2-deal={card.id}
        >
          <span className="pd2-orow__check">
            <button type="button" className={cx('lc-check', selected && 'is-on', !selecting && 'is-quiet')} role="checkbox" aria-checked={selected} aria-label={`Select ${card.address || card.seller || 'deal'}`} onClick={(e) => { e.stopPropagation(); onSelect(e, true) }} />
          </span>
          <button type="button" className="pd2-orow__deal" onClick={activate} title={autonomy.why}>
            <b>{card.address || card.seller || 'Unaddressed deal'}</b>
            <small><em>{stageTag(card.stageIndex, card.stage)}</em>{[card.address ? card.seller : null, card.market].filter(Boolean).join(' · ') || '—'}</small>
          </button>
          <span className={cx('pd2-orow__fig', implausible && 'is-flag')}>
            <b className="lc-num">{implausible ? 'Out of range' : engineFig ?? '—'}</b>
            <small>{share !== null ? `${share}% of value · modeled` : 'modeled'}</small>
          </span>
          <span className="pd2-orow__fig">
            <b className="lc-num">{compactMoney(offerValue(row)) ?? '—'}</b>
            <small className={cx(row.askImplausible && 'is-flag')}>ask {row.askImplausible ? 'mis-captured' : compactMoney(card.money.asking) ?? '—'}</small>
          </span>
          <span className="pd2-orow__fig">
            <b className={cx('lc-num', gap !== null && gap > 0 && 'is-gap')}>{signedMoney(gap) ?? '—'}</b>
            <small>{gap === null ? 'needs offer + ask' : gap > 0 ? 'ask above offer' : 'ask at or under offer'}</small>
          </span>
          <span className="pd2-orow__fig">
            <b className="lc-num">{live ? compactMoney(live.price) ?? '—' : 'Not sent'}</b>
            <small>{live ? `${(live.status || '').toLowerCase()}${LIVE_OFFER.test(live.status || '') && live.sentAt ? ` · ${relShort(live.sentAt, now)}` : ''}` : row.offersCount ? `${fmtInt(row.offersCount)} on record` : 'no offer record'}</small>
          </span>
          <span className="pd2-orow__eng">
            <b>{engine?.tierLabel ?? autonomyCause(row) ?? '—'}</b>
            <small>
              {[
                engine?.confidence !== null && engine?.confidence !== undefined ? `conf ${Math.round(engine.confidence)}` : null,
                engine?.compCount !== null && engine?.compCount !== undefined ? `${engine.compCount} comps` : null,
              ].filter(Boolean).join(' · ') || '—'}
              {engine?.computedAt ? <i className={cx(autonomy.stale && 'is-stale')}> · {relShort(engine.computedAt, now)}{autonomy.stale ? ' stale' : ''}</i> : null}
            </small>
          </span>
          <span className="pd2-orow__two">
            <b>{card.intentLabel || (card.intent ? card.intent.replace(/_/g, ' ') : '—')}</b>
            <small>{card.lastInboundAt ? `replied ${relShort(card.lastInboundAt, now)}` : 'no reply yet'}</small>
          </span>
          <span className="pd2-orow__two">
            {next ? (
              <><b>{next.kind === 'follow_up' ? 'Follow-up' : 'Reply'}</b><small>{next.future ? stampCT(next.at) ?? 'scheduled' : 'sending'}</small></>
            ) : card.intent_next ? (
              <><b>{intentWords(card.intent_next.action) ?? card.intent_next.action}</b><small>{card.intent_next.due ? `stated · ${stampCT(card.intent_next.due)}` : 'stated'}</small></>
            ) : <><b className="pd2-none">—</b><small>{REPRICES_TEXT[autonomy.reprices]}</small></>}
          </span>
          <span className="pd2-orow__acts">
            <LCIconButton icon="message" label="Open conversation beside" size="sm" disabled={!card.threadKey || !actions.onConversation} onClick={() => actions.onConversation?.(card)} />
            <LCIconButton icon="brain" label="Open Deal Intelligence beside" size="sm" disabled={!card.threadKey && !card.propertyId} onClick={() => actions.onDealIntelligence(card)} />
            <LCIconButton icon={expanded ? 'chevron-up' : 'chevron-down'} label={expanded ? 'Hide breakdown' : 'Breakdown & offer history'} size="sm" onClick={onExpand} aria-expanded={expanded} />
            <LCMenu trigger={<LCIconButton icon="more" label="More offer actions" size="sm" />} items={menu} label="Offer actions" />
          </span>
        </div>
      </LCContextMenu>
      {expanded ? <OfferDetail row={row} now={now} /> : null}
    </Fragment>
  )
}

/** The full breakdown, read only when expanded (one keyed story read for the history). */
function OfferDetail({ row, now }: { row: DeskOfferRow; now: number }) {
  const story = useDealStory(row.card.id)
  const { engine, negotiation, readiness, autonomy } = row
  const fact = (label: string, value: string | null | undefined, note?: string) => (
    <div><dt>{label}{note ? <em>{note}</em> : null}</dt><dd className="lc-num">{value ?? '—'}</dd></div>
  )
  const history = story.data?.negotiation.offers ?? []
  return (
    <div className="pd2-odetail" role="region" aria-label={`Offer breakdown · ${row.card.address || row.card.seller || 'deal'}`}>
      <section>
        <span className="lc-eyebrow">Valuation</span>
        <dl>
          {fact('Low', compactMoney(engine?.low), 'estimated')}
          {fact('Mid', compactMoney(engine?.mid), 'estimated')}
          {fact('High', compactMoney(engine?.high), 'estimated')}
          {fact('Valuation confidence', engine?.valuationConfidence !== null && engine?.valuationConfidence !== undefined ? String(Math.round(engine.valuationConfidence)) : null)}
          {fact('Qualified comps', engine?.compCount !== null && engine?.compCount !== undefined ? String(engine.compCount) : null, engine?.compStatus ? engine.compStatus.toLowerCase().replace(/_/g, ' ') : undefined)}
        </dl>
        {row.plausibility.engineValueOff ? <p className="pd2-odetail__flag">The engine’s value is far from the property record — the record’s estimate is shown instead.</p> : null}
      </section>
      <section>
        <span className="lc-eyebrow">Offer math · the engine’s own figures</span>
        <dl>
          {fact('Tier', engine?.tierLabel ?? readiness.tierLabel)}
          {fact('Engine confidence', engine?.confidence !== null && engine?.confidence !== undefined ? String(Math.round(engine.confidence)) : null)}
          {fact('Recommended', compactMoney(engine?.recommended), 'modeled')}
          {fact('Floor · min. acceptable', compactMoney(engine?.floor), 'modeled')}
          {fact('Assignment fee', compactMoney(engine?.assignmentFee), 'expected')}
          {fact('Strategy', engine?.strategy ? STRATEGY[engine.strategy] ?? engine.strategy.toLowerCase().replace(/_/g, ' ') : null)}
          {fact('Readiness', readiness.state === 'authorized' ? 'Spendable' : readiness.state === 'needs_validation' ? 'Needs validation' : 'Not priced')}
        </dl>
        <p className="pd2-odetail__why">{autonomy?.why}</p>
        {readiness.reasons.length ? <ul className="pd2-odetail__reasons">{readiness.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
        {readiness.thinCoverage ? <p className="pd2-odetail__flag">Thin comp coverage for this market.</p> : null}
      </section>
      <section>
        <span className="lc-eyebrow">Negotiation · offer history</span>
        <dl>
          {fact('Zone', negotiation?.zone ? negotiation.zone.toLowerCase().replace(/_/g, ' ') : null)}
          {fact('Next (stated)', negotiation?.nextAction ? negotiation.nextAction.toLowerCase().replace(/_/g, ' ') : null)}
          {negotiation?.reviewReason ? fact('Review reason', negotiation.reviewReason.toLowerCase().replace(/_/g, ' ')) : null}
        </dl>
        {story.loading && !story.data ? <LCSkeleton shape="lines" count={2} /> : story.error && !story.data ? (
          <p className="pd2-odetail__none">The offer history didn’t load.</p>
        ) : history.length ? (
          <ol className="pd2-odetail__history">
            {history.map((o) => (
              <li key={o.id}>
                <b className="lc-num">{compactMoney(o.price) ?? '—'}</b>
                <span>{[o.direction, o.status].filter(Boolean).join(' · ').toLowerCase() || '—'}{o.version ? ` · v${o.version}` : ''}</span>
                <small>{o.sentAt ? `sent ${relShort(o.sentAt, now)}` : o.acceptedAt ? `accepted ${relShort(o.acceptedAt, now)}` : ''}</small>
              </li>
            ))}
          </ol>
        ) : <p className="pd2-odetail__none">No offer has been recorded for this deal.</p>}
      </section>
    </div>
  )
}
