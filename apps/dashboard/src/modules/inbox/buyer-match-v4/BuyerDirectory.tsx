import { Fragment, useMemo, useState } from 'react'
import type { BuyerFilterState, BuyerMatchV4Projection } from './buyer-match-v4.types'
import { countBuyers, filterAndSortBuyers, formatBuyerClassLabel } from './buyerFilters'
import { humanDataState, fmtCurrency, fmtDate, fmtMiles, fmtRange } from './formatters'
import { BuyerLoadingState } from './BuyerLoadingState'

interface Props {
  projection: BuyerMatchV4Projection | null
  loading: boolean
  timedOut: boolean
  filters: BuyerFilterState
  selectedBuyerId: string | null
  expandedBuyerIds: string[]
  shortlistIds: string[]
  onSelectBuyer: (id: string) => void
  onToggleExpand: (id: string) => void
  onToggleShortlist: (id: string) => void
  onRetry?: () => void
}

export function BuyerDirectory({
  projection,
  loading,
  timedOut,
  filters,
  selectedBuyerId,
  expandedBuyerIds,
  shortlistIds,
  onSelectBuyer,
  onToggleExpand,
  onToggleShortlist,
  onRetry,
}: Props) {
  const [sortCol, setSortCol] = useState<string | null>(null)
  const [sortAsc, setSortAsc] = useState(false)

  const dataState = projection?.market?.dataState
  const allBuyers = projection?.rankedBuyers ?? []
  const buyers = filterAndSortBuyers(allBuyers, filters)
  const counts = countBuyers(allBuyers)
  const market = projection?.market

  const sorted = useMemo(() => {
    if (!sortCol) return buyers
    const copy = [...buyers]
    copy.sort((a, b) => {
      const av = (a as unknown as Record<string, unknown>)[sortCol] as number | null
      const bv = (b as unknown as Record<string, unknown>)[sortCol] as number | null
      const diff = (av ?? -1) - (bv ?? -1)
      return sortAsc ? diff : -diff
    })
    return copy
  }, [buyers, sortCol, sortAsc])

  const toggleSort = (col: string) => {
    if (sortCol === col) setSortAsc(!sortAsc)
    else { setSortCol(col); setSortAsc(false) }
  }

  if (loading && !projection) {
    return (
      <main className="bmv4-directory">
        <BuyerLoadingState timedOut={timedOut} onRetry={onRetry} />
      </main>
    )
  }

  if (dataState === 'NO_LOCAL_DATA') {
    return (
      <main className="bmv4-directory bmv4-directory--empty">
        <h3>Local buyer evidence is unavailable</h3>
        <p>No verified local buyers were found for this property. State- or market-level counts are not shown as local demand.</p>
      </main>
    )
  }

  return (
    <main className="bmv4-directory">
      <header className="bmv4-directory__head">
        <h3>Buyer Directory</h3>
        <p className="bmv4-tabular">
          {market?.eligibleBuyerFamilies ?? counts.total} eligible buyer families
          {' · '}{counts.highFit} high fit
          {' · '}{market?.localRegionalFamilies ?? counts.localRegional} local/regional
          {' · '}{market?.institutionalPlatforms ?? counts.institutional} institutional
          {' · '}{market?.builderFamilies ?? counts.builders} builders
        </p>
        {dataState === 'PARTIAL' && <span className="bmv4-badge is-partial">{humanDataState('PARTIAL')}</span>}
        <p className="bmv4-muted">Showing {sorted.length} after filters</p>
      </header>

      {sorted.length === 0 ? (
        <p className="bmv4-muted">No buyers matched current filters.</p>
      ) : (
        <div className="bmv4-table-wrap">
          <table className="bmv4-directory-table">
            <thead>
              <tr>
                <th />
                <th>Buyer family</th>
                <th>Class</th>
                <th>Grade</th>
                <th className="is-num" onClick={() => toggleSort('matchScore')}>Match</th>
                <th className="is-num" onClick={() => toggleSort('purchases30d')}>30d</th>
                <th className="is-num" onClick={() => toggleSort('purchases60d')}>60d</th>
                <th className="is-num" onClick={() => toggleSort('purchases90d')}>90d</th>
                <th className="is-num" onClick={() => toggleSort('purchases180d')}>180d</th>
                <th className="is-num" onClick={() => toggleSort('purchases365d')}>365d</th>
                <th className="is-num" onClick={() => toggleSort('lifetimePurchases')}>Life</th>
                <th className="is-num">Local</th>
                <th>Nearest</th>
                <th>Last</th>
                <th className="is-num">Median</th>
                <th className="is-num">Likely bid</th>
                <th>★</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((b) => {
                const expanded = expandedBuyerIds.includes(b.buyerId)
                const selected = selectedBuyerId === b.buyerId
                const classLabel = formatBuyerClassLabel(b.buyerClass ?? b.buyerArchetype)
                return (
                  <Fragment key={b.buyerId}>
                    <tr
                      className={`bmv4-dir-row${selected ? ' is-selected' : ''}${expanded ? ' is-expanded' : ''}`}
                      onClick={() => onSelectBuyer(b.buyerId)}
                    >
                      <td>
                        <button
                          type="button"
                          className="bmv4-btn is-ghost is-xs"
                          onClick={(e) => { e.stopPropagation(); onToggleExpand(b.buyerId) }}
                          aria-label={expanded ? 'Collapse' : 'Expand'}
                        >
                          {expanded ? '▾' : '▸'}
                        </button>
                      </td>
                      <td className="bmv4-dir-name">{b.buyerName}</td>
                      <td><span className={`bmv4-class is-${(b.buyerClass ?? 'unknown').toLowerCase()}`}>{classLabel}</span></td>
                      <td><span className={`bmv4-grade is-${(b.matchGrade ?? 'd').toLowerCase().replace('+', 'plus')}`}>{b.matchGrade ?? '—'}</span></td>
                      <td className="bmv4-tabular">{b.matchScore ?? '—'}</td>
                      <td className="bmv4-tabular">{b.purchases30d ?? '—'}</td>
                      <td className="bmv4-tabular">{b.purchases60d ?? '—'}</td>
                      <td className="bmv4-tabular">{b.purchases90d ?? '—'}</td>
                      <td className="bmv4-tabular">{b.purchases180d ?? '—'}</td>
                      <td className="bmv4-tabular">{b.purchases365d ?? '—'}</td>
                      <td className="bmv4-tabular">{b.lifetimePurchases ?? '—'}</td>
                      <td className="bmv4-tabular">{b.localPurchases ?? '—'}</td>
                      <td className="bmv4-tabular">{fmtMiles(b.nearestPurchaseMiles)}</td>
                      <td>{fmtDate(b.lastPurchaseAt)}</td>
                      <td className="bmv4-tabular">{fmtCurrency(b.medianQualifiedPrice)}</td>
                      <td className="bmv4-tabular">{fmtRange(b.likelyBidLow, b.likelyBidHigh)}</td>
                      <td>
                        <button
                          type="button"
                          className={`bmv4-btn is-ghost is-xs${shortlistIds.includes(b.buyerId) ? ' is-on' : ''}`}
                          onClick={(e) => { e.stopPropagation(); onToggleShortlist(b.buyerId) }}
                        >
                          ★
                        </button>
                      </td>
                    </tr>
                    {expanded && (
                      <tr key={`${b.buyerId}-detail`} className="bmv4-dir-detail">
                        <td colSpan={17}>
                          <div className="bmv4-dir-expand">
                            <div>
                              <strong>Match thesis</strong>
                              <ul>{b.reasonSummary.map((r) => <li key={r}>{r}</li>)}</ul>
                            </div>
                            {b.legalEntities && b.legalEntities.length > 0 && (
                              <div>
                                <strong>Legal entities</strong>
                                <ul>
                                  {b.legalEntities.map((le) => (
                                    <li key={le.entityId}>{le.legalName} · {le.purchaseCount} purchases · {le.relationshipType}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}