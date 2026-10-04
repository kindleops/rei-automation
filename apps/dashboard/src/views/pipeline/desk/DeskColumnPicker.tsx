/**
 * PIPELINE TABLE · COLUMN PICKER — searchable, grouped by domain; show / hide
 * and reorder. Widths are the grid's own (drag a header edge; double-click
 * resets). Every column names its source, so the operator knows what a cell
 * reads before turning it on.
 */
import { useMemo, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { LCButton, LCIconButton, LCPopover, LCSearch, cx } from '../../../shared/lc'
import { COLUMN_BY_ID, COLUMN_GROUPS, DESK_COLUMNS, matchesColumn, moveColumn, toggleColumn, type ColumnLayout } from './pipeline-columns'

export function DeskColumnPicker({ layout, onChange, onReset, partial }: {
  layout: ColumnLayout
  onChange: (next: ColumnLayout) => void
  onReset: () => void
  /** not every deal is loaded — sorting covers the loaded ones */
  partial: boolean
}) {
  const [q, setQ] = useState('')
  const shown = new Set(layout.visible)
  const groups = useMemo(() => COLUMN_GROUPS.map((g) => ({ ...g, cols: DESK_COLUMNS.filter((c) => c.group === g.id && matchesColumn(c, q)) })).filter((g) => g.cols.length), [q])
  const extra = layout.visible.length - 1
  return (
    <LCPopover
      trigger={<LCButton variant="quiet" size="sm" icon="grid">Columns{extra > 0 ? ` · ${extra}` : ''}</LCButton>}
      align="end"
      width={380}
      label="Table columns"
    >
      <div className="pd2-cols">
        <LCSearch value={q} onChange={setQ} label="Search columns" placeholder={`Search ${DESK_COLUMNS.length} columns`} className="pd2-cols__search" />
        {!q ? (
          <section className="pd2-cols__shown" aria-label="Shown columns, in order">
            <header><span className="lc-eyebrow">Shown · in order</span><LCButton variant="ghost" size="sm" onClick={onReset}>Reset</LCButton></header>
            <ol>
              {layout.visible.map((id, i) => {
                const c = COLUMN_BY_ID.get(id)
                if (!c) return null
                return (
                  <li key={id} className={cx(c.locked && 'is-locked')}>
                    <span className="pd2-cols__name">{c.header}<small>{COLUMN_GROUPS.find((g) => g.id === c.group)?.label}</small></span>
                    {c.locked ? <small className="pd2-cols__lock">Always shown</small> : (
                      <span className="pd2-cols__ops">
                        <LCIconButton icon="chevron-up" label={`Move ${c.header} left`} size="sm" disabled={i <= 1} onClick={() => onChange(moveColumn(layout, id, -1))} />
                        <LCIconButton icon="chevron-down" label={`Move ${c.header} right`} size="sm" disabled={i >= layout.visible.length - 1} onClick={() => onChange(moveColumn(layout, id, 1))} />
                        <LCIconButton icon="close" label={`Hide ${c.header}`} size="sm" onClick={() => onChange(toggleColumn(layout, id))} />
                      </span>
                    )}
                  </li>
                )
              })}
            </ol>
          </section>
        ) : null}
        <div className="pd2-cols__all" role="group" aria-label="All columns">
          {groups.map((g) => (
            <section key={g.id}>
              <span className="lc-eyebrow">{g.label} · {g.cols.length}</span>
              <ul>
                {g.cols.map((c) => {
                  const on = shown.has(c.id)
                  return (
                    <li key={c.id}>
                      <button type="button" className={cx('pd2-cols__toggle', on && 'is-on')} aria-pressed={on} disabled={c.locked} onClick={() => onChange(toggleColumn(layout, c.id))} title={c.hint}>
                        <span className={cx('lc-check', on && 'is-on')} aria-hidden="true" />
                        <span className="pd2-cols__name">{c.header}<small>{c.source}{c.needs ? ' · loaded while shown' : ''}</small></span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
          {!groups.length ? <p className="pd2-cols__none">No column matches “{q}”.</p> : null}
        </div>
        <p className="pd2-cols__foot"><Icon name="list" size={12} />Sort by any sortable header{partial ? ' — sorting covers the deals loaded in this table' : ''}. Drag a header edge to resize.</p>
      </div>
    </LCPopover>
  )
}
