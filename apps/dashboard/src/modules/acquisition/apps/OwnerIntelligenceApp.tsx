import { useMemo, useState } from 'react'
import { pushRoutePath } from '../../../app/router'
import { Icon } from '../../../shared/icons'
import { AcquisitionAppShell } from '../components/AcquisitionAppShell'
import { ScoreBar, StatusPill } from '../components/AcquisitionComponents'
import { EmptyState } from '../components/AcquisitionComponents'
import { filterByMarket, currency } from '../helpers'
import type { AcquisitionWorkspaceModel, AcquisitionOwner, AcquisitionRecordType } from '../acquisition.types'

interface OwnerIntelligenceAppProps {
  data: AcquisitionWorkspaceModel
}

const OwnerViews = [
  'Hot Owners',
  'Portfolio Owners',
  'High Equity',
  'Distressed',
  'Out of State',
  'Corporate',
  'Needs Action',
  'Recently Replied',
  'All Owners',
]

const filterOwnersByView = (owners: AcquisitionOwner[], view: string): AcquisitionOwner[] => {
  const normalized = view.toLowerCase()
  if (normalized === 'hot owners') return owners.filter((o) => o.motivationScore >= 70)
  if (normalized === 'portfolio owners') return owners.filter((o) => o.portfolioCount > 1)
  if (normalized === 'high equity') return owners.filter((o) => o.equityEstimate > 100000)
  if (normalized === 'distressed') return owners.filter((o) => o.motivationScore && o.motivationScore < 40)
  if (normalized === 'out of state') return owners.filter((o) => o.state !== 'CA')
  if (normalized === 'corporate') return owners.filter((o) => o.ownerType.toLowerCase().includes('corporate'))
  if (normalized === 'needs action') return owners.filter((o) => o.nextAction?.length > 0)
  if (normalized === 'recently replied') return owners.filter((o) => o.lastActivity && o.lastActivity.includes('ago'))
  return owners
}

export const OwnerIntelligenceApp = ({ data }: OwnerIntelligenceAppProps) => {
  const [selectedMarket, setSelectedMarket] = useState<string>(data.marketOptions[0] ?? 'All Markets')
  const [search, setSearch] = useState('')
  const [activeView, setActiveView] = useState('All Owners')
  const filteredOwners = useMemo(() => {
    let results = filterByMarket(data.owners, selectedMarket)
    results = filterOwnersByView(results, activeView)

    if (search.trim()) {
      const needle = search.toLowerCase()
      results = results.filter((owner) =>
        [owner.ownerName, owner.market, owner.status, owner.nextAction, owner.ownerType].some((text) =>
          text?.toLowerCase().includes(needle),
        ),
      )
    }

    return results
  }, [data.owners, selectedMarket, activeView, search])

  const openOwnerRecord = async (type: AcquisitionRecordType, id: string) => {
    // Drawer is managed by AcquisitionAppShell
    console.log('Open record:', type, id)
  }

  return (
    <AcquisitionAppShell
      breadcrumb="Owner Intelligence"
      appName="Owner Intelligence"
      appDescription="Seller inventory and motivation analysis"
      appStatus={`${filteredOwners.length} owners`}
      marketOptions={data.marketOptions}
      selectedMarket={selectedMarket}
      onMarketChange={setSelectedMarket}
      search={search}
      onSearchChange={setSearch}
      actions={[
        {
          label: 'Export',
          icon: 'download',
          onClick: () => console.log('Export owners'),
        },
        {
          label: 'Bulk Action',
          icon: 'layers',
          onClick: () => console.log('Bulk action'),
        },
      ]}
    >
      <div className="acq-app-body">
        <aside className="acq-filter-rail">
          <h3>Views</h3>
          <nav className="acq-view-nav">
            {OwnerViews.map((view) => (
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
          {filteredOwners.length > 0 ? (
            <div className="acq-table-wrapper">
              <table className="acq-table">
                <thead>
                  <tr>
                    <th>Owner</th>
                    <th>Type</th>
                    <th>Market</th>
                    <th>Portfolio</th>
                    <th>Value</th>
                    <th>Motivation</th>
                    <th>Contact Prob.</th>
                    <th>Status</th>
                    <th>Last Activity</th>
                    <th>Next Action</th>
                    <th className="acq-col-actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredOwners.map((owner) => (
                    <tr key={owner.id} className="acq-table-row" onClick={() => openOwnerRecord('owner', owner.id)}>
                      <td className="acq-col-name">
                        <strong>{owner.ownerName}</strong>
                      </td>
                      <td>
                        <small>{owner.ownerType}</small>
                      </td>
                      <td>{owner.market}</td>
                      <td className="acq-col-number">{owner.portfolioCount}</td>
                      <td className="acq-col-number">{owner.estimatedPortfolioValue > 0 ? currency(owner.estimatedPortfolioValue) : '—'}</td>
                      <td className="acq-col-score">
                        <ScoreBar value={owner.motivationScore} tone={owner.motivationScore >= 70 ? 'good' : owner.motivationScore <= 35 ? 'critical' : 'warn'} />
                      </td>
                      <td className="acq-col-score">
                        <ScoreBar value={owner.contactProbability} tone={owner.contactProbability >= 70 ? 'good' : owner.contactProbability <= 35 ? 'critical' : 'warn'} />
                      </td>
                      <td>
                        <StatusPill value={owner.status} />
                      </td>
                      <td>
                        <small>{owner.lastActivity}</small>
                      </td>
                      <td>
                        <small className="acq-next-action">{owner.nextAction}</small>
                      </td>
                      <td className="acq-col-actions">
                        <div className="acq-row-actions" onClick={(e) => e.stopPropagation()}>
                          <button type="button" title="Open owner" onClick={() => openOwnerRecord('owner', owner.id)}>
                            <Icon name="arrow-up-right" />
                          </button>
                          <button type="button" title="Open inbox" onClick={() => pushRoutePath('/acquisition/inbox')}>
                            <Icon name="inbox" />
                          </button>
                          <button type="button" title="Generate offer" onClick={() => pushRoutePath('/acquisition/offers')}>
                            <Icon name="file-text" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              title="No owners found"
              detail={`No owners match your search and filters. Try adjusting your market selection or search query.`}
            />
          )}
        </main>
      </div>
    </AcquisitionAppShell>
  )
}
