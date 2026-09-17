import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../shared/icons'
import {
  MOBILE_APPS_BY_GROUP,
  isAppActive,
  type NexusApp,
} from '../../domain/app-registry/app-registry'
import { MobileAppearanceControls } from './MobileAppearanceControls'
import { resolveAppDestination } from '../../domain/app-registry/contextual-navigation'
import { readPropertyLocator } from '../../domain/locator/property-locator'
import { badgeForApp, usePinnedAppDockBadges } from './usePinnedAppDockBadges'
import type { DockAppBadge } from './pinned-app-dock.types'
import './app-launcher.css'

/**
 * THE GLOBAL APP LAUNCHER.
 *
 * The dock can hold four destinations before the targets shrink below a thumb. Every
 * other application lives here, which is what makes "all applications discoverable on
 * mobile" true without turning the dock into an icon graveyard.
 *
 * It renders the CANONICAL registry, so an app is reachable the moment it is
 * registered. The three lists this replaces between them omitted Properties, Comp
 * Intelligence and Buyer Match from mobile entirely.
 *
 * The launcher also states the context it is carrying. Navigating from a seller thread
 * to Comps should visibly be "Comps for 1115 Nw 64th St", not a leap of faith — and
 * apps that cannot accept the context say so rather than pretending.
 */

export { APP_LAUNCHER_OPEN_EVENT } from './shell-surface-bridge'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

const formatBadge = (count?: number) => {
  if (!count || count <= 0) return null
  return count > 99 ? '99+' : String(count)
}

const renderBadge = (badge?: DockAppBadge) => {
  if (!badge) return null
  const label = formatBadge(badge.count)
  if (label) {
    return <span className={cls('nx-app-launcher__badge', badge.tone && `is-${badge.tone}`)}>{label}</span>
  }
  if (badge.dot) return <span className="nx-app-launcher__dot" />
  return null
}

interface AppLauncherProps {
  routePath: string
  onClose: () => void
  onSelect: (app: NexusApp) => void
}

/**
 * Mounted only while open (the dock renders it conditionally), so the search query
 * resets by unmounting rather than by an effect that clears state on a prop change.
 */
export const AppLauncher = ({ routePath, onClose, onSelect }: AppLauncherProps) => {
  const [query, setQuery] = useState('')
  const badges = usePinnedAppDockBadges()

  // Read once per mount. The locator is sessionStorage-backed, so re-reading on every
  // keystroke would be pointless work in a list that rerenders as you type.
  const locator = useMemo(() => readPropertyLocator(), [])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  /**
   * MOBILE_APPS_BY_GROUP, not APPS_BY_GROUP filtered here.
   *
   * The `app.mobile` test used to live in this component, which meant every OTHER
   * mobile surface had to remember to repeat it — and WorkspaceLauncher's mobile
   * application list did not, so Property OS was absent from this launcher's rules
   * and present in the one the inbox opened. The registry now exports the mobile
   * projection and this reads it.
   */
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return MOBILE_APPS_BY_GROUP
    return MOBILE_APPS_BY_GROUP
      .map((group) => ({
        ...group,
        apps: group.apps.filter((app) =>
          `${app.label} ${app.shortLabel} ${app.description}`.toLowerCase().includes(q),
        ),
      }))
      .filter((group) => group.apps.length > 0)
  }, [query])

  const matchCount = groups.reduce((total, group) => total + group.apps.length, 0)

  const contextLabel = locator?.address
    || locator?.propertyId
    || locator?.threadKey
    || null

  const launcher = (
    <div className="nx-app-launcher" role="dialog" aria-modal="true" aria-label="Applications">
      <button type="button" className="nx-app-launcher__scrim" aria-label="Close applications" onClick={onClose} />

      <div className="nx-app-launcher__sheet nx-liquid-surface">
        <span className="nx-app-launcher__sheen" aria-hidden />
        <div className="nx-app-launcher__grab" aria-hidden />

        <header className="nx-app-launcher__head">
          <div className="nx-app-launcher__title">
            <strong>Applications</strong>
            {contextLabel ? (
              <span className="nx-app-launcher__context" title={contextLabel}>
                <Icon name="pin" size={11} />
                {contextLabel}
              </span>
            ) : null}
          </div>
          <button type="button" className="nx-app-launcher__close" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="nx-app-launcher__search">
          <Icon name="search" size={15} />
          <input
            type="search"
            value={query}
            placeholder="Search applications…"
            aria-label="Search applications"
            enterKeyHint="go"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              const first = groups[0]?.apps[0]
              if (first) onSelect(first)
            }}
          />
          {query ? (
            <button type="button" className="nx-app-launcher__clear" aria-label="Clear search" onClick={() => setQuery('')}>
              <Icon name="close" size={13} />
            </button>
          ) : null}
        </div>

        <div className="nx-app-launcher__body">
          {matchCount === 0 ? (
            <p className="nx-app-launcher__empty">No application matches “{query}”.</p>
          ) : null}

          {groups.map((group) => (
            <section key={group.group} className="nx-app-launcher__group">
              <h4>{group.label}</h4>
              <div className="nx-app-launcher__grid">
                {group.apps.map((app) => {
                  const active = isAppActive(routePath, app)
                  const destination = resolveAppDestination(app, locator)
                  return (
                    <button
                      key={app.id}
                      type="button"
                      className={cls('nx-app-launcher__tile', active && 'is-active')}
                      aria-current={active ? 'page' : undefined}
                      onClick={() => onSelect(app)}
                    >
                      <span className="nx-app-launcher__glyph">
                        <Icon name={app.icon} size={19} strokeWidth={1.5} />
                        {renderBadge(badgeForApp(badges, app.route))}
                      </span>
                      <span className="nx-app-launcher__label">{app.label}</span>
                      {/* Only ever claim focus the destination genuinely accepts. */}
                      {destination.focused ? (
                        <span className="nx-app-launcher__focus">In context</span>
                      ) : app.mobileCaveat ? (
                        <span className="nx-app-launcher__caveat">{app.mobileCaveat}</span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            </section>
          ))}

          {/* Appearance is part of the launcher, not a separate menu: §0 requires the
              theme/accent system to survive this pass, and the only way it survives
              CONSISTENTLY is by living in the one surface every route can open.
              Hidden while searching — a query is a search for an application. */}
          {query.trim() ? null : <MobileAppearanceControls />}
        </div>
      </div>
    </div>
  )

  return typeof document !== 'undefined' ? createPortal(launcher, document.body) : null
}
