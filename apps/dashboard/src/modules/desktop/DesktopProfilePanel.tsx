import { useCallback, useState } from 'react'
import { Icon } from '../../shared/icons'
import { AlertSettings } from '../notifications/AlertSettings'
import { SoundSettings } from '../../shared/sound/SoundSettings'
import { formatBuildIdentityLine } from '../../lib/build-identity'
import { setClassicDesktop } from '../mobile/product-platform'
import { EnvironmentStudio } from './appearance/EnvironmentStudio'
import { operatorInitials } from './operator-initials'

/**
 * PROFILE — the operator, and the whole system's look and sound.
 *
 * Appearance is the Environment Studio (modules/desktop/appearance): theme,
 * environment, colour, material, motion and saved environments, all writing
 * the one settings store every surface reads, previewed live against the
 * real product behind this panel. Sound and alert behaviour likewise.
 *
 * Export name and props are stable: the shell (and its Command Deck) render
 * this panel as-is.
 */

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

type Tab = 'appearance' | 'sound' | 'system'

// Stable API: the shell imports operatorInitials from this module.
// eslint-disable-next-line react-refresh/only-export-components
export { operatorInitials }

export function DesktopProfilePanel({ email, name, onSignOut, onClose, onOpenSettings }: { email?: string | null; name?: string | null; onSignOut?: () => void; onClose: () => void; onOpenSettings?: () => void }) {
  const [tab, setTab] = useState<Tab>('appearance')
  // the colour editor asks for room: the panel widens while it is open
  const [wide, setWide] = useState(false)
  const initials = operatorInitials(email, name)
  const openSound = useCallback(() => setTab('sound'), [])

  return (
    <div className={cls('dsk-pop dsk-pop--profile', tab === 'appearance' && 'dsk-pop--studio', tab === 'appearance' && wide && 'is-wide')} role="dialog" aria-label="Profile and system settings">
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
            {t === 'appearance' ? 'Appearance' : t === 'sound' ? 'Sound' : 'System'}
          </button>
        ))}
      </div>

      <div className="dsk-prof__body">
        {tab === 'appearance' ? (
          <div className="dsk-prof__appearance">
            <EnvironmentStudio variant="panel" onOpenSound={openSound} onExpandChange={setWide} />
          </div>
        ) : null}

        {tab === 'sound' ? (
          <div className="dsk-prof__soundtab">
            {/* Sound & Alerts: the desktop Sound System (interface sounds and
                operational alerts), then which notifications appear at all. */}
            <SoundSettings />
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
