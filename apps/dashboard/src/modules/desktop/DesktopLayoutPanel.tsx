import { Icon } from '../../shared/icons'
import { getApp, resolveAppForRoute, type AppId } from '../../domain/app-registry/app-registry'
import { appHue } from '../mobile/app-hues'
import { MAIN, MAX_PANES, applyLayout, clearSplit, closePane, focusPane, getSplitState, useSplitWorkspace } from './split-workspace'
import { setDisplayMode, useDisplayMode, type DisplayMode } from './display-mode'

/**
 * WORKSPACE LAYOUT — how many applications share the screen, which ones, and
 * whether this display is treated as a 49″ ultrawide.
 */

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

/** The apps a new slot is filled with, in order, skipping any already open. */
const FILL_ORDER: AppId[] = ['inbox', 'map', 'pipeline', 'deal-intelligence', 'campaign-command', 'analytics', 'calendar', 'closing-desk']

function fill(n: number, mainPath: string): string[] {
  const open = new Set([resolveAppForRoute(mainPath.split('?')[0]).id, ...getSplitState().panes.map((p) => resolveAppForRoute(p.path.split('?')[0]).id)])
  const keep = getSplitState().panes.map((p) => p.path).slice(0, n - 1)
  for (const id of FILL_ORDER) {
    if (keep.length >= n - 1) break
    const app = getApp(id)
    if (!app || open.has(id)) continue
    open.add(id)
    keep.push(app.route)
  }
  return keep
}

const LAYOUTS: Array<{ n: number; label: string; hint: string }> = [
  { n: 1, label: 'Focus', hint: 'One app' },
  { n: 2, label: 'Dual', hint: 'Two side by side' },
  { n: 3, label: 'Tri', hint: 'Three columns' },
  { n: 4, label: 'Quad', hint: 'Four at 25%' },
]

const MODES: Array<{ id: DisplayMode; label: string; hint: string }> = [
  { id: 'auto', label: 'Auto', hint: 'Detect the display' },
  { id: 'standard', label: 'Standard', hint: '13″–34″ displays' },
  { id: 'ultrawide', label: 'Ultrawide 49″', hint: '32:9 · four full apps' },
]

export function DesktopLayoutPanel({ mainPath, onClose }: { mainPath: string; onClose: () => void }) {
  const split = useSplitWorkspace()
  const { mode, ultrawide } = useDisplayMode()
  const count = split.panes.length + 1
  const panes = [{ id: MAIN, path: mainPath }, ...split.panes]

  const choose = (n: number) => {
    if (n === 1) clearSplit()
    else applyLayout(fill(n, mainPath))
  }

  return (
    <div className="dsk-pop dsk-pop--layout" role="dialog" aria-label="Workspace layout">
      <header className="dsk-pop__head">
        <div>
          <p className="dsk-pop__eyebrow">Workspace</p>
          <h3>Split screen</h3>
        </div>
        <button type="button" className="dsk-pop__icon" onClick={onClose} aria-label="Close"><Icon name="x" size={14} /></button>
      </header>

      <div className="dsk-lay__grid" role="radiogroup" aria-label="Layout">
        {LAYOUTS.map((l) => (
          <button key={l.n} type="button" role="radio" aria-checked={count === l.n} className={cls('dsk-lay__opt', count === l.n && 'is-active')} onClick={() => choose(l.n)}>
            <span className={cls('dsk-lay__glyph', `is-${l.n}`)} aria-hidden>{Array.from({ length: l.n }, (_, k) => <i key={k} />)}</span>
            <b>{l.label}</b>
            <small>{l.hint}</small>
          </button>
        ))}
      </div>

      <p className="dsk-pop__eyebrow dsk-lay__sub">Open now · {count} of {MAX_PANES}</p>
      <ul className="dsk-lay__panes">
        {panes.map((p) => {
          const app = resolveAppForRoute(p.path.split('?')[0])
          return (
            <li key={p.id} style={{ ['--app' as string]: appHue(app.id) }}>
              <button type="button" className="dsk-lay__pane" onClick={() => focusPane(p.id)}>
                <span className="dsk-lay__pane-glyph"><Icon name={app.icon} size={13} /></span>
                <b>{app.label}</b>
                {p.id === MAIN ? <em>Main</em> : null}
              </button>
              {count > 1 ? <button type="button" className="dsk-pop__icon" onClick={() => closePane(p.id)} aria-label={`Close ${app.label}`}><Icon name="x" size={12} /></button> : null}
            </li>
          )
        })}
      </ul>
      <p className="dsk-lay__tip">Hover any app in the sidebar and choose <Icon name="layout-split" size={12} /> to open it beside what you have. Drag a divider to resize — no pane goes under 25%.</p>

      <p className="dsk-pop__eyebrow dsk-lay__sub">Display{ultrawide ? ' · ultrawide active' : ''}</p>
      <div className="dsk-lay__modes" role="radiogroup" aria-label="Display mode">
        {MODES.map((m) => (
          <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className={cls('dsk-lay__mode', mode === m.id && 'is-active')} onClick={() => setDisplayMode(m.id)}>
            <b>{m.label}</b>
            <small>{m.hint}</small>
          </button>
        ))}
      </div>
    </div>
  )
}
