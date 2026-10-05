import { Component, memo, Suspense, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { PaneRouteContext } from '../../../app/router'
import { resolveRoute } from '../../../app/routes'
import { Icon } from '../../../shared/icons'
import { LCButton } from '../../../shared/lc'
import { getApp, type AppId } from '../../../domain/app-registry/app-registry'
import { AppInstanceContext, type AppInstanceInfo } from './instance-context'
import type { Instance } from './layout'
import { instanceBodyKey } from './instance-key'

/**
 * ONE APPLICATION INSTANCE in one pane: its own route, its own loader, its
 * own error boundary. A pane that crashes says so and offers Retry / Close —
 * the rest of the workspace never notices. The URL-bound (primary) instance
 * gets no pane route context, so it behaves exactly like the app always has;
 * every other instance reads its own path from the context.
 */

const pathnameOf = (path: string) => path.split('?')[0].split('#')[0] || '/'

/* ── route data: one load per (path, attempt), shared, tear-free ──────── */

type RouteData = { status: 'loading' | 'ready' | 'error'; data: unknown; message: string }
const cache = new Map<string, { value: RouteData; listeners: Set<() => void> }>()

function entry(key: string, pathname: string) {
  let e = cache.get(key)
  if (!e) {
    const created = { value: { status: 'loading', data: null, message: '' } as RouteData, listeners: new Set<() => void>() }
    e = created
    cache.set(key, created)
    if (cache.size > 40) {
      for (const [k, v] of cache) { if (v.listeners.size === 0 && k !== key) { cache.delete(k); if (cache.size <= 30) break } }
    }
    let route: ReturnType<typeof resolveRoute>
    try { route = resolveRoute(pathname) } catch (error) {
      created.value = { status: 'error', data: null, message: error instanceof Error ? error.message : 'Unknown route' }
      return created
    }
    route.loader().then(
      (data) => { created.value = { status: 'ready', data, message: '' }; created.listeners.forEach((l) => l()) },
      (error: unknown) => { created.value = { status: 'error', data: null, message: error instanceof Error ? error.message : 'Could not load' }; created.listeners.forEach((l) => l()) },
    )
  }
  return e
}

function useRouteData(pathname: string, attempt: number): RouteData {
  const key = `${pathname}#${attempt}`
  const e = entry(key, pathname)
  return useSyncExternalStore(
    (l) => { e.listeners.add(l); return () => { e.listeners.delete(l) } },
    () => e.value,
    () => e.value,
  )
}

/* ── states ───────────────────────────────────────────────────────────── */

const appMeta = (app: string) => { try { return getApp(app as AppId) } catch { return null } }

export function PaneSkeleton({ app }: { app: string }) {
  const meta = appMeta(app)
  return (
    <div className="ws-skel" aria-busy="true" aria-label={`Loading ${meta?.label ?? 'application'}`}>
      <div className="ws-skel__head">
        <span className="ws-skel__glyph">{meta ? <Icon name={meta.icon} size={15} strokeWidth={1.7} /> : null}</span>
        <span className="lc-skel" style={{ width: 140, height: 12 }} />
      </div>
      <span className="lc-skel" style={{ width: '62%', height: 18 }} />
      <span className="lc-skel" style={{ width: '88%', height: 72 }} />
      <span className="lc-skel" style={{ width: '76%', height: 44 }} />
      <span className="lc-skel" style={{ width: '54%', height: 44 }} />
    </div>
  )
}

function PaneUnavailable({ app, message, onRetry, onClose }: { app: string; message: string; onRetry: () => void; onClose: (() => void) | null }) {
  const meta = appMeta(app)
  return (
    <div className="ws-state" role="alert">
      <span className="ws-state__eyebrow">App unavailable</span>
      <strong>{meta?.label ?? 'This application'} could not load</strong>
      <p>{message || 'Something went wrong inside this pane. The rest of the workspace is unaffected.'}</p>
      <div className="ws-state__actions">
        <LCButton variant="primary" size="sm" onClick={onRetry}>Retry</LCButton>
        {onClose ? <LCButton variant="ghost" size="sm" onClick={onClose}>Close pane</LCButton> : null}
      </div>
    </div>
  )
}

class PaneBoundary extends Component<{ app: string; resetKey: string; onRetry: () => void; onClose: (() => void) | null; children: ReactNode }, { error: Error | null; key: string }> {
  state = { error: null as Error | null, key: this.props.resetKey }
  static getDerivedStateFromError(error: Error) { return { error } }
  static getDerivedStateFromProps(props: { resetKey: string }, state: { error: Error | null; key: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null
  }
  render() {
    if (this.state.error) {
      return <PaneUnavailable app={this.props.app} message={this.state.error.message} onRetry={() => { this.setState({ error: null }); this.props.onRetry() }} onClose={this.props.onClose} />
    }
    return this.props.children
  }
}

/* ── the host ─────────────────────────────────────────────────────────── */


export interface AppInstanceHostProps {
  inst: Instance
  primary: boolean
  visible: boolean
  follows: boolean
  onClose: (() => void) | null
}

export const AppInstanceHost = memo(function AppInstanceHost({ inst, primary, visible, follows, onClose }: AppInstanceHostProps) {
  const pathname = pathnameOf(inst.path)
  const [attempt, setAttempt] = useState(0)
  const data = useRouteData(pathname, attempt)
  const route = useMemo(() => resolveRoute(pathname), [pathname])
  const paneRoute = useMemo(() => (primary ? null : { paneId: inst.id, path: pathname, location: inst.path }), [primary, inst.id, pathname, inst.path])
  const info = useMemo<AppInstanceInfo>(() => ({
    instanceId: inst.id,
    app: inst.app,
    follows: follows && !inst.pinned,
    pinned: inst.pinned,
    pinLabel: inst.pinLabel ?? null,
    visible,
  }), [inst.id, inst.app, inst.pinned, inst.pinLabel, follows, visible])
  const retry = () => setAttempt((a) => a + 1)

  let body: ReactNode
  if (data.status === 'loading') body = <PaneSkeleton app={inst.app} />
  else if (data.status === 'error') body = <PaneUnavailable app={inst.app} message={data.message} onRetry={retry} onClose={onClose} />
  else {
    body = (
      <PaneBoundary app={inst.app} resetKey={`${pathname}#${attempt}`} onRetry={retry} onClose={onClose}>
        <Suspense key={instanceBodyKey(inst)} fallback={<PaneSkeleton app={inst.app} />}>{route.render(data.data)}</Suspense>
      </PaneBoundary>
    )
  }
  return (
    <PaneRouteContext.Provider value={paneRoute}>
      <AppInstanceContext.Provider value={info}>{body}</AppInstanceContext.Provider>
    </PaneRouteContext.Provider>
  )
})
