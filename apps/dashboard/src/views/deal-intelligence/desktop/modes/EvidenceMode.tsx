import { useMemo, useState } from 'react'
import { Icon, type IconName } from '../../../../shared/icons'
import { cx, LCButton, LCDataGrid, LCTimeline, type LCColumn, type LCSort, type LCTimelineItem } from '../../../../shared/lc'
import { dateShort, humanize, int, usd } from '../di-format'
import type { DiLinks } from '../di-links'
import { compStats, debtGroups, factsDiffer, familyCount, type EvidenceFamily } from '../di-model'
import type { DiComp, DiDecision, DiSelection } from '../di-types'
import { Empty, Plane, Prov, Tag } from '../di-ui'
import { CompDistribution, CompRadar } from './EvidenceCharts'
import { countSaleTypes, SALE_TYPE_LABEL, SALE_TYPES, saleTypeOfDealComp } from '../../../../domain/comp-intelligence/comp-sale-type'
import { CompStreetView } from '../../../comp-intelligence/desktop/CompStreetView'
import { SaleTypeBadge } from '../../../comp-intelligence/desktop/SaleType'


const FAMILIES: Array<{ id: EvidenceFamily; label: string; icon: IconName }> = [
  { id: 'comps', label: 'Comparable sales', icon: 'stats' },
  { id: 'seller', label: 'Seller facts', icon: 'user' },
  { id: 'debt', label: 'Debt & liens', icon: 'dollar-sign' },
  { id: 'market', label: 'Market', icon: 'trending-up' },
  { id: 'transactions', label: 'Transactions', icon: 'clock' },
  { id: 'communication', label: 'Communication', icon: 'message' },
]

export function EvidenceMode({ d, family, onFamily, selection, onSelect, links, now }: {
  d: DiDecision
  family: EvidenceFamily
  onFamily: (f: EvidenceFamily) => void
  selection: DiSelection | null
  onSelect: (s: DiSelection) => void
  links: DiLinks | null
  now: number
}) {
  return (
    <div className="dr-mode dr-evidence">
      <nav className="dr-rail" aria-label="Evidence families">
        {FAMILIES.map((f) => {
          const n = familyCount(d, f.id)
          return (
            <button key={f.id} type="button" className={cx('dr-rail__item', family === f.id && 'is-on')} onClick={() => onFamily(f.id)} aria-current={family === f.id ? 'true' : undefined}>
              <Icon name={f.icon} size={14} />
              <span>{f.label}</span>
              {n !== null ? <b className="lc-num">{n.toLocaleString('en-US')}</b> : <em>—</em>}
            </button>
          )
        })}
      </nav>
      <div className="dr-evidence__body">
        {family === 'comps' ? <CompsEvidence d={d} selection={selection} onSelect={onSelect} links={links} now={now} /> : null}
        {family === 'seller' ? <SellerEvidence d={d} selection={selection} onSelect={onSelect} now={now} /> : null}
        {family === 'debt' ? <DebtEvidence d={d} selection={selection} onSelect={onSelect} now={now} /> : null}
        {family === 'market' ? <MarketEvidence d={d} now={now} /> : null}
        {family === 'transactions' ? <TransactionsEvidence d={d} onSelect={onSelect} /> : null}
        {family === 'communication' ? <CommunicationEvidence d={d} now={now} /> : null}
      </div>
    </div>
  )
}

/* ── comps ─────────────────────────────────────────────────────────────── */

const SOURCE_LABEL: Record<string, string> = { mls_sold: 'MLS', public_record_sold: 'Public record' }
const compValue = (c: DiComp) => c.adjustedValue ?? c.salePrice ?? 0

function CompsEvidence({ d, selection, onSelect, links, now }: { d: DiDecision; selection: DiSelection | null; onSelect: (s: DiSelection) => void; links: DiLinks | null; now: number }) {
  const c = d.comps
  const stats = useMemo(() => compStats(d), [d])
  const [sort, setSort] = useState<LCSort>({ id: 'weight', dir: 'desc' })
  const selectedId = selection?.type === 'comp' ? selection.id : null
  const rows = useMemo(() => {
    const list = [...(c?.top ?? [])]
    if (!sort) return list
    const key = (x: DiComp): number | string => {
      switch (sort.id) {
        case 'address': return x.address ?? ''
        case 'sale': return x.salePrice ?? 0
        case 'adjusted': return compValue(x)
        case 'distance': return x.distanceMiles ?? 99
        case 'date': return x.saleDate ? Date.parse(x.saleDate) : 0
        case 'sqft': return x.sqft ?? 0
        case 'ppsf': return x.ppsf ?? 0
        case 'score': return x.score ?? 0
        case 'saletype': return SALE_TYPES.indexOf(saleTypeOfDealComp(x).type)
        default: return x.weight ?? 0
      }
    }
    list.sort((a, b) => {
      const ka = key(a)
      const kb = key(b)
      const r = typeof ka === 'string' ? ka.localeCompare(String(kb)) : (ka as number) - (kb as number)
      return sort.dir === 'asc' ? r : -r
    })
    return list
  }, [c, sort])
  if (!c) return <Empty icon="stats" title="Comp evidence unavailable" body="This property has no analysis, so no comparable sales were selected." />
  const columns: LCColumn<DiComp>[] = [
    { id: 'photo', header: '', width: 66, render: (x) => <CompStreetView size="cell" load="visible" photo={x.photo} lat={x.lat} lng={x.lng} address={x.address} /> },
    { id: 'address', header: 'Address', minWidth: 210, sortable: true, render: (x) => <span className="dr-cell-addr"><b>{x.address?.split(',')[0] ?? '—'}</b>{x.assetMatch ? null : <em className="dr-off">different asset</em>}</span> },
    { id: 'saletype', header: 'Sale type', width: 150, sortable: true, hint: 'How the sale happened — MLS, investor purchase, off-market or public record — from the recorded fields', render: (x) => <SaleTypeBadge v={saleTypeOfDealComp(x)} withBuyer /> },
    { id: 'sale', header: 'Sale', width: 96, align: 'right', sortable: true, render: (x) => usd(x.salePrice) ?? '—' },
    { id: 'adjusted', header: 'Adjusted', width: 100, align: 'right', sortable: true, hint: 'Sale price after the engine’s feature adjustments', render: (x) => <b>{usd(x.adjustedValue) ?? '—'}</b> },
    { id: 'distance', header: 'Dist.', width: 74, align: 'right', sortable: true, render: (x) => (x.distanceMiles !== null ? `${x.distanceMiles.toFixed(2)} mi` : '—') },
    { id: 'date', header: 'Sold', width: 104, align: 'right', sortable: true, render: (x) => dateShort(x.saleDate, now) ?? '—' },
    { id: 'sqft', header: 'Sq ft', width: 78, align: 'right', sortable: true, render: (x) => int(x.sqft) ?? '—' },
    { id: 'ppsf', header: '$/sf', width: 70, align: 'right', sortable: true, render: (x) => (x.ppsf ? `$${Math.round(x.ppsf)}` : '—') },
    { id: 'bdba', header: 'Bd / Ba', width: 74, align: 'right', render: (x) => `${x.beds ?? '—'} / ${x.baths ?? '—'}` },
    { id: 'type', header: 'Type', width: 112, hideable: true, hiddenByDefault: true, render: (x) => x.propertyType ?? '—' },
    { id: 'weight', header: 'Weight', width: 84, align: 'right', sortable: true, hint: 'The engine’s weight for this comp in the valuation', render: (x) => (x.weight !== null ? <span className="dr-weight"><span className="dr-weight__bar" aria-hidden="true"><i style={{ width: `${Math.min(100, x.weight * 100)}%` }} /></span>{Math.round(x.weight * 100)}%</span> : '—') },
    { id: 'score', header: 'Match', width: 72, align: 'right', sortable: true, hint: 'Engine comp score (0–100)', render: (x) => (x.score !== null ? Math.round(x.score) : '—') },
    { id: 'source', header: 'Engine source', width: 112, hideable: true, hiddenByDefault: true, hint: 'How the engine weighed the source: MLS ×1, other ×0.92', render: (x) => (x.source ? SOURCE_LABEL[x.source] ?? humanize(x.source) : '—') },
    { id: 'included', header: 'Inclusion', width: 92, hideable: true, hiddenByDefault: true, render: () => <span className="dr-incl">Priced</span> },
  ]
  return (
    <>
      <Plane id="comps-summary" eyebrow="Comparable sales" title={`${c.selected} qualified of ${c.raw ?? '—'} screened`} under="exec"
        aside={<LCButton size="sm" variant="quiet" icon="arrow-up-right" onClick={links?.comps}>Open in Comp Intelligence</LCButton>}>
        <div className="dr-statline">
          <div><span>Candidates</span><b className="lc-num">{c.raw ?? '—'}</b><em>{c.eligible !== null ? `${c.eligible} eligible` : ''}</em></div>
          <div><span>Qualified</span><b className="lc-num">{c.selected}</b><em>{c.rejected !== null ? `${c.rejected} rejected` : ''}</em></div>
          <div><span>Engine value</span><b className="lc-num">{usd(stats.engine) ?? '—'}</b><em>weighted</em></div>
          <div><span>Median comp</span><b className="lc-num">{usd(stats.median) ?? '—'}</b><em>adjusted, unweighted</em></div>
          <div><span>Spread</span><b className="lc-num">{c.dispersion !== null ? `${Math.round(c.dispersion * 100)}%` : '—'}</b><em>{c.dispersion === null ? '' : c.dispersion > 0.35 ? 'wide' : c.dispersion > 0.2 ? 'moderate' : 'tight'}</em></div>
          <div><span>Distance</span><b className="lc-num">{c.avgDistanceMiles ?? '—'}</b><em>mi average</em></div>
          <div><span>Age</span><b className="lc-num">{c.medianAgeMonths ?? '—'}</b><em>mo median</em></div>
          <div><span>Asset match</span><b className="lc-num">{c.assetIntegrity ? `${c.assetIntegrity.matched}/${c.assetIntegrity.total}` : '—'}</b><em>{c.assetIntegrity?.mismatched.length ? 'mixed types' : 'same family'}</em></div>
        </div>
        {c.message && c.selected === 0 ? <p className="dr-warn">{c.message}</p> : null}
        {c.top.length ? (
          <div className="dr-comps__viz">
            <CompDistribution d={d} stats={stats} selectedId={selectedId} onSelect={(id) => onSelect({ type: 'comp', id })} />
            <CompRadar d={d} selectedId={selectedId} onSelect={(id) => onSelect({ type: 'comp', id })} />
          </div>
        ) : null}
      </Plane>
      {c.top.length ? (
        <Plane id="comps-grid" eyebrow="Comp grid" title="Every qualified comp, as the engine weighted it" depth={1}>
          {(() => {
            const mix = countSaleTypes(rows, (x) => saleTypeOfDealComp(x).type)
            return <p className="dr-quiet dr-salemix lc-num">{SALE_TYPES.filter((t) => mix[t]).map((t) => `${mix[t]} ${SALE_TYPE_LABEL[t].short}`).join(' · ')} — sale type from the recorded fields; the engine weights MLS sales ×1 and other sales ×0.92.</p>
          })()}
          <div className="dr-grid-wrap" style={{ height: Math.min(640, 46 + rows.length * 44 + 8) }}>
            <LCDataGrid
              id="di-comps"
              label="Qualified comparable sales"
              rows={rows}
              rowKey={(x) => x.id ?? x.address ?? ''}
              columns={columns}
              sort={sort}
              onSortChange={setSort}
              activeKey={selectedId}
              onActivate={(x) => onSelect({ type: 'comp', id: x.id ?? x.address ?? '' })}
              rowTone={(x) => (x.assetMatch ? null : 'crit')}
              density="comfortable"
            />
          </div>
        </Plane>
      ) : null}
      {c.rejectionBreakdown.length ? (
        <Plane id="comps-rejects" eyebrow="Screened out" title={`Why ${c.rejected ?? ''} candidates were not used`} depth={1}>
          <div className="dr-bars">
            {c.rejectionBreakdown.map((r) => {
              const max = Math.max(1, ...c.rejectionBreakdown.map((x) => x.count))
              return <div key={r.reason} className="dr-bars__row"><span>{r.label}</span><i style={{ width: `${(r.count / max) * 100}%` }} /><b className="lc-num">{r.count}</b></div>
            })}
          </div>
          <p className="dr-quiet">Sources of the qualified set: {Object.entries(c.sources).map(([k, n]) => `${SOURCE_LABEL[k] ?? humanize(k)} ${n}`).join(' · ')}. Individual buyers on comps are never named.</p>
        </Plane>
      ) : null}
    </>
  )
}

/* ── seller facts ──────────────────────────────────────────────────────── */

function SellerEvidence({ d, selection, onSelect, now }: { d: DiDecision; selection: DiSelection | null; onSelect: (s: DiSelection) => void; now: number }) {
  const facts = d.sellerFacts
  if (!facts.length) return <Empty icon="user" title="No seller facts" body="Nothing has been captured from the conversation or recorded for this property." />
  const groups = new Map<string, typeof facts>()
  for (const f of facts) groups.set(f.label, [...(groups.get(f.label) ?? []), f])
  return (
    <Plane id="seller-facts" eyebrow="Seller facts" title="What the seller said, what the record says, what the system derived" under="flow">
      <table className="dr-table">
        <thead><tr><th>Fact</th><th>Value</th><th>Provenance</th><th>Source</th><th>When</th></tr></thead>
        <tbody>
          {[...groups.entries()].flatMap(([label, list]) => {
            const differ = factsDiffer(list)
            return list.map((f, i) => {
              const sel = selection?.type === 'fact' && selection.key === f.key
              return (
                <tr key={f.key} className={cx(sel && 'is-selected', differ && 'is-differ')} onClick={() => onSelect({ type: 'fact', key: f.key })}>
                  <td>{i === 0 ? <b>{label}</b> : null}{i === 0 && differ ? <em className="dr-differ">sources differ</em> : null}</td>
                  <td><button type="button" className="dr-linkcell" onClick={() => onSelect({ type: 'fact', key: f.key })}>{f.display}</button>{f.quote ? <q>{f.quote}</q> : null}</td>
                  <td><Prov p={f.provenance} /></td>
                  <td className="dr-quietcell">{f.source}{f.confidence !== null && f.confidence !== undefined ? ` · conf ${f.confidence <= 1 ? Math.round(f.confidence * 100) : Math.round(f.confidence)}` : ''}</td>
                  <td className="dr-quietcell">{f.at ? dateShort(f.at, now) : '—'}</td>
                </tr>
              )
            })
          })}
        </tbody>
      </table>
    </Plane>
  )
}

/* ── debt & liens ──────────────────────────────────────────────────────── */

function DebtEvidence({ d, selection, onSelect, now }: { d: DiDecision; selection: DiSelection | null; onSelect: (s: DiSelection) => void; now: number }) {
  const e = d.economics
  const debt = e.debt
  const g = debtGroups(d)
  const docs = e.recordedDocuments ?? []
  const docIndex = (x: (typeof docs)[number]) => docs.indexOf(x)
  return (
    <>
      <Plane id="debt" eyebrow="Debt" title={debt.estOpenBalance ? `${usd(debt.estOpenBalance)} estimated open balance` : debt.mortgages.length ? 'Open balance unknown' : 'No current loans recorded'} under={e.foreclosure ? 'crit' : 'exec'}
        aside={<Tag kind="estimated">Estimated balances</Tag>}>
        <div className="dr-statline is-4">
          <div><span>Current loans</span><b className="lc-num">{debt.mortgages.length}</b><em>{debt.openMortgageCount !== null ? `${debt.openMortgageCount} open per provider` : ''}</em></div>
          <div><span>Original amount</span><b className="lc-num">{usd(debt.originalTotal) ?? '—'}</b><em>recorded</em></div>
          <div><span>Payment</span><b className="lc-num">{debt.monthlyPayment ? `${usd(debt.monthlyPayment)}/mo` : '—'}</b><em>estimated</em></div>
          <div><span>Equity</span><b className="lc-num">{e.equityPercent !== null ? `${Math.round(e.equityPercent)}%` : '—'}</b><em>{e.equityEstimate !== null ? `${usd(e.equityEstimate)} est.` : ''}</em></div>
        </div>
        {debt.mortgages.length ? (
          <ul className="dr-loans">
            {debt.mortgages.map((m, i) => {
              const sel = selection?.type === 'loan' && selection.index === i && !selection.prior
              return (
                <li key={`${m.slot}-${i}`}>
                  <button type="button" className={cx('dr-loan', sel && 'is-selected')} onClick={() => onSelect({ type: 'loan', index: i })}>
                    <span className="dr-loan__pos">{m.position ? `#${m.position}` : '—'}</span>
                    <span className="dr-loan__main"><b>{m.lender ?? 'Lender not recorded'}</b><em>{[m.type, m.amount ? `${usd(m.amount)} original` : null, m.rate ? `${m.rate}%` : null, m.recordedAt ? `recorded ${dateShort(m.recordedAt, now)}` : null].filter(Boolean).join(' · ')}</em></span>
                    <span className="dr-loan__bal lc-num">{m.balanceKnown || (m.estBalance ?? 0) > 0 ? <>{usd(m.estBalance)}<Tag kind="estimated" /></> : <span className="dr-none">Balance unknown</span>}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        ) : null}
        {debt.unknownBalances ? <p className="dr-quiet">{debt.unknownBalances} current loan{debt.unknownBalances === 1 ? ' has' : 's have'} no balance estimate (often a modification) — the open balance may be understated. Balances are provider estimates, not payoff letters.</p> : null}
        {(debt.priorMortgages ?? []).length ? (
          <details className="dr-details">
            <summary>{debt.priorMortgages!.length} prior / purchase loan{debt.priorMortgages!.length === 1 ? '' : 's'} (history, not open debt)</summary>
            <ul className="dr-loans is-prior">
              {debt.priorMortgages!.map((m, i) => (
                <li key={`p-${i}`}>
                  <button type="button" className="dr-loan" onClick={() => onSelect({ type: 'loan', index: i, prior: true })}>
                    <span className="dr-loan__pos">{m.kind === 'purchase' ? 'Buy' : 'Prior'}</span>
                    <span className="dr-loan__main"><b>{m.lender ?? 'Lender not recorded'}</b><em>{[m.type, m.amount ? `${usd(m.amount)} original` : null, m.recordedAt ? `recorded ${dateShort(m.recordedAt, now)}` : null].filter(Boolean).join(' · ')}</em></span>
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </Plane>

      <Plane id="liens" eyebrow="Liens & recorded documents" title={g.liens.length ? `${g.liens.length} recorded lien${g.liens.length === 1 ? '' : 's'}${e.lienSummary?.statedAmount ? ` · ${usd(e.lienSummary.statedAmount)} stated` : ''}` : 'No recorded liens'} under={g.liens.length ? 'attn' : 'exec'}>
        {g.byKind.length ? (
          <div className="dr-kinds">
            {g.byKind.map((k) => <span key={k.kind}><b>{k.count}</b>{k.label}{k.amount ? <em> · {usd(k.amount)}</em> : null}</span>)}
          </div>
        ) : null}
        {[['Liens', g.liens], ['Descriptions conflict', g.conflicts], ['Releases on file', g.releases], ['Other recorded documents', g.documents]].map(([title, list]) => (list as typeof docs).length ? (
          <div key={title as string} className="dr-docgroup">
            <span className="dr-eyebrow">{title as string} · {(list as typeof docs).length}</span>
            <ul className="dr-docs">
              {(list as typeof docs).map((x) => {
                const idx = docIndex(x)
                const sel = selection?.type === 'doc' && selection.index === idx
                return (
                  <li key={idx}>
                    <button type="button" className={cx('dr-doc', `is-${x.status}`, sel && 'is-selected')} onClick={() => onSelect({ type: 'doc', index: idx })}>
                      <span className="dr-doc__kind">{x.kindLabel}</span>
                      <span className="dr-doc__main"><b>{x.title}</b><em>{x.claimant ? x.claimant : x.parties.join(' · ') || 'Parties not recorded'}</em></span>
                      <span className="dr-doc__amt lc-num">{x.amount ? usd(x.amount) : <span className="dr-none">no amount</span>}</span>
                      <span className="dr-doc__at">{x.at ? dateShort(x.at, now) : x.updatedAt ? `upd. ${dateShort(x.updatedAt, now)}` : 'undated'}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        ) : null)}
        {!docs.length && !e.liens.length ? <p className="dr-none">No liens, releases or other instruments on the record.</p> : null}
        {e.foreclosure ? (
          <div className="dr-foreclosure">
            <Icon name="alert" size={13} />
            <div><b>{e.foreclosure.status ?? 'Foreclosure filing'}</b><span>{[e.foreclosure.docType, e.foreclosure.defaultAt ? `default ${dateShort(e.foreclosure.defaultAt, now)}` : null, e.foreclosure.auctionAt ? `auction ${dateShort(e.foreclosure.auctionAt, now)}` : null].filter(Boolean).join(' · ')}</span></div>
          </div>
        ) : null}
        <p className="dr-quiet">Classified from the county record: a release, an estate filing or a UCC statement is not counted as a lien; where the record’s two descriptions disagree the row is shown as a conflict, not picked.</p>
      </Plane>

      <Plane id="tax" eyebrow="Tax" title={e.tax.annual ? `${usd(e.tax.annual, { exact: true })} annual${e.tax.year ? ` (${e.tax.year})` : ''}` : 'Annual tax not recorded'} depth={1} under={e.tax.delinquent ? 'crit' : null}>
        <p className={cx('dr-taxline', e.tax.delinquent && 'is-crit')}>{e.tax.delinquent ? `Delinquent${e.tax.delinquentYear ? ` since ${e.tax.delinquentYear}` : ''}` : 'No delinquency on the record'}{e.tax.year ? ` · status as of the ${e.tax.year} tax record` : ''}</p>
      </Plane>
    </>
  )
}

/* ── market ────────────────────────────────────────────────────────────── */

function MarketEvidence({ d, now }: { d: DiDecision; now: number }) {
  const m = d.market
  if (!m || !m.ok) return <Empty icon="trending-up" title="Market evidence unavailable" body={m?.error === 'subject_not_geocoded' ? 'This property has no coordinates, so nearby sales can’t be measured.' : 'Nearby sales could not be loaded.'} />
  const o = m.overall
  const tmax = Math.max(1, ...m.trend.map((t) => t.count))
  return (
    <Plane id="market" eyebrow="Market" title={`${m.totals.sales} ${m.subject.familyLabel.toLowerCase()} sales within ${m.radius.used} mi`} under="exec"
      aside={m.window.dataThrough ? <span className="dr-quiet">sales recorded through {dateShort(m.window.dataThrough, now)}</span> : null}>
      <div className="dr-statline">
        <div><span>Median sale</span><b className="lc-num">{usd(o.medianPrice) ?? '—'}</b><em>{o.p25Price && o.p75Price ? `IQR ${usd(o.p25Price)}–${usd(o.p75Price)}` : ''}</em></div>
        <div><span>$/sq ft</span><b className="lc-num">{o.medianPpsf ? `$${Math.round(o.medianPpsf)}` : '—'}</b><em>median</em></div>
        <div><span>Window</span><b className="lc-num">{m.window.months} mo</b><em>{m.radius.widened ? 'radius widened' : `${m.radius.used} mi radius`}</em></div>
        <div><span>Excluded</span><b className="lc-num">{m.totals.excludedOutliers}</b><em>outliers</em></div>
      </div>
      {m.trend.length > 1 ? (
        <div className="dr-trend" aria-label="Quarterly sales volume">
          {m.trend.map((t) => (
            <div key={t.quarter} className="dr-trend__col">
              <i style={{ height: `${Math.max(6, (t.count / tmax) * 100)}%` }} title={`${t.quarter}: ${t.count} sales · median ${usd(t.medianPrice) ?? '—'}`} />
              <span>{t.quarter.replace(/^\d{2}(\d{2})-?/, '’$1 ')}</span>
            </div>
          ))}
        </div>
      ) : null}
      {m.bySource.length ? (
        <div className="dr-bars">
          {m.bySource.map((s) => {
            const max = Math.max(1, ...m.bySource.map((x) => x.count))
            return <div key={s.source} className="dr-bars__row"><span>{s.label}</span><i style={{ width: `${(s.count / max) * 100}%` }} /><b className="lc-num">{s.count}</b><em>{usd(s.medianPrice) ?? '—'}</em></div>
          })}
        </div>
      ) : null}
      <p className="dr-quiet">Recorded sales near the property for the same asset family — independent of Buyer Match, and not part of the engine’s value.</p>
      <ExitContext d={d} />
    </Plane>
  )
}

/** Exit-side context from Buyer Match — shape only, never buyer names, and never part of the value. */
function ExitContext({ d }: { d: DiDecision }) {
  const b = d.buyers
  return (
    <div className="dr-exit">
      <span className="dr-eyebrow">Exit context · Buyer Match</span>
      {b ? (
        <>
          <div className="dr-statline is-4">
            <div><span>Matched buyers</span><b className="lc-num">{b.candidates}</b><em>{b.topScore !== null ? `top score ${Math.round(b.topScore)}` : ''}</em></div>
            <div><span>A-grade</span><b className="lc-num">{b.grades.A ?? 0}</b><em>of {b.candidates}</em></div>
            <div><span>Packages sent</span><b className="lc-num">{b.packagesSent}</b><em>{b.interested ? `${b.interested} interested` : 'none interested yet'}</em></div>
            <div><span>Median dispo</span><b className="lc-num">{usd(b.medianDispo) ?? '—'}</b><em>Buyer Match suggestion</em></div>
          </div>
          {b.types.length ? <div className="dr-kinds">{b.types.map((t) => <span key={t.type}><b>{t.count}</b>{t.type}</span>)}</div> : null}
          <p className="dr-quiet">Disposition demand informs the exit; the engine value and offer do not use it.</p>
        </>
      ) : <p className="dr-none">Buyer Match has not been run for this property, so there is no measured exit demand.</p>}
    </div>
  )
}

/* ── transactions ──────────────────────────────────────────────────────── */

const KIND_ICON: Record<string, IconName> = { sale: 'home', mortgage: 'dollar-sign', lien: 'flag', foreclosure: 'alert', ask: 'message', analysis: 'cpu', offer: 'send' }

function TransactionsEvidence({ d, onSelect }: { d: DiDecision; onSelect: (s: DiSelection) => void }) {
  const items: LCTimelineItem[] = d.history.map((h, i) => ({
    id: `${h.kind}-${i}`,
    at: Date.parse(h.at),
    title: <>{h.title}{h.amount ? <b className="dr-tl-amt lc-num"> {usd(h.amount)}</b> : null}</>,
    body: h.detail ?? undefined,
    icon: KIND_ICON[h.kind] ?? 'clock',
    state: 'done',
    onOpen: () => onSelect({ type: 'event', index: i, source: 'history' }),
  }))
  if (!items.length) return <Empty icon="clock" title="No recorded transactions" body="No sales, loans, liens or analyses are on record for this property." />
  return (
    <Plane id="transactions" eyebrow="Transaction history" title="Recorded events, what the seller said, and every analysis" under="exec">
      <LCTimeline items={items} label="Property history" />
      <p className="dr-quiet">Only factual recorded events: sales and loans from the county record, liens as classified, seller asks from the conversation, engine analyses from immutable snapshots.</p>
    </Plane>
  )
}

/* ── communication ─────────────────────────────────────────────────────── */

function CommunicationEvidence({ d, now }: { d: DiDecision; now: number }) {
  const c = d.conversation
  if (!c) return <Empty icon="message" title="No conversation signal" body="No seller conversation is linked to this property, or it could not be read." />
  const factors = [...c.factors].sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
  const maxPts = Math.max(1, ...factors.map((f) => Math.abs(f.points)))
  const intents = Object.entries(c.intents).sort((a, b) => b[1] - a[1])
  return (
    <Plane id="communication" eyebrow="Communication signal" title={`${c.band.replace('_', ' ')} · ${c.score ?? '—'} · ${c.confidence} confidence`} under="flow">
      <ul className="dr-factors">
        {factors.map((f) => (
          <li key={f.key} className={f.points >= 0 ? 'is-plus' : 'is-minus'}>
            <div className="dr-factors__row"><span>{f.label}</span><i style={{ width: `${(Math.abs(f.points) / maxPts) * 100}%` }} /><b className="lc-num">{f.points > 0 ? `+${f.points}` : f.points}</b></div>
            <em>{f.value}</em>
            {f.evidence?.quote ? <blockquote>“{f.evidence.quote}”<small>{dateShort(f.evidence.at, now)}</small></blockquote> : null}
          </li>
        ))}
      </ul>
      {intents.length ? <div className="dr-kinds">{intents.map(([k, n]) => <span key={k}><b>{n}</b>{humanize(k)}</span>)}</div> : null}
      <p className="dr-quiet">A deterministic read of the messages — response speed, volume, timing and language. A heuristic, not a prediction; nothing here profiles the person.</p>
    </Plane>
  )
}
