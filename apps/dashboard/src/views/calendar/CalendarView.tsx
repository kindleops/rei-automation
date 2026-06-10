import { useEffect, useMemo, useState } from 'react'
import {
  getCalendarModeRangeLabel,
  loadAutomationSchedule,
  loadClosingDeadlines,
  loadContractDeadlines,
  loadDailyCalendar,
  loadGlobalExecutionTimeline,
  loadOfferFollowUps,
  loadOverdueExecutionItems,
  loadSelectedSellerTimeline,
  loadThirtyDayCalendar,
  loadTodayExecutionSummary,
  loadWeeklyCalendar,
  type CalendarEvent,
  type CalendarFilters,
  type CalendarScopeMode,
  type CalendarViewMode,
  type ExecutionSummaryCard,
} from '../../lib/data/calendarData'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import type { ViewLayoutMode } from '../../domain/inbox/view-layout'
import { formatCurrency, formatRelativeTime } from '../../shared/formatters'
import { Icon } from '../../shared/icons'
import { CalendarHeader } from './CalendarHeader'
import { CalendarModeTabs } from './CalendarModeTabs'
import { CalendarRightRail } from './CalendarRightRail'
import { DailyExecutionSchedule } from './DailyExecutionSchedule'
import { ExecutionSnapshotStrip } from './ExecutionSnapshotStrip'
import { MonthExecutionGrid } from './MonthExecutionGrid'
import { SellerCalendarContext } from './SellerCalendarContext'
import { TimelineExecutionFeed } from './TimelineExecutionFeed'
import { WeeklyExecutionGrid } from './WeeklyExecutionGrid'
import './calendar-view.css'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type DrawerAction = 'deal' | 'conversation' | 'pipeline' | 'comp' | 'buyer' | 'pause' | 'review'

type InboxCalendarViewProps = {
  threads: InboxWorkflowThread[]
  selectedThread: InboxWorkflowThread | null
  selectedId: string | null
  layoutMode: ViewLayoutMode
  onSelectThread: (id: string) => void
  onSelectEvent?: (event: CalendarEvent) => void
  onOpenDealIntelligence?: (threadId?: string | null) => void
}

const toStartOfDay = (value: Date) => {
  const next = new Date(value)
  next.setHours(0, 0, 0, 0)
  return next
}

const toIsoDate = (value: Date) => {
  const year = value.getFullYear()
  const month = `${value.getMonth() + 1}`.padStart(2, '0')
  const day = `${value.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

const toDateKey = (value: string) => toIsoDate(toStartOfDay(new Date(value)))

const addDays = (value: Date, amount: number) => {
  const next = new Date(value)
  next.setDate(next.getDate() + amount)
  return next
}

const sellerContextStats = (thread: InboxWorkflowThread | null) => {
  if (!thread) return []
  return [
    { label: 'Stage', value: String(thread.conversationStage || thread.inboxStage || 'Unknown').replace(/_/g, ' ') },
    { label: 'Priority', value: String(thread.priority || 'normal').replace(/_/g, ' ') },
    { label: 'Automation', value: String(thread.automationState || 'active').replace(/_/g, ' ') },
    { label: 'Last Reply', value: thread.lastInboundAt ? formatRelativeTime(thread.lastInboundAt) : 'No reply yet' },
    { label: 'Next Action', value: String((thread as any).next_action || thread.nextSystemAction || 'Review conversation') },
    { label: 'Offer / Contract', value: String((thread as any).offerStatus || (thread as any).contractStatus || 'Pending').replace(/_/g, ' ') },
    { label: 'Title / Closing', value: String((thread as any).titleStatus || (thread as any).closingStatus || 'Not started').replace(/_/g, ' ') },
  ]
}

const buildFilters = (threads: InboxWorkflowThread[], selectedThread: InboxWorkflowThread | null, scopeMode: CalendarScopeMode): CalendarFilters => ({
  threads,
  propertyId: scopeMode === 'selected' ? selectedThread?.propertyId ?? null : null,
  sellerId: scopeMode === 'selected' ? selectedThread?.ownerId ?? null : null,
  threadId: scopeMode === 'selected' ? selectedThread?.id ?? null : null,
})

function SurfaceList({
  title,
  count,
  events,
  selectedEventId,
  onSelect,
  emptyTitle,
  emptyDescription,
}: {
  title: string
  count?: number
  events: CalendarEvent[]
  selectedEventId: string | null
  onSelect: (event: CalendarEvent) => void
  emptyTitle?: string
  emptyDescription?: string
}) {
  return (
    <section className="nx-cal__surface">
      <div className="nx-cal__section-head">
        <strong>{title}</strong>
        <span>{count ?? events.length}</span>
      </div>
      <TimelineExecutionFeed
        events={events}
        selectedId={selectedEventId}
        onSelect={onSelect}
        compact
        emptyTitle={emptyTitle}
        emptyDescription={emptyDescription}
      />
    </section>
  )
}

function CompactPeriodList({
  title,
  days,
  selectedEventId,
  onSelect,
}: {
  title: string
  days: Array<{ label: string; sublabel: string; events: CalendarEvent[] }>
  selectedEventId: string | null
  onSelect: (event: CalendarEvent) => void
}) {
  return (
    <section className="nx-cal__surface">
      <div className="nx-cal__section-head">
        <strong>{title}</strong>
        <span>{days.reduce((total, day) => total + day.events.length, 0)}</span>
      </div>
      <div className="nx-cal__period-strip">
        {days.map((day) => (
          <article key={`${day.label}-${day.sublabel}`} className="nx-cal__period-card">
            <div className="nx-cal__period-head">
              <strong>{day.label}</strong>
              <span>{day.sublabel}</span>
            </div>
            <div className="nx-cal__period-body">
              {day.events.length === 0 ? (
                <span className="nx-cal__period-empty">No events</span>
              ) : day.events.slice(0, 3).map((event) => (
                <button
                  key={event.id}
                  type="button"
                  className={cls('nx-cal__period-chip', `is-${event.tone}`, selectedEventId === event.id && 'is-selected')}
                  onClick={() => onSelect(event)}
                >
                  <strong>{new Date(event.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</strong>
                  <span>{event.title}</span>
                </button>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

function EventDetailDrawer({
  event,
  selectedThread,
  onAction,
  onClose,
}: {
  event: CalendarEvent | null
  selectedThread: InboxWorkflowThread | null
  onAction: (action: DrawerAction) => void
  onClose: () => void
}) {
  if (!event) return null
  const actions: Array<{ id: DrawerAction; label: string; danger?: boolean }> = [
    { id: 'deal', label: 'Open Deal Intelligence' },
    { id: 'conversation', label: 'Open Conversation' },
    { id: 'pipeline', label: 'Open Pipeline' },
    { id: 'comp', label: 'Open Comp Intelligence' },
    { id: 'buyer', label: 'Open Buyer Match' },
    { id: 'pause', label: 'Pause Automation', danger: true },
    { id: 'review', label: 'Mark Reviewed' },
  ]

  return (
    <aside className="nx-cal__drawer">
      <div className="nx-cal__drawer-head">
        <div>
          <span className="nx-cal__eyebrow">{event.sourceTable.replace(/_/g, ' ')}</span>
          <strong>{event.title}</strong>
        </div>
        <button type="button" className="nx-cal__icon-btn" onClick={onClose} aria-label="Close event drawer">
          <Icon name="close" />
        </button>
      </div>
      <div className="nx-cal__drawer-grid">
        <div><label>Seller</label><strong>{event.sellerName}</strong></div>
        <div><label>Property</label><strong>{event.propertyAddress}</strong></div>
        <div><label>Timestamp</label><strong>{new Date(event.timestamp).toLocaleString()}</strong></div>
        <div><label>Market</label><strong>{event.market}</strong></div>
        <div><label>Status</label><strong>{event.status.replace(/_/g, ' ')}</strong></div>
        <div><label>Actor</label><strong>{event.actor}</strong></div>
        <div><label>Priority</label><strong>{event.priority}</strong></div>
        <div><label>Selected Context</label><strong>{selectedThread?.ownerDisplayName || selectedThread?.ownerName || 'Global Calendar'}</strong></div>
      </div>
      <p className="nx-cal__drawer-copy">{event.description}</p>
      {event.metadata?.amount ? (
        <div className="nx-cal__drawer-money">{formatCurrency(Number(event.metadata.amount))}</div>
      ) : null}
      <div className="nx-cal__drawer-actions">
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className={cls('nx-cal__drawer-action', action.danger && 'is-danger')}
            onClick={() => onAction(action.id)}
          >
            {action.label}
          </button>
        ))}
      </div>
    </aside>
  )
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
  const [anchorDate, setAnchorDate] = useState<Date>(() => toStartOfDay(new Date()))
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
  const [loading, setLoading] = useState(false)
  const [liveTick, setLiveTick] = useState(0)
  const [railOpen, setRailOpen] = useState(layoutMode === 'full')

  useEffect(() => {
    if (selectedThread && scopeMode === 'global' && layoutMode !== 'compact') {
      setScopeMode('selected')
    }
  }, [layoutMode, scopeMode, selectedThread])

  useEffect(() => {
    setRailOpen(layoutMode === 'full')
  }, [layoutMode])

  useEffect(() => {
    const interval = window.setInterval(() => setLiveTick((value) => value + 1), 20000)
    return () => window.clearInterval(interval)
  }, [])

  const filters = useMemo(() => buildFilters(threads, selectedThread, scopeMode), [threads, selectedThread, scopeMode])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const anchorIso = anchorDate.toISOString()
    const loadPrimary =
      scopeMode === 'selected' && selectedThread?.ownerId && viewMode === 'timeline'
        ? loadSelectedSellerTimeline(selectedThread.ownerId, selectedThread.propertyId || undefined, threads)
        : viewMode === 'day'
          ? loadDailyCalendar(anchorIso, filters)
          : viewMode === 'week'
            ? loadWeeklyCalendar(anchorIso, filters)
            : viewMode === 'thirty_day'
              ? loadThirtyDayCalendar(anchorIso, filters)
              : loadGlobalExecutionTimeline(filters)

    Promise.all([
      loadPrimary,
      loadTodayExecutionSummary(filters),
      loadOverdueExecutionItems(filters),
      loadAutomationSchedule(filters),
      loadClosingDeadlines(filters),
      loadContractDeadlines(filters),
      loadOfferFollowUps(filters),
    ]).then(([primaryEvents, nextSummary, nextOverdue, nextAutomation, nextClosings, nextContracts, nextOffers]) => {
      if (cancelled) return
      setEvents(primaryEvents)
      setSummaryCards(nextSummary)
      setOverdueItems(nextOverdue)
      setAutomationSchedule(nextAutomation)
      setClosingItems(nextClosings)
      setContractItems(nextContracts)
      setOfferItems(nextOffers)
      setLastUpdated(new Date().toISOString())
      setLoading(false)
    }).catch(() => {
      if (cancelled) return
      setEvents([])
      setSummaryCards([])
      setOverdueItems([])
      setAutomationSchedule([])
      setClosingItems([])
      setContractItems([])
      setOfferItems([])
      setLastUpdated(new Date().toISOString())
      setLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [anchorDate, filters, liveTick, scopeMode, selectedThread?.ownerId, selectedThread?.propertyId, viewMode])

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
    const todayKey = toDateKey(new Date().toISOString())
    return events.filter((event) => toDateKey(event.timestamp) === todayKey).slice(0, 14)
  }, [events])

  const urgentItems = useMemo(() => {
    const merged = [...overdueItems, ...events.filter((event) => event.hot || event.dueSoon)]
    const deduped = new Map<string, CalendarEvent>()
    merged.forEach((event) => {
      if (!deduped.has(event.id)) deduped.set(event.id, event)
    })
    return Array.from(deduped.values()).slice(0, 10)
  }, [events, overdueItems])

  const contextStats = useMemo(() => sellerContextStats(selectedThread), [selectedThread])
  const headerLabel = useMemo(() => getCalendarModeRangeLabel(viewMode, anchorDate), [anchorDate, viewMode])
  const liveLabel = loading ? 'Refreshing…' : `Live · ${formatRelativeTime(lastUpdated)}`
  const compactPeriodDays = useMemo(() => {
    const count = viewMode === 'thirty_day' ? 10 : viewMode === 'week' ? 7 : 4
    return Array.from({ length: count }, (_, index) => {
      const day = addDays(anchorDate, index)
      const dayKey = toIsoDate(day)
      return {
        label: day.toLocaleDateString(undefined, { weekday: 'short' }),
        sublabel: day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        events: events.filter((event) => toDateKey(event.timestamp) === dayKey),
      }
    })
  }, [anchorDate, events, viewMode])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    console.log('[calendar]', {
      calendarEventsCount: events.length,
      selectedSellerEventsCount: selectedTimeline.length,
      mode: viewMode,
      contextMode: scopeMode,
      layoutMode,
    })
  }, [events.length, layoutMode, scopeMode, selectedTimeline.length, viewMode])

  const handlePrev = () => {
    if (viewMode === 'day') setAnchorDate((value) => addDays(value, -1))
    else if (viewMode === 'week') setAnchorDate((value) => addDays(value, -7))
    else if (viewMode === 'thirty_day') setAnchorDate((value) => addDays(value, -30))
    else setAnchorDate((value) => addDays(value, -14))
  }

  const handleNext = () => {
    if (viewMode === 'day') setAnchorDate((value) => addDays(value, 1))
    else if (viewMode === 'week') setAnchorDate((value) => addDays(value, 7))
    else if (viewMode === 'thirty_day') setAnchorDate((value) => addDays(value, 30))
    else setAnchorDate((value) => addDays(value, 14))
  }

  const handleSelectEvent = (event: CalendarEvent) => {
    setSelectedEvent(event)
    onSelectEvent?.(event)
    const targetThreadId = event.threadId || selectedId
    if (targetThreadId) onSelectThread(targetThreadId)
  }

  const handleDrawerAction = (action: DrawerAction) => {
    if (!selectedEvent) return
    const targetThreadId = selectedEvent.threadId || selectedId || null
    if (action === 'deal' || action === 'comp' || action === 'buyer') {
      onOpenDealIntelligence?.(targetThreadId)
      return
    }
    if ((action === 'conversation' || action === 'pipeline') && targetThreadId) {
      onSelectThread(targetThreadId)
    }
  }

  const mainSurface = (() => {
    if (viewMode === 'day') {
      return <DailyExecutionSchedule events={events} selectedEventId={selectedEvent?.id ?? null} onSelect={handleSelectEvent} />
    }
    if (viewMode === 'week') {
      return <WeeklyExecutionGrid anchorDate={anchorDate} events={events} selectedEventId={selectedEvent?.id ?? null} onSelect={handleSelectEvent} />
    }
    if (viewMode === 'thirty_day') {
      return <MonthExecutionGrid anchorDate={anchorDate} events={events} selectedEventId={selectedEvent?.id ?? null} onSelect={handleSelectEvent} />
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
          events={events.slice(0, layoutMode === 'compact' ? 16 : 80)}
          selectedId={selectedEvent?.id ?? null}
          onSelect={handleSelectEvent}
          grouped
        />
      </section>
    )
  })()

  return (
    <div className={cls('calendar-command', 'nx-cal', `is-${layoutMode}`)}>
      {import.meta.env.DEV ? (
        <div className="calendar-command__dev-badge">CALENDAR ELITE UI ACTIVE</div>
      ) : null}
      <CalendarHeader
        rangeLabel={headerLabel}
        scopeMode={scopeMode}
        selectedEnabled={Boolean(selectedThread)}
        loading={loading}
        anchorDate={toIsoDate(anchorDate)}
        railOpen={railOpen}
        showRailToggle={layoutMode === 'expanded' || layoutMode === 'full'}
        onToday={() => setAnchorDate(toStartOfDay(new Date()))}
        onPrev={handlePrev}
        onNext={handleNext}
        onRefresh={() => setLiveTick((value) => value + 1)}
        onDateChange={(value) => setAnchorDate(toStartOfDay(new Date(value || new Date().toISOString())))}
        onScopeChange={setScopeMode}
        onToggleRail={() => setRailOpen((value) => !value)}
        liveLabel={liveLabel}
      />

      <CalendarModeTabs value={viewMode} onChange={setViewMode} />

      <ExecutionSnapshotStrip cards={summaryCards} compact={layoutMode !== 'full'} />

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

      {layoutMode === 'compact' ? (
        <div className="nx-cal__compact">
          <div className="nx-cal__compact-title">
            <span className="nx-cal__eyebrow">Calendar</span>
            <strong>{viewMode === 'timeline' ? 'Execution feed' : 'Execution rail'}</strong>
          </div>
          {viewMode === 'timeline'
            ? <SurfaceList title="Execution Feed" events={events.slice(0, 10)} selectedEventId={selectedEvent?.id ?? null} onSelect={handleSelectEvent} />
            : <CompactPeriodList title={viewMode === 'day' ? 'Today' : viewMode === 'week' ? 'This Week' : '30-Day Window'} days={compactPeriodDays} selectedEventId={selectedEvent?.id ?? null} onSelect={handleSelectEvent} />}
          <SurfaceList title="Top 3 Urgent Items" events={urgentItems.slice(0, 3)} selectedEventId={selectedEvent?.id ?? null} onSelect={handleSelectEvent} />
          <SurfaceList title="Next Scheduled Action" events={[...automationSchedule, ...offerItems, ...contractItems].slice(0, 4)} selectedEventId={selectedEvent?.id ?? null} onSelect={handleSelectEvent} />
          {selectedThread ? (
            <SurfaceList
              title="Selected Seller Timeline"
              events={selectedTimeline.slice(0, 6)}
              selectedEventId={selectedEvent?.id ?? null}
              onSelect={handleSelectEvent}
              emptyTitle="No timeline events found for this seller yet."
              emptyDescription="We found no matched seller queue, message, offer, contract, title, or closing rows yet."
            />
          ) : null}
        </div>
      ) : layoutMode === 'medium' ? (
        <div className="nx-cal__medium">
          {viewMode === 'timeline'
            ? <SurfaceList title="Execution Timeline" events={events.slice(0, 18)} selectedEventId={selectedEvent?.id ?? null} onSelect={handleSelectEvent} />
            : <CompactPeriodList title={viewMode === 'day' ? 'Today Schedule' : viewMode === 'week' ? 'Weekly Strip' : '30-Day Strip'} days={compactPeriodDays} selectedEventId={selectedEvent?.id ?? null} onSelect={handleSelectEvent} />}
          <div className="nx-cal__stack-grid">
            <SurfaceList title="Today Agenda" events={todayAgenda} selectedEventId={selectedEvent?.id ?? null} onSelect={handleSelectEvent} />
            <SurfaceList title="Overdue / Risk" events={overdueItems.slice(0, 10)} selectedEventId={selectedEvent?.id ?? null} onSelect={handleSelectEvent} />
            <SurfaceList title="Automation Schedule" events={automationSchedule.slice(0, 10)} selectedEventId={selectedEvent?.id ?? null} onSelect={handleSelectEvent} />
            {selectedThread
              ? <SurfaceList
                  title="Selected Seller Timeline"
                  events={selectedTimeline.slice(0, 10)}
                  selectedEventId={selectedEvent?.id ?? null}
                  onSelect={handleSelectEvent}
                  emptyTitle="No timeline events found for this seller yet."
                  emptyDescription="We found no matched seller queue, message, offer, contract, title, or closing rows yet."
                />
              : <SurfaceList title="Offers / Contracts / Closings" events={[...offerItems, ...contractItems, ...closingItems].slice(0, 10)} selectedEventId={selectedEvent?.id ?? null} onSelect={handleSelectEvent} />}
          </div>
        </div>
      ) : (
        <div className={cls('nx-cal__desktop', railOpen && 'has-rail')}>
          <div className="nx-cal__desktop-main">
            {mainSurface}
            {viewMode !== 'timeline' ? (
              <section className="nx-cal__surface">
                <div className="nx-cal__section-head">
                  <div>
                    <span className="nx-cal__eyebrow">{scopeMode === 'selected' ? 'Seller Timeline' : 'Global Feed'}</span>
                    <strong>{scopeMode === 'selected' ? 'Selected seller operational history' : 'Execution timeline feed'}</strong>
                  </div>
                  <span>{scopeMode === 'selected' ? selectedTimeline.length : events.length}</span>
                </div>
                <TimelineExecutionFeed
                  events={(scopeMode === 'selected' ? selectedTimeline : events).slice(0, 24)}
                  selectedId={selectedEvent?.id ?? null}
                  onSelect={handleSelectEvent}
                  grouped={layoutMode === 'full'}
                  compact={layoutMode === 'expanded'}
                  emptyTitle={scopeMode === 'selected' ? 'No timeline events found for this seller yet.' : 'No execution events scheduled for this period.'}
                  emptyDescription={scopeMode === 'selected' ? 'We found no matched queue, message, offer, contract, title, or closing history for the selected seller.' : 'Global execution events will appear here as scheduling and replies flow in.'}
                />
              </section>
            ) : null}
          </div>

          {railOpen ? (
            <CalendarRightRail
              todayAgenda={todayAgenda}
              overdueItems={overdueItems.slice(0, 12)}
              automationSchedule={automationSchedule.slice(0, 12)}
              scheduledItems={[...offerItems, ...contractItems, ...closingItems, ...automationSchedule]}
              selectedEventId={selectedEvent?.id ?? null}
              onSelect={handleSelectEvent}
            />
          ) : null}
        </div>
      )}

      {selectedEvent ? (
        <EventDetailDrawer
          event={selectedEvent}
          selectedThread={selectedThread}
          onAction={handleDrawerAction}
          onClose={() => setSelectedEvent(null)}
        />
      ) : null}
    </div>
  )
}
