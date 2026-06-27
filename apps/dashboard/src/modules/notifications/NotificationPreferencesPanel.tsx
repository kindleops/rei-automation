import { useEffect, useState } from 'react'
import { Icon } from '../../shared/icons'
import { updateSetting } from '../../shared/settings'
import type { NotificationDomain, NotificationPreferences, SoundCategory } from '../../domain/notifications/notification-contract'
import { NOTIFICATION_DOMAINS, SOUND_CATEGORIES } from '../../domain/notifications/notification-contract'
import { previewNotificationSound } from '../../domain/notifications/notification-sound-bridge'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

const DOMAIN_LABELS: Record<NotificationDomain, string> = {
  campaigns: 'Campaigns',
  templates: 'Templates',
  numbers: 'Numbers',
  markets: 'Markets',
  inbox: 'Inbox',
  acquisition: 'Acquisition',
  closing: 'Closing',
  workflow: 'Workflow',
  platform: 'Platform',
  intelligence: 'Intelligence',
}

const SOUND_LABELS: Record<SoundCategory, string> = {
  'positive-outcome': 'Positive Outcome',
  'seller-reply': 'Seller Reply',
  'campaign-activity': 'Campaign Activity',
  'offer-contract': 'Offer & Contract',
  'warning-alert': 'Warning Alert',
  'critical-system': 'Critical System',
}

const SETTINGS_VOLUME_KEY: Record<SoundCategory, keyof ReturnType<typeof import('../../shared/settings').loadSettings>> = {
  'positive-outcome': 'soundPositiveOutcomeVolume',
  'seller-reply': 'soundSellerReplyVolume',
  'campaign-activity': 'soundCampaignActivityVolume',
  'offer-contract': 'soundOfferContractVolume',
  'warning-alert': 'soundWarningAlertVolume',
  'critical-system': 'soundCriticalSystemVolume',
}

const SETTINGS_ENABLED_KEY: Record<SoundCategory, keyof ReturnType<typeof import('../../shared/settings').loadSettings>> = {
  'positive-outcome': 'soundPositiveOutcome',
  'seller-reply': 'soundSellerReply',
  'campaign-activity': 'soundCampaignActivity',
  'offer-contract': 'soundOfferContract',
  'warning-alert': 'soundWarningAlert',
  'critical-system': 'soundCriticalSystem',
}

export const NotificationPreferencesPanel = ({
  preferences,
  onSave,
  onClose,
}: {
  preferences: NotificationPreferences
  onSave: (prefs: NotificationPreferences) => Promise<void>
  onClose: () => void
}) => {
  const [draft, setDraft] = useState(preferences)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDraft(preferences)
  }, [preferences])

  const updateDraft = (patch: Partial<NotificationPreferences>) => {
    setDraft((prev) => ({ ...prev, ...patch }))
  }

  const toggleDomainMute = (domain: NotificationDomain) => {
    setDraft((prev) => ({
      ...prev,
      domainMutes: {
        ...prev.domainMutes,
        [domain]: !prev.domainMutes?.[domain],
      },
    }))
  }

  const setCategoryVolume = (category: SoundCategory, volume: number) => {
    setDraft((prev) => ({
      ...prev,
      soundCategoryVolumes: {
        ...prev.soundCategoryVolumes,
        [category]: volume,
      },
    }))
    updateSetting(SETTINGS_VOLUME_KEY[category], volume)
  }

  const toggleCategoryEnabled = (category: SoundCategory) => {
    const next = !(draft.soundCategoryEnabled?.[category] ?? true)
    setDraft((prev) => ({
      ...prev,
      soundCategoryEnabled: {
        ...prev.soundCategoryEnabled,
        [category]: next,
      },
    }))
    updateSetting(SETTINGS_ENABLED_KEY[category], next)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave(draft)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="lcnc-prefs">
      <header className="lcnc-prefs__header">
        <div>
          <span className="lcnc-prefs__eyebrow">INTELLIGENCE</span>
          <strong className="lcnc-prefs__title">Notification Preferences</strong>
        </div>
        <button type="button" className="lcnc-prefs__close" onClick={onClose} aria-label="Close preferences">
          <Icon name="close" />
        </button>
      </header>

      <div className="lcnc-prefs__body">
        <section className="lcnc-prefs__section">
          <label className="lcnc-prefs__label">MASTER CONTROLS</label>
          <div className="lcnc-prefs__row">
            <span>Mute all notification sounds</span>
            <button
              type="button"
              className={cls('lcnc-prefs__toggle', draft.masterMuted && 'is-on')}
              onClick={() => updateDraft({ masterMuted: !draft.masterMuted })}
            >
              {draft.masterMuted ? 'Muted' : 'Live'}
            </button>
          </div>
        </section>

        <section className="lcnc-prefs__section">
          <label className="lcnc-prefs__label">QUIET HOURS</label>
          <div className="lcnc-prefs__row">
            <span>Suppress sounds during quiet hours</span>
            <button
              type="button"
              className={cls('lcnc-prefs__toggle', draft.quietHoursEnabled && 'is-on')}
              onClick={() => updateDraft({ quietHoursEnabled: !draft.quietHoursEnabled })}
            >
              {draft.quietHoursEnabled ? 'On' : 'Off'}
            </button>
          </div>
          <div className="lcnc-prefs__time-row">
            <label>
              Start
              <input
                type="time"
                value={draft.quietHoursStart}
                onChange={(e) => updateDraft({ quietHoursStart: e.target.value })}
              />
            </label>
            <label>
              End
              <input
                type="time"
                value={draft.quietHoursEnd}
                onChange={(e) => updateDraft({ quietHoursEnd: e.target.value })}
              />
            </label>
          </div>
        </section>

        <section className="lcnc-prefs__section">
          <label className="lcnc-prefs__label">DOMAIN MUTES</label>
          <div className="lcnc-prefs__chips">
            {NOTIFICATION_DOMAINS.map((domain) => (
              <button
                key={domain}
                type="button"
                className={cls('lcnc-prefs__chip', draft.domainMutes?.[domain] && 'is-muted')}
                onClick={() => toggleDomainMute(domain)}
              >
                {DOMAIN_LABELS[domain]}
              </button>
            ))}
          </div>
        </section>

        <section className="lcnc-prefs__section">
          <label className="lcnc-prefs__label">SOUND CATEGORIES</label>
          <div className="lcnc-prefs__sound-list">
            {SOUND_CATEGORIES.map((category) => {
              const enabled = draft.soundCategoryEnabled?.[category] ?? true
              const volume = draft.soundCategoryVolumes?.[category] ?? 0.5
              return (
                <div key={category} className="lcnc-prefs__sound-row">
                  <div className="lcnc-prefs__sound-meta">
                    <strong>{SOUND_LABELS[category]}</strong>
                    <button
                      type="button"
                      className="lcnc-prefs__preview"
                      onClick={() => previewNotificationSound(category)}
                      title="Preview sound"
                    >
                      <Icon name="volume" />
                    </button>
                  </div>
                  <div className="lcnc-prefs__sound-controls">
                    <button
                      type="button"
                      className={cls('lcnc-prefs__toggle lcnc-prefs__toggle--compact', enabled && 'is-on')}
                      onClick={() => toggleCategoryEnabled(category)}
                    >
                      {enabled ? 'On' : 'Off'}
                    </button>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={volume}
                      onChange={(e) => setCategoryVolume(category, Number(e.target.value))}
                      aria-label={`${SOUND_LABELS[category]} volume`}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      </div>

      <footer className="lcnc-prefs__footer">
        <button type="button" className="lcnc-prefs__btn" onClick={onClose}>Cancel</button>
        <button type="button" className="lcnc-prefs__btn is-primary" onClick={() => void handleSave()} disabled={saving}>
          {saving ? 'Saving…' : 'Save preferences'}
        </button>
      </footer>
    </div>
  )
}