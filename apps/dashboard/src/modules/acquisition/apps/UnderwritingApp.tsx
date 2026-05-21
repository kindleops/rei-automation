import { useMemo, useState } from 'react'
import { pushRoutePath } from '../../../app/router'
import { Icon } from '../../../shared/icons'
import { AcquisitionAppShell } from '../components/AcquisitionAppShell'
import { ScoreBar, EmptyState } from '../components/AcquisitionComponents'
import { currency } from '../helpers'
import type { AcquisitionWorkspaceModel } from '../acquisition.types'

interface UnderwritingAppProps {
  data: AcquisitionWorkspaceModel
}

const UnderwritingViews = ['Cash Offers', 'Creative Finance', 'Novation', 'Multifamily', 'Repair Heavy', 'High Equity', 'All']

const filterUnderwritingByView = (underwriting: any[], view: string) => {
  const normalized = view.toLowerCase()
  if (normalized === 'cash offers') return underwriting.filter((u) => u.cashOffer > 0 && !u.creativeOffer)
  if (normalized === 'creative finance') return underwriting.filter((u) => u.creativeOffer > 0)
  if (normalized === 'novation') return underwriting.filter((u) => u.novationPath?.length > 0)
  if (normalized === 'multifamily') return underwriting.filter((u) => u.multiNoi && u.multiNoi > 0)
  if (normalized === 'repair heavy') return underwriting.filter((u) => u.repairEstimate > 50000)
  if (normalized === 'high equity') return underwriting.filter((u) => u.equity > 200000)
  return underwriting
}

export const UnderwritingApp = ({ data }: UnderwritingAppProps) => {
  const [search, setSearch] = useState('')
  const [activeView, setActiveView] = useState('All')

  const filteredUnderwriting = useMemo(() => {
    let results = filterUnderwritingByView(data.underwriting, activeView)
    if (search.trim()) {
      const needle = search.toLowerCase()
      results = results.filter((u) => u.propertyAddress?.toLowerCase().includes(needle))
    }
    return results
  }, [data.underwriting, activeView, search])

  return (
    <AcquisitionAppShell
      breadcrumb="Underwriting"
      appName="Underwriting"
      appDescription="Property valuation and deal analysis"
      appStatus={`${filteredUnderwriting.length} properties`}
      search={search}
      onSearchChange={setSearch}
    >
      <div className="acq-app-body">
        <aside className="acq-filter-rail">
          <h3>Deal Types</h3>
          <nav className="acq-view-nav">
            {UnderwritingViews.map((view) => (
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
          {filteredUnderwriting.length > 0 ? (
            <div className="acq-underwriting-grid">
              {filteredUnderwriting.map((uw) => (
                <article key={uw.id} className="acq-underwriting-card">
                  <header className="acq-card-header">
                    <h3>{uw.propertyAddress}</h3>
                    <small>{uw.id.slice(0, 8)}</small>
                  </header>

                  <div className="acq-card-metrics">
                    <div className="acq-metric">
                      <span>ARV</span>
                      <strong>{currency(uw.arv)}</strong>
                    </div>
                    <div className="acq-metric">
                      <span>After Repairs</span>
                      <strong>-{currency(uw.repairEstimate)}</strong>
                    </div>
                    <div className="acq-metric">
                      <span>MAO</span>
                      <strong>{currency(uw.mao)}</strong>
                    </div>
                  </div>

                  <div className="acq-card-offers">
                    {uw.cashOffer > 0 && (
                      <div className="acq-offer-option">
                        <span>Cash</span>
                        <strong>{currency(uw.cashOffer)}</strong>
                      </div>
                    )}
                    {uw.creativeOffer > 0 && (
                      <div className="acq-offer-option">
                        <span>Creative</span>
                        <strong>{currency(uw.creativeOffer)}</strong>
                      </div>
                    )}
                  </div>

                  <div className="acq-card-confidence">
                    <ScoreBar value={uw.aiValuationConfidence} />
                    <small>{Math.round(uw.aiValuationConfidence)}% confident</small>
                  </div>

                  {uw.riskNotes && (
                    <p className="acq-card-note" title={uw.riskNotes}>
                      ⚠ {uw.riskNotes}
                    </p>
                  )}

                  <div className="acq-card-actions">
                    <button type="button" onClick={() => pushRoutePath('/acquisition/offers')}>
                      <Icon name="file-text" />
                      Generate Offer
                    </button>
                    <button type="button">
                      <Icon name="chevron-right" />
                      Export
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No underwriting found"
              detail="No properties match your search and filters."
            />
          )}
        </main>
      </div>
    </AcquisitionAppShell>
  )
}
