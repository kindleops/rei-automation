import { useEffect, useRef } from 'react'
import { Icon } from '../../../shared/icons'
import { NAV_GROUPS, type NavFilters, type NavGroup, type NavRow } from './cockpit-model'
import { Bar, StateChip, cls } from './cockpit-ui'

export type NavSection = { key: NavGroup; label: string; rows: NavRow[] }

const SOURCE_OPTIONS: Array<{ key: string; label: string }> = [
  { key: 'all', label: 'All sources' },
  { key: 'map_area', label: 'Map area' },
  { key: 'entity_graph', label: 'Entity Graph' },
  { key: 'filters', label: 'Filters' },
  { key: 'selection', label: 'Selected properties' },
  { key: 'none', label: 'No audience' },
]

/**
 * LEFT — campaign navigation. Dense rows grouped by what the campaign needs
 * from a person; drafts read as inactive. Filters are compact selects; the
 * search box lives in the header.
 */
export function CockpitNav({
  sections,
  total,
  filters,
  onFilters,
  markets,
  marketsLoading,
  activeId,
  cursorId,
  onSelect,
  loading,
  failed,
  onRetry,
}: {
  sections: NavSection[]
  total: number
  filters: NavFilters
  onFilters: (next: NavFilters) => void
  markets: string[]
  marketsLoading: boolean
  activeId: string | null
  cursorId: string | null
  onSelect: (id: string) => void
  loading: boolean
  failed: boolean
  onRetry: () => void
}) {
  const listRef = useRef<HTMLDivElement>(null)

  // Keep the keyboard cursor in view as it moves.
  useEffect(() => {
    if (!cursorId || !listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-cpk-row="${CSS.escape(cursorId)}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [cursorId])

  const shown = sections.reduce((n, s) => n + s.rows.length, 0)
  const filtered = filters.status !== 'all' || filters.channel !== 'all' || filters.market !== 'all' || filters.source !== 'all' || filters.query.trim() !== ''

  return (
    <nav className="cpk-nav" aria-label="Campaigns">
      <div className="cpk-nav__filters">
        <label className="cpk-select">
          <span className="cpk-sr">Status</span>
          <select value={filters.status} onChange={(e) => onFilters({ ...filters, status: e.target.value as NavFilters['status'] })}>
            <option value="all">All states</option>
            {NAV_GROUPS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
          </select>
        </label>
        <label className="cpk-select">
          <span className="cpk-sr">Channel</span>
          <select value={filters.channel} onChange={(e) => onFilters({ ...filters, channel: e.target.value as NavFilters['channel'] })}>
            <option value="all">All channels</option>
            <option value="sms">SMS</option>
          </select>
        </label>
        <label className="cpk-select">
          <span className="cpk-sr">Market</span>
          <select value={filters.market} onChange={(e) => onFilters({ ...filters, market: e.target.value })} disabled={marketsLoading && !markets.length}>
            <option value="all">{marketsLoading && !markets.length ? 'Markets…' : 'All markets'}</option>
            {markets.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="cpk-select">
          <span className="cpk-sr">Source</span>
          <select value={filters.source} onChange={(e) => onFilters({ ...filters, source: e.target.value })}>
            {SOURCE_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </label>
      </div>

      <div className="cpk-nav__list" ref={listRef} role="listbox" aria-label="Campaigns" aria-activedescendant={cursorId ? `cpk-row-${cursorId}` : undefined}>
        {loading && !total ? (
          <div className="cpk-nav__skel" aria-hidden="true">
            {Array.from({ length: 6 }, (_, i) => <div key={i} className="cpk-row is-skel"><i /><i /><i /></div>)}
          </div>
        ) : failed && !total ? (
          <div className="cpk-nav__empty">
            <p>Campaigns couldn’t be loaded.</p>
            <button type="button" className="cpk-btn is-ghost" onClick={onRetry}>Try again</button>
          </div>
        ) : !shown ? (
          <div className="cpk-nav__empty">
            <p>{filtered ? 'No campaign matches these filters.' : 'No campaigns yet.'}</p>
            {filtered ? (
              <button type="button" className="cpk-btn is-ghost" onClick={() => onFilters({ status: 'all', channel: 'all', market: 'all', source: 'all', query: '' })}>Clear filters</button>
            ) : null}
          </div>
        ) : (
          sections.filter((s) => s.rows.length).map((section) => (
            <div key={section.key} className={cls('cpk-group', `is-${section.key}`)} role="group" aria-label={section.label}>
              <div className="cpk-group__head">
                <span>{section.label}</span>
                <b>{section.rows.length}</b>
              </div>
              {section.rows.map((row) => (
                <button
                  key={row.id}
                  id={`cpk-row-${row.id}`}
                  type="button"
                  role="option"
                  aria-selected={row.id === activeId}
                  data-cpk-row={row.id}
                  className={cls('cpk-row', row.id === activeId && 'is-active', row.id === cursorId && row.id !== activeId && 'is-cursor', row.inactive && 'is-inactive', `is-${row.state.tone}`)}
                  onClick={() => onSelect(row.id)}
                >
                  <span className="cpk-row__name" title={row.title}>{row.title}</span>
                  <span className="cpk-row__meta">
                    <StateChip state={row.state} size="sm" />
                    <span>{row.channel}</span>
                    <span>{row.source.label}{row.source.detail ? ` · ${row.source.detail}` : ''}</span>
                  </span>
                  {row.progress ? (
                    <span className="cpk-row__progress">
                      <Bar pct={row.progress.pct} tone={row.inactive || row.state.key === 'paused' ? 'muted' : 'exec'} />
                      <span className="cpk-row__count"><b>{row.progress.sent.toLocaleString()}</b> / {row.progress.of.toLocaleString()} sent</span>
                    </span>
                  ) : null}
                  {(row.result || row.exception) ? (
                    <span className="cpk-row__foot">
                      {row.result ? <span className="cpk-row__result">{row.result}</span> : null}
                      {row.exception ? <span className={cls('cpk-row__exception', (row.state.key === 'degraded' || row.state.key === 'needs_you') && `is-${row.state.tone}`)}>{row.exception}</span> : null}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          ))
        )}
      </div>
      <div className="cpk-nav__foot">
        <Icon name="command" size={12} />
        <span>↑ ↓ to move · Enter to open</span>
      </div>
    </nav>
  )
}
