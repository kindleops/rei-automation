import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react'
import { Icon } from '../../shared/icons'
import { LCHoverCard, LCPopover, LCTooltip, cx } from '../../shared/lc'
import { MOBILE_APPS_BY_GROUP, type NexusApp } from '../../domain/app-registry/app-registry'
import { navigateToApp } from '../../domain/app-registry/contextual-navigation'
import { appHue } from '../mobile/app-hues'
import { captureAppSession, resolveAppIdFromRoute } from '../mobile/app-session-cache'
import { closeInboxDealIntelligence, isInboxDealIntelligenceShowing, isInboxRoute, openInboxDealIntelligence, subscribeInboxDealIntelligenceShowing } from '../mobile/mobile-inbox-bridge'
import { requestNotificationsSurface } from '../mobile/shell-surface-bridge'
import { useDesktopShellPrefs } from './desktop-shell-prefs'
import { MAIN, MAX_PANES, getSplitState, markPaneInteraction, openInSplit, useSplitWorkspace } from './split-workspace'
import { MachinePlane } from './rail/MachinePlane'
import { RailTelemetry } from './rail/RailTelemetry'
import { machineState, restingFor } from './rail/rail-model'
import { useRail } from './rail/rail-store'
import { activeFor } from './rail/rail-nav'
import './rail/command-rail.css'

/**
 * THE COMMAND RAIL — the edge of the operating system.
 *
 * Navigation first, telemetry second, and still most of the time: a floating
 * glass instrument with naked app glyphs, one refractive lens on the open
 * app, a fixed micro-display on every row (one stable number, or — for a
 * moment — what the machine is doing), and a machine dock. Collapsed it is a
 * 60px rail; hover, focus or ⌘\ opens the full plane.
 */

const SECTIONS = MOBILE_APPS_BY_GROUP
  .map((g) => ({ ...g, apps: g.apps.filter((a) => a.action !== 'notifications' && a.action !== 'settings' && !a.route.startsWith('__')) }))
  .filter((g) => g.apps.length > 0)

export interface DesktopSidebarProps {
  routePath: string
  status: { tone: 'live' | 'warn' | 'down' | 'idle'; label: string; detail?: string }
  queueFailedToday?: number | null
  onOpenSettings: () => void
}

const PEEK_OPEN_MS = 200
const PEEK_CLOSE_MS = 260

export function DesktopSidebar({ routePath, onOpenSettings }: DesktopSidebarProps) {
  const [prefs, setPrefs] = useDesktopShellPrefs()
  const rail = useRail()
  const split = useSplitWorkspace()
  const splitFull = split.panes.length + 1 >= MAX_PANES
  const openRoutes = useMemo(() => new Set(split.panes.map((p) => p.path.split('?')[0])), [split.panes])
  const navRef = useRef<HTMLElement | null>(null)
  const rootRef = useRef<HTMLElement | null>(null)
  const [lens, setLens] = useState<{ y: number; h: number } | null>(null)
  const pinned = !prefs.collapsed
  const [peeking, setPeeking] = useState(false)
  const [dockOpen, setDockOpen] = useState(false)
  const peekTimer = useRef(0)
  const expanded = pinned || peeking
  const closed = useMemo(() => new Set(prefs.closedGroups), [prefs.closedGroups])

  const dealIntelShowing = useSyncExternalStore(subscribeInboxDealIntelligenceShowing, isInboxDealIntelligenceShowing, () => false)
  const activeApp = useMemo(() => SECTIONS.flatMap((s) => s.apps).find((a) => activeFor(routePath, a, dealIntelShowing)) ?? null, [routePath, dealIntelShowing])
  const hue = appHue(activeApp?.id)
  const machine = machineState(rail.telemetry, rail.updatedAt ?? 0)

  // the mark traces once when real events land — never on its own
  const [tracing, setTracing] = useState(false)
  const [traceFor, setTraceFor] = useState(rail.pulseAt)
  if (traceFor !== rail.pulseAt) { setTraceFor(rail.pulseAt); if (rail.pulseAt) setTracing(true) }
  useEffect(() => {
    if (!tracing) return
    const t = window.setTimeout(() => setTracing(false), 1700)
    return () => window.clearTimeout(t)
  }, [tracing])

  const go = useCallback((app: NexusApp, e?: MouseEvent) => {
    // ⌥-click opens the app beside the current one
    if (e?.altKey && !splitFull) { openInSplit(app.action === 'deal_intelligence' ? '/deal-intelligence' : app.route); return }
    captureAppSession(resolveAppIdFromRoute(routePath))
    markPaneInteraction(getSplitState().focused || MAIN)
    navigateToApp(app, {
      openDealIntelligence: (identity) => openInboxDealIntelligence(identity ?? undefined),
      openNotifications: requestNotificationsSurface,
      openSettings: onOpenSettings,
      closeInboxDealIntelligence,
      isInboxRoute,
    })
  }, [onOpenSettings, routePath, splitFull])

  // ⌘\ pins / unpins the plane from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') { e.preventDefault(); setPrefs({ collapsed: pinned }); setPeeking(false) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pinned, setPrefs])

  // hover / keyboard expansion of the collapsed rail (overlay; the workspace never moves)
  const openPeek = () => { if (pinned) return; window.clearTimeout(peekTimer.current); peekTimer.current = window.setTimeout(() => setPeeking(true), PEEK_OPEN_MS) }
  const closePeek = () => { window.clearTimeout(peekTimer.current); peekTimer.current = window.setTimeout(() => { if (!dockOpen) setPeeking(false) }, PEEK_CLOSE_MS) }
  useEffect(() => () => window.clearTimeout(peekTimer.current), [])

  const toggleGroup = (group: string) => {
    const next = new Set(closed)
    if (next.has(group)) next.delete(group)
    else next.add(group)
    setPrefs({ closedGroups: [...next] })
  }

  // the lens follows the open app; measured after layout and after any fold
  useLayoutEffect(() => {
    const nav = navRef.current
    if (!nav) return
    let raf = 0
    const measure = () => {
      raf = 0
      const row = nav.querySelector<HTMLElement>('.cr-row.is-active')
      if (!row || row.closest('.cr-sec.is-folded')) { setLens(null); return }
      const navBox = nav.getBoundingClientRect()
      const box = row.getBoundingClientRect()
      setLens({ y: box.top - navBox.top + nav.scrollTop, h: box.height })
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure) }
    schedule()
    const settle = window.setTimeout(schedule, 420)
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null
    ro?.observe(nav)
    window.addEventListener('resize', schedule)
    return () => { if (raf) cancelAnimationFrame(raf); window.clearTimeout(settle); ro?.disconnect(); window.removeEventListener('resize', schedule) }
  }, [routePath, dealIntelShowing, expanded, prefs.closedGroups])

  return (
    <aside
      ref={rootRef}
      className={cx('cr', expanded ? 'is-expanded' : 'is-rail', pinned ? 'is-pinned' : 'is-floating', peeking && 'is-peeking')}
      style={{ ['--cr-hue' as string]: hue }}
      aria-label="Applications"
      onMouseEnter={openPeek}
      onMouseLeave={closePeek}
      onFocus={(e) => {
        // keyboard focus opens the plane; a mouse click on the pin or dock does not
        if (!pinned && (e.target as HTMLElement).matches?.(':focus-visible')) { window.clearTimeout(peekTimer.current); setPeeking(true) }
      }}
      onBlur={(e) => { if (!pinned && !e.currentTarget.contains(e.relatedTarget as Node | null)) closePeek() }}
    >
      <div className="cr__glass">
        <header className="cr__brand">
          <span className={cx('cr__mark', tracing && 'is-tracing')} aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
              <path className="cr__mark-l" d="M7 5.5v11.5h11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path className="cr__mark-arc" d="M11 9.2a6.3 6.3 0 0 1 5.9 5.9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <path className="cr__mark-trace" d="M7 5.5v11.5h11" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="17.2" cy="6.8" r="1.5" className="cr__mark-dot" />
            </svg>
          </span>
          <b className="cr__word">LeadCommand</b>
          <LCTooltip content={pinned ? 'Collapse to rail' : 'Keep open'} shortcut={['⌘', '\\']} side="right">
            <button type="button" className="cr__pin" onClick={() => { setPrefs({ collapsed: pinned }); setPeeking(false) }} aria-label={pinned ? 'Collapse to rail' : 'Keep the navigation open'} aria-pressed={pinned}>
              <span aria-hidden="true" className={cx('cr__pin-glyph', pinned && 'is-on')}><i /><i /></span>
            </button>
          </LCTooltip>
        </header>

        <nav className="cr__nav" ref={navRef}>
          {lens ? <span className="cr__lens" style={{ transform: `translateY(${lens.y}px)`, height: lens.h }} aria-hidden="true"><i /></span> : null}
          {SECTIONS.map((section) => {
            const folded = closed.has(section.group) && expanded
            const hiddenNeed = folded ? section.apps.reduce((s, a) => s + (restingFor(a.route, rail.telemetry?.metrics ?? null)?.attention ?? 0), 0) : 0
            return (
              <section key={section.group} className={cx('cr-sec', folded && 'is-folded')}>
                <button type="button" className="cr-sec__head" onClick={() => toggleGroup(section.group)} aria-expanded={!folded} tabIndex={expanded ? 0 : -1} title={folded ? `Show ${section.label}` : `Fold ${section.label}`}>
                  <span className="cr-sec__label">{section.label}</span>
                  <span className="cr-sec__rule" aria-hidden="true" />
                  {folded ? <span className="cr-sec__more" aria-hidden="true">{section.apps.length}{hiddenNeed ? <i /> : null}</span> : null}
                </button>
                <div className="cr-sec__body">
                  <div className="cr-sec__inner">
                    {section.apps.map((app) => {
                      const active = activeFor(routePath, app, dealIntelShowing)
                      const resting = restingFor(app.route, rail.telemetry?.metrics ?? null)
                      const transient = rail.transients[app.route] ?? null
                      const inPane = openRoutes.has(app.route)
                      const said = transient ? transient.text : resting && resting.value > 0 ? resting.peek[0] : null
                      const row = (
                        <button
                          type="button"
                          className={cx('cr-row', active && 'is-active', transient && 'is-moving', inPane && 'is-inpane')}
                          style={{ ['--app' as string]: appHue(app.id) }}
                          onClick={(e) => go(app, e)}
                          aria-current={active ? 'page' : undefined}
                          aria-label={said ? `${app.label}, ${said}` : app.label}
                          tabIndex={folded ? -1 : 0}
                        >
                          <span className="cr-row__glyph" aria-hidden="true">
                            <Icon name={app.icon} size={17} strokeWidth={1.6} />
                            {!expanded && (transient || (resting?.attention ?? 0) > 0) ? <i className="cr-row__micro" data-tone={transient ? transient.tone : 'attn'} /> : null}
                          </span>
                          <span className="cr-row__label">{app.label}</span>
                          <RailTelemetry resting={resting} transient={transient} expanded={expanded} />
                        </button>
                      )
                      return (
                        <LCHoverCard
                          key={app.id}
                          side="right"
                          openDelay={expanded ? 420 : 160}
                          width={236}
                          className="cr-peek"
                          disabled={dockOpen}
                          trigger={row}
                        >
                          <span className="cr-peek__name">{app.label}</span>
                          {transient ? <span className="cr-peek__now" data-tone={transient.tone}>{transient.text}</span> : null}
                          {resting?.peek.map((line) => <span key={line} className="cr-peek__line">{line}</span>)}
                          {!resting && !transient ? <span className="cr-peek__line is-quiet">{app.description || 'Open'}</span> : null}
                          {inPane ? <span className="cr-peek__line is-quiet">Open in a split pane</span> : !active && !splitFull ? (
                            <button type="button" className="lc-link cr-peek__split" onClick={() => openInSplit(app.action === 'deal_intelligence' ? '/deal-intelligence' : app.route)}>Open beside · ⌥ click</button>
                          ) : null}
                        </LCHoverCard>
                      )
                    })}
                  </div>
                </div>
              </section>
            )
          })}
        </nav>

        <footer className="cr__foot">
          <button
            type="button"
            className={cx('cr-row cr-row--settings', routePath === '/settings' && 'is-active')}
            onClick={onOpenSettings}
            aria-current={routePath === '/settings' ? 'page' : undefined}
            aria-label="Settings"
          >
            <span className="cr-row__glyph" aria-hidden="true"><Icon name="settings" size={17} strokeWidth={1.6} /></span>
            <span className="cr-row__label">Settings</span>
            <span className="crt"><kbd className="lc-kbd cr__kbd">⌘,</kbd></span>
          </button>
          <LCPopover
            open={dockOpen}
            onOpenChange={(o) => { setDockOpen(o); if (!o) closePeek() }}
            side="right"
            align="end"
            width={360}
            label="Machine"
            trigger={
              <button type="button" className={cx('cr-dock', `is-${machine.state}`)} aria-label={`Machine ${machine.state}${machine.reason ? ` — ${machine.reason}` : ''}`}>
                <i className="cr-dock__dot" aria-hidden="true" />
                <span className="cr-dock__text">
                  <b>{machine.state === 'degraded' ? 'System · degraded' : machine.state === 'live' ? 'Machine · live' : machine.state === 'idle' ? 'Machine · idle' : 'Machine'}</b>
                  {machine.state === 'degraded' && machine.reason ? <small>{machine.reason}</small> : null}
                </span>
                {machine.needYou ? <span className="cr-dock__need" title={`${machine.needYou} need you`}>{machine.needYou}</span> : null}
              </button>
            }
          >
            <MachinePlane rail={rail} />
          </LCPopover>
        </footer>
        <span className="lc-sr-only" role="status" aria-live="polite">{rail.announce ?? ''}</span>
      </div>
    </aside>
  )
}
