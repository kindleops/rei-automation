import { startTransition, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { pushRoutePath, replaceRoutePath, useRoutePath } from './router'
import { resolveRoute } from './routes'
import { useCommandGrammar, type CommandBinding } from '../shared/command-grammar'
import { CopilotShell, type CopilotContext, type ResolvedIntent } from '../shared/copilot'
import { isCopilotSurfaceEnabled } from '../shared/copilot/copilot-availability'
import { BriefingPanel, buildBriefingDigest, type BriefingDigest } from '../shared/BriefingPanel'
import { NotificationToasts } from '../shared/NotificationToast'
import { NotificationIntelligenceProvider, useNotificationIntelligence } from '../domain/notifications/useNotificationIntelligence'
import { LeadCommandNotificationBell, LeadCommandNotificationCenter } from '../modules/notifications/LeadCommandNotificationCenter'
import { playSound } from '../shared/sounds'
import { ErrorBoundary } from '../shared/ErrorBoundary'
import { DevRuntimeDiagnostics } from '../components/dev/DevRuntimeDiagnostics'
import { applyThemeToDOM, subscribeSettings, updateSetting, type NexusTheme } from '../shared/settings'
import { GlobalCommandOverlay } from '../modules/command-center/GlobalCommandOverlay'
import { saveRecentCommandLocation } from '../modules/command-center/providers/locationCommandProvider'
import {
  GLOBAL_COMMAND_CONTEXT_EVENT,
  GLOBAL_COMMAND_OPEN_EVENT,
  type CommandResult,
  type GlobalCommandSearchContext,
} from '../domain/command-center/command.types'
import { useBreakpoint } from '../modules/mobile/useBreakpoint'
import { PortableCommandShell } from '../modules/mobile/PortableCommandShell'
import { PinnedAppDock } from '../modules/mobile/PinnedAppDock'
import { routeHasInboxCommandShell } from '../modules/mobile/inbox-shell-routes'
import { NEXUS_APPS, canonicalizeRoutePath, resolveAppForRoute } from '../domain/app-registry/app-registry'

// ── Types ──────────────────────────────────────────────────────────────────

interface RouteLoadState {
  status: 'loading' | 'ready' | 'error'
  path: string
  data: unknown
  message: string
}

const initialState: RouteLoadState = {
  status: 'loading',
  path: '',
  data: null,
  message: '',
}

// ── Navigation, derived from the canonical registry ───────────────────────

/**
 * These used to be a hand-written 15-entry `navItems` array plus a second copy of the
 * legacy-alias table (routes.tsx held the other). The two alias tables had already
 * drifted, and `navItems` was missing /properties entirely — so the Properties surface
 * had no keyboard shortcut and no room label even on desktop.
 */
interface NavItem {
  path: string
  label: string
  shortcut: string
  room: string
}

const navItems: NavItem[] = NEXUS_APPS
  .filter((app) => app.desktop && app.shortcut && !app.action)
  .map((app) => ({
    path: app.route,
    label: app.label,
    shortcut: app.shortcut as string,
    room: app.label,
  }))

const THEME_ALIASES: Record<string, NexusTheme> = {
  light: 'light',
  dark: 'dark',
  satellite: 'satellite',
  terrain: 'terrain',
  'red ops': 'red_ops',
  'red-ops': 'red_ops',
  red_ops: 'red_ops',
  matrix: 'matrix',
  blueprint: 'blueprint',
  executive: 'executive',
  'night vision': 'night_vision',
  'night-vision': 'night_vision',
  night_vision: 'night_vision',
  monochrome: 'monochrome',

  'dark-matter': 'dark-matter',
  'dark matter': 'dark-matter',
  'midnight-glass': 'midnight-glass',
  'midnight glass': 'midnight-glass',
  'tactical-blue': 'tactical-blue',
  'tactical blue': 'tactical-blue',
  'carbon-gold': 'carbon-gold',
  'carbon gold': 'carbon-gold',
  'monochrome-ops': 'monochrome-ops',
  'monochrome ops': 'monochrome-ops',
  infrared: 'infrared',
  'arctic-signal': 'arctic-signal',
  'arctic signal': 'arctic-signal',
  'operator-black': 'operator-black',
  'operator black': 'operator-black',
}

// ── Component ──────────────────────────────────────────────────────────────

const GlobalNotificationShell = ({
  children,
  routePath,
  isMobile,
  onOpenSearch,
}: {
  children: ReactNode
  routePath: string
  isMobile: boolean
  onOpenSearch: () => void
}) => {
  const [notifCenterOpen, setNotifCenterOpen] = useState(false)
  const { unreadCount } = useNotificationIntelligence()
  const showGlobalBell = routePath !== '/inbox' && !isMobile
  // Campaigns used to opt out of the portable rail and render only its own
  // large-title bar. On a real handset that read as a separate application, and
  // with no global top chrome the Campaign Detail title sat under the Dynamic
  // Island. Campaigns now uses the same global mobile chrome as every other
  // route, so the shared stage reservation gives it the same
  // safe-top -> global app switcher -> route content order.
  const showPortableShell = isMobile && !routeHasInboxCommandShell(routePath)

  return (
    <>
      {showPortableShell ? <PortableCommandShell onOpenSearch={onOpenSearch} /> : null}
      {isMobile ? <PinnedAppDock routePath={routePath} /> : null}
      {children}
      {showGlobalBell ? (
        <div className="nx-os-notif-bell">
          <LeadCommandNotificationBell
            unreadCount={unreadCount}
            active={notifCenterOpen}
            onClick={() => setNotifCenterOpen((open) => !open)}
          />
        </div>
      ) : null}
      {showGlobalBell ? (
        <LeadCommandNotificationCenter
          open={notifCenterOpen}
          onClose={() => setNotifCenterOpen(false)}
          anchorTop={48}
        />
      ) : null}
    </>
  )
}

export const CommandCenterApp = () => {
  const path = useRoutePath()
  const route = resolveRoute(path)
  const { isMobile } = useBreakpoint()

  const [routeState, setRouteState] = useState<RouteLoadState>({
    ...initialState,
    path: route.path,
  })

  const [cmdOpen, setCmdOpen] = useState(false)
  const [cmdInitialQuery, setCmdInitialQuery] = useState('')
  const [commandContextOverrides, setCommandContextOverrides] = useState<Partial<GlobalCommandSearchContext>>({})

  const [copilotOpen, setCopilotOpen] = useState(false)
  const [briefingOpen, setBriefingOpen] = useState(false)
  const [briefingDigest, setBriefingDigest] = useState<BriefingDigest | null>(null)
  const commandContext = useMemo<GlobalCommandSearchContext>(() => ({
    ...commandContextOverrides,
    routePath: route.path,
  }), [commandContextOverrides, route.path])

  // ── Theme system — apply on mount + subscribe to changes ──
  useEffect(() => {
    applyThemeToDOM()
    return subscribeSettings(() => applyThemeToDOM())
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('is-mobile-layout', isMobile)
    return () => document.documentElement.classList.remove('is-mobile-layout')
  }, [isMobile])

  // ── Room transition sound ──
  const prevPathRef = useRef(route.path)

  useEffect(() => {
    if (prevPathRef.current !== route.path) {
      playSound('room-enter')
      prevPathRef.current = route.path
    }
  }, [route.path])

  // Command grammar bindings — single-key navigation
  const bindings = useMemo<CommandBinding[]>(() => [
    ...navItems
      .filter((item) => item.path !== route.path)
      .map((item) => ({
        keys: item.shortcut,
        seq: [item.shortcut.toLowerCase()],
        label: item.label,
        category: 'Navigation',
        action: () => pushRoutePath(item.path),
      })),
  ], [route.path])

  const grammarState = useCommandGrammar(bindings)

  const openBriefing = useCallback(() => {
    const digest = buildBriefingDigest({
      hotLeadCount: 0,
      warmLeadCount: 0,
      totalLeads: 0,
      activeAlerts: 0,
      criticalAlerts: 0,
      activeMarkets: 0,
      healthLabel: 'Nominal',
      pipelineValue: '$0',
      agentsActive: 0,
      autopilotActions: 0,
      unreadInbox: 0,
    })

    setBriefingDigest(digest)
    setBriefingOpen(true)
    playSound('briefing-open')
  }, [])

  const openCmd = useCallback((initialQuery = '') => {
    setCmdOpen(true)
    setCmdInitialQuery(initialQuery)
  }, [])

  const closeCmd = useCallback(() => {
    setCmdOpen(false)
    setCmdInitialQuery('')
  }, [])

  useEffect(() => {
    const handleOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ initialQuery?: string }>).detail
      openCmd(detail?.initialQuery || '')
    }

    const handleContext = (event: Event) => {
      const detail = (event as CustomEvent<Partial<GlobalCommandSearchContext>>).detail
      if (!detail) return

      setCommandContextOverrides((current) => ({
        ...current,
        ...detail,
      }))
    }

    window.addEventListener(GLOBAL_COMMAND_OPEN_EVENT, handleOpen as EventListener)
    window.addEventListener(GLOBAL_COMMAND_CONTEXT_EVENT, handleContext as EventListener)

    return () => {
      window.removeEventListener(GLOBAL_COMMAND_OPEN_EVENT, handleOpen as EventListener)
      window.removeEventListener(GLOBAL_COMMAND_CONTEXT_EVENT, handleContext as EventListener)
    }
  }, [openCmd])

  const executeGlobalCommand = useCallback((result: CommandResult) => {
    if (result.meta?.confirmRequired && import.meta.env.DEV) {
      console.warn('[GlobalCommand]', 'confirm-required result selected', result)
    }

    if (result.location) {
      saveRecentCommandLocation(result.location)
    }

    const targetRoute = canonicalizeRoutePath(result.route)
    const shouldNavigate = Boolean(targetRoute && targetRoute !== route.path)

    if (shouldNavigate && targetRoute) {
      pushRoutePath(targetRoute)
    }

    if (result.action?.kind === 'dispatch_event' && result.action.eventName) {
      const eventName = result.action.eventName

      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent(eventName, {
          detail: {
            ...result.payload,
            route: targetRoute,
            resultId: result.id,
            resultType: result.type,
          },
        }))
      }, shouldNavigate ? 80 : 0)
    } else if (result.action?.kind === 'confirm_required' && result.action.eventName) {
      const eventName = result.action.eventName

      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent(eventName, {
          detail: {
            ...result.payload,
            route: targetRoute,
            resultId: result.id,
            resultType: result.type,
            confirmRequired: true,
          },
        }))
      }, shouldNavigate ? 80 : 0)
    } else if (!targetRoute && import.meta.env.DEV) {
      console.warn('[GlobalCommand]', 'No route or executable action registered for result', result)
    }

    closeCmd()
  }, [closeCmd, route.path])

  const copilotContext = useMemo<CopilotContext>(() => ({
    surface: route.path,
    roomPath: route.path,
    entityLabel: route.title,
  }), [route.path, route.title])

  const resolveThemeAlias = useCallback((rawTheme?: string): NexusTheme | null => {
    if (!rawTheme) return null
    const normalized = rawTheme.trim().toLowerCase()
    return THEME_ALIASES[normalized] ?? null
  }, [])

  const dispatchSplitView = useCallback((surfacePath: string, target?: string) => {
    window.dispatchEvent(new CustomEvent('nx:copilot-split-view', { detail: { surfacePath, target } }))
  }, [])

  const handleCopilotAction = useCallback((intent: ResolvedIntent) => {
    if (intent.domain === 'room' && intent.params.target) {
      pushRoutePath(canonicalizeRoutePath(intent.params.target))
      return
    }

    if (intent.domain === 'map') {
      pushRoutePath('/map')
      return
    }

    if (intent.domain === 'inbox') {
      pushRoutePath('/inbox')
      return
    }

    if (intent.domain === 'alerts') {
      pushRoutePath('/analytics')
      return
    }

    if (intent.domain === 'markets') {
      pushRoutePath('/map')
      return
    }

    if (intent.domain === 'buyers') {
      pushRoutePath('/buyer-match')
      return
    }

    if (intent.domain === 'title') {
      pushRoutePath('/closing-desk')
      return
    }

    if (intent.domain === 'watchlist') {
      pushRoutePath('/deal-intelligence')
      return
    }

    if (intent.domain === 'notification') {
      pushRoutePath('/inbox')
      return
    }

    if (intent.domain === 'autopilot') {
      pushRoutePath('/analytics')
      return
    }

    if (intent.domain === 'briefing') {
      openBriefing()
      return
    }

    if (intent.domain === 'settings' && intent.action === 'set_theme') {
      const nextTheme = resolveThemeAlias(intent.params.theme)

      if (nextTheme) {
        updateSetting('nexusTheme', nextTheme)
        applyThemeToDOM()
      }

      pushRoutePath('/inbox')
      return
    }

    if (intent.domain === 'copilot' && intent.action === 'switch_mode' && intent.params.mode) {
      updateSetting('copilotMode', intent.params.mode as 'orb' | 'sidecar' | 'console')
      return
    }

    if (intent.domain === 'copilot' && intent.action === 'voice_mode') {
      updateSetting('voiceModeDefault', intent.params.enabled === 'true')
      return
    }

    if (intent.domain === 'split_view') {
      const targetRoute = route.path === '/map' || route.path === '/inbox' ? route.path : '/map'

      if (route.path !== targetRoute) {
        pushRoutePath(targetRoute)
        window.setTimeout(() => dispatchSplitView(targetRoute, intent.params.target), 60)
      } else {
        dispatchSplitView(targetRoute, intent.params.target)
      }
    }
  }, [dispatchSplitView, openBriefing, resolveThemeAlias, route.path])

  // Global keyboard — ⌘K, ⌘⇧K, ⌘J, ⌘., /, Escape
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === 'k' || event.key === 'K')) {
        event.preventDefault()
        window.dispatchEvent(new CustomEvent('nx:context-palette'))
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault()
        if (cmdOpen) closeCmd()
        else openCmd()
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key === 'j') {
        event.preventDefault()
        setCopilotOpen((previous) => {
          if (!previous) playSound('copilot-wake')
          return !previous
        })
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key === '.') {
        event.preventDefault()
        if (!briefingOpen) openBriefing()
        else setBriefingOpen(false)
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') {
        event.preventDefault()
        window.dispatchEvent(new CustomEvent('nx:copilot-voice-activate'))
        return
      }

      if (event.key === 'Escape' && cmdOpen) {
        closeCmd()
        return
      }

      const tag = (event.target as HTMLElement)?.tagName

      if (event.key === '/' && !cmdOpen && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        event.preventDefault()
        openCmd()
      }
    }

    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [cmdOpen, openCmd, closeCmd, briefingOpen, openBriefing])

  useEffect(() => {
    document.title = route.title
  }, [route.title])

  useEffect(() => {
    let active = true

    route
      .loader()
      .then((data) => {
        if (!active) return

        startTransition(() => {
          setRouteState({ status: 'ready', path: route.path, data, message: '' })
        })
      })
      .catch((error: unknown) => {
        if (!active) return

        const message = error instanceof Error ? error.message : 'Unknown route loader error'

        setRouteState({
          status: 'error',
          path: route.path,
          data: null,
          message,
        })
      })

    return () => {
      active = false
    }
  }, [route])

  const isRouteLoading = routeState.path !== route.path || routeState.status === 'loading'
  const activeNav = navItems.find((item) => item.path === route.path)
  const activeApp = resolveAppForRoute(route.path)

  /**
   * THE SHELL IS NOT A ROUTE.
   *
   * Loading and error used to be EARLY RETURNS that replaced the entire application
   * with a centred boot panel — no dock, no top bar, no way to leave. Two routes carry
   * a blocking data loader, and measured at 390x844 that cost /queue 5.6s and
   * /properties 31s of a dead screen with zero navigation on it. A phone showing
   * nothing for half a minute reads as a crash, and the operator's only recovery was
   * to reload.
   *
   * The states now render INSIDE the stage, so the shell that the whole mobile program
   * is built on stays mounted and interactive throughout: the operator can always tap
   * away to another application while a slow surface resolves behind them.
   */
  const stageContent = isRouteLoading ? (
    <div className="app-state" aria-busy="true">
      <div className="app-state__panel">
        <span className="app-state__eyebrow">{activeApp.label}</span>
        <h1>Loading {activeApp.label}</h1>
        <p>Fetching live intelligence for `{route.path}`.</p>
      </div>
    </div>
  ) : routeState.status === 'error' ? (
    <div className="app-state" role="alert">
      <div className="app-state__panel">
        <span className="app-state__eyebrow">Route Error</span>
        <h1>Unable to load {activeApp.label}</h1>
        <p>{routeState.message}</p>
        <button
          className="app-state__button"
          type="button"
          onClick={() => replaceRoutePath(route.path)}
        >
          Retry live route
        </button>
      </div>
    </div>
  ) : (
    <ErrorBoundary label={route.title} resetKey={route.path}>
      {/*
        Views are lazy-loaded per route (see routes.tsx), so the first render of a
        surface suspends while its chunk downloads. The boundary lives HERE rather
        than around the whole app so the shell — command dock, nav, notifications —
        stays mounted and interactive while a surface loads, instead of the screen
        blanking back to the boot state on every navigation.
      */}
      <Suspense fallback={<div className="nx-stage-suspense" aria-busy="true" />}>
        {route.render(routeState.data)}
      </Suspense>
    </ErrorBoundary>
  )

  // ── Command-First Layout ───────────────────────────────────────────────

  return (
    <NotificationIntelligenceProvider>
      <GlobalNotificationShell
        routePath={route.path}
        isMobile={isMobile}
        onOpenSearch={() => openCmd()}
      >
        <div className={`nx-os${isMobile ? ' is-mobile-os' : ''}`}>
          {!isMobile && route.path !== '/map' && activeNav && (
            <div className="nx-room-label">
              <span className="nx-room-label__name">{activeNav.room}</span>
            </div>
          )}

          <main className="nx-stage">
            {stageContent}
          </main>

          <GlobalCommandOverlay
            open={cmdOpen}
            initialQuery={cmdInitialQuery}
            context={commandContext}
            onClose={closeCmd}
            onExecute={executeGlobalCommand}
          />

          {grammarState.pending && (
            <div className="nx-grammar-hint">
              <kbd>{grammarState.pending}</kbd>
              <span>waiting for next key…</span>
            </div>
          )}

          <NotificationToasts />

          {isCopilotSurfaceEnabled(isMobile) ? (
            <CopilotShell
              open={copilotOpen}
              context={copilotContext}
              onClose={() => setCopilotOpen(false)}
              onToggle={() => setCopilotOpen((previous) => {
                if (!previous) playSound('copilot-wake')
                return !previous
              })}
              onAction={handleCopilotAction}
            />
          ) : null}

          <BriefingPanel
            open={briefingOpen}
            digest={briefingDigest}
            onClose={() => setBriefingOpen(false)}
          />

          <DevRuntimeDiagnostics />
        </div>
      </GlobalNotificationShell>
    </NotificationIntelligenceProvider>
  )
}
