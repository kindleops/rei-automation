import { Icon } from '../../../shared/icons'
import { formatRelativeTime } from '../../../shared/formatters'
import type {
  BuyerCommandData,
  BuyerMapFilters,
  BuyerProfileSummary,
  BuyerRecentPurchase,
} from '../../buyer/buyerCommandData'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type BuyerMatchWorkspaceProps = {
  buyerCommandData: BuyerCommandData
  buyerFilters: BuyerMapFilters
  onBuyerFiltersChange: (updater: (current: BuyerMapFilters) => BuyerMapFilters) => void
  selectedBuyerKey: string | null
  onSelectBuyerKey: (value: string | null) => void
  paneMode: 'single' | 'multi'
  paneWidth: '25' | '50' | '75' | '100'
  selectedPropertyLabel: string
  selectedMarket: string
  selectedZip: string
  selectedPropertyType: string
}

const formatMoney = (value: number | null | undefined): string => {
  if (!Number.isFinite(value ?? NaN)) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value as number)
}

const formatCompactMoney = (value: number | null | undefined): string => {
  if (!Number.isFinite(value ?? NaN)) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(value as number)
}

const formatNumber = (value: number | null | undefined): string => {
  if (!Number.isFinite(value ?? NaN)) return '—'
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value as number)
}

const matchTierFor = (score: number | null | undefined): string => {
  const safe = Number(score ?? 0)
  if (safe >= 90) return 'Elite Match'
  if (safe >= 75) return 'Strong Match'
  if (safe >= 60) return 'Possible Match'
  if (safe >= 40) return 'Weak Match'
  return 'Noise / Low Fit'
}

const toneForBuyer = (buyer: BuyerProfileSummary): 'gold' | 'cyan' | 'purple' | 'slate' => {
  if (buyer.buyerGrade === 'A+' || buyer.buyerGrade === 'A') return 'gold'
  if (buyer.category === 'institutional') return 'purple'
  if (buyer.isCorporateBuyer || buyer.isRepeatBuyer) return 'cyan'
  return 'slate'
}

const initialsFor = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || 'BY'

const summarizeBuyer = (buyer: BuyerProfileSummary, purchases: BuyerRecentPurchase[]) => {
  const totalSpend = purchases.reduce((sum, purchase) => sum + (purchase.salePrice ?? 0), 0) || buyer.avgPurchasePrice || 0
  const avgPpsfValues = purchases.map((purchase) => purchase.pricePerSqft).filter((value): value is number => Number.isFinite(value ?? NaN))
  const avgPpsf = avgPpsfValues.length > 0 ? avgPpsfValues.reduce((sum, value) => sum + value, 0) / avgPpsfValues.length : null
  const sortedPpsf = [...avgPpsfValues].sort((left, right) => left - right)
  const medianPpsf = sortedPpsf.length > 0 ? sortedPpsf[Math.floor(sortedPpsf.length / 2)] : null
  const priceValues = purchases
    .map((purchase) => purchase.salePrice)
    .filter((value): value is number => Number.isFinite(value ?? NaN))
  const latestPurchase = purchases
    .slice()
    .sort((left, right) => new Date(right.saleDate || 0).getTime() - new Date(left.saleDate || 0).getTime())[0] ?? null
  const daysSinceLastPurchase = latestPurchase?.saleDate
    ? Math.max(0, Math.round((Date.now() - new Date(latestPurchase.saleDate).getTime()) / 86_400_000))
    : null
  return {
    totalSpend,
    avgPpsf,
    medianPpsf,
    minPrice: priceValues.length > 0 ? Math.min(...priceValues) : null,
    maxPrice: priceValues.length > 0 ? Math.max(...priceValues) : null,
    daysSinceLastPurchase,
  }
}

const temporaryMatchScoreFor = (
  buyer: BuyerProfileSummary,
  purchases: BuyerRecentPurchase[],
  propertyType: string,
  market: string,
  zip: string,
) => {
  let score = buyer.confidenceScore ?? 0
  const nearestDistance = purchases
    .map((purchase) => purchase.distanceMiles)
    .filter((value): value is number => Number.isFinite(value ?? NaN))
    .sort((left, right) => left - right)[0] ?? null
  if (nearestDistance != null) {
    if (nearestDistance <= 3) score += 25
    else if (nearestDistance <= 5) score += 20
    else if (nearestDistance <= 10) score += 12
  }
  if (market && buyer.topMarkets.some((value) => value.toLowerCase() === market.toLowerCase())) score += 15
  if (zip && buyer.topZips.includes(zip)) score += 15
  if (propertyType && buyer.propertyTypeFocus.some((value) => value.toLowerCase() === propertyType.toLowerCase())) score += 20
  if ((buyer.purchaseCount6mo ?? 0) >= 5) score += 15
  else if ((buyer.purchaseCount12mo ?? 0) >= 2) score += 8
  if (buyer.isOffMarketBuyer) score += 5
  if ((summarizeBuyer(buyer, purchases).daysSinceLastPurchase ?? 9999) <= 90) score += 15
  if (buyer.isRetailOrNoise && !buyer.isRepeatBuyer) score = Math.min(score, 55)
  return Math.max(0, Math.min(100, Math.round(score)))
}

const buildBuyerCardBadges = (buyer: BuyerProfileSummary, score: number | null) => {
  const badges: string[] = []
  badges.push(`${buyer.buyerGrade}-Tier Buyer`)
  if (buyer.isRepeatBuyer) badges.push('Repeat Buyer')
  if (buyer.isCorporateBuyer) badges.push('Corporate Buyer')
  if (buyer.category === 'institutional') badges.push('Institutional')
  if (buyer.category === 'builder') badges.push('Builder / Developer')
  if (buyer.category === 'landlord') badges.push('Local Operator')
  if (buyer.category === 'flipper') badges.push('Value-Add Buyer')
  if (buyer.isLocalBuyer) badges.push('Local Investor')
  if (buyer.isOffMarketBuyer) badges.push('Off-Market Buyer')
  if (buyer.isRetailOrNoise) badges.push('Retail / Noise')
  if ((buyer.purchaseCount6mo ?? 0) >= 5) badges.push('High Velocity')
  if ((score ?? 0) >= 90) badges.push('Elite Match')
  return badges
}

const safeCopy = async (value: string) => {
  try {
    await navigator.clipboard.writeText(value)
  } catch {
    // Best-effort only.
  }
}

export const BuyerMatchWorkspace = ({
  buyerCommandData,
  buyerFilters,
  onBuyerFiltersChange,
  selectedBuyerKey,
  onSelectBuyerKey,
  paneMode,
  paneWidth,
  selectedPropertyLabel,
  selectedMarket,
  selectedZip,
  selectedPropertyType,
}: BuyerMatchWorkspaceProps) => {
  const selectedBuyer = buyerCommandData.profiles.find((profile) => profile.buyerKey === selectedBuyerKey) ?? buyerCommandData.profiles[0] ?? null
  const matchesByBuyer = new Map(buyerCommandData.matches.map((match) => [match.buyerKey, match]))
  const purchasesByBuyer = new Map<string, BuyerRecentPurchase[]>()
  buyerCommandData.recentPurchases.forEach((purchase) => {
    const bucket = purchasesByBuyer.get(purchase.buyerKey) ?? []
    bucket.push(purchase)
    purchasesByBuyer.set(purchase.buyerKey, bucket)
  })

  const realBuyers = buyerCommandData.profiles.filter((profile) => profile.isRealBuyer && !profile.isRetailOrNoise)
  const repeatBuyers = buyerCommandData.profiles.filter((profile) => profile.isRepeatBuyer && !profile.isRetailOrNoise)
  const corporateBuyers = buyerCommandData.profiles.filter((profile) => profile.isCorporateBuyer && !profile.isRetailOrNoise)
  const localBuyers = buyerCommandData.profiles.filter((profile) => profile.isLocalBuyer && !profile.isRetailOrNoise)
  const offMarketBuyers = buyerCommandData.profiles.filter((profile) => profile.isOffMarketBuyer && !profile.isRetailOrNoise)
  const noiseBuyers = buyerCommandData.profiles.filter((profile) => profile.isRetailOrNoise)

  const sections: Array<{ title: string; buyers: BuyerProfileSummary[]; accent: string }> = [
    { title: 'Real Buyers', buyers: realBuyers.length > 0 ? realBuyers : buyerCommandData.profiles, accent: 'gold' },
    { title: 'Repeat Buyers', buyers: repeatBuyers, accent: 'cyan' },
    { title: 'Corporate Buyers', buyers: corporateBuyers, accent: 'purple' },
    { title: 'Local Buyers', buyers: localBuyers, accent: 'cyan' },
    { title: 'Off-Market Buyers', buyers: offMarketBuyers, accent: 'gold' },
    { title: 'Retail / Noise', buyers: noiseBuyers, accent: 'slate' },
  ]

  const widthClass = `is-pane-${paneWidth}`
  const detailPurchases = selectedBuyer ? (purchasesByBuyer.get(selectedBuyer.buyerKey) ?? []).slice().sort((left, right) => new Date(right.saleDate || 0).getTime() - new Date(left.saleDate || 0).getTime()) : []
  const selectedMatch = selectedBuyer ? matchesByBuyer.get(selectedBuyer.buyerKey) ?? null : null
  const detailSummary = selectedBuyer ? summarizeBuyer(selectedBuyer, detailPurchases) : null

  const renderCard = (buyer: BuyerProfileSummary, accent: string) => {
    const match = matchesByBuyer.get(buyer.buyerKey) ?? null
    const purchases = (purchasesByBuyer.get(buyer.buyerKey) ?? []).slice().sort((left, right) => new Date(right.saleDate || 0).getTime() - new Date(left.saleDate || 0).getTime())
    const summary = summarizeBuyer(buyer, purchases)
    const score = match?.matchScore ?? temporaryMatchScoreFor(buyer, purchases, selectedPropertyType, selectedMarket, selectedZip)
    const tier = matchTierFor(score)
    const tone = toneForBuyer(buyer)
    const badges = buildBuyerCardBadges(buyer, score)
    const topMarkets = buyer.topMarkets.slice(0, paneWidth === '25' ? 1 : 3)
    const assetFocus = buyer.assetClassesBought.length > 0 ? buyer.assetClassesBought : buyer.propertyTypeFocus
    const distanceLabel =
      purchases.find((purchase) => Number.isFinite(purchase.distanceMiles ?? NaN))?.distanceMiles != null
        ? `${(purchases.find((purchase) => Number.isFinite(purchase.distanceMiles ?? NaN))?.distanceMiles ?? 0).toFixed(1)} mi`
        : '—'

    return (
      <article
        key={buyer.buyerKey}
        className={cls('nx-buyer-entity-card', `is-${tone}`, selectedBuyerKey === buyer.buyerKey && 'is-selected')}
        onClick={() => onSelectBuyerKey(buyer.buyerKey)}
      >
        <header className="nx-buyer-entity-card__header">
          <div className="nx-buyer-entity-card__identity">
            <div className="nx-buyer-entity-card__avatar">{initialsFor(buyer.buyerName)}</div>
            <div>
              <span className="nx-buyer-entity-card__eyebrow">{buyer.buyerType}</span>
              <strong>{buyer.buyerName}</strong>
              <small>{buyer.buyerKey}</small>
            </div>
          </div>
          <div className="nx-buyer-entity-card__header-badges">
            <span className={cls('nx-buyer-entity-card__badge', `is-${accent}`)}>{buyer.buyerGrade}</span>
            <span className="nx-buyer-entity-card__badge is-dark">{tier}</span>
          </div>
        </header>

        <div className="nx-buyer-entity-card__badge-row">
          {badges.slice(0, paneWidth === '25' ? 3 : 6).map((badge) => (
            <span key={badge} className="nx-buyer-entity-card__pill">{badge}</span>
          ))}
        </div>

        <div className="nx-buyer-entity-card__metric-grid is-primary">
          <div><span>Purchases</span><strong>{formatNumber(buyer.purchaseCount12mo)}</strong></div>
          <div><span>Total Spend</span><strong>{formatCompactMoney(summary.totalSpend)}</strong></div>
          <div><span>Avg Price</span><strong>{formatCompactMoney(buyer.avgPurchasePrice)}</strong></div>
          <div><span>Last Buy</span><strong>{buyer.lastPurchaseDate ? formatRelativeTime(buyer.lastPurchaseDate) : '—'}</strong></div>
        </div>

        <div className="nx-buyer-entity-card__metric-grid">
          <div><span>Avg PPSF</span><strong>{summary.avgPpsf ? formatNumber(summary.avgPpsf) : '—'}</strong></div>
          <div><span>Markets / ZIPs</span><strong>{[...topMarkets, ...buyer.topZips.slice(0, paneWidth === '25' ? 0 : 2)].join(' • ') || '—'}</strong></div>
          <div><span>Asset Focus</span><strong>{assetFocus.slice(0, 2).join(', ') || '—'}</strong></div>
          <div><span>Distance</span><strong>{distanceLabel}</strong></div>
        </div>

        <div className="nx-buyer-entity-card__score">
          <div className="nx-buyer-entity-card__score-head">
            <span>Buyer Match Score</span>
            <strong>{Math.round(score)}/100</strong>
          </div>
          <div className="nx-buyer-entity-card__score-bar">
            <div className="nx-buyer-entity-card__score-fill" style={{ width: `${Math.max(10, Math.min(100, score))}%` }} />
          </div>
          <small>{match?.reasonForMatch || buyer.buyerSummary}</small>
        </div>

        {paneWidth !== '25' && (
          <div className="nx-buyer-entity-card__footer">
            <button type="button" onClick={(event) => { event.stopPropagation(); onSelectBuyerKey(buyer.buyerKey) }}>View Purchase Trail</button>
            <button type="button" onClick={(event) => { event.stopPropagation(); onSelectBuyerKey(buyer.buyerKey) }}>Center Buyer Activity</button>
            <button type="button" onClick={(event) => { event.stopPropagation(); void safeCopy(`${buyer.buyerName} • ${buyer.buyerSummary}`) }}>Copy Buyer Summary</button>
            {paneWidth === '100' && <button type="button" onClick={(event) => { event.stopPropagation() }}>Find Similar Buyers</button>}
          </div>
        )}

        {paneWidth === '100' && (
          <div className="nx-buyer-entity-card__trail-preview">
            {purchases.slice(0, buyer.buyerKey === selectedBuyerKey ? 3 : 2).map((purchase) => (
              <div key={`${purchase.buyerKey}-${purchase.propertyId}`} className="nx-buyer-entity-card__trail-row">
                <span>{purchase.saleDate ? formatRelativeTime(purchase.saleDate) : 'Unknown'}</span>
                <strong>{purchase.propertyAddressFull}</strong>
                <small>{formatMoney(purchase.salePrice)} • {purchase.propertyType}</small>
              </div>
            ))}
          </div>
        )}
      </article>
    )
  }

  return (
    <section className={cls('nx-buyer-intel-workspace', widthClass, paneMode === 'multi' && 'is-multi-pane')}>
      <header className="nx-buyer-intel-hero">
        <div>
          <span className="nx-buyer-intel-hero__eyebrow">Buyer Match</span>
          <h2>Grouped buyer entities, live dispo fit, and purchase trail intelligence.</h2>
          <p>{selectedPropertyLabel || 'Property Unknown'} • {selectedMarket || 'Market Unknown'} • {selectedPropertyType || 'Property Unknown'} • ZIP {selectedZip || '—'}</p>
        </div>
        <div className="nx-buyer-intel-hero__stats">
          <div><span>Demand</span><strong>{buyerCommandData.summary?.demandLabel || 'Limited'}</strong></div>
          <div><span>Real Buyers</span><strong>{buyerCommandData.summary?.realBuyerCount ?? 0}</strong></div>
          <div><span>Repeat</span><strong>{buyerCommandData.summary?.repeatBuyerCount ?? 0}</strong></div>
          <div><span>Off-Market</span><strong>{buyerCommandData.summary?.offMarketBuyerCount ?? 0}</strong></div>
        </div>
      </header>

      <div className="nx-buyer-intel-toolbar">
        <div className="nx-buyer-intel-toolbar__group">
          {['', 'Corporate Buyer', 'Individual Buyer'].map((value) => (
            <button
              key={value || 'all-type'}
              type="button"
              className={cls('nx-buyer-intel-filter', buyerFilters.buyerType === value && 'is-active')}
              onClick={() => onBuyerFiltersChange((current) => ({ ...current, buyerType: value }))}
            >
              {value || 'All Buyer Types'}
            </button>
          ))}
        </div>
        <div className="nx-buyer-intel-toolbar__group">
          {['', 'A+', 'A', 'B', 'Watchlist', 'Noise'].map((value) => (
            <button
              key={value || 'all-tier'}
              type="button"
              className={cls('nx-buyer-intel-filter', buyerFilters.buyerTier === value && 'is-active')}
              onClick={() => onBuyerFiltersChange((current) => ({ ...current, buyerTier: value }))}
            >
              {value || 'All Grades'}
            </button>
          ))}
        </div>
      </div>

      <div className="nx-buyer-intel-grid">
        <div className="nx-buyer-intel-grid__stack">
          {sections.map((section) => (
            <section key={section.title} className="nx-buyer-intel-section">
              <div className="nx-buyer-intel-section__header">
                <strong>{section.title}</strong>
                <span>{section.buyers.length} buyers</span>
              </div>
              <div className="nx-buyer-intel-card-grid">
                {section.buyers.slice(0, paneWidth === '25' ? 2 : paneWidth === '50' ? 4 : 6).map((buyer) => renderCard(buyer, section.accent))}
              </div>
            </section>
          ))}
        </div>

        <aside className="nx-buyer-intel-detail">
          {selectedBuyer ? (
            <>
              <header className={cls('nx-buyer-intel-detail__hero', `is-${toneForBuyer(selectedBuyer)}`)}>
                <div className="nx-buyer-intel-detail__identity">
                  <div className="nx-buyer-intel-detail__avatar">{initialsFor(selectedBuyer.buyerName)}</div>
                  <div>
                    <span>{selectedBuyer.buyerType}</span>
                    <h3>{selectedBuyer.buyerName}</h3>
                    <p>{selectedBuyer.buyerKey}</p>
                  </div>
                </div>
                <div className="nx-buyer-intel-detail__badge-stack">
                  {buildBuyerCardBadges(selectedBuyer, selectedMatch?.matchScore ?? selectedBuyer.confidenceScore).slice(0, 6).map((badge) => (
                    <span key={badge}>{badge}</span>
                  ))}
                </div>
              </header>

              <section className="nx-buyer-intel-detail__section">
                <div className="nx-buyer-intel-detail__section-head">
                  <strong>Buyer Stats</strong>
                  <span>{selectedBuyer.lastPurchaseDate ? `Last buy ${formatRelativeTime(selectedBuyer.lastPurchaseDate)}` : 'No recent buy date'}</span>
                </div>
                <div className="nx-buyer-intel-detail__metrics">
                  <div><span>Purchase Count</span><strong>{formatNumber(selectedBuyer.purchaseCount12mo)}</strong></div>
                  <div><span>Recent Purchases</span><strong>{formatNumber(selectedBuyer.purchaseCount6mo)}</strong></div>
                  <div><span>Total Spend</span><strong>{formatCompactMoney(detailSummary?.totalSpend)}</strong></div>
                  <div><span>Avg Price</span><strong>{formatCompactMoney(selectedBuyer.avgPurchasePrice)}</strong></div>
                  <div><span>Median Price</span><strong>{formatCompactMoney(selectedBuyer.medianPurchasePrice)}</strong></div>
                  <div><span>Avg PPSF</span><strong>{detailSummary?.avgPpsf ? formatNumber(detailSummary.avgPpsf) : '—'}</strong></div>
                  <div><span>Markets Active</span><strong>{selectedBuyer.topMarkets.slice(0, 3).join(' • ') || '—'}</strong></div>
                  <div><span>Asset Classes</span><strong>{selectedBuyer.assetClassesBought.slice(0, 3).join(', ') || '—'}</strong></div>
                </div>
              </section>

              <section className="nx-buyer-intel-detail__section">
                <div className="nx-buyer-intel-detail__section-head">
                  <strong>Purchase Trail</strong>
                  <span>{detailPurchases.length} recent purchases</span>
                </div>
                <div className="nx-buyer-intel-detail__trail">
                  {detailPurchases.slice(0, paneWidth === '25' ? 4 : 8).map((purchase) => (
                    <article key={`${purchase.buyerKey}-${purchase.propertyId}`} className="nx-buyer-intel-trail-card">
                      <div className="nx-buyer-intel-trail-card__top">
                        <strong>{purchase.propertyAddressFull}</strong>
                        <span>{purchase.saleDate ? formatRelativeTime(purchase.saleDate) : 'Unknown date'}</span>
                      </div>
                      <div className="nx-buyer-intel-trail-card__meta">
                        <span>{formatMoney(purchase.salePrice)}</span>
                        <span>{purchase.propertyType}</span>
                        <span>{purchase.buyerBuyBoxSignal || 'General buy box'}</span>
                      </div>
                      <div className="nx-buyer-intel-trail-card__meta">
                        <span>{purchase.pricePerSqft ? `${formatMoney(purchase.pricePerSqft)} ppsf` : '—'}</span>
                        <span>{purchase.isOffMarketPurchase ? 'Off-Market / Public Record' : 'MLS'}</span>
                        <span>{purchase.distanceMiles != null ? `${purchase.distanceMiles.toFixed(1)} mi away` : 'Distance unavailable'}</span>
                      </div>
                    </article>
                  ))}
                  {detailPurchases.length === 0 && (
                    <p className="nx-workspace-card__body">No live purchase trail rows are available for the selected buyer in the current market window.</p>
                  )}
                </div>
              </section>

              <section className="nx-buyer-intel-detail__section">
                <div className="nx-buyer-intel-detail__section-head">
                  <strong>Market Footprint</strong>
                  <span>{selectedBuyer.topStates.slice(0, 3).join(' • ') || 'Single-state activity'}</span>
                </div>
                <div className="nx-buyer-intel-detail__footprint">
                  <div><span>Top Markets</span><strong>{selectedBuyer.topMarkets.join(' • ') || '—'}</strong></div>
                  <div><span>Top ZIPs</span><strong>{selectedBuyer.topZips.join(' • ') || '—'}</strong></div>
                  <div><span>States Active</span><strong>{selectedBuyer.topStates.join(' • ') || '—'}</strong></div>
                  <div><span>Market Density</span><strong>{selectedBuyer.marketsActive.join(' • ') || 'Focused buy box'}</strong></div>
                </div>
              </section>

              <section className="nx-buyer-intel-detail__section">
                <div className="nx-buyer-intel-detail__section-head">
                  <strong>Match Explanation</strong>
                  <span>{selectedMatch ? `${matchTierFor(selectedMatch.matchScore)} • ${selectedMatch.matchScore}/100` : 'Confidence fallback'}</span>
                </div>
                <div className="nx-buyer-intel-detail__explanation">
                  <div><span>Why Matched</span><strong>{selectedMatch?.reasonForMatch || selectedBuyer.buyerSummary}</strong></div>
                  <div><span>Distance</span><strong>{detailPurchases.find((purchase) => purchase.distanceMiles != null)?.distanceMiles != null ? `${(detailPurchases.find((purchase) => purchase.distanceMiles != null)?.distanceMiles ?? 0).toFixed(1)} mi` : '—'}</strong></div>
                  <div><span>Asset Fit</span><strong>{selectedBuyer.assetClassesBought.slice(0, 2).join(', ') || selectedPropertyType || '—'}</strong></div>
                  <div><span>Price Fit</span><strong>{formatCompactMoney(selectedMatch?.medianPurchasePrice ?? selectedBuyer.medianPurchasePrice)}</strong></div>
                  <div><span>Recency</span><strong>{detailSummary?.daysSinceLastPurchase != null ? `${detailSummary.daysSinceLastPurchase}d` : '—'}</strong></div>
                  <div><span>Risk Note</span><strong>{selectedBuyer.isRetailOrNoise ? 'Noise separated from active pool.' : 'Real buyer entity with recent activity.'}</strong></div>
                </div>
              </section>

              <section className="nx-buyer-intel-detail__section">
                <div className="nx-buyer-intel-detail__actions">
                  <button type="button" onClick={() => onSelectBuyerKey(selectedBuyer.buyerKey)}>Center Trail on Map</button>
                  <button type="button" onClick={() => onSelectBuyerKey(selectedBuyer.buyerKey)}>Show Only This Buyer</button>
                  <button type="button">Open Buyer Match</button>
                  <button type="button">Add to Dispo List</button>
                  <button type="button" onClick={() => void safeCopy(`${selectedBuyer.buyerName}\n${selectedBuyer.buyerSummary}`)}>Export Buyer Summary</button>
                </div>
              </section>
            </>
          ) : (
            <div className="nx-workspace-card">
              <div className="nx-workspace-card__title"><Icon name="users" /><span>Buyer Detail</span></div>
              <p className="nx-workspace-card__body">Select a buyer card to open the live buyer identity, purchase trail, footprint, and match explanation panel.</p>
            </div>
          )}
        </aside>
      </div>
    </section>
  )
}
