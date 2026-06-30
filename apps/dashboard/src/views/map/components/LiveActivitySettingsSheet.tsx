import { memo, useEffect } from 'react'
import { createPortal } from 'react-dom'
import type {
  CommandMapActivityType,
  CommandMapLiveActivitySettings,
  CommandMapPerformanceSettings,
  LiveActivityDisplayMode,
  LiveActivitySpeed,
} from '../commandMapLiveActivity'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

const DISPLAY_MODES: LiveActivityDisplayMode[] = ['minimal', 'compact', 'expanded', 'docked', 'hidden']
const SPEEDS: LiveActivitySpeed[] = ['paused', 'slow', 'normal', 'fast']
const SCOPES = ['viewport', 'selected', 'market', 'global'] as const

const EVENT_FILTERS: Array<{ key: CommandMapActivityType; label: string }> = [
  { key: 'new_reply', label: 'New Replies' },
  { key: 'positive_reply', label: 'Positive Replies' },
  { key: 'hot_lead', label: 'Hot Sellers' },
  { key: 'message_sent', label: 'Message Sent' },
  { key: 'message_delivered', label: 'Delivered' },
  { key: 'message_failed', label: 'Failed' },
  { key: 'follow_up_due', label: 'Follow-Ups' },
  { key: 'offer', label: 'Offers' },
  { key: 'contract', label: 'Contracts' },
  { key: 'closing', label: 'Closings' },
  { key: 'buyer_activity', label: 'Buyer Activity' },
  { key: 'sold_comp', label: 'Sold Comps' },
  { key: 'automation_block', label: 'Automation Blocks' },
  { key: 'queue_blocked', label: 'Queue Blocks' },
  { key: 'opt_out', label: 'DNC / Opt-Out' },
]

type Props = {
  open: boolean
  isMobile: boolean
  settings: CommandMapLiveActivitySettings
  isUltrawide: boolean
  onClose: () => void
  onSettingsChange: (patch: Partial<CommandMapLiveActivitySettings>) => void
  onPerformanceChange: (patch: Partial<CommandMapPerformanceSettings>) => void
}

export const LiveActivitySettingsSheet = memo(function LiveActivitySettingsSheet({
  open,
  isMobile,
  settings,
  isUltrawide,
  onClose,
  onSettingsChange,
  onPerformanceChange,
}: Props) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, open])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div className="nx-icm-activity-sheet-root" role="presentation" onClick={onClose}>
      <aside
        className={cls('nx-icm-activity-sheet', isMobile && 'is-mobile')}
        role="dialog"
        aria-label="Live Activity settings"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="nx-icm-activity-sheet__header">
          <strong>Activity Settings</strong>
          <button type="button" className="nx-icm-activity-sheet__close" onClick={onClose} aria-label="Close settings">×</button>
        </header>

        <div className="nx-icm-activity-sheet__body">
          <section>
            <span className="nx-icm-activity-settings__label">Display Mode</span>
            <div className="nx-icm-activity-settings__segment">
              {DISPLAY_MODES.map((mode) => (
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
          </section>

          <section>
            <span className="nx-icm-activity-settings__label">Scope</span>
            <div className="nx-icm-activity-settings__segment">
              {SCOPES.map((scope) => (
                <button
                  key={scope}
                  type="button"
                  className={cls('nx-icm-activity-settings__chip', settings.scope === scope && 'is-active')}
                  onClick={() => onSettingsChange({ scope, onlyCurrentBounds: scope === 'viewport' })}
                >
                  {scope}
                </button>
              ))}
            </div>
          </section>

          <section>
            <span className="nx-icm-activity-settings__label">Channel</span>
            <div className="nx-icm-activity-settings__segment">
              <button type="button" className={cls('nx-icm-activity-settings__chip', settings.activeChannel === 'live' && 'is-active')} onClick={() => onSettingsChange({ activeChannel: 'live' })}>Live</button>
              <button type="button" className={cls('nx-icm-activity-settings__chip', settings.activeChannel === 'context' && 'is-active')} onClick={() => onSettingsChange({ activeChannel: 'context' })}>Context</button>
            </div>
          </section>

          <section>
            <span className="nx-icm-activity-settings__label">Playback Speed</span>
            <div className="nx-icm-activity-settings__segment">
              {SPEEDS.map((speed) => (
                <button key={speed} type="button" className={cls('nx-icm-activity-settings__chip', settings.speed === speed && 'is-active')} onClick={() => onSettingsChange({ speed })}>{speed}</button>
              ))}
            </div>
          </section>

          <div className="nx-icm-activity-settings__toggles">
            <label><input type="checkbox" checked={settings.pauseOnHover} onChange={(e) => onSettingsChange({ pauseOnHover: e.target.checked })} />Pause on hover</label>
            <label><input type="checkbox" checked={settings.autoScroll} onChange={(e) => onSettingsChange({ autoScroll: e.target.checked })} />Auto-advance</label>
            <label><input type="checkbox" checked={settings.pinHotEvents} onChange={(e) => onSettingsChange({ pinHotEvents: e.target.checked })} />Pin urgent events</label>
            <label><input type="checkbox" checked={settings.showMapRipples} onChange={(e) => onSettingsChange({ showMapRipples: e.target.checked })} />Show map ripples</label>
            <label><input type="checkbox" checked={settings.openTargetOnClick} onChange={(e) => onSettingsChange({ openTargetOnClick: e.target.checked })} />Open target on event click</label>
          </div>

          <section>
            <span className="nx-icm-activity-settings__label">Retention Window (days)</span>
            <input
              className="nx-icm-activity-settings__range"
              type="range"
              min={3}
              max={30}
              step={1}
              value={settings.retentionDays}
              onChange={(e) => onSettingsChange({ retentionDays: Number(e.target.value) })}
            />
            <strong>{settings.retentionDays}d</strong>
          </section>

          <section>
            <span className="nx-icm-activity-settings__label">Max Retained Events</span>
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
          </section>

          <div className="nx-icm-activity-settings__filters">
            {EVENT_FILTERS.map((option) => (
              <label key={option.key} className="nx-icm-activity-settings__event">
                <input
                  type="checkbox"
                  checked={settings.eventTypes[option.key]}
                  onChange={(e) => onSettingsChange({
                    eventTypes: { ...settings.eventTypes, [option.key]: e.target.checked },
                  })}
                />
                {option.label}
              </label>
            ))}
          </div>
        </div>
      </aside>
    </div>,
    document.body,
  )
})