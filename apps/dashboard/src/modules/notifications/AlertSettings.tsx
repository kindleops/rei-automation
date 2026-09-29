import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Icon } from '../../shared/icons'
import { loadSettings, subscribeSettings, updateSetting } from '../../shared/settings'
import { SOUND_ASSET_LABELS, SOUND_ASSET_URLS, type SoundAssetId } from '../../shared/sound-assets'
import {
  ALERT_TYPES,
  ALERT_TYPE_HINT,
  ALERT_TYPE_LABEL,
  DEFAULT_ALERT_SOUND,
  type AlertType,
} from '../../domain/notifications/alert-types'
import { alertSoundFor, previewAlertSound } from '../../domain/notifications/notification-sound-bridge'
import { readDevicePushAlertTypes, saveDevicePushAlertTypes } from '../../domain/notifications/push-subscription'
import { MobileNotificationPermission } from './MobileNotificationPermission'
import './alert-settings.css'

/**
 * ALERTS — the operator's switches, in one place.
 *
 *   In-app pop-ups on/off, alert sounds on/off + volume, and per alert type:
 *   on/off, which sound (or none), and whether it reaches THIS phone.
 *
 * In-app choices live in `nexus-settings` (this device); the phone choice is
 * stored with this device's push subscription, because the server decides
 * which phones a push goes to. A web app cannot choose the lock-screen sound
 * on iPhone — iOS plays its own — so the picker governs in-app sound only,
 * and the copy says so.
 */

const SOUND_IDS = Object.keys(SOUND_ASSET_URLS) as SoundAssetId[]

const useSettingsSnapshot = () => useSyncExternalStore(subscribeSettings, loadSettings, loadSettings)

function Switch({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (next: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={`nx-alerts__switch${on ? ' is-on' : ''}`}
      onClick={() => onChange(!on)}
    >
      <span aria-hidden />
    </button>
  )
}

export function AlertSettings() {
  const settings = useSettingsSnapshot()
  const [phone, setPhone] = useState<Record<AlertType, boolean> | null>(null)
  const [phoneSaving, setPhoneSaving] = useState<AlertType | null>(null)
  const [phoneError, setPhoneError] = useState(false)

  const reloadPhone = useCallback(() => {
    void readDevicePushAlertTypes().then(setPhone)
  }, [])
  useEffect(() => { reloadPhone() }, [reloadPhone])

  const popups = settings.notificationsEnabled !== false
  const sounds = settings.notificationSoundEnabled !== false

  const setTypeEnabled = (type: AlertType, on: boolean) =>
    updateSetting('alertTypeEnabled', { ...(settings.alertTypeEnabled ?? {}), [type]: on })
  const setTypeSound = (type: AlertType, sound: string) => {
    updateSetting('alertTypeSound', { ...(settings.alertTypeSound ?? {}), [type]: sound })
    if (sound !== 'none') previewAlertSound(sound as SoundAssetId)
  }
  const setPhoneType = async (type: AlertType, on: boolean) => {
    if (!phone) return
    const next = { ...phone, [type]: on }
    setPhone(next)
    setPhoneSaving(type)
    const ok = await saveDevicePushAlertTypes(next)
    setPhoneSaving(null)
    setPhoneError(!ok)
    if (!ok) setPhone(phone)
  }

  return (
    <section className="nx-alerts" aria-label="Alerts">
      <div className="nx-alerts__master">
        <div className="nx-alerts__row">
          <div className="nx-alerts__copy">
            <strong>Pop-up alerts</strong>
            <small>A banner in the app when something happens</small>
          </div>
          <Switch on={popups} label="Pop-up alerts" onChange={(v) => updateSetting('notificationsEnabled', v)} />
        </div>
        <div className="nx-alerts__row">
          <div className="nx-alerts__copy">
            <strong>Alert sounds</strong>
            <small>Plays while LeadCommand is open</small>
          </div>
          <Switch on={sounds} label="Alert sounds" onChange={(v) => updateSetting('notificationSoundEnabled', v)} />
        </div>
        {sounds ? (
          <label className="nx-alerts__volume">
            <Icon name="volume" size={14} />
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings.soundVolume}
              aria-label="Alert volume"
              onChange={(e) => updateSetting('soundVolume', Number(e.target.value))}
              onPointerUp={() => previewAlertSound(alertSoundFor('seller_reply') ?? 'new-sms')}
            />
          </label>
        ) : null}
      </div>

      <MobileNotificationPermission variant="setting" onChange={reloadPhone} />

      <ul className="nx-alerts__types">
        {ALERT_TYPES.map((type) => {
          const enabled = settings.alertTypeEnabled?.[type] !== false
          const chosen = settings.alertTypeSound?.[type] ?? DEFAULT_ALERT_SOUND[type]
          return (
            <li key={type} className={`nx-alerts__type${enabled ? '' : ' is-off'}`}>
              <div className="nx-alerts__row">
                <div className="nx-alerts__copy">
                  <strong>{ALERT_TYPE_LABEL[type]}</strong>
                  <small>{ALERT_TYPE_HINT[type]}</small>
                </div>
                <Switch on={enabled} label={`${ALERT_TYPE_LABEL[type]} alerts`} onChange={(v) => setTypeEnabled(type, v)} />
              </div>
              {enabled ? (
                <div className="nx-alerts__controls">
                  <label className="nx-alerts__sound">
                    <Icon name="volume" size={13} />
                    <select
                      value={chosen}
                      aria-label={`${ALERT_TYPE_LABEL[type]} sound`}
                      disabled={!sounds}
                      onChange={(e) => setTypeSound(type, e.target.value)}
                    >
                      {SOUND_IDS.map((id) => <option key={id} value={id}>{SOUND_ASSET_LABELS[id]}</option>)}
                      <option value="none">None</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    className="nx-alerts__play"
                    aria-label={`Play ${ALERT_TYPE_LABEL[type]} sound`}
                    disabled={chosen === 'none'}
                    onClick={() => chosen !== 'none' && previewAlertSound(chosen as SoundAssetId)}
                  >
                    <Icon name="play" size={12} />
                  </button>
                  {phone ? (
                    <span className="nx-alerts__phone">
                      <Icon name="phone" size={13} />
                      <span>Phone</span>
                      <Switch
                        on={phone[type]}
                        label={`${ALERT_TYPE_LABEL[type]} on this phone`}
                        disabled={phoneSaving === type}
                        onChange={(v) => void setPhoneType(type, v)}
                      />
                    </span>
                  ) : null}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>

      {phoneError ? <p className="nx-alerts__note is-error">Couldn’t save the phone setting — try again.</p> : null}
      <p className="nx-alerts__note">
        {phone
          ? 'Phone alerts use your phone’s own notification sound — iPhone doesn’t let web apps pick it.'
          : 'Turn on push above to choose which alerts reach this phone.'}
      </p>
    </section>
  )
}
