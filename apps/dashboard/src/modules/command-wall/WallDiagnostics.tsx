/**
 * /wall/diagnostics (§53, §73): what this browser can do, and which render mode
 * the wall would pick. Shows NO token, cookie value, operator detail or data —
 * only capability facts and whether this display is paired.
 */
import { useEffect, useMemo, useState } from 'react'
import { browserFamily, chooseRenderMode, probeCapabilities } from './render-mode'
import { createWallApi, WallHttpError } from './wall-api'

type Check = 'checking' | 'paired' | 'not paired' | 'unreachable' | 'registry not provisioned'

export function WallDiagnostics() {
  const caps = useMemo(() => probeCapabilities(window), [])
  const decision = useMemo(() => chooseRenderMode(caps, new URLSearchParams(window.location.search).get('render')), [caps])
  const [session, setSession] = useState<Check>('checking')
  const [latency, setLatency] = useState<number | null>(null)

  useEffect(() => {
    const api = createWallApi()
    const t0 = performance.now()
    api.session()
      .then(() => { setSession('paired'); setLatency(Math.round(performance.now() - t0)) })
      .catch((e: unknown) => {
        setLatency(Math.round(performance.now() - t0))
        const err = e instanceof WallHttpError ? e : null
        setSession(err?.unpaired ? 'not paired' : err?.unprovisioned ? 'registry not provisioned' : err?.status === 0 ? 'unreachable' : 'not paired')
      })
  }, [])

  const yes = (b: boolean) => (b ? 'Yes' : 'No')
  const rows: [string, string][] = [
    ['Recommended render mode', `${decision.mode.toUpperCase()} — ${decision.reasons.join('; ')}`],
    ['Viewport', `${caps.screenWidth} × ${caps.screenHeight} CSS px · DPR ${caps.dpr} · ${Math.round(caps.screenWidth * caps.dpr)} × ${Math.round(caps.screenHeight * caps.dpr)} device px`],
    ['Screen', `${window.screen?.width ?? '?'} × ${window.screen?.height ?? '?'}`],
    ['Browser family', browserFamily(caps.userAgent)],
    ['User agent', caps.userAgent || 'unknown'],
    ['JavaScript', 'Running (this page rendered)'],
    ['WebGL 2', yes(caps.webgl2)],
    ['WebGL 1', yes(caps.webgl)],
    ['WebGL software-rendered', yes(caps.webglSoftware)],
    ['Max texture size', caps.maxTextureSize ? String(caps.maxTextureSize) : 'n/a'],
    ['Device memory', caps.deviceMemoryGb !== null ? `${caps.deviceMemoryGb} GB` : 'not reported'],
    ['CPU cores', caps.cores !== null ? String(caps.cores) : 'not reported'],
    ['fetch', yes(caps.fetch)],
    ['WebSocket', yes(caps.webSocket)],
    ['EventSource', yes(caps.eventSource)],
    ['ResizeObserver', yes(caps.resizeObserver)],
    ['IntersectionObserver', yes(caps.intersectionObserver)],
    ['BroadcastChannel', yes(caps.broadcastChannel)],
    ['requestIdleCallback', yes(caps.requestIdleCallback)],
    ['backdrop-filter', yes(caps.backdropFilter)],
    ['Display-P3', yes(caps.colorGamutP3)],
    ['Reduced motion', yes(caps.reducedMotion)],
    ['localStorage', yes(caps.localStorage)],
    ['Cookies enabled', yes(caps.cookies)],
    ['Wall API (session)', `${session}${latency !== null ? ` · ${latency} ms` : ''}`],
    ['Map compatibility', decision.mode === 'safe' ? 'SVG atlas (no WebGL map)' : decision.mode === 'lite' ? 'WebGL map, reduced effects' : 'WebGL map, full effects'],
  ]
  return (
    <div className="cw-diag">
      <div className="cw-diag__head"><img src="/favicon.svg" alt="" /> Command Wall · Diagnostics</div>
      <div className="cw-diag__grid">
        {rows.map(([k, v]) => <div key={k} className="cw-diag__row"><span>{k}</span><span>{v}</span></div>)}
      </div>
      <div className="cw-diag__foot">No credentials, cookies or business data are shown on this page. Open <b>/wall</b> to run the wall.</div>
    </div>
  )
}
