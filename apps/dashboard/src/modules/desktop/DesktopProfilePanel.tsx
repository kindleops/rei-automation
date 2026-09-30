import { useEffect, useState } from 'react'
import { Icon } from '../../shared/icons'
import { loadSettings, subscribeSettings, updateSetting } from '../../shared/settings'
import { MobileAppearanceControls } from '../mobile/MobileAppearanceControls'
import { AlertSettings } from '../notifications/AlertSettings'
import { formatBuildIdentityLine } from '../../lib/build-identity'
import { setClassicDesktop } from '../mobile/product-platform'
import { useBackdropColors, useBackdropSettings, type BackdropStyle } from './backdrop-settings'

const STYLES: Array<{ id: BackdropStyle; label: string }> = [
  { id: 'liquid', label: 'Liquid' },
  { id: 'waves', label: 'Waves' },
  { id: 'aurora', label: 'Aurora' },
  { id: 'still', label: 'Still' },
]

/** The flowing colour under the glass: style, colours, strength, motion. */
function BackdropControls() {
  const [bd, setBd] = useBackdropSettings()
  const colors = useBackdropColors(bd.palette)
  const swatch = { ['--pa' as string]: colors[0], ['--pb' as string]: colors[1], ['--pc' as string]: colors[2 % colors.length] }
  return (
    <section className="dsk-bdc">
      <p className="dsk-pop__eyebrow">Background</p>
      <div className="dsk-bdc__styles" role="radiogroup" aria-label="Background style">
        {STYLES.map((st) => (
          <button key={st.id} type="button" role="radio" aria-checked={bd.style === st.id} className={cls('dsk-bdc__style', `is-${st.id}`, bd.style === st.id && 'is-active')} style={swatch} onClick={() => setBd({ style: st.id })}>
            <span className="dsk-bdc__preview" aria-hidden><i /><i /><i /></span>
            <b>{st.label}</b>
          </button>
        ))}
      </div>
      <div className="dsk-bdc__row">
        <span>Colours</span>
        <div className="dsk-seg dsk-seg--inline" role="radiogroup" aria-label="Background colours">
          <button type="button" role="radio" aria-checked={bd.palette === 'accent'} className={cls('dsk-seg__tab', bd.palette === 'accent' && 'is-active')} onClick={() => setBd({ palette: 'accent' })}>Accent</button>
          <button type="button" role="radio" aria-checked={bd.palette === 'spectrum'} className={cls('dsk-seg__tab', bd.palette === 'spectrum' && 'is-active')} onClick={() => setBd({ palette: 'spectrum' })}>Spectrum</button>
        </div>
      </div>
      <label className="dsk-bdc__row">
        <span>Intensity</span>
        <input type="range" min={0} max={100} step={1} value={bd.intensity} onChange={(e) => setBd({ intensity: Number(e.target.value) })} aria-label="Background intensity" />
        <em>{bd.intensity}%</em>
      </label>
      <label className="dsk-bdc__row">
        <span>Motion</span>
        <button type="button" role="switch" aria-checked={bd.motion} className={cls('dsk-switch', bd.motion && 'is-on')} onClick={() => setBd({ motion: !bd.motion })}><i /></button>
      </label>
    </section>
  )
}

/**
 * PROFILE — the operator, and the whole system's look and sound.
 * Theme, accent and Liquid Glass are the same store every surface reads
 * (updateSetting + applyThemeToDOM broadcast), so a change lands everywhere
 * at once; sound and alert behaviour likewise.
 */

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

type Tab = 'appearance' | 'sound' | 'system'

export function operatorInitials(email?: string | null, name?: string | null): string {
  const src = (name || '').trim() || (email || '').split('@')[0]
  const parts = src.split(/[\s._-]+/).filter(Boolean)
  const letters = parts.length >= 2 ? parts[0][0] + parts[1][0] : (parts[0] || 'LC').slice(0, 2)
  return letters.toUpperCase()
}

export function DesktopProfilePanel({ email, name, onSignOut, onClose, onOpenSettings }: { email?: string | null; name?: string | null; onSignOut?: () => void; onClose: () => void; onOpenSettings?: () => void }) {
  const [tab, setTab] = useState<Tab>('appearance')
  const [settings, setSettings] = useState(() => loadSettings())
  useEffect(() => subscribeSettings(() => setSettings(loadSettings())), [])
  const initials = operatorInitials(email, name)

  return (
    <div className="dsk-pop dsk-pop--profile" role="dialog" aria-label="Profile and system settings">
      <header className="dsk-prof__head">
        <span className="dsk-prof__avatar" aria-hidden>{initials}</span>
        <div>
          <h3>{name || (email ? email.split('@')[0] : 'Operator')}</h3>
          {email ? <p>{email}</p> : null}
        </div>
        <button type="button" className="dsk-pop__icon" onClick={onClose} aria-label="Close"><Icon name="x" size={14} /></button>
      </header>

      <div className="dsk-seg" role="tablist" aria-label="Settings">
        {(['appearance', 'sound', 'system'] as Tab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={cls('dsk-seg__tab', tab === t && 'is-active')} onClick={() => setTab(t)}>
            {t === 'appearance' ? 'Appearance' : t === 'sound' ? 'Alerts' : 'System'}
          </button>
        ))}
      </div>

      <div className="dsk-prof__body">
        {tab === 'appearance' ? (
          <div className="dsk-prof__appearance">
            <BackdropControls />
            <MobileAppearanceControls />
          </div>
        ) : null}

        {tab === 'sound' ? (
          <div className="dsk-prof__sound">
            {/* The UI-sound switch playSound() actually reads. (A "sound profile"
                picker used to sit here; nothing ever read its value.) */}
            <label className="dsk-prof__toggle">
              <span><b>Interface sounds</b><small>Confirmations when you move between apps</small></span>
              <button type="button" role="switch" aria-checked={Boolean(settings.soundEnabled)} className={cls('dsk-switch', settings.soundEnabled && 'is-on')} onClick={() => updateSetting('soundEnabled', !settings.soundEnabled)}><i /></button>
            </label>
            <div className="dsk-prof__alerts"><AlertSettings /></div>
          </div>
        ) : null}

        {tab === 'system' ? (
          <div className="dsk-prof__system">
            <button type="button" className="dsk-prof__row" onClick={() => { setClassicDesktop(true) }}>
              <Icon name="layout-split" size={15} />
              <span><b>Classic desktop</b><small>Switch this browser back to the previous desktop views</small></span>
              <Icon name="chevron-right" size={14} />
            </button>
            {onSignOut ? (
              <button type="button" className="dsk-prof__row is-danger" onClick={onSignOut}>
                <Icon name="external-link" size={15} />
                <span><b>Sign out</b><small>End this session on this device</small></span>
                <Icon name="chevron-right" size={14} />
              </button>
            ) : null}
            <p className="dsk-prof__build">{formatBuildIdentityLine()}</p>
          </div>
        ) : null}
      </div>

      {onOpenSettings ? (
        <footer className="dsk-prof__foot">
          <button type="button" className="dsk-prof__all" onClick={onOpenSettings}>
            <Icon name="settings" size={14} />
            <span>All settings</span>
            <kbd>⌘,</kbd>
          </button>
        </footer>
      ) : null}
    </div>
  )
}
