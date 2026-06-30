import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type TouchEvent } from 'react'
import type {
  CommandMapLiveActivitySettings,
  CommandMapPerformanceSettings,
  LiveActivityDisplayMode,
} from '../commandMapLiveActivity'
import type { LiveActivityEvent, LiveActivityFeedSnapshot } from '../live-activity-engine'
import { groupEventsByRecency } from '../useLiveActivityDeck'
import { useLiveActivityDeck } from '../useLiveActivityDeck'
import { LiveActivitySettingsSheet } from './LiveActivitySettingsSheet'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

const SCOPE_LABELS = {
  viewport: 'VIEWPORT',
  selected: 'SELECTED',
  market: 'MARKET',
  global: 'GLOBAL',
} as const

type Props = {
  feed: LiveActivityFeedSnapshot
  settings: CommandMapLiveActivitySettings
  isUltrawide: boolean
  isMobile: boolean
  reducedMotion: boolean
  conversationOpen?: boolean
  composerActive?: boolean
  sellerCardExpanded?: boolean
  sellerCardPeek?: boolean
  onSettingsChange: (patch: Partial<CommandMapLiveActivitySettings>) => void
  onPerformanceChange: (patch: Partial<CommandMapPerformanceSettings>) => void
  onSelectEvent: (event: LiveActivityEvent) => void
  onFocusEvent: (event: LiveActivityEvent) => void
  onHoverEvent?: (event: LiveActivityEvent | null) => void
  onNewEventPulse?: (event: LiveActivityEvent) => void
}

export const CommandMapLiveActivityRail = memo(function CommandMapLiveActivityRail({
  feed,
  settings,
  isUltrawide,
  isMobile,
  reducedMotion,
  conversationOpen = false,
  composerActive = false,
  sellerCardExpanded = false,
  sellerCardPeek = false,
  onSettingsChange,
  onPerformanceChange,
  onSelectEvent,
  onFocusEvent,
  onHoverEvent,
  onNewEventPulse,
}: Props) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const prevTopIdRef = useRef<string | null>(null)

  const preferredMode = settings.visible && settings.displayMode !== 'hidden'
    ? settings.displayMode
    : 'hidden'

  const effectiveMode: LiveActivityDisplayMode = useMemo(() => {
    if (preferredMode === 'hidden') return 'hidden'
    if (conversationOpen || composerActive) return 'hidden'
    if (sellerCardExpanded && isMobile) return 'minimal'
    if (sellerCardExpanded && preferredMode === 'expanded') return 'compact'
    if (isMobile && preferredMode === 'docked') return 'expanded'
    return preferredMode
  }, [composerActive, conversationOpen, isMobile, preferredMode, sellerCardExpanded])

  const timelineEvents = feed.visible
  const tickerQueue = feed.tickerQueue
  const displayCount = effectiveMode === 'minimal' || effectiveMode === 'compact'
    ? feed.tickerCount
    : feed.visibleCount

  const deck = useLiveActivityDeck({
    queue: tickerQueue,
    speed: settings.speed,
    autoAdvance: settings.autoScroll,
    pauseOnHover: settings.pauseOnHover,
    isHovered,
    isInteractionPaused: settingsOpen,
    reducedMotion,
  })

  useEffect(() => {
    const topId = tickerQueue[0]?.id ?? null
    if (topId && topId !== prevTopIdRef.current && tickerQueue[0]) {
      onNewEventPulse?.(tickerQueue[0])
    }
    prevTopIdRef.current = topId
  }, [onNewEventPulse, tickerQueue])

  const scopeLabel = SCOPE_LABELS[settings.scope ?? 'viewport']
  const showChannelTabs = effectiveMode === 'expanded' || (effectiveMode === 'docked' && !isMobile)
  const timelineGrouped = useMemo(() => groupEventsByRecency(timelineEvents), [timelineEvents])

  const handlePrimaryClick = useCallback((event: LiveActivityEvent) => {
    if (settings.openTargetOnClick) onSelectEvent(event)
    deck.acknowledgeActive()
  }, [deck, onSelectEvent, settings.openTargetOnClick])

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0]
    touchStartRef.current = { x: touch.clientX, y: touch.clientY }
  }

  const handleTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    const start = touchStartRef.current
    touchStartRef.current = null
    if (!start || effectiveMode !== 'compact') return
    const touch = event.changedTouches[0]
    const dx = touch.clientX - start.x
    const dy = touch.clientY - start.y
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 42) {
      if (dx < 0) deck.goNext()
      else deck.goPrevious()
      return
    }
    if (dy < -60 && isMobile) {
      onSettingsChange({ displayMode: 'expanded' })
      onPerformanceChange({ liveActivityMode: 'expanded' })
    }
    if (dy > 60 && isMobile) {
      onSettingsChange({ displayMode: 'minimal' })
      onPerformanceChange({ liveActivityMode: 'minimal' })
    }
  }

  if (effectiveMode === 'hidden') return null

  const railClassName = cls(
    'nx-icm-activity',
    `is-${effectiveMode}`,
    isMobile && 'is-mobile',
    isHovered && 'is-hovered',
    sellerCardPeek && 'is-behind-peek',
    sellerCardExpanded && 'is-behind-card',
    deck.isFlipping && 'is-flipping',
    settingsOpen && 'is-sheet-open',
  )

  return (
    <>
      <section
        className={railClassName}
        aria-label="Live Activity"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        <header className="nx-icm-activity__header">
          <div className="nx-icm-activity__heading">
            <span className="nx-icm-activity__dot" aria-hidden />
            <div className="nx-icm-activity__title-block">
              <strong>Live Activity</strong>
              <span className="nx-icm-activity__meta">
                {displayCount} in flow
                <em className="nx-icm-activity__scope">{scopeLabel}</em>
              </span>
            </div>
          </div>

          <div className="nx-icm-activity__controls">
            {showChannelTabs && (
              <div className="nx-icm-activity__channel-switch" role="tablist">
                <button type="button" role="tab" aria-selected={settings.activeChannel === 'live'} className={cls('nx-icm-activity__channel-btn', settings.activeChannel === 'live' && 'is-active')} onClick={() => onSettingsChange({ activeChannel: 'live' })}>Live Now</button>
                <button type="button" role="tab" aria-selected={settings.activeChannel === 'context'} className={cls('nx-icm-activity__channel-btn', settings.activeChannel === 'context' && 'is-active')} onClick={() => onSettingsChange({ activeChannel: 'context' })}>Context</button>
              </div>
            )}
            <button type="button" className="nx-icm-activity__icon-btn" aria-label="Hide" title="Hide" onClick={() => onSettingsChange({ visible: false, displayMode: 'hidden' })}>
              <span aria-hidden>×</span>
            </button>
            <button type="button" className="nx-icm-activity__icon-btn" aria-label="Settings" title="Settings" onClick={() => setSettingsOpen(true)}>
              <span aria-hidden>⚙</span>
            </button>
          </div>
        </header>

        {(effectiveMode === 'minimal' || effectiveMode === 'compact') && (
          <div className={cls('nx-icm-activity__ticker', effectiveMode === 'compact' && 'is-compact-ticker')}>
            {deck.queueCount === 0 ? (
              <div className="nx-icm-activity__empty nx-icm-activity__empty--ticker">
                <strong>No live events in {settings.scope === 'market' ? 'market' : 'scope'}</strong>
                <span>Monitoring sends, replies, offers, contracts, and automation.</span>
              </div>
            ) : (
              <>
                <div className="nx-icm-activity__flip-stage">
                  <div
                    className={cls('nx-icm-activity__flip-card', deck.isFlipped && 'is-flipped')}
                    style={{ '--nx-flip-duration': `${deck.flipDurationMs}ms` } as CSSProperties}
                  >
                    <div className="nx-icm-activity__flip-face nx-icm-activity__flip-face--front">
                      {deck.activeEvent && (
                        <TickerEventFace
                          event={deck.activeEvent}
                          variant={effectiveMode}
                          position={deck.activeIndex + 1}
                          total={deck.queueCount}
                          onPrimary={() => handlePrimaryClick(deck.activeEvent!)}
                          onFocus={() => onFocusEvent(deck.activeEvent!)}
                          onHover={onHoverEvent}
                        />
                      )}
                    </div>
                    <div className="nx-icm-activity__flip-face nx-icm-activity__flip-face--back">
                      {deck.nextEvent && (
                        <TickerEventFace
                          event={deck.nextEvent}
                          variant={effectiveMode}
                          position={((deck.activeIndex + 1) % deck.queueCount) + 1}
                          total={deck.queueCount}
                          onPrimary={() => handlePrimaryClick(deck.nextEvent!)}
                          onFocus={() => onFocusEvent(deck.nextEvent!)}
                          onHover={onHoverEvent}
                        />
                      )}
                    </div>
                  </div>
                </div>

                {effectiveMode === 'compact' && (
                  <div className="nx-icm-activity__ticker-controls">
                    <button type="button" className="nx-icm-activity__transport" aria-label="Previous event" title="Previous" onClick={deck.goPrevious}>‹</button>
                    <button type="button" className="nx-icm-activity__transport" aria-label={deck.manualPaused ? 'Resume autoplay' : 'Pause autoplay'} title={deck.manualPaused ? 'Play' : 'Pause'} onClick={deck.toggleManualPause}>{deck.manualPaused ? '▶' : '❚❚'}</button>
                    <button type="button" className="nx-icm-activity__transport" aria-label="Next event" title="Next" onClick={deck.goNext}>›</button>
                    <button type="button" className={cls('nx-icm-activity__transport', deck.isPinned && 'is-active')} aria-label="Pin event" title="Pin event" onClick={deck.togglePinActive}>{deck.isPinned ? '★' : '☆'}</button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {(effectiveMode === 'expanded' || (effectiveMode === 'docked' && !isMobile)) && (
          <div className={cls('nx-icm-activity__timeline', effectiveMode === 'docked' && 'is-docked-timeline')}>
            {timelineEvents.length === 0 ? (
              <div className="nx-icm-activity__empty nx-icm-activity__empty--timeline">
                <strong>
                  {settings.activeChannel === 'context'
                    ? 'No contextual intelligence in the current scope.'
                    : 'No live operating events in the current scope.'}
                </strong>
                <span>
                  {settings.activeChannel === 'context'
                    ? 'Select a property or expand the map area.'
                    : 'Pan the map or change scope to surface more activity.'}
                </span>
              </div>
            ) : (
              <div className="nx-icm-activity__timeline-groups">
                {(['now', 'lastHour', 'today', 'earlier'] as const).map((group) => {
                  const events = timelineGrouped[group]
                  if (events.length === 0) return null
                  const label = group === 'now' ? 'Now' : group === 'lastHour' ? 'Last Hour' : group === 'today' ? 'Today' : 'Earlier'
                  return (
                    <section key={group} className="nx-icm-activity__timeline-group">
                      <h4>{label}</h4>
                      <div className="nx-icm-activity__timeline-grid">
                        {events.map((event) => (
                          <TimelineEventCard
                            key={event.id}
                            event={event}
                            docked={effectiveMode === 'docked'}
                            onPrimary={() => onSelectEvent(event)}
                            onFocus={() => onFocusEvent(event)}
                            onHover={onHoverEvent}
                          />
                        ))}
                      </div>
                    </section>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </section>

      <LiveActivitySettingsSheet
        open={settingsOpen}
        isMobile={isMobile}
        settings={settings}
        isUltrawide={isUltrawide}
        onClose={() => setSettingsOpen(false)}
        onSettingsChange={onSettingsChange}
        onPerformanceChange={onPerformanceChange}
      />
    </>
  )
})

function TickerEventFace({
  event,
  variant,
  position,
  total,
  onPrimary,
  onFocus,
  onHover,
}: {
  event: LiveActivityEvent
  variant: 'minimal' | 'compact'
  position: number
  total: number
  onPrimary: () => void
  onFocus: () => void
  onHover?: (event: LiveActivityEvent | null) => void
}) {
  const isMinimal = variant === 'minimal'

  return (
    <article
      className={cls(
        'nx-icm-activity-ticker-card',
        `tone-${event.accentTone || 'slate'}`,
        `severity-${event.severity}`,
        isMinimal && 'is-minimal',
        event.isUnread && 'is-unread',
      )}
      onMouseEnter={() => onHover?.(event)}
      onMouseLeave={() => onHover?.(null)}
    >
      <div className="nx-icm-activity-ticker-card__edge" aria-hidden />
      <div className="nx-icm-activity-ticker-card__body" role="button" tabIndex={0} onClick={onPrimary} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPrimary() } }}>
        <div className="nx-icm-activity-ticker-card__top">
          <span className="nx-icm-activity-ticker-card__type">{event.badgeLabel}</span>
          <span className="nx-icm-activity-ticker-card__time">{event.timeAgo}</span>
        </div>
        <strong className="nx-icm-activity-ticker-card__subject">{event.title}</strong>
        {!isMinimal && event.summary && <p className="nx-icm-activity-ticker-card__summary">{event.summary}</p>}
        {isMinimal && event.summary && <em className="nx-icm-activity-ticker-card__summary-line">{event.summary}</em>}
      </div>
      <div className="nx-icm-activity-ticker-card__actions">
        {!isMinimal && <span className="nx-icm-activity-ticker-card__position">{position} / {total}</span>}
        <button type="button" className="nx-icm-activity-ticker-card__action" onClick={(e) => { e.stopPropagation(); onPrimary() }}>{event.primaryAction.toUpperCase()}</button>
        {event.secondaryAction && (
          <button type="button" className="nx-icm-activity-ticker-card__focus" title="Focus on map" aria-label="Focus on map" onClick={(e) => { e.stopPropagation(); onFocus() }}>
            <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden><circle cx="10" cy="10" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            {!isMinimal && <span>Focus</span>}
          </button>
        )}
      </div>
    </article>
  )
}

function TimelineEventCard({
  event,
  docked,
  onPrimary,
  onFocus,
  onHover,
}: {
  event: LiveActivityEvent
  docked: boolean
  onPrimary: () => void
  onFocus: () => void
  onHover?: (event: LiveActivityEvent | null) => void
}) {
  return (
    <article
      className={cls('nx-icm-activity-timeline-card', `tone-${event.accentTone || 'slate'}`, docked && 'is-docked', event.channel === 'context' && 'is-context')}
      role="button"
      tabIndex={0}
      onClick={onPrimary}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPrimary() } }}
      onMouseEnter={() => onHover?.(event)}
      onMouseLeave={() => onHover?.(null)}
    >
      <div className="nx-icm-activity-timeline-card__top">
        <span>{event.badgeLabel}</span>
        <span>{event.timeAgo}</span>
      </div>
      <strong>{event.title}</strong>
      {event.summary && <p>{event.summary}</p>}
      <div className="nx-icm-activity-timeline-card__footer">
        <button type="button" className="nx-icm-activity-ticker-card__action" onClick={(e) => { e.stopPropagation(); onPrimary() }}>{event.primaryAction}</button>
        {event.secondaryAction && (
          <button type="button" className="nx-icm-activity-ticker-card__focus" title="Focus" aria-label="Focus on map" onClick={(e) => { e.stopPropagation(); onFocus() }}>
            <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden><circle cx="10" cy="10" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
        )}
      </div>
    </article>
  )
}