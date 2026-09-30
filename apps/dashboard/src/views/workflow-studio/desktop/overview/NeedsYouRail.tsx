import { Icon } from '../../../../shared/icons'
import type { ActivityGroup, NeedsYouItem } from '../observatory-types'
import { ago } from '../../mobile/workflow-format'

/**
 * NEEDS YOU — dense, one line of who and one line of why. A click opens the
 * exact run on the canvas, centred on the node that is holding it.
 */
export function NeedsYouRail({ items, total, loading, error, onOpen }: {
  items: NeedsYouItem[]
  total: number
  loading: boolean
  error: string | null
  onOpen: (it: NeedsYouItem) => void
}) {
  return (
    <section className="ws3-needs" aria-label="Needs you">
      <h3 className="ws3-h3">Needs you<em className={total ? 'is-on' : ''}>{total}</em></h3>
      {loading && !items.length ? <div className="ws3-skel-rows" aria-busy="true">{[0, 1, 2, 3].map((i) => <span key={i} />)}</div> : null}
      {error && !items.length ? <p className="ws3-quiet is-error">Could not read what needs you — {error}. Nothing is shown rather than a guess.</p> : null}
      {!loading && !error && !items.length ? <p className="ws3-quiet"><Icon name="check" />Nothing is waiting on you. Every open run is moving on its own.</p> : null}
      <ol className="ws3-needs__list">
        {items.map((it) => (
          <li key={`${it.workflow_key}:${it.run_id}:${it.node_key}`}>
            <button type="button" className="ws3-needs__row" onClick={() => onOpen(it)} data-run={it.run_id}>
              <i className="ws3-dot is-human" aria-hidden />
              <span className="ws3-needs__text">
                <strong>{it.subject?.name || it.subject?.address || it.workflow_name}</strong>
                <small>{it.reason}</small>
                <span className="ws3-needs__spec">{it.workflow_name}{it.subject?.name && it.subject?.address ? ` · ${it.subject.address}` : ''}</span>
              </span>
              <time>{ago(it.since)}</time>
            </button>
          </li>
        ))}
      </ol>
    </section>
  )
}

const STATUS_WORD: Record<string, string> = { completed: 'Handled', waiting: 'Waiting', running: 'Running', held: 'Held', needs_you: 'Needs you', failed: 'Failed', cancelled: 'Stopped' }

/** LIVE ACTIVITY — meaningful events grouped per run, newest first. */
export function LiveActivity({ groups, loading, error, onOpen, limit = 12 }: {
  groups: ActivityGroup[]
  loading: boolean
  error: string | null
  onOpen: (g: ActivityGroup) => void
  limit?: number
}) {
  const list = groups.slice(0, limit)
  return (
    <section className="ws3-act" aria-label="Live activity">
      <h3 className="ws3-h3"><i className="ws3-livedot" aria-hidden />Live activity</h3>
      {loading && !list.length ? <div className="ws3-skel-rows" aria-busy="true">{[0, 1, 2, 3, 4].map((i) => <span key={i} />)}</div> : null}
      {error && !list.length ? <p className="ws3-quiet is-error">Activity could not be read — {error}.</p> : null}
      {!loading && !error && !list.length ? <p className="ws3-quiet">No runs in the window.</p> : null}
      <ol className="ws3-act__list">
        {list.map((g) => (
          <li key={g.group_id}>
            <button type="button" className={`ws3-act__row is-${g.status}`} onClick={() => onOpen(g)}>
              <i className={`ws3-dot is-${g.status}`} aria-hidden />
              <span className="ws3-act__text">
                <span className="ws3-act__wf">{g.workflow_name}<em>{STATUS_WORD[g.status] || g.status}</em></span>
                <strong>{g.subject?.name || g.subject?.address || g.headline}</strong>
                <small>{g.facts.filter(Boolean).slice(0, 4).join(' · ')}</small>
              </span>
              <time>{ago(g.at)}</time>
            </button>
          </li>
        ))}
      </ol>
    </section>
  )
}
