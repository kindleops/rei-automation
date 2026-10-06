/**
 * Command Wall render modes (§9, §10).
 *
 *   FULL  full map effects: WebGL map, pulses, market glow, blur glass.
 *   LITE  WebGL map with reduced effects: no blur, fewer animated pulses,
 *         a lighter pixel ratio, no 3D/extrusions.
 *   SAFE  no WebGL: an SVG national map with market dots, minimal motion.
 *
 * Detection is pure over a probed capability record, so it is testable and the
 * diagnostics page can show exactly why a mode was chosen. Never a blank
 * screen: anything uncertain degrades to a lower mode, and SAFE needs nothing
 * beyond SVG + fetch.
 */
import type { WallRenderMode } from './wall-types'

export interface WallCapabilities {
  webgl2: boolean
  webgl: boolean
  /** WebGL works only with a major performance caveat (software rendering) */
  webglSoftware: boolean
  maxTextureSize: number | null
  deviceMemoryGb: number | null
  cores: number | null
  backdropFilter: boolean
  resizeObserver: boolean
  intersectionObserver: boolean
  broadcastChannel: boolean
  requestIdleCallback: boolean
  webSocket: boolean
  eventSource: boolean
  fetch: boolean
  localStorage: boolean
  cookies: boolean
  reducedMotion: boolean
  screenWidth: number
  screenHeight: number
  dpr: number
  colorGamutP3: boolean
  userAgent: string
}

export type BrowserFamily = 'tizen' | 'webos' | 'android_tv' | 'chromecast' | 'fire_tv' | 'apple_tv' | 'chromium' | 'safari' | 'firefox' | 'other'

export function browserFamily(ua: string): BrowserFamily {
  const s = ua || ''
  if (/Tizen/i.test(s)) return 'tizen'
  if (/Web0S|webOS|NetCast/i.test(s)) return 'webos'
  if (/CrKey/i.test(s)) return 'chromecast'
  if (/AFT[A-Z]|Silk\//.test(s)) return 'fire_tv'
  if (/AppleTV|tvOS/i.test(s)) return 'apple_tv'
  if (/Android/i.test(s) && /\bTV\b|AndroidTV|BRAVIA|SmartTV/i.test(s)) return 'android_tv'
  if (/Firefox\//.test(s)) return 'firefox'
  if (/Chrome\/|Chromium\/|Edg\//.test(s)) return 'chromium'
  if (/Safari\//.test(s) && /Version\//.test(s)) return 'safari'
  return 'other'
}

export const isTvFamily = (f: BrowserFamily) => f === 'tizen' || f === 'webos' || f === 'android_tv' || f === 'chromecast' || f === 'fire_tv' || f === 'apple_tv'

export interface RenderDecision { mode: WallRenderMode; reasons: string[]; family: BrowserFamily }

/** Pure: capabilities (+ optional forced mode) → mode and the reasons for it. */
export function chooseRenderMode(caps: WallCapabilities, forced?: string | null): RenderDecision {
  const family = browserFamily(caps.userAgent)
  const reasons: string[] = []
  if (forced === 'full' || forced === 'lite' || forced === 'safe') {
    // a forced FULL/LITE still cannot run a WebGL map without WebGL
    if (forced !== 'safe' && !caps.webgl && !caps.webgl2) return { mode: 'safe', reasons: ['forced mode needs WebGL; none available'], family }
    return { mode: forced, reasons: [`forced by ?render=${forced}`], family }
  }
  if (!caps.fetch) return { mode: 'safe', reasons: ['fetch unavailable'], family }
  if (!caps.webgl && !caps.webgl2) return { mode: 'safe', reasons: ['WebGL unavailable'], family }
  if (caps.webglSoftware) return { mode: 'safe', reasons: ['WebGL is software-rendered'], family }
  if (caps.maxTextureSize !== null && caps.maxTextureSize < 4096) return { mode: 'safe', reasons: [`max texture ${caps.maxTextureSize} < 4096`], family }

  let lite = false
  if (!caps.webgl2) { lite = true; reasons.push('WebGL1 only') }
  if (isTvFamily(family)) { lite = true; reasons.push(`TV browser (${family})`) }
  if (caps.deviceMemoryGb !== null && caps.deviceMemoryGb < 4) { lite = true; reasons.push(`device memory ${caps.deviceMemoryGb} GB`) }
  if (caps.cores !== null && caps.cores < 4) { lite = true; reasons.push(`${caps.cores} CPU cores`) }
  if (!caps.backdropFilter) { lite = true; reasons.push('no backdrop-filter') }
  if (caps.reducedMotion) { lite = true; reasons.push('reduced motion') }
  // 4K (≥ 3000 device px wide): measured 2026-10-06 on an Intel UHD 630, FULL ran 19.8 fps median at
  // 3840×2160 (blur glass + drift compositing); LITE drops the blur. 2560×1440 stays FULL.
  if (caps.screenWidth * caps.dpr >= 3000) { lite = true; reasons.push('4K-class framebuffer') }
  if (!lite) reasons.push('capable desktop-class browser')
  return { mode: lite ? 'lite' : 'full', reasons, family }
}

/** Pixel ratio the map should render at, per mode (bounded GPU cost on 4K TVs). */
export function mapPixelRatio(mode: WallRenderMode, dpr: number, screenWidth: number): number {
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  if (mode === 'lite') return Math.min(d, screenWidth >= 3000 ? 1 : 1.5)
  return Math.min(d, 2)
}

/** Browser probe. Side-effect free apart from one throwaway canvas. */
export function probeCapabilities(win: Window & typeof globalThis = window): WallCapabilities {
  const doc = win.document
  const nav = win.navigator as Navigator & { deviceMemory?: number }
  let webgl2 = false
  let webgl = false
  let webglSoftware = false
  let maxTextureSize: number | null = null
  try {
    const c = doc.createElement('canvas')
    const g2 = c.getContext('webgl2', { failIfMajorPerformanceCaveat: true }) as WebGL2RenderingContext | null
    const g1 = g2 ? null : (c.getContext('webgl', { failIfMajorPerformanceCaveat: true }) as WebGLRenderingContext | null)
    const g = g2 || g1
    webgl2 = Boolean(g2)
    webgl = Boolean(g)
    if (g) {
      maxTextureSize = Number(g.getParameter(g.MAX_TEXTURE_SIZE)) || null
      g.getExtension('WEBGL_lose_context')?.loseContext()
    } else {
      const c2 = doc.createElement('canvas')
      const soft = (c2.getContext('webgl2') || c2.getContext('webgl')) as WebGLRenderingContext | null
      if (soft) { webgl = true; webglSoftware = true; soft.getExtension('WEBGL_lose_context')?.loseContext() }
    }
  } catch {
    webgl = false
  }
  const css = (win as unknown as { CSS?: { supports?: (p: string, v?: string) => boolean } }).CSS
  const supports = (p: string, v: string) => { try { return Boolean(css?.supports?.(p, v)) } catch { return false } }
  let ls = false
  try { const k = '__lcw_probe'; win.localStorage.setItem(k, '1'); win.localStorage.removeItem(k); ls = true } catch { ls = false }
  return {
    webgl2,
    webgl,
    webglSoftware,
    maxTextureSize,
    deviceMemoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    cores: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
    backdropFilter: supports('backdrop-filter', 'blur(4px)') || supports('-webkit-backdrop-filter', 'blur(4px)'),
    resizeObserver: typeof win.ResizeObserver === 'function',
    intersectionObserver: typeof win.IntersectionObserver === 'function',
    broadcastChannel: typeof win.BroadcastChannel === 'function',
    requestIdleCallback: typeof (win as unknown as { requestIdleCallback?: unknown }).requestIdleCallback === 'function',
    webSocket: typeof win.WebSocket === 'function',
    eventSource: typeof win.EventSource === 'function',
    fetch: typeof win.fetch === 'function',
    localStorage: ls,
    cookies: Boolean(nav.cookieEnabled),
    reducedMotion: Boolean(win.matchMedia?.('(prefers-reduced-motion: reduce)').matches),
    screenWidth: win.innerWidth || win.screen?.width || 0,
    screenHeight: win.innerHeight || win.screen?.height || 0,
    dpr: win.devicePixelRatio || 1,
    colorGamutP3: Boolean(win.matchMedia?.('(color-gamut: p3)').matches),
    userAgent: nav.userAgent || '',
  }
}
