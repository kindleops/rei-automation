import { cx } from './cx'
import './lc-feedback.css'

/**
 * LCPaneLoading — the LoadingPlane. A quiet, layout-shaped placeholder that
 * fills a pane (or a large region of one) while its code or first data
 * arrives. Never blank, never a spinner, never "Loading…" text.
 *
 *   layout="split"  list rail + main plane (Inbox-family, Email, Closing)
 *   layout="board"  header + wide plane (Map, Calendar, canvases)
 *   layout="list"   header + rows (lists, feeds)
 *
 * Container-query driven: the split collapses to a single plane in narrow panes.
 */
export interface LCPaneLoadingProps {
  layout?: 'split' | 'board' | 'list'
  /** accessible name, e.g. "Loading Email Command" */
  label?: string
  className?: string
}

export function LCPaneLoading({ layout = 'board', label = 'Loading', className }: LCPaneLoadingProps) {
  return (
    <div className={cx('lc-pane-loading', `is-${layout}`, className)} role="status" aria-busy="true" aria-label={label}>
      <div className="lc-pane-loading__bar">
        <i className="lc-skel" style={{ width: 132, height: 12 }} />
        <i className="lc-skel lc-pane-loading__grow" style={{ height: 26, borderRadius: 9 }} />
        <i className="lc-skel" style={{ width: 72, height: 26, borderRadius: 9 }} />
      </div>
      <div className="lc-pane-loading__body">
        {layout === 'split' ? (
          <div className="lc-pane-loading__rail">
            {Array.from({ length: 7 }, (_, i) => (
              <span key={i} className="lc-pane-loading__row">
                <i className="lc-skel" style={{ width: 26, height: 26, borderRadius: 8 }} />
                <span className="lc-pane-loading__col">
                  <i className="lc-skel" style={{ width: `${70 - ((i * 13) % 26)}%`, height: 9 }} />
                  <i className="lc-skel" style={{ width: `${44 - ((i * 7) % 16)}%`, height: 7 }} />
                </span>
              </span>
            ))}
          </div>
        ) : null}
        {layout === 'list' ? (
          <div className="lc-pane-loading__plane is-rows">
            {Array.from({ length: 8 }, (_, i) => (
              <span key={i} className="lc-pane-loading__row">
                <span className="lc-pane-loading__col">
                  <i className="lc-skel" style={{ width: `${58 - ((i * 11) % 22)}%`, height: 10 }} />
                  <i className="lc-skel" style={{ width: `${34 - ((i * 5) % 12)}%`, height: 8 }} />
                </span>
                <i className="lc-skel" style={{ width: 56, height: 10 }} />
              </span>
            ))}
          </div>
        ) : (
          <div className="lc-pane-loading__plane">
            <i className="lc-skel" style={{ width: '38%', height: 14 }} />
            <i className="lc-skel lc-pane-loading__fill" />
          </div>
        )}
      </div>
    </div>
  )
}
