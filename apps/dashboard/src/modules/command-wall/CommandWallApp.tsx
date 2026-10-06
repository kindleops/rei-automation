/**
 * COMMAND WALL root (§1, §2, §4, §10, §28–§31, §51–§55, §70).
 *
 * Mounted by main.tsx for /wall paths INSTEAD of the operator App: no
 * AuthProvider, no RequireAuth, no desktop or mobile shell, no notification
 * shell, no operator session — the TV only ever holds its display credential.
 *
 * Boot: mark → "Connecting…" → map + data → "Live". Paired displays restore
 * straight into the stage (kiosk, §55); unpaired ones show the pairing code.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import './command-wall.css'
import { createWallApi } from './wall-api'
import { createWallChannel, type WallChannel } from './wall-channel'
import { createRecoveryLadder } from './wall-recovery'
import { chooseRenderMode, probeCapabilities, browserFamily, type RenderDecision } from './render-mode'
import { resolveActiveView } from './wall-rotation'
import { presetFor, WALL_PRESET_IDS } from './wall-presets'
import { isQuietMoment } from './wall-feed-model'
import { WallStage } from './WallStage'
import { WallPairing } from './WallPairing'
import { WallDiagnostics } from './WallDiagnostics'
import { getFreshnessNotice, parseMainEntry, subscribeFreshnessNotice } from '../../shared/build-freshness/build-freshness'
import type { WallDisplayConfig, WallPresetId, WallSession, WallThemeId } from './wall-types'

const LOCAL_KEY = 'lc.wall.local.v1'
const TICK_MS = 20_000
const SAFE_RETRY_MS = 10 * 60_000
const THEMES: WallThemeId[] = ['dark', 'true_black', 'light', 'red_ops']

interface LocalPrefs { preset: WallPresetId | null; theme: WallThemeId | null; feed: boolean | null; rotationPaused: boolean; configVersion: number | null }
const EMPTY_LOCAL: LocalPrefs = { preset: null, theme: null, feed: null, rotationPaused: false, configVersion: null }

function readLocal(): LocalPrefs {
  try { return { ...EMPTY_LOCAL, ...(JSON.parse(window.localStorage.getItem(LOCAL_KEY) || '{}') as Partial<LocalPrefs>) } } catch { return EMPTY_LOCAL }
}
function writeLocal(p: LocalPrefs) {
  try { window.localStorage.setItem(LOCAL_KEY, JSON.stringify(p)) } catch { /* storage blocked: choice lasts this page life */ }
}

function runningBuild(): string {
  for (const s of Array.from(document.scripts)) {
    const e = parseMainEntry(s.getAttribute('src'))
    if (e) return e.replace(/^.*main-/, '').replace(/\.js$/, '').slice(0, 16)
  }
  return import.meta.env.DEV ? 'dev' : 'unknown'
}

/** A full reload only helps when the app origin answers (stale build / wedged page). With the WAN
 *  down it would replace the last good view with the browser's error page, so probe first. */
async function reloadIfOriginAnswers(): Promise<boolean> {
  try {
    const r = await fetch(`/?lc-wall-probe=${Date.now()}`, { cache: 'no-store', credentials: 'same-origin' })
    if (!r.ok) return false
  } catch { return false }
  window.location.reload()
  return true
}

export default function CommandWallApp() {
  const path = typeof window === 'undefined' ? '/wall' : window.location.pathname
  if (path.startsWith('/wall/diagnostics')) return <div className="cw-root" data-cw-theme="dark"><WallDiagnostics /></div>
  return <WallRuntime />
}

function WallRuntime() {
  const api = useMemo(() => createWallApi(), [])
  const ladder = useMemo(() => createRecoveryLadder({ storage: (() => { try { return window.localStorage } catch { return null } })() }), [])
  const caps = useMemo(() => probeCapabilities(window), [])
  const forced = useMemo(() => new URLSearchParams(window.location.search).get('render'), [])
  const decision: RenderDecision = useMemo(() => chooseRenderMode(caps, forced), [caps, forced])
  const [mapFailedAt, setMapFailedAt] = useState<number | null>(null)
  const [generation, setGeneration] = useState(0)
  const [paired, setPaired] = useState<'unknown' | 'yes' | 'no'>('unknown')
  const [local, setLocal] = useState<LocalPrefs>(() => readLocal())
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuIndex, setMenuIndex] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [updating, setUpdating] = useState(false)
  const [rotationStart] = useState(() => Date.now())

  const renderMode = mapFailedAt !== null && now - mapFailedAt < SAFE_RETRY_MS ? 'safe' : decision.mode

  const channel: WallChannel = useMemo(() => createWallChannel({
    api,
    ladder,
    heartbeatInfo: (ctx) => ({ build: runningBuild(), render_mode: ctx.renderMode, preset: ctx.preset, route: '/wall', client: { browser: browserFamily(navigator.userAgent), width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1, render_mode: ctx.renderMode } }),
    miQuery: (ctx) => ({ mi: presetFor(ctx.preset).needsMi, markets: ctx.market ? [ctx.market] : [] }),
    onSoftReload: () => setGeneration((g) => g + 1),
    onFullReload: reloadIfOriginAnswers,
  // a soft reload (generation bump) rebuilds the channel and remounts the stage
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [api, ladder, generation])

  const snap = useSyncExternalStore(channel.subscribe, channel.getSnapshot, channel.getSnapshot)

  // start / stop the one channel; pause it while the page is hidden
  useEffect(() => {
    void channel.start()
    const onVis = () => (document.visibilityState === 'hidden' ? channel.pause() : channel.resume())
    const onOnline = () => channel.resume()
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) channel.resume() }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('online', onOnline)
    window.addEventListener('pageshow', onShow)
    return () => {
      channel.stop()
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('pageshow', onShow)
    }
  }, [channel])

  // the one clock: drift, dimming, capsule expiry, rotation, ages
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(id)
  }, [])

  const session: WallSession | null = snap.session
  const pairedState = snap.unpaired ? 'no' : session ? 'yes' : paired
  // a desktop config change supersedes the TV-local choices
  const effectiveLocal = local.configVersion !== null && session && session.config_version !== local.configVersion ? EMPTY_LOCAL : local
  const config: WallDisplayConfig | null = session?.config ?? null
  const view = config ? resolveActiveView({ now, configPreset: config.preset, rotation: config.rotation, rotationStartedAt: rotationStart, rotationPaused: effectiveLocal.rotationPaused, command: session?.view_command ?? null, localPreset: effectiveLocal.preset }) : null
  const theme: WallThemeId = effectiveLocal.theme || config?.theme || 'dark'
  const showFeed = effectiveLocal.feed ?? config?.show_feed ?? true
  const viewPreset = view?.preset ?? 'national_command'
  const viewMarket = view?.market ?? null
  useEffect(() => { channel.setContext({ preset: viewPreset, renderMode, market: viewMarket }) }, [channel, viewPreset, renderMode, viewMarket])

  // theme on <html> (the LC tokens key off data-nexus-theme)
  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-nexus-theme', theme)
    root.classList.add('cw-html')
    return () => root.classList.remove('cw-html')
  }, [theme])

  // version recovery (§30): reuse build-freshness detection; reload only at a quiet moment, within the ladder's budget
  const notice = useSyncExternalStore(subscribeFreshnessNotice, getFreshnessNotice, getFreshnessNotice)
  useEffect(() => {
    if (!notice || (notice.kind !== 'update-available' && notice.kind !== 'update-deferred') || updating) return
    if (!isQuietMoment(snap.events, now) || !ladder.canFullReload()) return
    const t = window.setTimeout(() => { setUpdating(true); ladder.noteFullReload(); window.setTimeout(() => window.location.reload(), 2_500) }, 0)
    return () => window.clearTimeout(t)
  }, [notice, now, snap.events, ladder, updating])

  const updateLocal = useCallback((patch: Partial<LocalPrefs>) => {
    setLocal((prev) => { const next = { ...prev, ...patch, configVersion: session?.config_version ?? null }; writeLocal(next); return next })
  }, [session?.config_version])

  // TV input (§51, §52): Enter opens a small menu; arrows move; Enter picks; Esc closes. No hover anywhere.
  const menu = [
    { key: 'preset', label: 'Preset', value: presetFor(view?.preset).label, act: () => { const i = WALL_PRESET_IDS.indexOf(view?.preset || 'national_command'); updateLocal({ preset: WALL_PRESET_IDS[(i + 1) % (WALL_PRESET_IDS.length - 1)] }) } },
    { key: 'theme', label: 'Theme', value: ({ dark: 'Dark', true_black: 'True Black', light: 'Light', red_ops: 'Red Ops' } as const)[theme], act: () => updateLocal({ theme: THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] }) },
    { key: 'rotation', label: 'Rotation', value: config?.rotation.enabled ? (effectiveLocal.rotationPaused ? 'Paused' : 'On') : 'Off', act: () => { if (config?.rotation.enabled) updateLocal({ rotationPaused: !effectiveLocal.rotationPaused }) } },
    { key: 'feed', label: 'Activity feed', value: showFeed ? 'Shown' : 'Hidden', act: () => updateLocal({ feed: !showFeed }) },
    { key: 'reset', label: 'Use display settings', value: '', act: () => { writeLocal(EMPTY_LOCAL); setLocal(EMPTY_LOCAL) } },
  ]

  const menuRef = useRef(menu)
  useEffect(() => { menuRef.current = menu })
  useEffect(() => {
    if (pairedState !== 'yes') return undefined
    const onKey = (e: KeyboardEvent) => {
      const menu = menuRef.current
      const k = e.key
      if (!menuOpen) {
        if (k === 'Enter' || k === ' ' || k === 'ContextMenu' || k === 'm') { e.preventDefault(); setMenuOpen(true); setMenuIndex(0) }
        return
      }
      if (k === 'Escape' || k === 'Backspace' || k === 'GoBack') { e.preventDefault(); setMenuOpen(false) }
      else if (k === 'ArrowDown' || (k === 'Tab' && !e.shiftKey)) { e.preventDefault(); setMenuIndex((i) => (i + 1) % menu.length) }
      else if (k === 'ArrowUp' || (k === 'Tab' && e.shiftKey)) { e.preventDefault(); setMenuIndex((i) => (i - 1 + menu.length) % menu.length) }
      else if (k === 'Enter' || k === ' ' || k === 'ArrowRight') { e.preventDefault(); menu[menuIndex]?.act() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pairedState, menuOpen, menuIndex])

  const onMapFail = useCallback(() => setMapFailedAt(Date.now()), [])
  const fetchLayer = useCallback((kind: 'cameras' | 'crime' | 'presence', bbox: string, zoom: number) => api.layers({ kind, bbox, zoom }), [api])
  const [pairedAt, setPairedAt] = useState<number | null>(null)
  const onPaired = useCallback(() => { setPairedAt(Date.now()); setPaired('yes'); setGeneration((g) => g + 1) }, [])
  // a credential refused right after pairing (revoked again, clock skew, registry reset) must not loop
  const pairCooldownMs = pairedAt !== null && now - pairedAt < 120_000 ? 30_000 : 0
  const client = useMemo(() => ({ browser: browserFamily(navigator.userAgent), width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1, render_mode: decision.mode }), [decision.mode])

  // soak / diagnostics introspection: counts only, never a token
  useEffect(() => {
    ;(window as unknown as { __lcWall?: unknown }).__lcWall = { debug: () => ({ ...channel._debug(), connection: channel.getSnapshot().connection, events: channel.getSnapshot().events.byId.size, renderMode, generation }) }
  }, [channel, generation, renderMode])

  const rotationLabel = view?.source === 'command' ? 'Sent from desktop' : view?.source === 'rotation' ? 'Rotating' : null

  return (
    <div className="cw-root" data-cw-theme={theme} data-cw-motion={caps.reducedMotion ? 'reduced' : 'full'}>
      {pairedState === 'no' ? <WallPairing api={api} client={client} onPaired={onPaired} cooldownMs={pairCooldownMs} /> : null}
      {pairedState !== 'no' && (!session || !config) ? (
        <div className="cw-boot"><img src="/favicon.svg" alt="" /><span>{snap.connection === 'offline' ? 'Offline · Reconnecting…' : 'Connecting…'}</span></div>
      ) : null}
      {pairedState === 'yes' && session && config && view ? (
        <WallStage
          key={generation}
          channel={channel}
          config={{ ...config, theme }}
          presetId={view.preset}
          focusMarket={view.market}
          renderMode={renderMode}
          reducedMotion={caps.reducedMotion}
          now={now}
          showFeed={showFeed}
          updating={updating}
          onMapFail={onMapFail}
          fetchLayer={fetchLayer}
          rotationLabel={rotationLabel}
        />
      ) : null}
      {menuOpen ? (
        <div className="cw-menu" role="menu" aria-label="Command Wall">
          <div className="cw-menu__k">{session?.name || 'Command Wall'}</div>
          {menu.map((m, i) => (
            <div key={m.key} role="menuitem" className="cw-menu__item" data-focus={i === menuIndex ? 'true' : undefined}>
              <span>{m.label}</span><span className="cw-menu__v">{m.value}</span>
            </div>
          ))}
          <div className="cw-menu__hint">↑ ↓ move · OK change · Back close</div>
        </div>
      ) : null}
    </div>
  )
}
