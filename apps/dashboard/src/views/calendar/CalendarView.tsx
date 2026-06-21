import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getCalendarModeRangeLabel,
  getLastCalendarLoadMeta,
  loadAutomationSchedule,
  loadClosingDeadlines,
  loadContractDeadlines,
  loadDailyCalendar,
  loadGlobalExecutionTimeline,
  loadMonthCalendar,
  loadOfferFollowUps,
  loadOverdueExecutionItems,
  loadSelectedSellerTimeline,
  loadTodayExecutionSummary,
  loadWeeklyCalendar,
  type CalendarEvent,
  type CalendarFilters,
  type CalendarScopeMode,
  type CalendarViewMode,
  type ExecutionSummaryCard,
} from '../../lib/data/calendarData'
import { rescheduleCalendarEvent } from '../../lib/calendar/calendar-api'
import { addDays, addMonths, dayRangeIso, monthRangeIso, startOfDay, toIsoDate, weekRangeIso } from '../../lib/calendar/calendar-date-engine'
import { loadCalendarLayers, saveCalendarLayers, type CalendarLayerId } from '../../lib/calendar/calendar-layers'
import type { CalendarTimezoneMode } from '../../lib/calendar/calendar-timezone'
import { pushRoutePath } from '../../app/router'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import type { ViewLayoutMode } from '../../domain/inbox/view-layout'
import { formatRelativeTime } from '../../shared/formatters'
import { CalendarHeader, type CalendarRefreshState } from './CalendarHeader'
import { CalendarModeTabs } from './CalendarModeTabs'
import { CalendarRightRail } from './CalendarRightRail'
import { DailyExecutionSchedule } from './DailyExecutionSchedule'
import { ExecutionSnapshotStrip } from './ExecutionSnapshotStrip'
import { MonthExecutionGrid } from './MonthExecutionGrid'
import { SellerCalendarContext } from './SellerCalendarContext'
import { TimelineExecutionFeed } from './TimelineExecutionFeed'
import { WeeklyExecutionGrid } from './WeeklyExecutionGrid'
import { CalendarAgendaView } from './components/CalendarAgendaView'
import { CalendarEventDetailDrawer, type CalendarDrawerAction } from './components/CalendarEventDetailDrawer'
import { CalendarLayersMenu } from './components/CalendarLayersMenu'
import { CalendarNewEventModal } from './components/CalendarNewEventModal'
import './calendar-view.css'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type InboxCalendarViewProps = {
  threads: InboxWorkflowThread[]
  selectedThread: InboxWorkflowThread | null
  selectedId: string | null
  layoutMode: ViewLayoutMode
  onSelectThread: (id: string) => void
  onSelectEvent?: (event: CalendarEvent) => void
  onOpenDealIntelligence?: (threadId?: string | null) => void
}

const buildFilters = (
  threads: InboxWorkflowThread[],
  selectedThread: InboxWorkflowThread | null,
  scopeMode: CalendarScopeMode,
  layers: CalendarLayerId[],
  range: { startIso: string; endIso: string },
): CalendarFilters => ({
  threads,
  layers,
  startDate: range.startIso,
  endDate: range.endIso,
  propertyId: scopeMode === 'selected' ? selectedThread?.propertyId ?? null : null,
  sellerId: scopeMode === 'selected' ? selectedThread?.ownerId ?? null : null,
  threadId: scopeMode === 'selected' ? selectedThread?.id ?? null : null,
})

const sellerContextStats = (thread: InboxWorkflowThread | null) => {
  if (!thread) return []
  return [
    { label: 'Stage', value: String(thread.conversationStage || thread.inboxStage || 'Unknown').replace(/_/g, ' ') },
    { label: 'Priority', value: String(thread.priority || 'normal').replace(/_/g, ' ') },
    { label: 'Automation', value: String(thread.automationState || 'active').replace(/_/g, ' ') },
    { label: 'Last Reply', value: thread.lastInboundAt ? formatRelativeTime(thread.lastInboundAt) : 'No reply yet' },
    { label: 'Next Action', value: String((thread as { next_action?: string }).next_action || thread.nextSystemAction || 'Review conversation') },
    { label: 'Offer / Contract', value: String((thread as { offerStatus?: string }).offerStatus || (thread as { contractStatus?: string }).contractStatus || 'Pending').replace(/_/g, ' ') },
    { label: 'Title / Closing', value: String((thread as { titleStatus?: string }).titleStatus || (thread as { closingStatus?: string }).closingStatus || 'Not started').replace(/_/g, ' ') },
  ]
}

export function CalendarView({
  threads,
  selectedThread,
  selectedId,
  layoutMode,
  onSelectThread,
  onSelectEvent,
  onOpenDealIntelligence,
}: InboxCalendarViewProps) {
  const [viewMode, setViewMode] = useState<CalendarViewMode>('week')
  const [scopeMode, setScopeMode] = useState<CalendarScopeMode>('global')
  const [anchorDate, setAnchorDate] = useState<Date>(() => startOfDay(new Date()))
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [summaryCards, setSummaryCards] = useState<ExecutionSummaryCard[]>([])
  const [overdueItems, setOverdueItems] = useState<CalendarEvent[]>([])
  const [automationSchedule, setAutomationSchedule] = useState<CalendarEvent[]>([])
  const [closingItems, setClosingItems] = useState<CalendarEvent[]>([])
  const [contractItems, setContractItems] = useState<CalendarEvent[]>([])
  const [offerItems, setOfferItems] = useState<CalendarEvent[]>([])
  const [selectedSellerHistory, setSelectedSellerHistory] = useState<CalendarEvent[]>([])
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null)
  const [lastUpdated, setLastUpdated] = useState<string>(new Date().toISOString())
  const [refreshState, setRefreshState] = useState<CalendarRefreshState>('live')
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [liveTick, setLiveTick] = useState(0)
  const [railOpen, setRailOpen] = useState(layoutMode === 'full')
  const [layers, setLayers] = useState<CalendarLayerId[]>(() => loadCalendarLayers())
  const [timezoneMode, setTimezoneMode] = useState<CalendarTimezoneMode>('operator')
  const [agendaSearch, setAgendaSearch] = useState('')
  const [newEventOpen, setNewEventOpen] = useState(false)
  const [developerMode] = useState(() => typeof window !== 'undefined' && window.localStorage.getItem('developer_mode') === 'true')
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (selectedThread && scopeMode === 'global' && layoutMode !== 'compact') {
      setScopeMode('selected')
    }
  }, [layoutMode, scopeMode, selectedThread])

  useEffect(() => {
    setRailOpen(layoutMode === 'full')
  }, [layoutMode])

  useEffect(() => {
    const interval = window.setInterval(() => setLiveTick((value) => value + 1), 30000)
    return () => window.clearInterval(interval)
  }, [])

  const range = useMemo(() => {
    if (viewMode === 'day') return dayRangeIso(anchorDate)
    if (viewMode === 'week') return weekRangeIso(anchorDate)
    if (viewMode === 'month') return monthRangeIso(anchorDate)
    if (viewMode === 'agenda') {
      const start = startOfDay(anchorDate)
      const end = addDays(start, 30)
      return { startIso: start.toISOString(), endIso: end.toISOString() }
    }
    const start = addDays(startOfDay(new Date()), -30)
    const end = addDays(startOfDay(new Date()), 90)
    return { startIso: start.toISOString(), endIso: end.toISOString() }
  }, [anchorDate, viewMode])

  const filters = useMemo(
    () => buildFilters(threads, selectedThread, scopeMode, layers, range),
    [threads, selectedThread, scopeMode, layers, range],
  )

  const loadAll = useCallback(async () => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setRefreshState('updating')
    setRefreshError(null)

    try {
      const loadPrimary =
        scopeMode === 'selected' && selectedThread?.ownerId && viewMode === 'timeline'
          ? loadSelectedSellerTimeline(selectedThread.ownerId, selectedThread.propertyId || undefined, threads)
          : viewMode === 'day'
            ? loadDailyCalendar(anchorDate.toISOString(), filters)
            : viewMode === 'week'
              ? loadWeeklyCalendar(anchorDate.toISOString(), filters)
              : viewMode === 'month'
                ? loadMonthCalendar(anchorDate.toISOString(), filters)
                : viewMode === 'agenda'
                  ? loadCalendarEventsWithFilters(filters)
                  : loadGlobalExecutionTimeline(filters)

      const [primaryEvents, nextSummary, nextOverdue, nextAutomation, nextClosings, nextContracts, nextOffers] = await Promise.all([
        loadPrimary,
        loadTodayExecutionSummary(filters),
        loadOverdueExecutionItems(filters),
        loadAutomationSchedule(filters),
        loadClosingDeadlines(filters),
        loadContractDeadlines(filters),
        loadOfferFollowUps(filters),
      ])

      setEvents(primaryEvents)
      setSummaryCards(nextSummary)
      setOverdueItems(nextOverdue)
      setAutomationSchedule(nextAutomation)
      setClosingItems(nextClosings)
      setContractItems(nextContracts)
      setOfferItems(nextOffers)
      setLastUpdated(new Date().toISOString())
      setRefreshState('updated')
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : 'Refresh failed')
      setRefreshState('error')
    } finally {
      window.setTimeout(() => setRefreshState('live'), 2500)
    }
  }, [anchorDate, filters, scopeMode, selectedThread?.ownerId, selectedThread?.propertyId, threads, viewMode])

  useEffect(() => {
    void loadAll()
  }, [loadAll, liveTick])

  useEffect(() => {
    let cancelled = false
    if (!selectedThread?.ownerId) {
      setSelectedSellerHistory([])
      return
    }
    loadSelectedSellerTimeline(selectedThread.ownerId, selectedThread.propertyId || undefined, threads)
      .then((nextEvents) => {
        if (!cancelled) setSelectedSellerHistory(nextEvents)
      })
      .catch(() => {
        if (!cancelled) setSelectedSellerHistory([])
      })
    return () => {
      cancelled = true
    }
  }, [selectedThread?.ownerId, selectedThread?.propertyId, threads, liveTick])

  const selectedTimeline = useMemo(() => {
    if (!selectedThread) return []
    return selectedSellerHistory.slice(0, 40)
  }, [selectedSellerHistory, selectedThread])

  const todayAgenda = useMemo(() => {
    const todayKey = toIsoDate(new Date())
    return events.filter((event) => toIsoDate(new Date(event.timestamp)) === todayKey).slice(0, 14)
  }, [events])

  const relatedChain = useMemo(() => {
    if (!selectedEvent?.correlationId) return []
    return events
      .filter((event) => event.correlationId === selectedEvent.correlationId)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
  }, [events, selectedEvent])

  const contextStats = useMemo(() => sellerContextStats(selectedThread), [selectedThread])
  const headerLabel = useMemo(() => getCalendarModeRangeLabel(viewMode, anchorDate), [anchorDate, viewMode])
  const loadMeta = getLastCalendarLoadMeta()

  const handlePrev = () => {
    if (viewMode === 'day') setAnchorDate((value) => addDays(value, -1))
    else if (viewMode === 'week') setAnchorDate((value) => addDays(value, -7))
    else if (viewMode === 'month') setAnchorDate((value) => addMonths(value, -1))
    else setAnchorDate((value) => addDays(value, -14))
  }

  const handleNext = () => {
    if (viewMode === 'day') setAnchorDate((value) => addDays(value, 1))
    else if (viewMode === 'week') setAnchorDate((value) => addDays(value, 7))
    else if (viewMode === 'month') setAnchorDate((value) => addMonths(value, 1))
    else setAnchorDate((value) => addDays(value, 14))
  }

  const handleSelectEvent = (event: CalendarEvent) => {
    setSelectedEvent(event)
    onSelectEvent?.(event)
    const targetThreadId = event.threadId || selectedId
    if (targetThreadId) onSelectThread(targetThreadId)
  }

  const handleReschedule = async (event: CalendarEvent, dayIso: string, hour = 9) => {
    if (!event.reschedulable) return
    const previous = events
    const nextTs = new Date(`${dayIso}T${`${hour}`.padStart(2, '0')}:00:00`).toISOString()
    setEvents((list) => list.map((item) => item.id === event.id ? { ...item, timestamp: nextTs } : item))
    try {
      const result = await rescheduleCalendarEvent({
        source_domain: event.sourceDomain,
        source_record_id: event.sourceRecordId,
        source_table: event.sourceTable,
        start_timestamp: nextTs,
        workflow_enrollment_id: event.deepLinkContext?.workflow_enrollment_id,
      })
      if (!result.ok) throw new Error(result.error || 'reschedule_failed')
      setLiveTick((v) => v + 1)
    } catch (error) {
      setEvents(previous)
      setRefreshError(error instanceof Error ? error.message : 'Reschedule failed')
      setRefreshState('error')
    }
  }

  const handleDrawerAction = (action: CalendarDrawerAction) => {
    if (!selectedEvent) return
    const ctx = selectedEvent.deepLinkContext || {}
    const targetThreadId = selectedEvent.threadId || selectedId || null

    if (action === 'deal' || action === 'comp') {
      onOpenDealIntelligence?.(targetThreadId)
      return
    }
    if (action === 'conversation' || action === 'inbox') {
      if (targetThreadId) onSelectThread(targetThreadId)
      pushRoutePath('/conversation')
      return
    }
    if (action === 'pipeline') {
      pushRoutePath('/pipeline')
      return
    }
    if (action === 'property' && ctx.property_id) {
      pushRoutePath(`/entity-graph/property/${encodeURIComponent(ctx.property_id)}`)
      return
    }
    if (action === 'map') {
      pushRoutePath('/map')
      return
    }
    if (action === 'buyer') {
      pushRoutePath('/buyer-match')
      return
    }
    if (action === 'queue') {
      pushRoutePath('/queue')
      return
    }
    if (action === 'campaign') {
      pushRoutePath('/campaigns')
      return
    }
    if (action === 'workflow') {
      pushRoutePath('/workflow-studio')
      return
    }
    if (action === 'contract') {
      pushRoutePath('/deal-intelligence')
      return
    }
    if (action === 'entity_graph') {
      const owner = ctx.master_owner_id
      if (owner) pushRoutePath(`/entity-graph/owner/${encodeURIComponent(owner)}`)
      else pushRoutePath('/entity-graph')
      return
    }
    if (action === 'reschedule' && selectedEvent.reschedulable) {
      const nextHour = new Date(selectedEvent.timestamp).getHours() + 1
      void handleReschedule(selectedEvent, toIsoDate(new Date(selectedEvent.timestamp)), nextHour)
    }
  }

  const mainSurface = (() => {
    if (viewMode === 'day') {
      return (
        <DailyExecutionSchedule
          anchorDate={anchorDate}
          events={events}
          selectedEventId={selectedEvent?.id ?? null}
          onSelect={handleSelectEvent}
          onCreateSlot={() => setNewEventOpen(true)}
          onReschedule={(event, hour) => handleReschedule(event, toIsoDate(anchorDate), hour)}
        />
      )
    }
    if (viewMode === 'week') {
      return (
        <WeeklyExecutionGrid
          anchorDate={anchorDate}
          events={events}
          selectedEventId={selectedEvent?.id ?? null}
          onSelect={handleSelectEvent}
          onReschedule={(event, dayIso, hour) => handleReschedule(event, dayIso, hour)}
        />
      )
    }
    if (viewMode === 'month') {
      return (
        <MonthExecutionGrid
          anchorDate={anchorDate}
          events={events}
          selectedEventId={selectedEvent?.id ?? null}
          onSelect={handleSelectEvent}
          onReschedule={(event, dayIso) => handleReschedule(event, dayIso)}
        />
      )
    }
    if (viewMode === 'agenda') {
      return (
        <CalendarAgendaView
          events={events}
          selectedEventId={selectedEvent?.id ?? null}
          onSelect={handleSelectEvent}
          search={agendaSearch}
        />
      )
    }
    return (
      <section className="nx-cal__surface">
        <div className="nx-cal__section-head">
          <div>
            <span className="nx-cal__eyebrow">{scopeMode === 'selected' ? 'Selected Seller' : 'Global'}</span>
            <strong>Execution timeline</strong>
          </div>
          <span>{events.length}</span>
        </div>
        <TimelineExecutionFeed
          events={events.slice(0, layoutMode === 'compact' ? 16 : 120)}
          selectedId={selectedEvent?.id ?? null}
          onSelect={handleSelectEvent}
          grouped
          emptyDescription="No events match the selected range and active filters."
        />
      </section>
    )
  })()

  const railSections = [
    { id: 'today', title: 'Today Agenda', events: todayAgenda, defaultOpen: true },
    { id: 'overdue', title: 'Overdue / Risk', events: overdueItems.slice(0, 12), defaultOpen: true },
    { id: 'automation', title: 'Automation Schedule', events: automationSchedule.slice(0, 12), defaultOpen: true },
    { id: 'offers', title: 'Offers / Contracts / Closings', events: [...offerItems, ...contractItems, ...closingItems].slice(0, 12), defaultOpen: false },
    { id: 'sends', title: 'Next Scheduled Sends', events: automationSchedule.filter((e) => e.type === 'scheduled_sms').slice(0, 5), defaultOpen: false },
    { id: 'followups', title: 'Upcoming Follow-Ups', events: events.filter((e) => e.type.includes('follow')).slice(0, 8), defaultOpen: false },
    { id: 'entity', title: 'Selected Entity', events: selectedTimeline.slice(0, 8), defaultOpen: Boolean(selectedThread) },
  ]

  return (
    <div className={cls('calendar-command', 'nx-cal', `is-${layoutMode}`)}>
      <CalendarHeader
        rangeLabel={headerLabel}
        scopeMode={scopeMode}
        selectedEnabled={Boolean(selectedThread)}
        refreshState={refreshState}
        anchorDate={toIsoDate(anchorDate)}
        railOpen={railOpen}
        showRailToggle={layoutMode === 'expanded' || layoutMode === 'full'}
        timezoneMode={timezoneMode}
        onToday={() => setAnchorDate(startOfDay(new Date()))}
        onPrev={handlePrev}
        onNext={handleNext}
        onRefresh={() => setLiveTick((value) => value + 1)}
        onDateChange={(value) => value && setAnchorDate(startOfDay(new Date(value)))}
        onScopeChange={setScopeMode}
        onToggleRail={() => setRailOpen((value) => !value)}
        onTimezoneModeChange={setTimezoneMode}
        onNewEvent={() => setNewEventOpen(true)}
        lastSyncedLabel={formatRelativeTime(lastUpdated)}
        errorMessage={refreshError}
      />

      <CalendarModeTabs value={viewMode} onChange={setViewMode} />

      <ExecutionSnapshotStrip
        cards={summaryCards}
        compact={layoutMode !== 'full'}
        onCardClick={(id) => {
          if (id === 'overdue') setViewMode('agenda')
          if (id === 'scheduled-sms') setLayers(['sms'])
        }}
      />

      <div className="nx-cal__toolbar-row">
        <CalendarLayersMenu
          layers={layers}
          onChange={(next) => { setLayers(next); saveCalendarLayers(next) }}
          selectedSellerActive={scopeMode === 'selected' && Boolean(selectedThread)}
          selectedSellerDisabledReason={!selectedThread ? 'Select a seller in global entity context to scope the calendar.' : null}
        />
        {viewMode === 'agenda' ? (
          <input
            className="nx-cal__agenda-search"
            placeholder="Search agenda"
            value={agendaSearch}
            onChange={(e) => setAgendaSearch(e.target.value)}
          />
        ) : null}
      </div>

      {scopeMode === 'selected' && selectedThread ? (
        <SellerCalendarContext
          thread={selectedThread}
          stats={contextStats}
          compact={layoutMode === 'compact' || layoutMode === 'medium'}
          onBackToGlobal={() => setScopeMode('global')}
          onOpenDeal={() => onOpenDealIntelligence?.(selectedThread.id)}
          onOpenConversation={() => onSelectThread(selectedThread.id)}
        />
      ) : null}

      <div className={cls('nx-cal__desktop', railOpen && 'has-rail')}>
        <div className="nx-cal__desktop-main">
          {mainSurface}
          {viewMode !== 'timeline' && viewMode !== 'agenda' ? (
            <section className="nx-cal__surface">
              <div className="nx-cal__section-head">
                <div>
                  <span className="nx-cal__eyebrow">Execution Feed</span>
                  <strong>Chronological execution chain</strong>
                </div>
                <span>{events.length}</span>
              </div>
              <TimelineExecutionFeed
                events={events.slice(0, 24)}
                selectedId={selectedEvent?.id ?? null}
                onSelect={handleSelectEvent}
                grouped
                compact
              />
            </section>
          ) : null}
        </div>

        {railOpen && layoutMode !== 'compact' ? (
          <CalendarRightRail
            sections={railSections}
            selectedEventId={selectedEvent?.id ?? null}
            onSelect={handleSelectEvent}
          />
        ) : null}
      </div>

      {selectedEvent ? (
        <CalendarEventDetailDrawer
          event={selectedEvent}
          selectedThread={selectedThread}
          relatedEvents={relatedChain}
          developerMode={developerMode}
          onAction={handleDrawerAction}
          onClose={() => setSelectedEvent(null)}
        />
      ) : null}

      <CalendarNewEventModal
        open={newEventOpen}
        defaultDate={toIsoDate(anchorDate)}
        sellerId={selectedThread?.ownerId}
        propertyId={selectedThread?.propertyId}
        threadId={selectedThread?.id}
        onClose={() => setNewEventOpen(false)}
        onCreated={() => setLiveTick((v) => v + 1)}
      />

      {loadMeta.performance ? (
        <div className="nx-cal__perf" aria-hidden="true">
          {JSON.stringify(loadMeta.performance)}
        </div>
      ) : null}
    </div>
  )
}

async function loadCalendarEventsWithFilters(filters: CalendarFilters) {
  const { loadCalendarEvents } = await import('../../lib/data/calendarData')
  return loadCalendarEvents(filters)
}