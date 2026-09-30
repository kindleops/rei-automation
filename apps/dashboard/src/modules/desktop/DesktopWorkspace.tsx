import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../../shared/icons'
import { PaneRouteContext, setRouteNavigationInterceptor } from '../../app/router'
import { resolveRoute } from '../../app/routes'
import { resolveAppForRoute } from '../../domain/app-registry/app-registry'
import { ErrorBoundary } from '../../shared/ErrorBoundary'
import { appHue } from '../mobile/app-hues'
import {
  MAIN,
  MIN_FRACTION,
  closePane,
  focusPane,
  interceptNavigation,
  markPaneInteraction,
  normalizeSizes,
  promoteToMain,
  setPaneSizes,
  useSplitWorkspace,
} from './split-workspace'

/**
 * THE WORKSPACE — one to four application panes.
 *
 * Every pane is its own containing block (contain: layout paint) and its own
 * size container (container: pane), so a surface fills exactly its pane —
 * absolute and fixed layers included — and lays itself out by the width it was
 * given rather than the window's. The main pane renders the router's current
 * route; secondary panes resolve, load and render their own.
 */

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

function SecondaryRoute({ path }: { path: string }) {
  const pathname = path.split('?')[0] || '/'
  const route = useMemo(() => resolveRoute(pathname), [pathname])
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; data: unknown; message?: string }>({ status: 'loading', data: null })
  useEffect(() => {
    let live = true
    setState({ status: 'loading', data: null })
    route.loader().then(
      (data) => { if (live) setState({ status: 'ready', data }) },
      (error: unknown) => { if (live) setState({ status: 'error', data: null, message: error instanceof Error ? error.message : 'Could not load' }) },
    )
    return () => { live = false }
  }, [route])
  if (state.status === 'loading') return <div className="dsk-pane__state"><span className="dsk-pane__spinner" /></div>
  if (state.status === 'error') return <div className="dsk-pane__state"><strong>{route.title} could not load</strong><small>{state.message}</small></div>
  return <>{route.render(state.data)}</>
}

export function DesktopWorkspace({ main, mainPath }: { main: ReactNode; mainPath: string }) {
  const split = useSplitWorkspace()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [drag, setDrag] = useState<number | null>(null)

  useEffect(() => {
    setRouteNavigationInterceptor(interceptNavigation)
    return () => setRouteNavigationInterceptor(null)
  }, [])

  const panes = useMemo(() => [{ id: MAIN, path: mainPath }, ...split.panes], [mainPath, split.panes])
  const sizes = normalizeSizes(split.sizes, panes.length)
  const isSplit = panes.length > 1

  // Divider drag: move the boundary between pane i and i+1, both kept ≥ 25%.
  const startDrag = useCallback((i: number, e: React.PointerEvent) => {
    e.preventDefault()
    const root = rootRef.current
    if (!root) return
    setDrag(i)
    const box = root.getBoundingClientRect()
    const start = normalizeSizes(split.sizes, panes.length)
    const left = start.slice(0, i).reduce((a, b) => a + b, 0)
    const pair = start[i] + start[i + 1]
    const move = (ev: PointerEvent) => {
      const x = (ev.clientX - box.left) / box.width
      const a = Math.min(pair - MIN_FRACTION, Math.max(MIN_FRACTION, x - left))
      const next = [...start]
      next[i] = a
      next[i + 1] = pair - a
      setPaneSizes(next)
    }
    const up = () => { setDrag(null); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [panes.length, split.sizes])

  const columns = sizes.map((f) => `minmax(0, ${f}fr)`).join(' var(--dsk-divider) ')

  return (
    <div
      ref={rootRef}
      className={cls('dsk-ws', isSplit ? `is-split is-split-${panes.length}` : 'is-single', drag !== null && 'is-dragging')}
      style={{ gridTemplateColumns: columns }}
    >
      {panes.map((pane, i) => {
        const app = resolveAppForRoute(pane.path.split('?')[0])
        const focused = split.focused === pane.id
        const body = pane.id === MAIN
          ? main
          : (
            <PaneRouteContext.Provider value={{ paneId: pane.id, path: pane.path.split('?')[0], location: pane.path }}>
              <ErrorBoundary label={app.label} resetKey={pane.path}>
                <Suspense fallback={<div className="dsk-pane__state"><span className="dsk-pane__spinner" /></div>}>
                  <SecondaryRoute path={pane.path} />
                </Suspense>
              </ErrorBoundary>
            </PaneRouteContext.Provider>
          )
        return [
          i > 0 ? (
            <div
              key={`d-${pane.id}`}
              className={cls('dsk-divider', drag === i - 1 && 'is-active')}
              onPointerDown={(e) => startDrag(i - 1, e)}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize panes"
            ><i /></div>
          ) : null,
          <section
            key={pane.id}
            className={cls('dsk-pane', isSplit && focused && 'is-focused')}
            style={{ ['--app' as string]: appHue(app.id) }}
            onPointerDownCapture={() => { markPaneInteraction(pane.id); if (isSplit) focusPane(pane.id) }}
            onKeyDownCapture={() => markPaneInteraction(pane.id)}
            aria-label={app.label}
          >
            {isSplit ? (
              <header className="dsk-pane__bar">
                <span className="dsk-pane__glyph"><Icon name={app.icon} size={13} strokeWidth={1.8} /></span>
                <b>{app.label}</b>
                {pane.id === MAIN ? <em>Main</em> : null}
                <span className="dsk-pane__tools">
                  {pane.id !== MAIN ? (
                    <button type="button" onClick={() => promoteToMain(pane.id)} aria-label={`Make ${app.label} the main pane`} data-tip="Make main"><Icon name="maximize" size={13} /></button>
                  ) : null}
                  <button type="button" onClick={() => closePane(pane.id)} aria-label={`Close ${app.label}`} data-tip="Close"><Icon name="x" size={13} /></button>
                </span>
              </header>
            ) : null}
            <div className="dsk-pane__body">{body}</div>
          </section>,
        ]
      })}
    </div>
  )
}
