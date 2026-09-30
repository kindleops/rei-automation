import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../shared/icons'
import { MOBILE_APPS_BY_GROUP, isAppActive, type NexusApp } from '../../domain/app-registry/app-registry'
import { navigateToApp } from '../../domain/app-registry/contextual-navigation'
import { appHue } from '../mobile/app-hues'
import { captureAppSession, resolveAppIdFromRoute } from '../mobile/app-session-cache'
import { closeInboxDealIntelligence, isInboxRoute, openInboxDealIntelligence } from '../mobile/mobile-inbox-bridge'
import { requestNotificationsSurface } from '../mobile/shell-surface-bridge'
import { usePinnedAppDockBadges } from '../mobile/usePinnedAppDockBadges'
import type { DockAppBadge } from '../mobile/pinned-app-dock.types'
import { useDesktopShellPrefs } from './desktop-shell-prefs'
import { MAIN, MAX_PANES, getSplitState, markPaneInteraction, openInSplit, useSplitWorkspace } from './split-workspace'

/**
 * THE DESKTOP SIDEBAR — the whole product, one glance.
 *
 * The same registry, badges and context-preserving navigator the phone dock
 * uses, laid out as a collapsible Liquid Glass sidebar: app sections fold,
 * the whole bar folds to an icon rail, and the active application is held by
 * a liquid highlight that glides between rows in that application's own hue.
 */

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const SECTIONS = MOBILE_APPS_BY_GROUP
  .map((g) => ({ ...g, apps: g.apps.filter((a) => a.action !== 'notifications' && a.action !== 'settings' && !a.route.startsWith('__')) }))
  .filter((g) => g.apps.length > 0)

function activeFor(routePath: string, app: NexusApp): boolean {
  if (app.action === 'deal_intelligence') return routePath === '/deal-intelligence'
  return isAppActive(routePath, app)
}

const badgeText = (b?: DockAppBadge) => (!b || !b.count ? null : b.count > 99 ? '99+' : String(b.count))

export interface DesktopSidebarProps {
  routePath: string
  status: { tone: 'live' | 'warn' | 'down' | 'idle'; label: string; detail?: string }
  onOpenSettings: () => void
}

export function DesktopSidebar({ routePath, status, onOpenSettings }: DesktopSidebarProps) {
  const [prefs, setPrefs] = useDesktopShellPrefs()
  const badges = usePinnedAppDockBadges()
  const split = useSplitWorkspace()
  const splitFull = split.panes.length + 1 >= MAX_PANES
  const openRoutes = useMemo(() => new Set(split.panes.map((p) => p.path.split('?')[0])), [split.panes])
  const navRef = useRef<HTMLElement | null>(null)
  const [glide, setGlide] = useState<{ y: number; h: number; hue: string } | null>(null)
  const collapsed = prefs.collapsed
  const closed = useMemo(() => new Set(prefs.closedGroups), [prefs.closedGroups])

  const activeApp = useMemo(() => SECTIONS.flatMap((s) => s.apps).find((a) => activeFor(routePath, a)) ?? null, [routePath])
  const hue = appHue(activeApp?.id)

  const go = useCallback((app: NexusApp) => {
    captureAppSession(resolveAppIdFromRoute(routePath))
    // The sidebar drives whichever pane has focus (the main pane when unsplit).
    markPaneInteraction(getSplitState().focused || MAIN)
    navigateToApp(app, {
      openDealIntelligence: (identity) => openInboxDealIntelligence(identity ?? undefined),
      openNotifications: requestNotificationsSurface,
      openSettings: onOpenSettings,
      closeInboxDealIntelligence,
      isInboxRoute,
    })
  }, [onOpenSettings, routePath])

  // ⌘\ folds the sidebar from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') { e.preventDefault(); setPrefs({ collapsed: !collapsed }) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [collapsed, setPrefs])

  const toggleGroup = (group: string) => {
    const next = new Set(closed)
    if (next.has(group)) next.delete(group)
    else next.add(group)
    setPrefs({ closedGroups: [...next] })
  }

  // The liquid highlight follows the active row: measured after layout, and
  // again after a section folds or the bar collapses (both move rows).
  useLayoutEffect(() => {
    const nav = navRef.current
    if (!nav) return
    let raf = 0
    const measure = () => {
      raf = 0
      const row = nav.querySelector<HTMLElement>('.dsk-side__item.is-active')
      if (!row || row.closest('.dsk-side__group.is-closed')) { setGlide(null); return }
      const navBox = nav.getBoundingClientRect()
      const box = row.getBoundingClientRect()
      setGlide({ y: box.top - navBox.top + nav.scrollTop, h: box.height, hue })
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure) }
    schedule()
    // Folding animates grid rows for ~360 ms; follow it, then settle.
    const settle = window.setTimeout(schedule, 380)
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null
    ro?.observe(nav)
    window.addEventListener('resize', schedule)
    return () => { if (raf) cancelAnimationFrame(raf); window.clearTimeout(settle); ro?.disconnect(); window.removeEventListener('resize', schedule) }
  }, [routePath, collapsed, prefs.closedGroups, hue])

  return (
    <aside className={cls('dsk-side', collapsed && 'is-collapsed')} style={{ ['--hue' as string]: hue }} aria-label="Applications">
      <div className="dsk-side__glass">
        <span className="dsk-side__liquid" aria-hidden><i /><i /><i /></span>
        <span className="dsk-side__sheen" aria-hidden />

        <header className="dsk-side__brand">
          <span className="dsk-side__mark" aria-hidden>
            {/* LeadCommand monogram: an L whose corner opens into a signal arc. */}
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
              <path d="M7 5.5v11.5h11" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M11 9.2a6.3 6.3 0 0 1 5.9 5.9" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" opacity="0.55" />
              <circle cx="17.2" cy="6.8" r="1.55" fill="var(--dsk-accent, currentColor)" />
            </svg>
          </span>
          <span className="dsk-side__word">
            <b>LeadCommand</b>
            <small>Command Center</small>
          </span>
          <button
            type="button"
            className="dsk-side__fold"
            onClick={() => setPrefs({ collapsed: !collapsed })}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            data-tip={collapsed ? 'Expand  ⌘\\' : undefined}
            title={collapsed ? undefined : 'Collapse sidebar  ⌘\\'}
          >
            <span className="dsk-side__fold-icon" aria-hidden><i /><i /></span>
          </button>
        </header>

        <nav className="dsk-side__nav" ref={navRef}>
          {glide ? <span className="dsk-side__glide" style={{ transform: `translateY(${glide.y}px)`, height: glide.h }} aria-hidden /> : null}
          {SECTIONS.map((section) => {
            const isClosed = closed.has(section.group) && !collapsed
            const sectionBadge = isClosed ? section.apps.reduce((n, a) => n + (badges[a.route as keyof typeof badges]?.count ?? 0), 0) : 0
            return (
              <section key={section.group} className={cls('dsk-side__group', isClosed && 'is-closed')}>
                <button
                  type="button"
                  className="dsk-side__group-head"
                  onClick={() => toggleGroup(section.group)}
                  aria-expanded={!isClosed}
                  tabIndex={collapsed ? -1 : 0}
                >
                  <span>{section.label}</span>
                  {sectionBadge > 0 ? <em>{sectionBadge > 99 ? '99+' : sectionBadge}</em> : null}
                  <Icon name="chevron-down" size={12} strokeWidth={2.2} />
                </button>
                <div className="dsk-side__group-body">
                  <div className="dsk-side__group-inner">
                    {section.apps.map((app) => {
                      const active = activeFor(routePath, app)
                      const badge = badges[app.route as keyof typeof badges]
                      const count = badgeText(badge)
                      return (
                        <button
                          key={app.id}
                          type="button"
                          className={cls('dsk-side__item', active && 'is-active')}
                          style={{ ['--app' as string]: appHue(app.id) }}
                          onClick={() => go(app)}
                          aria-current={active ? 'page' : undefined}
                          data-tip={app.label}
                          tabIndex={isClosed ? -1 : 0}
                        >
                          <span className="dsk-side__glyph"><Icon name={app.icon} size={16} strokeWidth={1.7} /></span>
                          <span className="dsk-side__label">{app.label}</span>
                          {count ? <span className={cls('dsk-side__badge', badge?.tone && `is-${badge.tone}`)}>{count}</span> : badge?.dot ? <span className={cls('dsk-side__dot', badge.tone && `is-${badge.tone}`)} /> : null}
                          {openRoutes.has(app.route) ? <span className="dsk-side__inpane" aria-label="Open in a split pane" /> : null}
                          {!active && !openRoutes.has(app.route) && !splitFull ? (
                            <span
                              role="button"
                              tabIndex={-1}
                              className="dsk-side__split"
                              aria-label={`Open ${app.label} in split screen`}
                              title="Open in split screen"
                              onClick={(e) => { e.stopPropagation(); openInSplit(app.action === 'deal_intelligence' ? '/deal-intelligence' : app.route) }}
                            >
                              <Icon name="layout-split" size={13} strokeWidth={1.8} />
                            </span>
                          ) : null}
                        </button>
                      )
                    })}
                  </div>
                </div>
              </section>
            )
          })}
        </nav>

        <footer className="dsk-side__foot">
          <div className={cls('dsk-side__status', `is-${status.tone}`)} title={status.detail || status.label} data-tip={status.label}>
            <i aria-hidden />
            <span><b>{status.label}</b>{status.detail ? <small>{status.detail}</small> : null}</span>
          </div>
        </footer>
      </div>
    </aside>
  )
}
