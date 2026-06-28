import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  BuyerMatchPaneWidth,
  BuyerMatchSubjectContext,
  BuyerMatchV4Projection,
  BuyerMatchV4ShellState,
  BuyerMatchV4Tab,
} from './buyer-match-v4.types'
import {
  INITIAL_FILTER_STATE,
  INITIAL_SHELL_STATE,
  TAB_LAYOUT_COLUMNS,
} from './buyer-match-v4.types'
import { BuyerMarketRail } from './BuyerMarketRail'
import { BuyerActivityMap } from './BuyerActivityMap'
import { BuyerMatchCompactRail } from './BuyerMatchCompactRail'
import { BuyerTabNav } from './BuyerTabNav'
import { BuyerFiltersRail } from './BuyerFiltersRail'
import { BuyerDirectory } from './BuyerDirectory'
import { BuyerDossier } from './BuyerDossier'
import { ActivityControlsRail } from './ActivityControlsRail'
import { PurchaseFeed } from './PurchaseFeed'
import { MarketIntelligenceRail } from './MarketIntelligenceRail'
import { ShortlistPanel } from './ShortlistPanel'
import { filterPurchaseEvents } from './buyerFilters'
import { subjectContextKey } from './buildSubjectContext'

interface Props {
  subject: BuyerMatchSubjectContext
  projection: BuyerMatchV4Projection | null
  loading: boolean
  refreshing: boolean
  error: string | null
  timedOut: boolean
  paneWidth: BuyerMatchPaneWidth
  onOpenFull?: () => void
  onRetry?: () => void
}

export function BuyerMatchV4Shell({
  subject,
  projection,
  loading,
  refreshing,
  error,
  timedOut,
  paneWidth,
  onOpenFull,
  onRetry,
}: Props) {
  const [shellState, setShellState] = useState<BuyerMatchV4ShellState>(INITIAL_SHELL_STATE)
  const subjectKey = subjectContextKey(subject)

  useEffect(() => {
    setShellState((prev) => ({
      ...INITIAL_SHELL_STATE,
      activeTab: prev.activeTab,
    }))
  }, [subjectKey])

  const setTab = useCallback((activeTab: BuyerMatchV4Tab) => {
    setShellState((s) => ({ ...s, activeTab }))
  }, [])

  const selectBuyer = useCallback((buyerId: string) => {
    setShellState((s) => ({
      ...s,
      selectedBuyerId: buyerId,
    }))
  }, [])

  const selectEvent = useCallback((eventId: string, buyerId: string) => {
    setShellState((s) => ({
      ...s,
      selectedEventId: eventId,
      selectedBuyerId: buyerId,
    }))
  }, [])

  const toggleShortlist = useCallback((buyerId: string) => {
    setShellState((s) => ({
      ...s,
      shortlistIds: s.shortlistIds.includes(buyerId)
        ? s.shortlistIds.filter((id) => id !== buyerId)
        : [...s.shortlistIds, buyerId],
    }))
  }, [])

  const selectedBuyer = useMemo(
    () => projection?.rankedBuyers.find((b) => b.buyerId === shellState.selectedBuyerId) ?? null,
    [projection?.rankedBuyers, shellState.selectedBuyerId],
  )

  const shortlistedBuyers = useMemo(
    () => (projection?.rankedBuyers ?? []).filter((b) => shellState.shortlistIds.includes(b.buyerId)),
    [projection?.rankedBuyers, shellState.shortlistIds],
  )

  const institutionalIds = useMemo(
    () => new Set(
      (projection?.rankedBuyers ?? [])
        .filter((b) => b.institutionalStatus === 'VERIFIED_INSTITUTIONAL' || b.institutionalStatus === 'CORPORATE')
        .map((b) => b.buyerId),
    ),
    [projection?.rankedBuyers],
  )

  const activityEvents = useMemo(() => {
    const all = projection?.purchaseEvents ?? []
    let filtered = filterPurchaseEvents(all, {
      periodDays: shellState.activityFilters.periodDays,
      institutionalBuyerIds: institutionalIds,
      institutionalOnly: shellState.activityFilters.institutionalOnly,
      radiusMiles: shellState.activityFilters.radiusMiles,
    })
    if (shellState.activityFilters.repeatOnly) {
      const repeatIds = new Set(
        (projection?.rankedBuyers ?? [])
          .filter((b) => /repeat/i.test(b.buyerArchetype ?? ''))
          .map((b) => b.buyerId),
      )
      filtered = filtered.filter((e) => repeatIds.has(e.buyerId))
    }
    return filtered.sort((a, b) => {
      const at = a.purchaseDate ? new Date(a.purchaseDate).getTime() : 0
      const bt = b.purchaseDate ? new Date(b.purchaseDate).getTime() : 0
      return bt - at
    })
  }, [projection, shellState.activityFilters, institutionalIds])

  const layout = TAB_LAYOUT_COLUMNS[shellState.activeTab]
  const tabClass = `is-tab-${shellState.activeTab.toLowerCase()}`

  const mapPanel = (
    <BuyerActivityMap
      projection={projection}
      selectedBuyerId={shellState.selectedBuyerId}
      selectedEventId={shellState.selectedEventId}
      activityFilters={shellState.activeTab === 'ACTIVITY' ? shellState.activityFilters : undefined}
      onSelectEvent={selectEvent}
    />
  )

  if (paneWidth === '25') {
    return (
      <div className={`bmv4-shell is-pane-25 ${tabClass}`}>
        <BuyerMatchCompactRail
          projection={projection}
          shortlistCount={shellState.shortlistIds.length}
          onOpenFull={onOpenFull ?? (() => {})}
        />
      </div>
    )
  }

  if (paneWidth === '50' || paneWidth === '75') {
    return (
      <div className={`bmv4-shell is-pane-${paneWidth} ${tabClass}`}>
        <BuyerTabNav
          activeTab={shellState.activeTab}
          shortlistCount={shellState.shortlistIds.length}
          onSelectTab={setTab}
        />
        <div className="bmv4-adaptive-body">
          {shellState.activeTab === 'MARKET' && (
            <>
              <BuyerMarketRail subject={subject} projection={projection} loading={loading} refreshing={refreshing} compact />
              {mapPanel}
            </>
          )}
          {shellState.activeTab === 'BUYERS' && (
            <BuyerDirectory
              projection={projection}
              loading={loading}
              timedOut={timedOut}
              filters={shellState.filters}
              selectedBuyerId={shellState.selectedBuyerId}
              shortlistIds={shellState.shortlistIds}
              onSelectBuyer={selectBuyer}
              onToggleShortlist={toggleShortlist}
              onRetry={onRetry}
            />
          )}
          {shellState.activeTab === 'ACTIVITY' && mapPanel}
          {shellState.activeTab === 'SHORTLIST' && (
            <ShortlistPanel
              shortlistedBuyers={shortlistedBuyers}
              selectedBuyerId={shellState.selectedBuyerId}
              events={projection?.purchaseEvents ?? []}
              onSelectBuyer={selectBuyer}
              onToggleShortlist={toggleShortlist}
              onBrowseBuyers={() => setTab('BUYERS')}
            />
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      className={`bmv4-shell is-pane-100 ${tabClass}`}
      style={{
        ['--bmv4-left' as string]: layout.left,
        ['--bmv4-main' as string]: layout.main,
        ['--bmv4-right' as string]: layout.right,
      }}
    >
      <BuyerTabNav
        activeTab={shellState.activeTab}
        shortlistCount={shellState.shortlistIds.length}
        onSelectTab={setTab}
      />

      {error && !projection && (
        <div className="bmv4-banner-error">
          {error}
          {onRetry && <button type="button" className="bmv4-btn is-sm" onClick={onRetry}>Retry</button>}
        </div>
      )}

      {shellState.activeTab === 'MARKET' && (
        <>
          <div className="bmv4-col-left"><BuyerMarketRail subject={subject} projection={projection} loading={loading} refreshing={refreshing} /></div>
          <div className="bmv4-col-main">{mapPanel}</div>
          <div className="bmv4-col-right">
            <MarketIntelligenceRail
              projection={projection}
              selectedBuyerId={shellState.selectedBuyerId}
              shortlistIds={shellState.shortlistIds}
              onSelectBuyer={selectBuyer}
              onToggleShortlist={toggleShortlist}
              onViewAllBuyers={() => setTab('BUYERS')}
            />
          </div>
        </>
      )}

      {shellState.activeTab === 'BUYERS' && (
        <>
          <div className="bmv4-col-left">
            <BuyerFiltersRail
              projection={projection}
              filters={shellState.filters}
              onChange={(patch) => setShellState((s) => ({ ...s, filters: { ...s.filters, ...patch } }))}
              onClear={() => setShellState((s) => ({ ...s, filters: INITIAL_FILTER_STATE }))}
            />
          </div>
          <div className="bmv4-col-main">
            <BuyerDirectory
              projection={projection}
              loading={loading}
              timedOut={timedOut}
              filters={shellState.filters}
              selectedBuyerId={shellState.selectedBuyerId}
              shortlistIds={shellState.shortlistIds}
              onSelectBuyer={selectBuyer}
              onToggleShortlist={toggleShortlist}
              onRetry={onRetry}
            />
          </div>
          <div className="bmv4-col-right">
            <BuyerDossier
              buyer={selectedBuyer}
              events={projection?.purchaseEvents ?? []}
              shortlisted={shellState.shortlistIds.includes(shellState.selectedBuyerId ?? '')}
              onToggleShortlist={() => shellState.selectedBuyerId && toggleShortlist(shellState.selectedBuyerId)}
            />
          </div>
        </>
      )}

      {shellState.activeTab === 'ACTIVITY' && (
        <>
          <div className="bmv4-col-left">
            <ActivityControlsRail
              filters={shellState.activityFilters}
              eventCount={activityEvents.length}
              onChange={(patch) => setShellState((s) => ({ ...s, activityFilters: { ...s.activityFilters, ...patch } }))}
            />
          </div>
          <div className="bmv4-col-main">{mapPanel}</div>
          <div className="bmv4-col-right">
            <PurchaseFeed
              events={activityEvents}
              buyers={projection?.rankedBuyers ?? []}
              selectedEventId={shellState.selectedEventId}
              selectedBuyerId={shellState.selectedBuyerId}
              onSelectEvent={selectEvent}
            />
          </div>
        </>
      )}

      {shellState.activeTab === 'SHORTLIST' && (
        <div className="bmv4-col-full">
          <ShortlistPanel
            shortlistedBuyers={shortlistedBuyers}
            selectedBuyerId={shellState.selectedBuyerId}
            events={projection?.purchaseEvents ?? []}
            onSelectBuyer={selectBuyer}
            onToggleShortlist={toggleShortlist}
            onBrowseBuyers={() => setTab('BUYERS')}
          />
        </div>
      )}
    </div>
  )
}