import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { pushRoutePath, replaceRoutePath, useRoutePath } from './router'
import { resolveRoute } from './routes'
import { useCommandGrammar, type CommandBinding } from '../shared/command-grammar'
import { CopilotShell, type CopilotContext, type ResolvedIntent } from '../shared/copilot'
import { BriefingPanel, buildBriefingDigest, type BriefingDigest } from '../shared/BriefingPanel'
import { NotificationToasts, NotificationCenter } from '../shared/NotificationToast'
import { playSound } from '../shared/sounds'
import { applyThemeToDOM, subscribeSettings, updateSetting, type NexusTheme } from '../shared/settings'
import { GlobalCommandOverlay } from '../modules/command-center/GlobalCommandOverlay'
import { DevApiBanner } from '../components/dev/DevApiBanner'
import { saveRecentCommandLocation } from '../modules/command-center/providers/locationCommandProvider'
import {
  GLOBAL_COMMAND_CONTEXT_EVENT,
  GLOBAL_COMMAND_OPEN_EVENT,
  type CommandResult,
  type GlobalCommandSearchContext,
} from '../modules/command-center/command.types'

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

// ── Nav Items ──────────────────────────────────────────────────────────────

type NavIconName = 'radar' | 'inbox' | 'alert' | 'stats' | 'map' | 'users' | 'file-text' | 'settings' | 'bell' | 'star' | 'grid' | 'target'

interface NavItem {
  path: string
  label: string
  icon: NavIconName
  shortcut: string
  room: string
}

const navItems: NavItem[] = [
  { path: '/', label: 'Home', icon: 'radar', shortcut: 'H', room: 'Home' },
  { path: '/acquisition', label: 'Acquisition', icon: 'target', shortcut: 'R', room: 'Acquisition Command' },
  { path: '/command-store', label: 'Command Store', icon: 'grid', shortcut: 'C', room: 'Command Store' },
  { path: '/inbox', label: 'Inbox', icon: 'inbox', shortcut: 'I', room: 'Inbox' },
  { path: '/queue', label: 'Queue', icon: 'inbox', shortcut: 'Q', room: 'Queue' },
  { path: '/dossier', label: 'Dossier', icon: 'users', shortcut: 'D', room: 'Dossier' },
  { path: '/alerts', label: 'Alerts', icon: 'alert', shortcut: 'A', room: 'Alerts' },
  { path: '/stats', label: 'Intelligence', icon: 'stats', shortcut: 'G', room: 'Intelligence' },
  { path: '/agents', label: 'AI Agents', icon: 'users', shortcut: 'X', room: 'AI Agent Performance' },
  { path: '/dashboard/kpis', label: 'KPIs', icon: 'stats', shortcut: 'K', room: 'KPI Intelligence' },
  { path: '/markets', label: 'Markets', icon: 'map', shortcut: 'M', room: 'Markets' },
  { path: '/buyer', label: 'Buyers', icon: 'users', shortcut: 'B', room: 'Buyers' },
  { path: '/title', label: 'Title', icon: 'file-text', shortcut: 'T', room: 'Title' },
  { path: '/watchlists', label: 'Watchlists', icon: 'star', shortcut: 'W', room: 'Watchlists' },
  { path: '/notifications', label: 'Notifications', icon: 'bell', shortcut: 'N', room: 'Notifications' },
  { path: '/settings', label: 'Settings', icon: 'settings', shortcut: 'S', room: 'Settings' },
  { path: '/mobile', label: 'Mobile', icon: 'grid', shortcut: 'O', room: 'Mobile Command Center' },
]

const THEME_ALIASES: Record<string, NexusTheme> = {
  // New global themes
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
  // Legacy aliases
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

export const CommandCenterApp = () => {
  const path = useRoutePath()

  // On first load on a mobile viewport, redirect to /mobile if not already there
  useEffect(() => {
    if (path === '/mobile') return
    const isMobileViewport = window.matchMedia('(max-width: 768px)').matches
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0
    if (isMobileViewport && isTouchDevice && path === '/') {
      pushRoutePath('/mobile')
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const route = resolveRoute(path)
  const [routeState, setRouteState] = useState<RouteLoadState>({
    ...initialState,
    path: route.path,
  })
  const [cmdOpen, setCmdOpen] = useState(false)
  const [cmdInitialQuery, setCmdInitialQuery] = useState('')
  const [commandContext, setCommandContext] = useState<GlobalCommandSearchContext>({ routePath: route.path })

  // New Phase 4 systems
  const [copilotOpen, setCopilotOpen] = useState(false)
  const [briefingOpen, setBriefingOpen] = useState(false)
  const [briefingDigest, setBriefingDigest] = useState<BriefingDigest | null>(null)
  const [notifCenterOpen, setNotifCenterOpen] = useState(false)

  // ── Theme system — apply on mount + subscribe to changes ──
  useEffect(() => {
    applyThemeToDOM()
    return subscribeSettings(() => applyThemeToDOM())
  }, [])

  // ── Room transition sound ──
  const prevPathRef = useRef(route.path)
  useEffect(() => {
    if (prevPathRef.current !== route.path) {
      playSound('room-enter')
      prevPathRef.current = route.path
    }
  }, [route.path])

  // Command grammar bindings — single-key navigation
  // Exclude the binding for the currently active route so pressing its shortcut
  // while already on that page doesn't trigger a loader re-run / remount.
  const bindings = useMemo<CommandBinding[]>(() => [
    ...navItems
      .filter((item) => item.path !== path)
      .map((item) => ({
        keys: item.shortcut,
        seq: [item.shortcut.toLowerCase()],
        label: item.label,
        category: 'Navigation',
        action: () => pushRoutePath(item.path),
      })),
  ], [path])

  const grammarState = useCommandGrammar(bindings)

  // Briefing digest builder
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
    setCommandContext((current) => ({ ...current, routePath: route.path }))
  }, [route.path])

  useEffect(() => {
    const handleOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ initialQuery?: string }>).detail
      openCmd(detail?.initialQuery || '')
    }
    const handleContext = (event: Event) => {
      const detail = (event as CustomEvent<Partial<GlobalCommandSearchContext>>).detail
      if (!detail) return
      setCommandContext((current) => ({
        ...current,
        ...detail,
        routePath: route.path,
      }))
    }
    window.addEventListener(GLOBAL_COMMAND_OPEN_EVENT, handleOpen as EventListener)
    window.addEventListener(GLOBAL_COMMAND_CONTEXT_EVENT, handleContext as EventListener)
    return () => {
      window.removeEventListener(GLOBAL_COMMAND_OPEN_EVENT, handleOpen as EventListener)
      window.removeEventListener(GLOBAL_COMMAND_CONTEXT_EVENT, handleContext as EventListener)
    }
  }, [openCmd, route.path])

  const executeGlobalCommand = useCallback((result: CommandResult) => {
    if (result.meta?.confirmRequired && import.meta.env.DEV) {
      console.warn('[GlobalCommand]', 'confirm-required result selected', result)
    }

    if (result.location) {
      saveRecentCommandLocation(result.location)
    }

    const shouldNavigate = Boolean(result.route && result.route !== route.path)
    if (shouldNavigate && result.route) {
      pushRoutePath(result.route)
    }

    if (result.action?.kind === 'dispatch_event' && result.action.eventName) {
      const eventName = result.action.eventName
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent(eventName, {
          detail: {
            ...result.payload,
            route: result.route,
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
            route: result.route,
            resultId: result.id,
            resultType: result.type,
            confirmRequired: true,
          },
        }))
      }, shouldNavigate ? 80 : 0)
    } else if (!result.route && import.meta.env.DEV) {
      console.warn('[GlobalCommand]', 'No route or executable action registered for result', result)
    }

    closeCmd()
  }, [closeCmd, route.path])

  // AI Copilot context — derived from current route
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
      pushRoutePath(intent.params.target)
      return
    }

    if (intent.domain === 'map') {
      pushRoutePath('/dashboard/live')
      return
    }

    if (intent.domain === 'inbox') {
      pushRoutePath('/inbox')
      return
    }

    if (intent.domain === 'alerts') {
      pushRoutePath('/alerts')
      return
    }

    if (intent.domain === 'markets') {
      pushRoutePath('/markets')
      return
    }

    if (intent.domain === 'buyers') {
      pushRoutePath('/buyer')
      return
    }

    if (intent.domain === 'title') {
      pushRoutePath('/title')
      return
    }

    if (intent.domain === 'watchlist') {
      pushRoutePath('/watchlists')
      return
    }

    if (intent.domain === 'notification') {
      pushRoutePath('/notifications')
      return
    }

    if (intent.domain === 'autopilot') {
      pushRoutePath('/dashboard/live')
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
      pushRoutePath('/settings')
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
      const targetRoute = route.path === '/dashboard/live' || route.path === '/inbox' ? route.path : '/dashboard/live'
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
    const handleKey = (e: KeyboardEvent) => {
      // ⌘⇧K — context-aware command palette for the active screen
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('nx:context-palette'))
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        if (cmdOpen) closeCmd()
        else openCmd()
        return
      }
      // ⌘J — AI Copilot toggle
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault()
        setCopilotOpen((prev) => {
          if (!prev) playSound('copilot-wake')
          return !prev
        })
        return
      }
      // ⌘. — Operator Briefing
      if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        e.preventDefault()
        if (!briefingOpen) openBriefing()
        else setBriefingOpen(false)
        return
      }
      // ⌘V — Voice toggle (only activate voice; do not open sidecar)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('nx:copilot-voice-activate'))
        return
      }
      if (e.key === 'Escape' && cmdOpen) {
        closeCmd()
        return
      }
      // / opens palette when not in an input
      const tag = (e.target as HTMLElement)?.tagName
      if (e.key === '/' && !cmdOpen && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        e.preventDefault()
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
        setRouteState({ status: 'error', path: route.path, data: null, message })
      })

    return () => { active = false }
  }, [route])

  const isRouteLoading = routeState.path !== route.path || routeState.status === 'loading'

  // Current active nav
  const activeNav = navItems.find((n) => n.path === route.path)

  // ── Loading State ──────────────────────────────────────────────────────

  if (isRouteLoading) {
    return (
      <main className="app-state">
        <div className="app-state__panel">
          <span className="app-state__eyebrow">NEXUS</span>
          <h1>Initializing command center</h1>
          <p>Loading live route intelligence for `{route.path}`.</p>
        </div>
      </main>
    )
  }

  // ── Error State ────────────────────────────────────────────────────────

  if (routeState.status === 'error') {
    return (
      <main className="app-state">
        <div className="app-state__panel">
          <span className="app-state__eyebrow">Route Error</span>
          <h1>Unable to load surface</h1>
          <p>{routeState.message}</p>
          <button
            className="app-state__button"
            type="button"
            onClick={() => replaceRoutePath('/dashboard/live')}
          >
            Retry live route
          </button>
        </div>
      </main>
    )
  }

  // ── Ready State — Command-First Layout ─────────────────────────────────

  // Mobile route gets full-screen treatment — no desktop shell at all
  if (route.path === '/mobile') {
    return (
      <>
        <main style={{ position: 'fixed', inset: 0, overflow: 'hidden' }}>
          {route.render(routeState.data)}
        </main>
        <NotificationToasts />
      </>
    )
  }

  return (
    <div className={`nx-os ${route.path === '/' ? 'is-home-route' : ''}`}>
      {/* Room label — non-Home surfaces */}
      {route.path !== '/dashboard/live' && route.path !== '/command-store' && activeNav && (
        <div className="nx-room-label">
          <span className="nx-room-label__name">{activeNav.room}</span>
        </div>
      )}

      {/* Main content — full bleed */}
      <main className="nx-stage">
        {route.render(routeState.data)}
      </main>

      <GlobalCommandOverlay
        open={cmdOpen}
        initialQuery={cmdInitialQuery}
        context={commandContext}
        onClose={closeCmd}
        onExecute={executeGlobalCommand}
      />

      {/* Grammar pending indicator */}
      {grammarState.pending && (
        <div className="nx-grammar-hint">
          <kbd>{grammarState.pending}</kbd>
          <span>waiting for next key…</span>
        </div>
      )}

      {/* Global notification toasts */}
      <NotificationToasts />

      {/* AI Copilot — multimodal intelligence shell */}
      <CopilotShell
        open={copilotOpen}
        context={copilotContext}
        onClose={() => setCopilotOpen(false)}
        onToggle={() => setCopilotOpen(p => { if (!p) playSound('copilot-wake'); return !p })}
        onAction={handleCopilotAction}
      />

      {/* Operator Briefing panel */}
      <BriefingPanel
        open={briefingOpen}
        digest={briefingDigest}
        onClose={() => setBriefingOpen(false)}
      />

      {/* Notification Center */}
      <NotificationCenter
        open={notifCenterOpen}
        onClose={() => setNotifCenterOpen(false)}
      />

      <DevApiBanner />
    </div>
  )
}
