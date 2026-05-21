import { useMemo, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { AcquisitionAppShell } from '../components/AcquisitionAppShell'
import { StatusPill, EmptyState } from '../components/AcquisitionComponents'
import type { AcquisitionWorkspaceModel } from '../acquisition.types'

interface AutomationMonitorAppProps {
  data: AcquisitionWorkspaceModel
}

const AutomationViews = ['Feeder', 'Queue Runner', 'Retry Engine', 'Reconcile', 'Inbound Webhook', 'Delivery Webhook', 'AI Drafts', 'Template Resolver', 'Compliance', 'All']

const filterAutomationsByView = (automations: any[], view: string) => {
  const normalized = view.toLowerCase()
  if (normalized === 'all') return automations
  return automations.filter((a) => a.name?.toLowerCase().includes(normalized))
}

export const AutomationMonitorApp = ({ data }: AutomationMonitorAppProps) => {
  const [search, setSearch] = useState('')
  const [activeView, setActiveView] = useState('All')

  const filteredAutomations = useMemo(() => {
    let results = filterAutomationsByView(data.automations, activeView)
    if (search.trim()) {
      const needle = search.toLowerCase()
      results = results.filter((a) => a.name?.toLowerCase().includes(needle))
    }
    return results
  }, [data.automations, activeView, search])

  const healthyCount = filteredAutomations.filter((a) => a.status === 'healthy').length
  const watchCount = filteredAutomations.filter((a) => a.status === 'watch').length
  const criticalCount = filteredAutomations.filter((a) => a.status === 'critical').length

  return (
    <AcquisitionAppShell
      breadcrumb="Automation Monitor"
      appName="Automation Monitor"
      appDescription="Feeder and background job health monitoring"
      appStatus={`${filteredAutomations.length} automations`}
      search={search}
      onSearchChange={setSearch}
    >
      <div className="acq-app-body">
        <aside className="acq-filter-rail">
          <h3>Automations</h3>
          <nav className="acq-view-nav">
            {AutomationViews.map((view) => (
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

          <div className="acq-health-summary">
            <h4>Health Summary</h4>
            <div className="acq-health-items">
              <div className="acq-health-item is-good">
                <strong>{healthyCount}</strong>
                <span>Healthy</span>
              </div>
              <div className="acq-health-item is-warn">
                <strong>{watchCount}</strong>
                <span>Watch</span>
              </div>
              <div className="acq-health-item is-critical">
                <strong>{criticalCount}</strong>
                <span>Critical</span>
              </div>
            </div>
          </div>
        </aside>

        <main className="acq-app-main">
          {filteredAutomations.length > 0 ? (
            <div className="acq-automation-grid">
              {filteredAutomations.map((automation) => (
                <article key={automation.id} className="acq-automation-card">
                  <header className="acq-card-header">
                    <h3>{automation.name}</h3>
                    <StatusPill value={automation.status} />
                  </header>

                  <div className="acq-automation-details">
                    {automation.failedJobs > 0 && (
                      <div className="acq-detail-item">
                        <Icon name="alert" />
                        <span>{automation.failedJobs} failed jobs</span>
                      </div>
                    )}
                    <div className="acq-detail-item">
                      <Icon name="clock" />
                      <span>Last run: {automation.lastRun}</span>
                    </div>
                    {automation.detail && (
                      <div className="acq-detail-item">
                        <Icon name="briefing" />
                        <span>{automation.detail}</span>
                      </div>
                    )}
                  </div>

                  <div className="acq-card-actions">
                    <button type="button">
                      <Icon name="play" />
                      Run Now
                    </button>
                    <button type="button">
                      <Icon name="activity" />
                      View Logs
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No automations found"
              detail="No automations match your search and filters."
            />
          )}
        </main>
      </div>
    </AcquisitionAppShell>
  )
}
