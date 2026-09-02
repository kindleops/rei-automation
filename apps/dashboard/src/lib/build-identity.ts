const read = (value: unknown, fallback = 'unknown') => {
  const text = String(value ?? '').trim()
  return text && text !== 'local' ? text : fallback
}

export interface BuildIdentity {
  gitSha: string
  gitShaShort: string
  buildTime: string
  deploymentId: string
  project: string
}

export function resolveBuildIdentity(): BuildIdentity {
  const gitSha = read(
    import.meta.env.VITE_COMMIT_SHA,
    read(import.meta.env.VITE_DASHBOARD_GIT_SHA, 'unknown'),
  )
  return {
    gitSha,
    gitShaShort: gitSha === 'unknown' ? gitSha : gitSha.slice(0, 12),
    buildTime: read(import.meta.env.VITE_BUILD_TIME, 'unknown'),
    deploymentId: read(import.meta.env.VITE_DEPLOYMENT_ID, 'unknown'),
    project: read(import.meta.env.VITE_VERCEL_PROJECT, 'dashboard'),
  }
}

export function formatBuildIdentityLine(identity = resolveBuildIdentity()): string {
  return `${identity.gitShaShort} · ${identity.deploymentId} · ${identity.buildTime}`
}

// ── Runtime shell identity ────────────────────────────────────────────────
//
// resolveBuildIdentity() reports what the bundle was COMPILED with. This
// reports what the browser actually EXECUTED — the two disagree exactly when a
// stale worker or HTTP cache is serving an old application shell, which is the
// condition this is here to make visible from the handset.

export interface RuntimeShellReport {
  metaSha: string
  loadedCss: string
  loadedJs: string
  chunkCount: number
  href: string
  displayMode: string
  navigatorStandalone: string
  innerHeight: number
  clientHeight: number
  rootRect: string
  dockRect: string
}

const DISPLAY_MODES = ['standalone', 'fullscreen', 'minimal-ui', 'browser'] as const

const basename = (url: string) => {
  try {
    return new URL(url).pathname.split('/').pop() || url
  } catch {
    return url
  }
}

const formatRect = (el: Element | null): string => {
  if (!el) return 'absent'
  const r = el.getBoundingClientRect()
  return `${Math.round(r.width)}×${Math.round(r.height)} top=${Math.round(r.top)} bottom=${Math.round(r.bottom)}`
}

const resolveDisplayMode = (): string => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'unknown'
  const hit = DISPLAY_MODES.find((mode) => window.matchMedia(`(display-mode: ${mode})`).matches)
  return hit ?? 'unknown'
}

export function resolveRuntimeShellReport(): RuntimeShellReport {
  const empty: RuntimeShellReport = {
    metaSha: 'unknown',
    loadedCss: 'unknown',
    loadedJs: 'unknown',
    chunkCount: 0,
    href: 'unknown',
    displayMode: 'unknown',
    navigatorStandalone: 'unknown',
    innerHeight: 0,
    clientHeight: 0,
    rootRect: 'absent',
    dockRect: 'absent',
  }
  if (typeof document === 'undefined' || typeof window === 'undefined') return empty

  const meta = document.querySelector<HTMLMetaElement>('meta[name="nx-build-sha"]')

  // The resource timeline is the only source that reports the bytes the browser
  // really fetched. Filenames derived from source would agree with themselves
  // even while the page runs a different build entirely.
  let loadedCss = 'none'
  let loadedJs = 'none'
  let chunkCount = 0
  try {
    const own = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => name.startsWith(window.location.origin))
      .map(basename)
    const css = own.filter((name) => /\.css(\?|$)/.test(name))
    const js = own.filter((name) => /\.js(\?|$)/.test(name))
    chunkCount = js.length
    loadedCss = css.find((name) => name.startsWith('main-')) ?? css[0] ?? 'none'
    loadedJs = js.find((name) => name.startsWith('main-')) ?? js[0] ?? 'none'
  } catch {
    loadedCss = 'timeline-unavailable'
    loadedJs = 'timeline-unavailable'
  }

  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone

  return {
    metaSha: meta?.content?.trim() || 'absent',
    loadedCss,
    loadedJs,
    chunkCount,
    href: window.location.href,
    displayMode: resolveDisplayMode(),
    navigatorStandalone: standalone === undefined ? 'n/a' : standalone ? 'yes' : 'no',
    innerHeight: Math.round(window.innerHeight),
    clientHeight: Math.round(document.documentElement.clientHeight),
    rootRect: formatRect(document.getElementById('root')),
    dockRect: formatRect(document.querySelector('.nx-pinned-app-dock')),
  }
}
