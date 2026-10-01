import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Icon, type IconName } from '../../shared/icons'
import {
  ACCENT_PALETTE_IDS,
  ACCENT_PALETTES,
  LIGHT_ACCENT_PALETTES,
  THEME_PRESETS,
  applyThemeToDOM,
  loadSettings,
  subscribeSettings,
  updateSetting,
  type AccentPalette,
  type NexusTheme,
} from '../../shared/settings'
import { NEXUS_GLOBAL_THEME_OPTIONS, type NexusGlobalThemeId } from '../../domain/theme/nexusThemes'
import { LiquidGlassControls } from '../../shared/LiquidGlassControls'
import { AlertSettings } from '../../modules/notifications/AlertSettings'
import { useNotificationIntelligence } from '../../domain/notifications/useNotificationIntelligence'
import { useAuth } from '../../components/auth/AuthProvider'
import { resolveBuildIdentity } from '../../lib/build-identity'
import { NEXUS_APPS } from '../../domain/app-registry/app-registry'
import { EnvironmentStudio } from '../../modules/desktop/appearance/EnvironmentStudio'
import { useDesktopShellPrefs } from '../../modules/desktop/desktop-shell-prefs'
import { setDisplayMode, useDisplayMode, type DisplayMode } from '../../modules/desktop/display-mode'
import { clearSplit, useSplitWorkspace } from '../../modules/desktop/split-workspace'
import { operatorInitials } from '../../modules/desktop/operator-initials'
import { setClassicDesktop } from '../../modules/mobile/product-platform'
import { useBreakpoint } from '../../modules/mobile/useBreakpoint'
import './settings.css'

/**
 * SETTINGS — the whole system's preferences on one page.
 *
 * Every control here writes a store something actually reads: theme, accent
 * and Liquid Glass (applyThemeToDOM), the backdrop, the shell, alert and sound
 * switches, quiet hours (the notification preferences the server also keeps).
 * Nothing is listed that does not take effect.
 */

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

type SectionId = 'appearance' | 'alerts' | 'workspace' | 'keyboard' | 'account' | 'about'

const SECTIONS: Array<{ id: SectionId; label: string; icon: IconName; blurb: string }> = [
  { id: 'appearance', label: 'Appearance', icon: 'palette', blurb: 'Theme, environment, colour, glass and motion — previewed live and applied across every app.' },
  { id: 'alerts', label: 'Notifications & sound', icon: 'bell', blurb: 'What interrupts you, how it sounds, and when it stays quiet.' },
  { id: 'workspace', label: 'Workspace', icon: 'layout-split', blurb: 'Sidebar, display, split screen and the Home board.' },
  { id: 'keyboard', label: 'Keyboard', icon: 'command', blurb: 'The shortcuts that work on this desktop.' },
  { id: 'account', label: 'Account', icon: 'user', blurb: 'Who is signed in on this device.' },
  { id: 'about', label: 'About', icon: 'cpu', blurb: 'The build this browser is running.' },
]

const useSettings = () => useSyncExternalStore(subscribeSettings, loadSettings, loadSettings)

function Row({ title, hint, children, stacked }: { title: string; hint?: ReactNode; children?: ReactNode; stacked?: boolean }) {
  return (
    <div className={cls('st-row', stacked && 'is-stacked')}>
      <div className="st-row__copy">
        <strong>{title}</strong>
        {hint ? <small>{hint}</small> : null}
      </div>
      {children ? <div className="st-row__control">{children}</div> : null}
    </div>
  )
}

function Switch({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (next: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={cls('st-switch', on && 'is-on')} onClick={() => onChange(!on)}>
      <i aria-hidden />
    </button>
  )
}

function Segmented<T extends string>({ value, options, label, onChange }: { value: T; options: Array<{ id: T; label: string }>; label: string; onChange: (next: T) => void }) {
  return (
    <div className="st-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={cls('st-seg__opt', value === o.id && 'is-active')} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="st-group">
      {title ? <h3 className="st-group__title">{title}</h3> : null}
      <div className="st-group__card">{children}</div>
    </section>
  )
}

// ── Appearance ───────────────────────────────────────────────────────────

/** Desktop: the Environment Studio. The phone keeps its own appearance controls. */
function AppearanceSection({ phone }: { phone: boolean }) {
  return phone ? <PhoneAppearanceSection /> : <EnvironmentStudio variant="page" />
}

function PhoneAppearanceSection() {
  const settings = useSettings()
  const themeId = settings.nexusTheme as NexusGlobalThemeId
  const isLight = settings.nexusTheme === 'light'
  const palette = isLight ? LIGHT_ACCENT_PALETTES : ACCENT_PALETTES
  const selectTheme = (next: NexusGlobalThemeId) => { updateSetting('nexusTheme', next); applyThemeToDOM() }
  const selectAccent = (next: AccentPalette) => { updateSetting('accentPalette', next); applyThemeToDOM() }

  return (
    <>
      <Group title="Theme">
        <div className="st-themes" role="radiogroup" aria-label="Theme">
          {NEXUS_GLOBAL_THEME_OPTIONS.map((theme) => {
            const active = themeId === theme.id
            // The preview is painted from the theme's own tokens, so it shows
            // the room the operator will actually get.
            const t = THEME_PRESETS[theme.id as NexusTheme]
            return (
              <button
                key={theme.id}
                type="button"
                role="radio"
                aria-checked={active}
                className={cls('st-theme', `is-${theme.id}`, active && 'is-active')}
                style={{
                  ['--th' as string]: t?.accent ?? theme.accent,
                  ['--tb' as string]: t?.bg,
                  ['--ts' as string]: t?.surface,
                  ['--te' as string]: t?.elevated,
                  ['--tl' as string]: t?.border,
                  ['--tt' as string]: t?.textPrimary,
                }}
                onClick={() => selectTheme(theme.id)}
                title={theme.description}
              >
                <span className="st-theme__preview" aria-hidden>
                  <i className="st-theme__side" />
                  <i className="st-theme__bar" />
                  <i className="st-theme__card" />
                  <i className="st-theme__dot" />
                </span>
                <span className="st-theme__label">{theme.label}{active ? <Icon name="check" size={12} strokeWidth={2.4} /> : null}</span>
              </button>
            )
          })}
        </div>
      </Group>

      <Group title="Accent">
        <Row title="Accent colour" hint="Focus, selection and primary actions. Everything else stays neutral.">
          <div className="st-accents" role="radiogroup" aria-label="Accent colour">
            {ACCENT_PALETTE_IDS.map((accent) => (
              <button
                key={accent}
                type="button"
                role="radio"
                aria-checked={settings.accentPalette === accent}
                aria-label={`${accent} accent`}
                title={accent[0].toUpperCase() + accent.slice(1)}
                className={cls('st-accent', settings.accentPalette === accent && 'is-active')}
                style={{ ['--sw' as string]: palette[accent].primary }}
                onClick={() => selectAccent(accent)}
              />
            ))}
          </div>
        </Row>
      </Group>

      <Group title="Liquid Glass">
        <div className="st-lgc">
          <LiquidGlassControls />
        </div>
      </Group>
    </>
  )
}

// ── Notifications & sound ────────────────────────────────────────────────

function AlertsSection() {
  const settings = useSettings()
  const { preferences, savePrefs, setMasterMuted } = useNotificationIntelligence()
  const [start, setStart] = useState(preferences.quietHoursStart || '21:00')
  const [end, setEnd] = useState(preferences.quietHoursEnd || '08:00')
  useEffect(() => { setStart(preferences.quietHoursStart || '21:00'); setEnd(preferences.quietHoursEnd || '08:00') }, [preferences.quietHoursStart, preferences.quietHoursEnd])
  const saveQuiet = (patch: Partial<typeof preferences>) => void savePrefs({ ...preferences, ...patch })

  return (
    <>
      <Group title="General">
        <Row title="Pause all alerts" hint="No pop-ups and no alert sounds until you turn this back off.">
          <Switch on={Boolean(preferences.masterMuted)} label="Pause all alerts" onChange={setMasterMuted} />
        </Row>
        <Row title="Interface sounds" hint="Small confirmations when you move between apps and run actions.">
          <Switch on={Boolean(settings.soundEnabled)} label="Interface sounds" onChange={(v) => updateSetting('soundEnabled', v)} />
        </Row>
        <Row title="Quiet hours" hint="Alerts still arrive in the notification centre, silently.">
          <div className="st-quiet">
            {preferences.quietHoursEnabled ? (
              <>
                <input type="time" value={start} aria-label="Quiet hours start" onChange={(e) => setStart(e.target.value)} onBlur={() => start !== preferences.quietHoursStart && saveQuiet({ quietHoursStart: start })} />
                <span>to</span>
                <input type="time" value={end} aria-label="Quiet hours end" onChange={(e) => setEnd(e.target.value)} onBlur={() => end !== preferences.quietHoursEnd && saveQuiet({ quietHoursEnd: end })} />
              </>
            ) : null}
            <Switch on={Boolean(preferences.quietHoursEnabled)} label="Quiet hours" onChange={(v) => saveQuiet({ quietHoursEnabled: v, quietHoursStart: start, quietHoursEnd: end })} />
          </div>
        </Row>
      </Group>
      <Group title="Alerts">
        <div className="st-alerts"><AlertSettings /></div>
      </Group>
    </>
  )
}

// ── Workspace ────────────────────────────────────────────────────────────

function WorkspaceSection() {
  const [prefs, setPrefs] = useDesktopShellPrefs()
  const { mode, ultrawide } = useDisplayMode()
  const split = useSplitWorkspace()
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  const open = split.panes.length + 1

  return (
    <>
      <Group title="Sidebar">
        <Row title="Collapse to icons" hint={<>Keeps every app one click away in a slim rail. <kbd>⌘</kbd><kbd>\</kbd></>}>
          <Switch on={prefs.collapsed} label="Collapse sidebar" onChange={(collapsed) => setPrefs({ collapsed })} />
        </Row>
        {prefs.closedGroups.length ? (
          <Row title="Folded sections" hint={`${prefs.closedGroups.length} section${prefs.closedGroups.length === 1 ? '' : 's'} folded in the sidebar.`}>
            <button type="button" className="st-btn" onClick={() => setPrefs({ closedGroups: [] })}>Unfold all</button>
          </Row>
        ) : null}
      </Group>

      <Group title="Display">
        <Row title="Layout" hint={`This window is ${size.w.toLocaleString()} × ${size.h.toLocaleString()} — ${ultrawide ? 'ultrawide' : 'standard'} layout${mode === 'auto' ? ' (automatic)' : ''}.`}>
          <Segmented<DisplayMode> value={mode} label="Display layout" options={[{ id: 'auto', label: 'Automatic' }, { id: 'standard', label: 'Standard' }, { id: 'ultrawide', label: 'Ultrawide' }]} onChange={setDisplayMode} />
        </Row>
      </Group>

      <Group title="Split screen">
        <Row title="Open apps" hint={open > 1 ? `${open} apps side by side. Up to 4, each at least a quarter of the width.` : 'One app on screen. Open more beside it from the sidebar, or ⌥↵ in search.'}>
          {open > 1 ? <button type="button" className="st-btn" onClick={clearSplit}>Close split panes</button> : null}
        </Row>
      </Group>

      <Group title="Product">
        <Row title="Classic desktop" hint="Switch this browser back to the previous desktop views. “New desktop” in its profile menu brings you back here.">
          <button type="button" className="st-btn" onClick={() => setClassicDesktop(true)}>Switch</button>
        </Row>
      </Group>
    </>
  )
}

// ── Keyboard ─────────────────────────────────────────────────────────────

const Keys = ({ keys }: { keys: string[] }) => <span className="st-keys">{keys.map((k) => <kbd key={k}>{k}</kbd>)}</span>

function KeyboardSection() {
  // The single-key app jumps are the registry's own shortcuts (CommandCenterApp
  // binds exactly this list); they work anywhere outside a text field.
  const jumps = useMemo(() => NEXUS_APPS.filter((a) => a.desktop && a.shortcut && !a.action && a.id !== 'conversation'), [])
  return (
    <>
      <Group title="Everywhere">
        <Row title="Search everything"><Keys keys={['⌘', 'K']} /></Row>
        <Row title="Search (outside a text field)"><Keys keys={['/']} /></Row>
        <Row title="Open a search result beside this app"><Keys keys={['⌥', '↵']} /></Row>
        <Row title="Collapse or expand the sidebar"><Keys keys={['⌘', '\\']} /></Row>
        <Row title="Open settings"><Keys keys={['⌘', ',']} /></Row>
        <Row title="Close a panel or search"><Keys keys={['esc']} /></Row>
      </Group>
      <Group title="Jump to an app">
        <div className="st-jumps">
          {jumps.map((a) => (
            <div key={a.id} className="st-jump">
              <span><Icon name={a.icon} size={14} strokeWidth={1.7} />{a.label}</span>
              <Keys keys={[String(a.shortcut)]} />
            </div>
          ))}
        </div>
      </Group>
    </>
  )
}

// ── Account ──────────────────────────────────────────────────────────────

function AccountSection() {
  const { user, signOut } = useAuth()
  const settings = useSettings()
  const email = user?.email ?? null
  const fullName = (user?.user_metadata?.full_name as string | undefined) || null
  const [name, setName] = useState(settings.operatorName ?? '')
  useEffect(() => { setName(settings.operatorName ?? '') }, [settings.operatorName])
  return (
    <>
      <Group>
        <div className="st-account">
          <span className="st-account__avatar" aria-hidden>{operatorInitials(email, settings.operatorName || fullName)}</span>
          <div>
            <strong>{settings.operatorName || fullName || (email ? email.split('@')[0] : 'Operator')}</strong>
            {email ? <small>{email}</small> : null}
          </div>
        </div>
      </Group>
      <Group title="Profile">
        <Row title="Name" hint="Used to greet you on Home. Stored on this device.">
          <input
            className="st-input"
            value={name}
            placeholder={fullName || 'Your name'}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => { if (name.trim() !== (settings.operatorName ?? '')) updateSetting('operatorName', name.trim()) }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            aria-label="Name"
          />
        </Row>
      </Group>
      <Group title="Session">
        <Row title="Sign out" hint="Ends the session on this device.">
          <button type="button" className="st-btn is-danger" onClick={() => void signOut()}>Sign out</button>
        </Row>
      </Group>
    </>
  )
}

// ── About ────────────────────────────────────────────────────────────────

function AboutSection() {
  const build = resolveBuildIdentity()
  const known = (v: string) => (v && v !== 'unknown' ? v : null)
  const rows: Array<[string, string | null]> = [
    ['Version', known(build.gitShaShort)],
    ['Deployment', known(build.deploymentId)],
    ['Built', known(build.buildTime) ? (Number.isNaN(Date.parse(build.buildTime)) ? build.buildTime : new Date(build.buildTime).toLocaleString()) : null],
    ['Host', window.location.host],
  ]
  return (
    <Group>
      {rows.filter(([, v]) => v).map(([k, v]) => (
        <Row key={k} title={k}><code className="st-code">{v}</code></Row>
      ))}
    </Group>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────

export function SettingsView() {
  const { isPhone } = useBreakpoint()
  const [section, setSection] = useState<SectionId>(() => {
    const want = new URLSearchParams(window.location.search).get('section')
    // "background" now lives inside Appearance (the Environment Studio)
    return (SECTIONS.some((s) => s.id === want) ? want : 'appearance') as SectionId
  })
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]
  const visible = isPhone ? SECTIONS.filter((s) => s.id !== 'workspace' && s.id !== 'keyboard') : SECTIONS

  return (
    <div className="st" data-section={section}>
      <nav className="st-nav" aria-label="Settings sections">
        <h1 className="st-nav__title">Settings</h1>
        {visible.map((s) => (
          <button key={s.id} type="button" className={cls('st-nav__item', s.id === section && 'is-active')} aria-current={s.id === section ? 'page' : undefined} onClick={() => setSection(s.id)}>
            <Icon name={s.icon} size={15} strokeWidth={1.7} />
            <span>{s.label}</span>
          </button>
        ))}
      </nav>
      <main className="st-main">
        <header className="st-head">
          <h2>{current.label}</h2>
          <p>{current.blurb}</p>
        </header>
        <div className="st-body" key={section}>
          {section === 'appearance' ? <AppearanceSection phone={isPhone} /> : null}
          {section === 'alerts' ? <AlertsSection /> : null}
          {section === 'workspace' ? <WorkspaceSection /> : null}
          {section === 'keyboard' ? <KeyboardSection /> : null}
          {section === 'account' ? <AccountSection /> : null}
          {section === 'about' ? <AboutSection /> : null}
        </div>
      </main>
    </div>
  )
}
