import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getCalendarModeRangeLabel,
  getLastCalendarLoadMeta,
  loadDailyCalendar,
  loadGlobalExecutionTimeline,
  loadMonthCalendar,
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
import { CalendarCommandBar, type CalendarRefreshState } from './CalendarCommandBar'
import { CalendarExecutionDrawer } from './CalendarExecutionDrawer'
import { CalendarKpiRibbon, KPI_LAYER_MAP } from './CalendarKpiRibbon'
import { buildCalendarProofFixtures, isCalendarProofMode } from '../../lib/calendar/calendar-proof-fixtures'
import { CalendarMobileView } from './CalendarMobileView'
import { CalendarIntelligenceRail } from './CalendarIntelligenceRail'
import { filterViewEvents } from '../../lib/calendar/calendar-event-classification'
import { DailyExecutionSchedule } from './DailyExecutionSchedule'
import { MonthExecutionGrid } from './MonthExecutionGrid'
import { TimelineExecutionFeed } from './TimelineExecutionFeed'
import { WeeklyExecutionGrid } from './WeeklyExecutionGrid'
import { CalendarAgendaView } from './components/CalendarAgendaView'
import { CalendarEventDetailDrawer, type CalendarDrawerAction } from './components/CalendarEventDetailDrawer'
import { CalendarNewEventModal } from './components/CalendarNewEventModal'
import { SellerContextRibbon } from './components/SellerContextRibbon'
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

export function CalendarView({
  threads,
  selectedThread,
  selectedId,
  layoutMode,
  onSelectThread,
  onSelectEvent,
  onOpenDealIntelligence,
}: InboxCalendarViewProps) {
  const [viewMode, setViewMode] = useState<CalendarViewMode>('month')
  const [scopeMode, setScopeMode] = useState<CalendarScopeMode>('global')
  const [anchorDate, setAnchorDate] = useState<Date>(() => startOfDay(new Date()))
  const [selectedDayIso, setSelectedDayIso] = useState<string>(() => toIsoDate(new Date()))
  const [allEvents, setAllEvents] = useState<CalendarEvent[]>([])
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
  const [execDrawerOpen, setExecDrawerOpen] = useState(false)
  const [layers, setLayers] = useState<CalendarLayerId[]>(() => loadCalendarLayers())
  const [timezoneMode, setTimezoneMode] = useState<CalendarTimezoneMode>('operator')
  const [agendaSearch, setAgendaSearch] = useState('')
  const [activeKpi, setActiveKpi] = useState<string | null>(null)
  const [newEventOpen, setNewEventOpen] = useState(false)
  const [editEvent, setEditEvent] = useState<CalendarEvent | null>(null)
  const proofMode = isCalendarProofMode()
  const [developerMode] = useState(() => typeof window !== 'undefined' && window.localStorage.getItem('developer_mode') === 'true')
  const abortRef = useRef<AbortController | null>(null)
  const requestIdRef = useRef(0)

  useEffect(() => {
    if (selectedThread && scopeMode === 'global' && layoutMode !== 'compact') {
      setScopeMode('selected')
    }
  }, [layoutMode, scopeMode, selectedThread])

  useEffect(() => {
    setRailOpen(layoutMode === 'full' || layoutMode === 'expanded')
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
    const requestId = ++requestIdRef.current
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setRefreshState('updating')
    setRefreshError(null)

    const watchdog = window.setTimeout(() => {
      if (requestId === requestIdRef.current) {
        setRefreshState((state) => (state === 'updating' ? 'error' : state))
        setRefreshError((err) => err || 'Refresh timed out')
        window.setTimeout(() => {
          if (requestId === requestIdRef.current) setRefreshState('live')
        }, 2000)
      }
    }, 12000)

    const withTimeout = async <T,>(promise: Promise<T>, ms = 10000): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          promise,
          new Promise<T>((_, reject) => {
            timer = setTimeout(() => reject(new Error('calendar_request_timeout')), ms)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

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

      const [primaryEvents, nextSummary] = await Promise.all([
        withTimeout(loadPrimary),
        withTimeout(loadTodayExecutionSummary(filters), 8000),
      ])

      if (requestId !== requestIdRef.current || controller.signal.aborted) return

      const merged = proofMode && primaryEvents.length === 0
        ? buildCalendarProofFixtures(anchorDate)
        : proofMode
          ? [...primaryEvents, ...buildCalendarProofFixtures(anchorDate).filter((f) => !primaryEvents.some((e) => e.id === f.id))]
          : primaryEvents

      const nextOverdue = merged.filter((e) => e.overdue).slice(0, 80)
      const nextAutomation = merged.filter((e) =>
        ['scheduled_sms', 'seller_follow_up', 'automation_blocked', 'queue_retry', 'workflow_wake', 'workflow_task'].includes(e.type))
      const nextClosings = merged.filter((e) =>
        ['title_opened', 'title_milestone', 'clear_to_close', 'closing_scheduled'].includes(e.type))
      const nextContracts = merged.filter((e) =>
        ['contract_sent', 'contract_signature_deadline', 'fully_executed_contract'].includes(e.type))
      const nextOffers = merged.filter((e) =>
        ['offer_created', 'offer_sent', 'offer_expiration', 'offer_follow_up'].includes(e.type))

      setAllEvents(merged)
      const proofSummary = proofMode ? [
        { id: 'due-today', label: 'Due Today', value: merged.filter((e) => toIsoDate(new Date(e.timestamp)) === toIsoDate(new Date())).length, tone: 'blue' as const },
        { id: 'overdue', label: 'Overdue', value: merged.filter((e) => e.overdue).length, tone: 'red' as const },
        { id: 'seller-replies', label: 'Seller Replies', value: merged.filter((e) => ['inbound_reply', 'seller_reply_needs_action'].includes(e.type)).length, tone: 'cyan' as const },
        { id: 'scheduled-sms', label: 'Scheduled SMS', value: merged.filter((e) => e.type === 'scheduled_sms').length, tone: 'blue' as const },
        { id: 'workflow-wakes', label: 'Workflow Wakes', value: merged.filter((e) => ['workflow_wake', 'workflow_task'].includes(e.type)).length, tone: 'violet' as const },
        { id: 'offers-due', label: 'Offers Due', value: merged.filter((e) => ['offer_expiration', 'offer_follow_up'].includes(e.type)).length, tone: 'gold' as const },
        { id: 'contracts-awaiting', label: 'Contracts Awaiting', value: merged.filter((e) => e.type === 'contract_signature_deadline').length, tone: 'purple' as const },
        { id: 'title-milestones', label: 'Title Milestones', value: merged.filter((e) => ['title_milestone', 'title_opened'].includes(e.type)).length, tone: 'gold' as const },
        { id: 'buyer-follow-ups', label: 'Buyer Follow-Ups', value: merged.filter((e) => e.type === 'buyer_follow_up').length, tone: 'amber' as const },
        { id: 'closings', label: 'Closings', value: merged.filter((e) => e.type === 'closing_scheduled').length, tone: 'emerald' as const },
      ] : nextSummary
      setSummaryCards(proofSummary)
      setOverdueItems(nextOverdue)
      setAutomationSchedule(nextAutomation)
      setClosingItems(nextClosings)
      setContractItems(nextContracts)
      setOfferItems(nextOffers)
      setLastUpdated(new Date().toISOString())
      setRefreshState('updated')
    } catch (error) {
      if (controller.signal.aborted || requestId !== requestIdRef.current) return
      setRefreshError(error instanceof Error ? error.message : 'Refresh failed')
      setRefreshState('error')
    } finally {
      window.clearTimeout(watchdog)
      if (requestId === requestIdRef.current) {
        window.setTimeout(() => {
          if (requestId === requestIdRef.current) setRefreshState('live')
        }, 2200)
      }
    }
  }, [anchorDate, filters, proofMode, scopeMode, selectedThread?.ownerId, selectedThread?.propertyId, threads, viewMode])

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

  const events = useMemo(
    () => filterViewEvents(allEvents, viewMode === 'timeline' ? 'timeline' : viewMode),
    [allEvents, viewMode],
  )

  const selectedDay = useMemo(() => startOfDay(new Date(`${selectedDayIso}T12:00:00`)), [selectedDayIso])

  const relatedChain = useMemo(() => {
    if (!selectedEvent?.correlationId) return []
    return allEvents
      .filter((event) => event.correlationId === selectedEvent.correlationId)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
  }, [allEvents, selectedEvent])

  const nextSellerEvent = useMemo(() => {
    if (!selectedThread) return null
    const now = Date.now()
    return allEvents
      .filter((e) => e.sellerId === selectedThread.ownerId && new Date(e.timestamp).getTime() >= now)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())[0] ?? null
  }, [allEvents, selectedThread])

  const handleSelectDay = (iso: string) => {
    setSelectedDayIso(iso)
    setAnchorDate(startOfDay(new Date(`${iso}T12:00:00`)))
    setSelectedEvent(null)
  }

  const headerLabel = useMemo(() => getCalendarModeRangeLabel(viewMode, anchorDate), [anchorDate, viewMode])
  const loadMeta = getLastCalendarLoadMeta()
  const isMobile = layoutMode === 'compact'

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
    setAllEvents((list) => list.map((item) => item.id === event.id ? { ...item, timestamp: nextTs } : item))
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
      setAllEvents(previous)
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

  const handleKpiClick = (id: string) => {
    setActiveKpi(id)
    if (id === 'overdue') setViewMode('agenda')
    const layerIds = KPI_LAYER_MAP[id]
    if (layerIds?.length) {
      setLayers(layerIds as CalendarLayerId[])
      saveCalendarLayers(layerIds as CalendarLayerId[])
    }
  }

  const mainSurface = (() => {
    if (isMobile) {
      return (
        <CalendarMobileView
          anchorDate={anchorDate}
          events={events}
          selectedEventId={selectedEvent?.id ?? null}
          onSelect={handleSelectEvent}
          onNewEvent={() => setNewEventOpen(true)}
          onDateChange={(date) => setAnchorDate(startOfDay(date))}
        />
      )
    }
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
          selectedDayIso={selectedDayIso}
          selectedEventId={selectedEvent?.id ?? null}
          onSelectDay={handleSelectDay}
          onSelect={handleSelectEvent}
          onCreateTask={(dayIso) => { setSelectedDayIso(dayIso); setNewEventOpen(true) }}
          onReschedule={(event, dayIso) => handleReschedule(event, dayIso)}
        />
      )
    }
    if (viewMode === 'agenda') {
      return (
        <div className="nx-cal__agenda-shell">
          <input
            className="nx-cal__agenda-search"
            placeholder="Search agenda…"
            value={agendaSearch}
            onChange={(e) => setAgendaSearch(e.target.value)}
          />
          <CalendarAgendaView
            events={events}
            selectedEventId={selectedEvent?.id ?? null}
            onSelect={handleSelectEvent}
            search={agendaSearch}
          />
        </div>
      )
    }
    return (
      <section className="nx-cal__surface nx-cal__timeline-surface">
        <div className="nx-cal__section-head">
          <div>
            <span className="nx-cal__eyebrow">{scopeMode === 'selected' ? 'Selected Entity' : 'Global'}</span>
            <strong>Execution Timeline</strong>
          </div>
          <span>{events.length}</span>
        </div>
        <TimelineExecutionFeed
          events={allEvents.slice(0, layoutMode === 'medium' ? 40 : 120)}
          selectedId={selectedEvent?.id ?? null}
          onSelect={handleSelectEvent}
          grouped
          emptyDescription="No events match the selected range and active filters."
        />
      </section>
    )
  })()

  return (
    <div className={cls('calendar-command', 'nx-cal', `is-${layoutMode}`, `is-view-${viewMode}`)} data-refresh-state={refreshState}>
      <div className="nx-cal__aurora" aria-hidden="true" />
      <div className="nx-cal__shell">
        <CalendarCommandBar
          rangeLabel={headerLabel}
          viewMode={viewMode}
          scopeMode={scopeMode}
          selectedEnabled={Boolean(selectedThread)}
          refreshState={refreshState}
          anchorDate={toIsoDate(anchorDate)}
          railOpen={railOpen}
          showRailToggle={!isMobile && (layoutMode === 'expanded' || layoutMode === 'full' || layoutMode === 'medium')}
          timezoneMode={timezoneMode}
          layers={layers}
          visibleEventCount={events.length}
          collapsed={layoutMode === 'medium'}
          onViewChange={setViewMode}
          onToday={() => setAnchorDate(startOfDay(new Date()))}
          onPrev={handlePrev}
          onNext={handleNext}
          onRefresh={() => setLiveTick((value) => value + 1)}
          onDateChange={(value) => value && setAnchorDate(startOfDay(new Date(value)))}
          onScopeChange={setScopeMode}
          onToggleRail={() => setRailOpen((value) => !value)}
          onTimezoneModeChange={setTimezoneMode}
          onNewEvent={() => setNewEventOpen(true)}
          onLayersChange={(next) => { setLayers(next); saveCalendarLayers(next) }}
          lastSyncedLabel={formatRelativeTime(lastUpdated)}
          errorMessage={refreshError}
        />

        {!isMobile ? (
          <CalendarKpiRibbon cards={summaryCards} activeId={activeKpi} onCardClick={handleKpiClick} />
        ) : null}

        {scopeMode === 'selected' && selectedThread ? (
          <SellerContextRibbon
            thread={selectedThread}
            nextEvent={nextSellerEvent}
            onOpenDeal={() => onOpenDealIntelligence?.(selectedThread.id)}
            onOpenConversation={() => onSelectThread(selectedThread.id)}
            onOpenIntelligence={() => onOpenDealIntelligence?.(selectedThread.id)}
          />
        ) : null}

        <div className={cls('nx-cal__workspace', railOpen && !isMobile && 'has-rail', layoutMode === 'medium' && 'is-overlay-rail')}>
          <div className="nx-cal__workspace-main">
            {mainSurface}
            {!isMobile && viewMode !== 'timeline' && viewMode !== 'agenda' ? (
              <CalendarExecutionDrawer
                open={execDrawerOpen}
                events={events}
                selectedEventId={selectedEvent?.id ?? null}
                onToggle={() => setExecDrawerOpen((v) => !v)}
                onSelect={handleSelectEvent}
              />
            ) : null}
          </div>

        {railOpen && !isMobile ? (
          <CalendarIntelligenceRail
            selectedDate={selectedDay}
            selectedEvent={selectedEvent}
            events={events}
            allEvents={allEvents}
            selectedEventId={selectedEvent?.id ?? null}
            collapsed={false}
            onToggleCollapse={() => setRailOpen(false)}
            onSelect={handleSelectEvent}
            onAddTask={() => { setEditEvent(null); setNewEventOpen(true) }}
            onClearEvent={() => setSelectedEvent(null)}
            onEditEvent={(event) => { setEditEvent(event); setNewEventOpen(true) }}
          />
        ) : null}
        </div>
      </div>

      <CalendarEventDetailDrawer
        event={selectedEvent}
        selectedThread={selectedThread}
        relatedEvents={relatedChain}
        developerMode={developerMode}
        onAction={handleDrawerAction}
        onClose={() => setSelectedEvent(null)}
        mobile={isMobile}
      />

      <CalendarNewEventModal
        open={newEventOpen}
        defaultDate={selectedDayIso || toIsoDate(anchorDate)}
        sellerId={selectedThread?.ownerId}
        propertyId={selectedThread?.propertyId}
        threadId={selectedThread?.id}
        editEvent={editEvent}
        entityLabel={selectedThread ? `${selectedThread.ownerDisplayName || selectedThread.ownerName || 'Entity'} · ${selectedThread.propertyAddress || ''}` : undefined}
        onClose={() => { setNewEventOpen(false); setEditEvent(null) }}
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