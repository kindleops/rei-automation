import { useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Icon } from '../../../../shared/icons'
import { LCButton, LCIconButton, LCSearch } from '../../../../shared/lc'
import { cx } from './widget-runtime'
import { SIZE_LABEL, type HomeWidgetDef, type LibraryMetrics } from './widget-registry'

/**
 * ADD WIDGET — the glass library, grouped by domain, searchable.
 *
 * Only functional widgets are listed; a provider widget whose connection is
 * missing shows as Not connected and cannot be added. Each card carries a
 * cheap live line read from the rail's resting telemetry (already in memory —
 * opening the library makes no request). Click Add, or drag a card onto the
 * board.
 */

const DOMAIN_ORDER: HomeWidgetDef['domain'][] = ['Command', 'Communication', 'Acquisitions', 'Operations', 'Intelligence', 'Closings']

export function WidgetLibrary({ defs, metrics, counts, onAdd, onDragStart, onClose }: {
  defs: HomeWidgetDef[]
  metrics: LibraryMetrics | null
  counts: Record<string, number>
  onAdd: (type: string) => void
  onDragStart: (type: string, e: ReactPointerEvent) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const hit = (d: HomeWidgetDef) => !needle || [d.name, d.description, d.domain, d.ownerApp].some((s) => s.toLowerCase().includes(needle))
    return DOMAIN_ORDER.map((domain) => ({ domain, items: defs.filter((d) => d.domain === domain && hit(d)) })).filter((g) => g.items.length)
  }, [defs, q])

  return (
    <aside className="hb-lib" aria-label="Add widget">
      <header className="hb-lib__head">
        <div>
          <h2>Add widget</h2>
          <p>Click Add, or drag a widget onto the board.</p>
        </div>
        <LCIconButton icon="x" label="Close the library" onClick={onClose} />
      </header>
      <LCSearch value={q} onChange={setQ} label="Search widgets" placeholder="Search widgets" autoFocus />
      <div className="hb-lib__scroll">
        {groups.length ? groups.map((g) => (
          <section key={g.domain} className="hb-lib__group" aria-label={g.domain}>
            <p className="hb-eyebrow">{g.domain}</p>
            <ul>
              {g.items.map((d) => {
                const conn = d.connectionRequirements?.() ?? { connected: true }
                const atCap = d.maxInstances != null && (counts[d.id] ?? 0) >= d.maxInstances
                const live = conn.connected ? d.preview?.(metrics) ?? null : null
                const blocked = !conn.connected ? conn.reason ?? 'Not connected' : atCap ? `This board already has ${d.maxInstances} ${d.name} widgets` : null
                return (
                  <li key={d.id}>
                    <div
                      className={cx('hb-lib__card', blocked && 'is-blocked')}
                      onPointerDown={blocked ? undefined : (e) => { if (!(e.target as HTMLElement).closest('button')) onDragStart(d.id, e) }}
                    >
                      <span className="hb-lib__glyph" aria-hidden="true"><Icon name={d.icon} size={16} /></span>
                      <span className="hb-lib__text">
                        <strong>{d.name}{counts[d.id] ? <em>{counts[d.id]} on board</em> : null}</strong>
                        <small>{d.description}</small>
                        {live ? <span className="hb-lib__live"><i aria-hidden="true" />{live}</span> : null}
                        {!conn.connected ? <span className="hb-lib__off">Not connected</span> : null}
                        <span className="hb-lib__sizes">{d.sizes.map((s) => SIZE_LABEL[s]).join(' · ')}</span>
                      </span>
                      <LCButton size="sm" variant="secondary" disabled={Boolean(blocked)} title={blocked ?? undefined} onClick={() => onAdd(d.id)}>Add</LCButton>
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        )) : <p className="hb-empty"><Icon name="search" size={13} />No widget matches “{q}”.</p>}
      </div>
    </aside>
  )
}
