import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BuyerMatchPaneWidth, BuyerMatchSubjectContext, BuyerMatchV4Projection, BuyerMatchV4ShellState, BuyerMatchV4Tab } from './buyer-match-v4.types'
import { INITIAL_SHELL_STATE } from './buyer-match-v4.types'
import { BuyerMarketRail } from './BuyerMarketRail'
import { BuyerActivityMap } from './BuyerActivityMap'
import { RankedBuyerPanel } from './RankedBuyerPanel'
import { BuyerMatchCompactRail } from './BuyerMatchCompactRail'
import { subjectContextKey } from './buildSubjectContext'

const TABS: BuyerMatchV4Tab[] = ['MARKET', 'BUYERS', 'ACTIVITY', 'SHORTLIST']

interface Props {
  subject: BuyerMatchSubjectContext
  projection: BuyerMatchV4Projection | null
  loading: boolean
  refreshing: boolean
  paneWidth: BuyerMatchPaneWidth
  onOpenFull?: () => void
}

export function BuyerMatchV4Shell({
  subject,
  projection,
  loading,
  refreshing,
  paneWidth,
  onOpenFull,
}: Props) {
  const [shellState, setShellState] = useState<BuyerMatchV4ShellState>(INITIAL_SHELL_STATE)
  const subjectKey = subjectContextKey(subject)

  useEffect(() => {
    setShellState((prev) => ({
      ...prev,
      selectedBuyerId: null,
      selectedEventId: null,
      shortlist: [],
    }))
  }, [subjectKey])

  const setTab = useCallback((activeTab: BuyerMatchV4Tab) => {
    setShellState((s) => ({ ...s, activeTab }))
  }, [])

  const selectBuyer = useCallback((buyerId: string) => {
    setShellState((s) => ({ ...s, selectedBuyerId: buyerId, activeTab: 'BUYERS' }))
  }, [])

  const selectEvent = useCallback((eventId: string, buyerId: string) => {
    setShellState((s) => ({ ...s, selectedEventId: eventId, selectedBuyerId: buyerId }))
  }, [])

  const toggleMap = useCallback(() => {
    setShellState((s) => ({ ...s, mapVisible: !s.mapVisible }))
  }, [])

  const nav = (
    <nav className="bmv4-nav" aria-label="Buyer Match navigation">
      {TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          className={`bmv4-nav__tab${shellState.activeTab === tab ? ' is-active' : ''}`}
          onClick={() => setTab(tab)}
        >
          {tab}
          {tab === 'SHORTLIST' && <span className="bmv4-nav__count">0</span>}
        </button>
      ))}
    </nav>
  )

  const shortlistPanel = (
    <section className="bmv4-shortlist bmv4-shortlist--empty">
      <h3>Shortlist</h3>
      <p>No buyers shortlisted yet. Shortlist persistence arrives in a later phase.</p>
    </section>
  )

  const activityPanel = useMemo(
    () => (
      <BuyerActivityMap
        projection={projection}
        selectedBuyerId={shellState.selectedBuyerId}
        selectedEventId={shellState.selectedEventId}
        onSelectEvent={selectEvent}
      />
    ),
    [projection, shellState.selectedBuyerId, shellState.selectedEventId, selectEvent],
  )

  if (paneWidth === '25') {
    return (
      <div className="bmv4-shell is-pane-25">
        <BuyerMatchCompactRail projection={projection} onOpenFull={onOpenFull ?? (() => {})} />
      </div>
    )
  }

  if (paneWidth === '50') {
    return (
      <div className="bmv4-shell is-pane-50">
        <header className="bmv4-compact-header">
          <div className="bmv4-compact-header__addr">{subject.canonicalAddress}</div>
          {nav}
          <button type="button" className={`bmv4-map-toggle${shellState.mapVisible ? ' is-active' : ''}`} onClick={toggleMap}>
            {shellState.mapVisible ? 'Hide Activity Map' : 'Activity Map'}
          </button>
        </header>
        {shellState.mapVisible && <div className="bmv4-shell__map-panel">{activityPanel}</div>}
        <div className="bmv4-shell__main">
          {shellState.activeTab === 'MARKET' && (
            <BuyerMarketRail subject={subject} projection={projection} loading={loading} refreshing={refreshing} compact />
          )}
          {shellState.activeTab === 'BUYERS' && (
            <RankedBuyerPanel
              projection={projection}
              loading={loading}
              selectedBuyerId={shellState.selectedBuyerId}
              gradeFilter={shellState.gradeFilter}
              onSelectBuyer={selectBuyer}
              onGradeFilter={(gradeFilter) => setShellState((s) => ({ ...s, gradeFilter }))}
            />
          )}
          {shellState.activeTab === 'ACTIVITY' && activityPanel}
          {shellState.activeTab === 'SHORTLIST' && shortlistPanel}
        </div>
      </div>
    )
  }

  if (paneWidth === '75') {
    return (
      <div className="bmv4-shell is-pane-75">
        <header className="bmv4-compact-header is-sticky">
          <BuyerMarketRail subject={subject} projection={projection} loading={loading} refreshing={refreshing} compact />
        </header>
        <div className="bmv4-shell__split">
          <div className="bmv4-shell__map-col">{activityPanel}</div>
          <div className="bmv4-shell__buyers-col">
            {nav}
            {shellState.activeTab === 'BUYERS' || shellState.activeTab === 'MARKET' ? (
              <RankedBuyerPanel
                projection={projection}
                loading={loading}
                selectedBuyerId={shellState.selectedBuyerId}
                gradeFilter={shellState.gradeFilter}
                onSelectBuyer={selectBuyer}
                onGradeFilter={(gradeFilter) => setShellState((s) => ({ ...s, gradeFilter }))}
              />
            ) : shellState.activeTab === 'ACTIVITY' ? (
              activityPanel
            ) : (
              shortlistPanel
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="bmv4-shell is-pane-100">
      <BuyerMarketRail subject={subject} projection={projection} loading={loading} refreshing={refreshing} />
      <div className="bmv4-shell__center">
        {nav}
        {shellState.activeTab === 'ACTIVITY' || shellState.activeTab === 'MARKET' ? activityPanel : null}
        {shellState.activeTab === 'SHORTLIST' && shortlistPanel}
      </div>
      <div className="bmv4-shell__buyers">
        {(shellState.activeTab === 'BUYERS' || shellState.activeTab === 'MARKET') && (
          <RankedBuyerPanel
            projection={projection}
            loading={loading}
            selectedBuyerId={shellState.selectedBuyerId}
            gradeFilter={shellState.gradeFilter}
            onSelectBuyer={selectBuyer}
            onGradeFilter={(gradeFilter) => setShellState((s) => ({ ...s, gradeFilter }))}
          />
        )}
        {shellState.activeTab === 'BUYERS' && shellState.selectedBuyerId && (
          <div className="bmv4-selected-note">Selected buyer — full dossier arrives in Phase 9.</div>
        )}
      </div>
    </div>
  )
}