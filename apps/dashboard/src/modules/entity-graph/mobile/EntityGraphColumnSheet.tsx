import { useMemo, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { MobileSheet } from '../../mobile/MobileSheet'
import {
  COLUMN_GROUP_LABELS,
  COLUMN_GROUP_ORDER,
  SCOPE_TABLE_COLUMNS,
  defaultVisibleColumns,
  type ColumnGroup,
} from './entity-graph-table-columns'
import type { EntityScope } from './entity-graph-mobile-format'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

/**
 * Column picker.
 *
 * Two panes in one sheet, because they answer different questions: the top is
 * "what order are my columns in" (only the selected ones, reorderable), the
 * bottom is "what else exists" (the full catalog, grouped). Merging them into
 * one long list makes reordering unusable once a scope has 80 fields.
 *
 * The identity column is not in either list — it is pinned and cannot be
 * hidden, because a table row without an identity is unusable.
 */
type Props = {
  open: boolean
  scope: EntityScope
  visible: string[]
  onClose: () => void
  onChange: (next: string[]) => void
}

export function EntityGraphColumnSheet({ open, scope, visible, onClose, onChange }: Props) {
  const [query, setQuery] = useState('')
  const catalog = SCOPE_TABLE_COLUMNS[scope]
  const byKey = useMemo(() => new Map(catalog.map((c) => [c.key, c])), [catalog])

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase()
    const groups = new Map<ColumnGroup, typeof catalog>()
    for (const column of catalog) {
      if (q && !column.label.toLowerCase().includes(q) && !column.key.toLowerCase().includes(q)) continue
      if (!groups.has(column.group)) groups.set(column.group, [])
      groups.get(column.group)!.push(column)
    }
    return COLUMN_GROUP_ORDER
      .filter((g) => groups.has(g))
      .map((g) => ({ group: g, columns: groups.get(g)! }))
  }, [catalog, query])

  const move = (key: string, direction: -1 | 1) => {
    const index = visible.indexOf(key)
    const target = index + direction
    if (index < 0 || target < 0 || target >= visible.length) return
    const next = [...visible]
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }

  const toggle = (key: string) => {
    onChange(visible.includes(key) ? visible.filter((k) => k !== key) : [...visible, key])
  }

  return (
    <MobileSheet
      open={open}
      title="Columns"
      subtitle={`${visible.length} shown of ${catalog.length} available`}
      height="full"
      className="egm-sheet"
      onClose={onClose}
    >
      <div className="egcol">
        <section className="egcol-block">
          <h4>Shown · in order</h4>
          <div className="egcol-pinned">
            <Icon name="key" />
            <span>{scope === 'properties' ? 'Address' : scope === 'contact_methods' ? 'Contact' : 'Name'}</span>
            <em>pinned</em>
          </div>
          {visible.length === 0 ? (
            <p className="egcol-hint">No extra columns — the table shows the identity column only.</p>
          ) : (
            visible.map((key, index) => {
              const column = byKey.get(key)
              if (!column) return null
              return (
                <div key={key} className="egcol-row is-on">
                  <button
                    type="button"
                    className="egcol-row__toggle"
                    onClick={() => toggle(key)}
                    aria-label={`Hide ${column.label}`}
                  >
                    <span className="egcol-check is-on"><Icon name="check" /></span>
                    <span className="egcol-row__label">{column.label}</span>
                    <span className="egcol-row__group">{COLUMN_GROUP_LABELS[column.group]}</span>
                  </button>
                  <div className="egcol-row__move">
                    <button type="button" disabled={index === 0} onClick={() => move(key, -1)} aria-label="Move left">
                      <Icon name="chevron-up" />
                    </button>
                    <button
                      type="button"
                      disabled={index === visible.length - 1}
                      onClick={() => move(key, 1)}
                      aria-label="Move right"
                    >
                      <Icon name="chevron-down" />
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </section>

        <section className="egcol-block">
          <h4>Field catalog</h4>
          <div className="egm-search egcol-search">
            <span className="egm-search__icon"><Icon name="search" /></span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search fields…"
              aria-label="Search columns"
              type="search"
            />
            {query ? (
              <button type="button" className="egm-search__clear" onClick={() => setQuery('')} aria-label="Clear">×</button>
            ) : null}
          </div>

          {grouped.length === 0 ? (
            <p className="egcol-hint">No fields match “{query}”.</p>
          ) : (
            grouped.map(({ group, columns }) => (
              <div key={group} className="egcol-group">
                <h5>{COLUMN_GROUP_LABELS[group]}<em>{columns.length}</em></h5>
                {columns.map((column) => {
                  const on = visible.includes(column.key)
                  return (
                    <button
                      key={column.key}
                      type="button"
                      className={cls('egcol-row__toggle', 'is-catalog', on && 'is-on')}
                      onClick={() => toggle(column.key)}
                    >
                      <span className={cls('egcol-check', on && 'is-on')}><Icon name="check" /></span>
                      <span className="egcol-row__label">{column.label}</span>
                      {column.sortBy ? <span className="egcol-row__sortable">sortable</span> : null}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </section>

        <div className="egm-filters__footer">
          <button
            type="button"
            className="egm-btn is-ghost"
            onClick={() => onChange(defaultVisibleColumns(scope))}
          >
            Reset
          </button>
          <button type="button" className="egm-btn is-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </MobileSheet>
  )
}
