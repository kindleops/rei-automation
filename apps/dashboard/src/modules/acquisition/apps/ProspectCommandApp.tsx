import { useMemo, useState } from 'react'
import { pushRoutePath } from '../../../app/router'
import { Icon } from '../../../shared/icons'
import { AcquisitionAppShell } from '../components/AcquisitionAppShell'
import { ScoreBar, StatusPill } from '../components/AcquisitionComponents'
import { EmptyState } from '../components/AcquisitionComponents'
import { filterByMarket } from '../helpers'
import type { AcquisitionWorkspaceModel } from '../acquisition.types'

interface ProspectCommandAppProps {
  data: AcquisitionWorkspaceModel
}

const ProspectViews = ['Best Contacts', 'Decision Makers', 'Low Confidence', 'Missing Phone', 'Multilingual', 'Needs Verification', 'All Prospects']

const filterProspectsByView = (prospects: any[], view: string) => {
  const normalized = view.toLowerCase()
  if (normalized === 'best contacts') return prospects.filter((p) => p.contactProbability >= 80)
  if (normalized === 'decision makers') return prospects.filter((p) => p.relationshipType?.includes('Decision'))
  if (normalized === 'low confidence') return prospects.filter((p) => p.contactProbability < 40)
  if (normalized === 'missing phone') return prospects.filter((p) => !p.bestPhone)
  if (normalized === 'multilingual') return prospects.filter((p) => p.language && p.language !== 'English')
  if (normalized === 'needs verification') return prospects.filter((p) => p.outreachStatus?.includes('Unverified'))
  return prospects
}

export const ProspectCommandApp = ({ data }: ProspectCommandAppProps) => {
  const [selectedMarket, setSelectedMarket] = useState<string>(data.marketOptions[0] ?? 'All Markets')
  const [search, setSearch] = useState('')
  const [activeView, setActiveView] = useState('All Prospects')

  const filteredProspects = useMemo(() => {
    let results = filterByMarket(data.prospects, selectedMarket)
    results = filterProspectsByView(results, activeView)

    if (search.trim()) {
      const needle = search.toLowerCase()
      results = results.filter((prospect) =>
        [prospect.prospectName, prospect.ownerName, prospect.market].some((text) =>
          text?.toLowerCase().includes(needle),
        ),
      )
    }
    return results
  }, [data.prospects, selectedMarket, activeView, search])

  return (
    <AcquisitionAppShell
      breadcrumb="Prospect Command"
      appName="Prospect Command"
      appDescription="Contact and decision maker targeting"
      appStatus={`${filteredProspects.length} prospects`}
      marketOptions={data.marketOptions}
      selectedMarket={selectedMarket}
      onMarketChange={setSelectedMarket}
      search={search}
      onSearchChange={setSearch}
    >
      <div className="acq-app-body">
        <aside className="acq-filter-rail">
          <h3>Views</h3>
          <nav className="acq-view-nav">
            {ProspectViews.map((view) => (
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
          {filteredProspects.length > 0 ? (
            <div className="acq-table-wrapper">
              <table className="acq-table">
                <thead>
                  <tr>
                    <th>Prospect</th>
                    <th>Owner</th>
                    <th>Relationship</th>
                    <th>Phone</th>
                    <th>Email</th>
                    <th>Language</th>
                    <th>Contact Prob.</th>
                    <th>Status</th>
                    <th>Last Message</th>
                    <th className="acq-col-actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProspects.map((prospect) => (
                    <tr key={prospect.id} className="acq-table-row">
                      <td className="acq-col-name">
                        <strong>{prospect.prospectName}</strong>
                      </td>
                      <td>
                        <small>{prospect.ownerName}</small>
                      </td>
                      <td>
                        <small>{prospect.relationshipType}</small>
                      </td>
                      <td>
                        <small>{prospect.bestPhone || '—'}</small>
                      </td>
                      <td>
                        <small>{prospect.bestEmail || '—'}</small>
                      </td>
                      <td>{prospect.language}</td>
                      <td className="acq-col-score">
                        <ScoreBar value={prospect.contactProbability} />
                      </td>
                      <td>
                        <StatusPill value={prospect.outreachStatus} />
                      </td>
                      <td>
                        <small>{prospect.lastMessage}</small>
                      </td>
                      <td className="acq-col-actions">
                        <div className="acq-row-actions">
                          <button type="button" title="Contact">
                          <Icon name="send" />
                        </button>
                        <button type="button" title="Message" onClick={() => pushRoutePath('/acquisition/inbox')}>
                          <Icon name="message" />
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
              title="No prospects found"
              detail="No prospects match your search and filters."
            />
          )}
        </main>
      </div>
    </AcquisitionAppShell>
  )
}
