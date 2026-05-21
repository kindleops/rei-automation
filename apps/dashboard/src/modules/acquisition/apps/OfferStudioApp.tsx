import { useMemo, useState } from 'react'
import { pushRoutePath } from '../../../app/router'
import { Icon } from '../../../shared/icons'
import { AcquisitionAppShell } from '../components/AcquisitionAppShell'
import { ScoreBar, StatusPill, EmptyState } from '../components/AcquisitionComponents'
import { currency } from '../helpers'
import type { AcquisitionWorkspaceModel, AcquisitionOffer } from '../acquisition.types'

interface OfferStudioAppProps {
  data: AcquisitionWorkspaceModel
}

const OfferViews = ['Offers Ready', 'Draft Offers', 'Sent Offers', 'Seller Countered', 'Needs Underwriting', 'Contract Ready', 'All Offers']

const filterOffersByView = (offers: AcquisitionOffer[], view: string) => {
  const normalized = view.toLowerCase()
  if (normalized === 'offers ready') return offers.filter((o) => o.offerStatus === 'Ready')
  if (normalized === 'draft offers') return offers.filter((o) => o.offerStatus === 'Draft')
  if (normalized === 'sent offers') return offers.filter((o) => o.offerStatus === 'Sent')
  if (normalized === 'seller countered') return offers.filter((o) => o.offerStatus === 'Countered')
  if (normalized === 'needs underwriting') return offers.filter((o) => o.offerStatus === 'Needs Review')
  if (normalized === 'contract ready') return offers.filter((o) => o.offerStatus === 'Contract Ready')
  return offers
}

export const OfferStudioApp = ({ data }: OfferStudioAppProps) => {
  const [selectedMarket, setSelectedMarket] = useState<string>(data.marketOptions[0] ?? 'All Markets')
  const [search, setSearch] = useState('')
  const [activeView, setActiveView] = useState('All Offers')

  const filteredOffers = useMemo(() => {
    let results = data.offers
    if (selectedMarket !== 'All Markets') {
      results = results.filter((o) => {
        const propOwnerIds = new Set(data.owners.filter((owner) => owner.market === selectedMarket).map((o) => o.id))
        return propOwnerIds.has(o.ownerId)
      })
    }
    results = filterOffersByView(results, activeView)

    if (search.trim()) {
      const needle = search.toLowerCase()
      results = results.filter((offer) =>
        [offer.propertyAddress, offer.ownerName].some((text) =>
          text?.toLowerCase().includes(needle),
        ),
      )
    }
    return results
  }, [data.offers, selectedMarket, activeView, search])

  return (
    <AcquisitionAppShell
      breadcrumb="Offer Studio"
      appName="Offer Studio"
      appDescription="Deal generation and offer management"
      appStatus={`${filteredOffers.length} offers`}
      marketOptions={data.marketOptions}
      selectedMarket={selectedMarket}
      onMarketChange={setSelectedMarket}
      search={search}
      onSearchChange={setSearch}
      actions={[
        {
          label: 'Generate Offer',
          icon: 'plus',
          onClick: () => console.log('Generate offer'),
        },
      ]}
    >
      <div className="acq-app-body">
        <aside className="acq-filter-rail">
          <h3>Views</h3>
          <nav className="acq-view-nav">
            {OfferViews.map((view) => (
              <button
                key={view}
                type="button"
                className={activeView === view ? 'is-active' : ''}
                onClick={() => {
                  setActiveView(view)
                  setSearch('')
                }}
              >
                {view}
              </button>
            ))}
          </nav>
        </aside>

        <main className="acq-app-main">
          {filteredOffers.length > 0 ? (
            <div className="acq-table-wrapper">
              <table className="acq-table">
                <thead>
                  <tr>
                    <th>Offer ID</th>
                    <th>Property</th>
                    <th>Owner</th>
                    <th>Strategy</th>
                    <th>Recommended</th>
                    <th>Asking Price</th>
                    <th>Spread</th>
                    <th>Confidence</th>
                    <th>Status</th>
                    <th className="acq-col-actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredOffers.map((offer) => {
                    const spread = offer.sellerAskingPrice - offer.recommendedOffer
                    const spreadPercent = (spread / offer.sellerAskingPrice) * 100
                    return (
                      <tr key={offer.id} className="acq-table-row">
                        <td className="acq-col-name">
                          <strong>{offer.id.slice(0, 8)}</strong>
                        </td>
                        <td>
                          <small>{offer.propertyAddress}</small>
                        </td>
                        <td>
                          <small>{offer.ownerName}</small>
                        </td>
                        <td>{offer.strategy}</td>
                        <td className="acq-col-number">{currency(offer.recommendedOffer)}</td>
                        <td className="acq-col-number">{currency(offer.sellerAskingPrice)}</td>
                        <td className="acq-col-number">
                          <strong>{spreadPercent.toFixed(1)}%</strong>
                        </td>
                        <td className="acq-col-score">
                          <ScoreBar value={offer.confidence} />
                        </td>
                        <td>
                          <StatusPill value={offer.offerStatus} />
                        </td>
                        <td className="acq-col-actions">
                          <div className="acq-row-actions">
                            <button type="button" title="Send">
                              <Icon name="send" />
                            </button>
                            <button type="button" title="Underwrite" onClick={() => pushRoutePath('/acquisition/underwriting')}>
                              <Icon name="trending-up" />
                            </button>
                            <button type="button" title="Contract">
                              <Icon name="file-text" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              title="No offers found"
              detail="No offers match your search and filters."
            />
          )}
        </main>
      </div>
    </AcquisitionAppShell>
  )
}
