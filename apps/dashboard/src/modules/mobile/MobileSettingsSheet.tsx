import { useEffect, useState } from 'react'
import { Icon } from '../../shared/icons'
import {
  applyThemeToDOM,
  loadSettings,
  subscribeSettings,
  updateSetting,
  type NexusTheme,
} from '../../shared/settings'
import {
  formatBuildIdentityLine,
  resolveBuildIdentity,
  resolveRuntimeShellReport,
  type RuntimeShellReport,
} from '../../lib/build-identity'
import { useBreakpoint } from './useBreakpoint'
import { getViewportDebug } from './viewport-runtime'

const THEME_OPTIONS: Array<{ id: NexusTheme; label: string }> = [
  { id: 'dark', label: 'Dark' },
  { id: 'true_black', label: 'True Black' },
  { id: 'light', label: 'Light' },
  { id: 'midnight-glass', label: 'Midnight' },
  { id: 'tactical-blue', label: 'Tactical' },
  { id: 'operator-black', label: 'Operator' },
]

interface MobileSettingsSheetProps {
  open: boolean
  onClose: () => void
}

export const MobileSettingsSheet = ({ open, onClose }: MobileSettingsSheetProps) => {
  const [theme, setTheme] = useState<NexusTheme>(() => loadSettings().nexusTheme)
  const build = resolveBuildIdentity()
  const viewport = useBreakpoint()

  // Resolved once on open: the manifest and service-worker scope have to be
  // read asynchronously, and they are the two things that decide whether an
  // installed icon launches standalone.
  const [installInfo, setInstallInfo] = useState('resolving…')

  // Measured when the sheet opens, never at module scope: the geometry rows
  // have to reflect the live document, and the resource timeline is only
  // complete once the shell has actually loaded.
  const [shell, setShell] = useState<RuntimeShellReport | null>(null)
  useEffect(() => {
    if (!open) return
    // Measured after paint, so the sheet is laid out and the #root / dock rects
    // are settled rather than read mid-transition.
    const frame = requestAnimationFrame(() => setShell(resolveRuntimeShellReport()))
    return () => cancelAnimationFrame(frame)
  }, [open])
  useEffect(() => {
    let live = true
    const parts: string[] = [`host=${window.location.host}`]
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')
    parts.push(`manifestLink=${link ? 'y' : 'n'}`)

    const swScope = navigator.serviceWorker?.controller
      ? 'controlled'
      : navigator.serviceWorker
        ? 'registered?'
        : 'unsupported'

    const finish = (extra: string[]) => {
      if (!live) return
      setInstallInfo([...parts, ...extra, `sw=${swScope}`, `sha=${build.gitSha}`].join(' · '))
    }

    void (async () => {
      const extra: string[] = []
      try {
        const res = await fetch(link?.href || '/manifest.webmanifest', { credentials: 'include' })
        extra.push(`manifest=${res.status}`, `ct=${(res.headers.get('content-type') || '?').split(';')[0]}`)
        if (res.ok) {
          const m = (await res.json()) as Record<string, unknown>
          // start_url may legitimately carry a bypass param; show only its path
          // and whether the bypass is present, never the token itself.
          const start = String(m.start_url ?? '')
          const [path, query = ''] = start.split('?')
          extra.push(
            `start=${path}`,
            `bypass=${query.includes('x-vercel-protection-bypass') ? 'y' : 'n'}`,
            `display=${String(m.display ?? '-')}`,
            `scope=${String(m.scope ?? '-')}`,
            `id=${String(m.id ?? '-')}`,
          )
        }
      } catch {
        extra.push('manifest=fetch-failed')
      }
      try {
        const reg = await navigator.serviceWorker?.getRegistration()
        if (reg) extra.push(`swScope=${new URL(reg.scope).pathname}`)
      } catch { /* registration lookup is best-effort */ }
      finish(extra)
    })()

    return () => { live = false }
  }, [build.gitSha])

  useEffect(() => {
    return subscribeSettings(() => setTheme(loadSettings().nexusTheme))
  }, [])

  if (!open) return null

  return (
    <>
      <button type="button" className="nx-mobile-sheet-backdrop" aria-label="Close settings" onClick={onClose} />
      <aside className="nx-mobile-settings-sheet" role="dialog" aria-label="Settings">
        <header className="nx-mobile-more-sheet__header">
          <strong>Settings</strong>
          <button type="button" className="nx-mobile-more-sheet__close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="nx-mobile-settings-sheet__body">
          <p className="nx-mobile-settings-sheet__label">Theme</p>
          <div className="nx-mobile-settings-sheet__themes">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`nx-mobile-settings-sheet__theme${theme === option.id ? ' is-active' : ''}`}
                onClick={() => {
                  updateSetting('nexusTheme', option.id)
                  applyThemeToDOM()
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="nx-mobile-settings-sheet__label">About</p>
          <div className="nx-mobile-settings-sheet__about">
            <span>Build</span>
            <code>{formatBuildIdentityLine(build)}</code>
            <span>SHA</span>
            <code>{build.gitSha}</code>
            <span>Viewport</span>
            <code>
              {viewport.layoutWidth}×{viewport.layoutHeight} layout · {viewport.width}×{viewport.height} effective · mobile={viewport.isMobile ? 'yes' : 'no'}
            </code>
            {/* Readable on the physical handset. These are the exact inputs the
                dock anchoring uses, so a wrong dock position can be diagnosed
                from the device rather than inferred from desktop emulation. */}
            <span>Shell</span>
            <code>
              {(() => {
                const d = getViewportDebug()
                if (!d) return 'viewport runtime not started'
                return [
                  `mode=${d.standalone ? 'standalone' : 'browser'}`,
                  `displayMode=${d.displayModeStandalone ? 'y' : 'n'}`,
                  `navStandalone=${d.navigatorStandalone ? 'y' : 'n'}`,
                  `inner=${d.innerHeight}`,
                  `client=${d.clientHeight}`,
                  `vv=${d.visualViewportHeight ?? '-'}`,
                  `vvTop=${d.visualViewportOffsetTop ?? '-'}`,
                  `rawGap=${d.rawGap}`,
                  `appliedGap=${d.appliedGap}`,
                  `vvh=${d.vvh}`,
                  `rendered=${d.renderedHeight}`,
                  `drift=${d.drift}`,
                  `locked=${d.locked ? 'y' : 'n'}`,
                ].join(' · ')
              })()}
            </code>
            {/* What the browser actually executed, read from the resource
                timeline and the pre-React document stamp — not from what this
                bundle's own source expects. A stale application shell shows up
                as a loaded hash that disagrees with the build SHA. */}
            <span>Assets</span>
            <code>
              {shell
                ? [
                    `css=${shell.loadedCss}`,
                    `js=${shell.loadedJs}`,
                    `chunks=${shell.chunkCount}`,
                    `metaSha=${shell.metaSha.slice(0, 12)}`,
                  ].join(' · ')
                : 'measuring…'}
            </code>
            <span>Geometry</span>
            <code>
              {shell
                ? [
                    `inner=${shell.innerHeight}`,
                    `client=${shell.clientHeight}`,
                    `root=${shell.rootRect}`,
                    `dock=${shell.dockRect}`,
                    `display=${shell.displayMode}`,
                    `navStandalone=${shell.navigatorStandalone}`,
                  ].join(' · ')
                : 'measuring…'}
            </code>
            <span>URL</span>
            <code>{shell ? shell.href : 'measuring…'}</code>
            {/* Install contract. If a Home-Screen icon opens in browser mode
                this is what distinguishes "wrong host / wrong start_url" from
                "standalone detection failed". */}
            <span>Install</span>
            <code>{installInfo}</code>
          </div>
        </div>
      </aside>
    </>
  )
}