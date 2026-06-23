import { memo, useMemo, useState, type CSSProperties } from 'react'
import type {
  CommandMapActivityEvent,
  CommandMapLiveActivitySettings,
  CommandMapPerformanceSettings,
  CommandMapActivityType,
  LiveActivityDisplayMode,
  LiveActivitySpeed,
} from '../commandMapLiveActivity'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

const DISPLAY_MODE_OPTIONS: LiveActivityDisplayMode[] = ['minimal', 'compact', 'expanded', 'docked', 'hidden']
const SPEED_OPTIONS: LiveActivitySpeed[] = ['paused', 'slow', 'normal', 'fast']
const EVENT_TYPE_OPTIONS: Array<{ key: CommandMapActivityType; label: string }> = [
  { key: 'message_sent', label: 'Message Sent' },
  { key: 'message_delivered', label: 'Delivered' },
  { key: 'message_failed', label: 'Failed' },
  { key: 'queue_scheduled', label: 'Scheduled' },
  { key: 'queue_ready', label: 'Queue Ready' },
  { key: 'queue_blocked', label: 'Queue Blocked' },
  { key: 'queue_paused', label: 'Queue Paused' },
  { key: 'new_reply', label: 'New Replies' },
  { key: 'positive_reply', label: 'Positive Replies' },
  { key: 'hot_lead', label: 'Hot Leads' },
  { key: 'follow_up_due', label: 'Follow-Ups Due' },
  { key: 'offer', label: 'Offers' },
  { key: 'contract', label: 'Contracts' },
  { key: 'closing', label: 'Closings' },
  { key: 'buyer_activity', label: 'Buyer Activity' },
  { key: 'sold_comp', label: 'Recent Sold Comps' },
  { key: 'system_alert', label: 'System Alerts' },
  { key: 'routing_block', label: 'Routing Blocks' },
  { key: 'opt_out', label: 'DNC / Opt-Outs' },
  { key: 'automation_block', label: 'Automation Blocks' },
  { key: 'missing_message_event', label: 'Missing Event' },
  { key: 'provider_id_missing', label: 'Provider ID Missing' },
]

type Props = {
  events: CommandMapActivityEvent[]
  settings: CommandMapLiveActivitySettings
  performanceSettings: CommandMapPerformanceSettings
  isUltrawide: boolean
  reducedMotion: boolean
  onSettingsChange: (patch: Partial<CommandMapLiveActivitySettings>) => void
  onPerformanceChange: (patch: Partial<CommandMapPerformanceSettings>) => void
  onSelectEvent: (event: CommandMapActivityEvent) => void
}

const SPEED_TO_DURATION: Record<LiveActivitySpeed, number> = {
  paused: 0,
  slow: 92,
  normal: 68,
  fast: 46,
}

export const CommandMapLiveActivityRail = memo(function CommandMapLiveActivityRail({
  events,
  settings,
  performanceSettings,
  isUltrawide,
  reducedMotion,
  onSettingsChange,
  onPerformanceChange,
  onSelectEvent,
}: Props) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [manualPins, setManualPins] = useState<string[]>([])

  const effectiveMode: LiveActivityDisplayMode =
    settings.visible && settings.displayMode !== 'hidden'
      ? settings.displayMode
      : 'hidden'

  const scrollEnabled = settings.autoScroll && !reducedMotion && settings.speed !== 'paused' && effectiveMode !== 'docked'
  const duration = SPEED_TO_DURATION[settings.speed]

  const pinnedEvents = useMemo(() => {
    const pinnedSet = new Set(manualPins)
    return events.filter((event, index) => {
      if (pinnedSet.has(event.id)) return true
      if (!settings.pinHotEvents) return false
      if (event.priority === 'critical') return index < 4
      return event.priority === 'hot' && index < (isUltrawide ? 3 : 2)
    }).slice(0, isUltrawide ? 4 : 2)
  }, [events, isUltrawide, manualPins, settings.pinHotEvents])

  const flowingEvents = useMemo(() => {
    const pinnedSet = new Set(pinnedEvents.map((event) => event.id))
    return events.filter((event) => !pinnedSet.has(event.id))
  }, [events, pinnedEvents])

  if (effectiveMode === 'hidden' || events.length === 0) return null

  const railClassName = cls(
    'nx-icm-activity',
    `is-${effectiveMode}`,
    scrollEnabled && 'is-scrolling',
    settingsOpen && 'is-settings-open',
    reducedMotion && 'is-reduced-motion',
    settings.pauseOnHover && 'is-pause-on-hover',
    isUltrawide && 'is-ultrawide',
  )

  return (
    <section
      className={railClassName}
      aria-label="Command Map live activity"
      style={{
        '--nx-activity-duration': `${duration}s`,
      } as CSSProperties}
    >
      <div className="nx-icm-activity__header">
        <div className="nx-icm-activity__heading">
          <span className="nx-icm-activity__dot" />
          <div>
            <strong>Live Activity</strong>
            <span>{events.length} events in flow</span>
          </div>
        </div>
        <div className="nx-icm-activity__controls">
          <button type="button" className="nx-icm-activity__toggle" onClick={() => onSettingsChange({ visible: !settings.visible, displayMode: settings.visible ? 'hidden' : performanceSettings.liveActivityMode || 'compact' })}>
            {settings.visible ? 'Hide Live Activity' : 'Show Live Activity'}
          </button>
          <button type="button" className={cls('nx-icm-activity__toggle', settingsOpen && 'is-active')} onClick={() => setSettingsOpen((current) => !current)}>
            Activity Settings
          </button>
        </div>
      </div>

      {settingsOpen && (
        <CommandMapLiveActivitySettingsPanel
          settings={settings}
          performanceSettings={performanceSettings}
          isUltrawide={isUltrawide}
          onSettingsChange={onSettingsChange}
          onPerformanceChange={onPerformanceChange}
        />
      )}

      {pinnedEvents.length > 0 && effectiveMode !== 'minimal' && (
        <div className="nx-icm-activity__pinned" aria-label="Pinned hot events">
          {pinnedEvents.map((event) => (
            <CommandMapLiveActivityCard
              key={event.id}
              event={event}
              compact={effectiveMode === 'compact'}
              pinned
              onPin={() => setManualPins((current) => current.includes(event.id) ? current.filter((id) => id !== event.id) : [...current, event.id])}
              onSelect={onSelectEvent}
            />
          ))}
        </div>
      )}

      {effectiveMode === 'minimal' ? (
        <div className="nx-icm-activity__minimal">
          <button type="button" className="nx-icm-activity__minimal-event" onClick={() => onSelectEvent(events[0])}>
            <span>{events[0]?.badgeLabel}</span>
            <strong>{events[0]?.title}</strong>
            <em>{events[0]?.detail || events[0]?.address || events[0]?.subtitle}</em>
          </button>
        </div>
      ) : (
        <div className="nx-icm-activity__stream">
          <div className="nx-icm-activity__fade nx-icm-activity__fade--left" />
          <div className="nx-icm-activity__fade nx-icm-activity__fade--right" />
          <div className="nx-icm-activity__viewport">
            <div className="nx-icm-activity__track">
              {(effectiveMode === 'docked' ? flowingEvents : [...flowingEvents, ...flowingEvents]).map((event, index) => (
                <CommandMapLiveActivityCard
                  key={`${event.id}-${index}`}
                  event={event}
                  compact={effectiveMode === 'compact'}
                  onPin={() => setManualPins((current) => current.includes(event.id) ? current.filter((id) => id !== event.id) : [...current, event.id])}
                  onSelect={onSelectEvent}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  )
})

const CommandMapLiveActivityCard = memo(function CommandMapLiveActivityCard({
  event,
  compact = false,
  pinned = false,
  onPin,
  onSelect,
}: {
  event: CommandMapActivityEvent
  compact?: boolean
  pinned?: boolean
  onPin: () => void
  onSelect: (event: CommandMapActivityEvent) => void
}) {
  const widthClass = (event.detail?.length || 0) > 96 || (event.address?.length || 0) > 28 ? 'is-wide' : 'is-standard'
  return (
    <article
      className={cls('nx-icm-activity-card', `is-${event.priority}`, `tone-${event.accentTone || 'slate'}`, compact && 'is-compact', pinned && 'is-pinned', widthClass)}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(event)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(event)
        }
      }}
    >
      <div className="nx-icm-activity-card__top">
        <span className="nx-icm-activity-card__badge">{event.badgeLabel}</span>
        <span className="nx-icm-activity-card__time">{event.timeAgo}</span>
      </div>
      <div className="nx-icm-activity-card__main">
        <strong>{event.title}</strong>
        {(event.address || event.subtitle) && <span>{event.address || event.subtitle}</span>}
      </div>
      {event.detail && <p className="nx-icm-activity-card__detail">{event.detail}</p>}
      <div className="nx-icm-activity-card__footer">
        <div className="nx-icm-activity-card__meta">
          {event.valueLabel && <span>{event.valueLabel}</span>}
          {event.scoreLabel && <span>{event.scoreLabel}</span>}
        </div>
        <div className="nx-icm-activity-card__actions">
          {event.actionLabel && <em>{event.actionLabel}</em>}
          <button
            type="button"
            className="nx-icm-activity-card__pin"
            onClick={(e) => {
              e.stopPropagation()
              onPin()
            }}
          >
            {pinned ? 'Unpin' : 'Pin'}
          </button>
        </div>
      </div>
    </article>
  )
})

function CommandMapLiveActivitySettingsPanel({
  settings,
  performanceSettings,
  isUltrawide,
  onSettingsChange,
  onPerformanceChange,
}: {
  settings: CommandMapLiveActivitySettings
  performanceSettings: CommandMapPerformanceSettings
  isUltrawide: boolean
  onSettingsChange: (patch: Partial<CommandMapLiveActivitySettings>) => void
  onPerformanceChange: (patch: Partial<CommandMapPerformanceSettings>) => void
}) {
  return (
    <div className="nx-icm-activity-settings">
      <div className="nx-icm-activity-settings__section">
        <span className="nx-icm-activity-settings__label">Display Mode</span>
        <div className="nx-icm-activity-settings__segment">
          {DISPLAY_MODE_OPTIONS.map((mode) => (
            <button
              key={mode}
              type="button"
              className={cls('nx-icm-activity-settings__chip', settings.displayMode === mode && 'is-active')}
              onClick={() => {
                onSettingsChange({ visible: mode !== 'hidden', displayMode: mode })
                onPerformanceChange({ liveActivityMode: mode })
              }}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      <div className="nx-icm-activity-settings__section">
        <span className="nx-icm-activity-settings__label">Speed</span>
        <div className="nx-icm-activity-settings__segment">
          {SPEED_OPTIONS.map((speed) => (
            <button
              key={speed}
              type="button"
              className={cls('nx-icm-activity-settings__chip', settings.speed === speed && 'is-active')}
              onClick={() => onSettingsChange({ speed })}
            >
              {speed}
            </button>
          ))}
        </div>
      </div>

      <div className="nx-icm-activity-settings__toggles">
        <label><input type="checkbox" checked={settings.pauseOnHover} onChange={(e) => onSettingsChange({ pauseOnHover: e.target.checked })} />Pause on hover</label>
        <label><input type="checkbox" checked={settings.onlyCurrentBounds} onChange={(e) => onSettingsChange({ onlyCurrentBounds: e.target.checked })} />Only current bounds</label>
        <label><input type="checkbox" checked={settings.onlySelectedMarket} onChange={(e) => onSettingsChange({ onlySelectedMarket: e.target.checked })} />Only selected market</label>
        <label><input type="checkbox" checked={settings.onlyHotCritical} onChange={(e) => onSettingsChange({ onlyHotCritical: e.target.checked })} />Only hot / critical</label>
        <label><input type="checkbox" checked={settings.autoScroll} onChange={(e) => onSettingsChange({ autoScroll: e.target.checked })} />Auto-scroll</label>
        <label><input type="checkbox" checked={settings.pinHotEvents} onChange={(e) => onSettingsChange({ pinHotEvents: e.target.checked })} />Pin hot events</label>
        <label><input type="checkbox" checked={settings.subtleSpeedVariance} onChange={(e) => onSettingsChange({ subtleSpeedVariance: e.target.checked })} />Subtle speed variance</label>
        <label><input type="checkbox" checked={settings.visible} onChange={(e) => onSettingsChange({ visible: e.target.checked, displayMode: e.target.checked ? settings.displayMode : 'hidden' })} />Show live activity</label>
      </div>

      <div className="nx-icm-activity-settings__section">
        <span className="nx-icm-activity-settings__label">Max Cards Visible</span>
        <input
          className="nx-icm-activity-settings__range"
          type="range"
          min={8}
          max={isUltrawide ? 40 : 28}
          step={2}
          value={settings.maxCardsVisible}
          onChange={(e) => onSettingsChange({ maxCardsVisible: Number(e.target.value) })}
        />
        <strong>{settings.maxCardsVisible}</strong>
      </div>

      <div className="nx-icm-activity-settings__filters">
        {EVENT_TYPE_OPTIONS.map((option) => (
          <label key={option.key} className="nx-icm-activity-settings__event">
            <input
              type="checkbox"
              checked={settings.eventTypes[option.key]}
              onChange={(e) => onSettingsChange({
                eventTypes: {
                  ...settings.eventTypes,
                  [option.key]: e.target.checked,
                },
              })}
            />
            {option.label}
          </label>
        ))}
      </div>

      <div className="nx-icm-activity-settings__footer">
        <span>Performance live activity mode: {performanceSettings.liveActivityMode}</span>
      </div>
    </div>
  )
}
