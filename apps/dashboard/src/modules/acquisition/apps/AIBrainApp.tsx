import { useMemo, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { AcquisitionAppShell } from '../components/AcquisitionAppShell'
import { ScoreBar, EmptyState } from '../components/AcquisitionComponents'
import type { AcquisitionWorkspaceModel } from '../acquisition.types'

interface AIBrainAppProps {
  data: AcquisitionWorkspaceModel
}

const AIViews = ['Intent Detected', 'Objections', 'Follow-Up Recommendations', 'Template Suggestions', 'Agent Performance', 'Sentiment Shifts']

const filterAIPByView = (aiBrain: any[], view: string) => {
  const normalized = view.toLowerCase()
  if (normalized === 'intent detected') return aiBrain.filter((a) => a.sellerIntent?.length > 0)
  if (normalized === 'objections') return aiBrain.filter((a) => a.objections?.length > 0)
  if (normalized === 'agent performance') return aiBrain.filter((a) => a.agentAssigned?.length > 0)
  if (normalized === 'sentiment shifts') return aiBrain.filter((a) => a.sentiment)
  return aiBrain
}

export const AIBrainApp = ({ data }: AIBrainAppProps) => {
  const [search, setSearch] = useState('')
  const [activeView, setActiveView] = useState('Intent Detected')

  const filteredAI = useMemo(() => {
    let results = filterAIPByView(data.aiBrain, activeView)
    if (search.trim()) {
      const needle = search.toLowerCase()
      results = results.filter((ai) => ai.ownerName?.toLowerCase().includes(needle))
    }
    return results
  }, [data.aiBrain, activeView, search])

  return (
    <AcquisitionAppShell
      breadcrumb="AI Brain"
      appName="AI Brain"
      appDescription="Conversation intelligence and acquisition insights"
      appStatus={`${filteredAI.length} conversations`}
      search={search}
      onSearchChange={setSearch}
    >
      <div className="acq-app-body">
        <aside className="acq-filter-rail">
          <h3>Views</h3>
          <nav className="acq-view-nav">
            {AIViews.map((view) => (
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
          {filteredAI.length > 0 ? (
            <div className="acq-ai-grid">
              {filteredAI.map((ai) => (
                <article key={ai.id} className="acq-ai-card">
                  <header className="acq-card-header">
                    <h3>{ai.ownerName}</h3>
                    <span className="acq-ai-confidence">
                      <ScoreBar value={ai.aiConfidence} />
                    </span>
                  </header>

                  <div className="acq-ai-insights">
                    {ai.sellerIntent && (
                      <div className="acq-ai-item">
                        <span className="acq-ai-label">Intent</span>
                        <p>{ai.sellerIntent}</p>
                      </div>
                    )}

                    {ai.sentiment && (
                      <div className="acq-ai-item">
                        <span className="acq-ai-label">Sentiment</span>
                        <p>{ai.sentiment}</p>
                      </div>
                    )}

                    {ai.conversationStage && (
                      <div className="acq-ai-item">
                        <span className="acq-ai-label">Stage</span>
                        <p>{ai.conversationStage}</p>
                      </div>
                    )}

                    {ai.language && (
                      <div className="acq-ai-item">
                        <span className="acq-ai-label">Language</span>
                        <p>{ai.language}</p>
                      </div>
                    )}

                    {ai.objections && (
                      <div className="acq-ai-item">
                        <span className="acq-ai-label">Objections</span>
                        <p>{ai.objections}</p>
                      </div>
                    )}

                    {ai.templateRecommendation && (
                      <div className="acq-ai-item">
                        <span className="acq-ai-label">Template</span>
                        <p>{ai.templateRecommendation}</p>
                      </div>
                    )}

                    {ai.recommendedNextAction && (
                      <div className="acq-ai-item">
                        <span className="acq-ai-label">Next Action</span>
                        <p>{ai.recommendedNextAction}</p>
                      </div>
                    )}
                  </div>

                  {ai.agentAssigned && (
                    <p className="acq-ai-agent">
                      <Icon name="users" />
                      {ai.agentAssigned}
                    </p>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No AI insights found"
              detail="No conversations match your search and filters."
            />
          )}
        </main>
      </div>
    </AcquisitionAppShell>
  )
}
