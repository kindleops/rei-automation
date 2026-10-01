import { forwardRef, useMemo, useState, type InputHTMLAttributes, type ReactNode } from 'react'
import { Icon, type IconName } from '../icons'
import { LCButton, LCLink } from './Button'
import { cx } from './cx'
import './lc-controls.css'
import './lc-data.css'

/**
 * One filtering language for every app: the search field, compact
 * removable chips, an active-filter summary with a real preview count, and
 * a filter inspector with grouped sections. Components render the app's
 * filter state — they never decide what a filter means.
 */

/* ── SEARCH ─────────────────────────────────────────────────────────────── */

export interface LCSearchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'size' | 'onSubmit'> {
  value: string
  onChange: (value: string) => void
  /** accessible name — what is being searched */
  label: string
  loading?: boolean
  /** keyboard hint shown when empty, e.g. '/' */
  hint?: string
  icon?: IconName
  onSubmit?: (value: string) => void
}

export const LCSearch = forwardRef<HTMLInputElement, LCSearchProps>(function LCSearch(
  { value, onChange, label, loading, hint, icon = 'search', onSubmit, className, placeholder, ...rest },
  ref,
) {
  return (
    <label className={cx('lc-search', className)}>
      <span className="lc-search__glyph" aria-hidden="true">{loading ? <span className="lc-search__spin" /> : <Icon name={icon} size={14} />}</span>
      <input
        ref={ref}
        type="search"
        className="lc-search__input"
        aria-label={label}
        placeholder={placeholder ?? label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit?.(value)
          if (e.key === 'Escape' && value) { e.preventDefault(); e.stopPropagation(); onChange('') }
        }}
        spellCheck={false}
        autoComplete="off"
        {...rest}
      />
      {value ? (
        <button type="button" className="lc-combo__clear" aria-label="Clear search" onClick={() => onChange('')}><Icon name="x" size={12} /></button>
      ) : hint ? <kbd className="lc-kbd" aria-hidden="true">{hint}</kbd> : null}
    </label>
  )
})

/* ── CHIP ───────────────────────────────────────────────────────────────── */

export interface LCChipProps {
  /** the value as the operator reads it: "Miami, FL", "S2–S5", "≥ 60%" */
  value: ReactNode
  /** optional field name in front: "Equity" */
  field?: string
  onRemove?: () => void
  /** open the filter to edit it */
  onEdit?: () => void
  tone?: 'select' | 'neutral'
  title?: string
}

export function LCChip({ value, field, onRemove, onEdit, tone = 'select', title }: LCChipProps) {
  const text = (
    <>
      {field ? <span className="lc-chip__field">{field}</span> : null}
      <span className="lc-chip__value">{value}</span>
    </>
  )
  const plain = typeof value === 'string' ? `${field ? `${field}: ` : ''}${value}` : field || 'filter'
  return (
    <span className={cx('lc-chip', tone === 'neutral' && 'is-neutral')} title={title}>
      {onEdit ? <button type="button" className="lc-chip__edit" onClick={onEdit} aria-label={`Edit ${plain}`}>{text}</button> : text}
      {onRemove ? (
        <button type="button" className="lc-chip__x" onClick={onRemove} aria-label={`Remove ${plain}`}><Icon name="x" size={11} /></button>
      ) : null}
    </span>
  )
}

/* ── ACTIVE FILTER BAR ──────────────────────────────────────────────────── */

export interface LCActiveFilter {
  id: string
  field?: string
  value: ReactNode
  onRemove?: () => void
  onEdit?: () => void
}

export interface LCFilterBarProps {
  filters: ReadonlyArray<LCActiveFilter>
  onClearAll?: () => void
  /** opens the filter inspector */
  onOpen?: () => void
  /** real cohort count for the current filters; omit when unknown — never estimate */
  count?: number | null
  countNoun?: string
  /** count is being recomputed */
  counting?: boolean
  className?: string
  /** keep the bar even with no filters (shows the Filters trigger only) */
  persistent?: boolean
}

export function LCFilterBar({ filters, onClearAll, onOpen, count, countNoun = 'records', counting, className, persistent }: LCFilterBarProps) {
  if (!filters.length && !persistent) return null
  return (
    <div className={cx('lc-fbar', className)} role="group" aria-label="Active filters">
      {onOpen ? (
        <LCButton variant="quiet" size="sm" icon="filter" onClick={onOpen} aria-label={`Filters, ${filters.length} active`}>
          Filters{filters.length ? <span className="lc-fbar__n">{filters.length}</span> : null}
        </LCButton>
      ) : null}
      <div className="lc-fbar__chips">
        {filters.map((f) => <LCChip key={f.id} field={f.field} value={f.value} onRemove={f.onRemove} onEdit={f.onEdit} />)}
      </div>
      {typeof count === 'number' ? (
        <span className={cx('lc-fbar__count', counting && 'is-counting')} aria-live="polite">
          {count.toLocaleString('en-US')} {countNoun}
        </span>
      ) : null}
      {filters.length && onClearAll ? <LCLink onClick={onClearAll}>Clear all</LCLink> : null}
    </div>
  )
}

/* ── FILTER INSPECTOR ───────────────────────────────────────────────────── */

export interface LCFilterSection {
  id: string
  /** PROPERTY · GEOGRAPHY · FINANCIAL · STATUS · ACTIVITY … */
  label: string
  /** how many filters in this section are active */
  active?: number
  /** words a filter search should match (field names) */
  keywords?: string[]
  /** the app renders its own controls */
  render: () => ReactNode
}

export interface LCFilterInspectorProps {
  sections: ReadonlyArray<LCFilterSection>
  activeCount: number
  /** live cohort for the draft filters, when the app can count it */
  cohort?: number | null
  cohortNoun?: string
  counting?: boolean
  /** deferred apply (draft → applied); omit when filters apply immediately */
  onApply?: () => void
  applyDisabled?: boolean
  onClear?: () => void
  /** only when saved views are actually supported by the backend */
  onSaveView?: () => void
  onClose?: () => void
  className?: string
}

export function LCFilterInspector({ sections, activeCount, cohort, cohortNoun = 'records', counting, onApply, applyDisabled, onClear, onSaveView, onClose, className }: LCFilterInspectorProps) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(sections.map((s, i) => [s.id, i === 0 || Boolean(s.active)])))
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return sections
    return sections.filter((s) => [s.label, ...(s.keywords ?? [])].some((k) => k.toLowerCase().includes(needle)))
  }, [q, sections])
  return (
    <div className={cx('lc-finsp', className)}>
      <header className="lc-finsp__head">
        <span className="lc-eyebrow">Filters{activeCount ? ` · ${activeCount} active` : ''}</span>
        {onClose ? <button type="button" className="lc-combo__clear" aria-label="Close filters" onClick={onClose}><Icon name="x" size={12} /></button> : null}
      </header>
      <LCSearch value={q} onChange={setQ} label="Search filters" placeholder="Search filters…" className="lc-finsp__search" />
      <div className="lc-finsp__sections lc-scroll">
        {shown.map((s) => {
          const isOpen = q ? true : open[s.id]
          return (
            <section key={s.id} className={cx('lc-finsp__sec', isOpen && 'is-open')}>
              <button type="button" className="lc-finsp__sechead" aria-expanded={isOpen} onClick={() => setOpen((o) => ({ ...o, [s.id]: !o[s.id] }))}>
                <span>{s.label}</span>
                {s.active ? <span className="lc-tab__count">{s.active}</span> : null}
                <Icon name="chevron-down" size={12} className="lc-finsp__chev" />
              </button>
              {isOpen ? <div className="lc-finsp__body">{s.render()}</div> : null}
            </section>
          )
        })}
        {!shown.length ? <p className="lc-combo__state">No filter matches “{q}”</p> : null}
      </div>
      <footer className="lc-finsp__foot">
        <div className="lc-finsp__cohort">
          <span className="lc-eyebrow">Active cohort</span>
          <b className={cx('lc-t-metric-sm', counting && 'is-counting')}>{typeof cohort === 'number' ? `${cohort.toLocaleString('en-US')} ${cohortNoun}` : '—'}</b>
        </div>
        <div className="lc-finsp__actions">
          {onClear && activeCount ? <LCButton variant="quiet" size="sm" onClick={onClear}>Clear</LCButton> : null}
          {onSaveView ? <LCButton variant="secondary" size="sm" icon="bookmark" onClick={onSaveView}>Save view</LCButton> : null}
          {onApply ? <LCButton variant="primary" size="sm" onClick={onApply} disabled={applyDisabled}>Apply filters</LCButton> : null}
        </div>
      </footer>
    </div>
  )
}

/* ── DATA TOOLBAR ───────────────────────────────────────────────────────── */

export interface LCToolbarProps {
  /** search field, usually LCSearch */
  search?: ReactNode
  /** filters trigger / chips */
  filters?: ReactNode
  /** sort · group · view · density controls (LCSelect / LCSegmented) */
  controls?: ReactNode
  /** trailing actions */
  actions?: ReactNode
  /** chips row under the main row */
  below?: ReactNode
  sticky?: boolean
  className?: string
}

/** The premium data toolbar: search · filters · sort · group · view · density · actions. */
export function LCToolbar({ search, filters, controls, actions, below, sticky, className }: LCToolbarProps) {
  return (
    <div className={cx('lc-toolbar', sticky && 'lc-sticky', className)} role="toolbar" aria-orientation="horizontal">
      <div className="lc-toolbar__row">
        {search ? <div className="lc-toolbar__search">{search}</div> : null}
        {filters ? <div className="lc-toolbar__filters">{filters}</div> : null}
        <div className="lc-toolbar__spacer" />
        {controls ? <div className="lc-toolbar__controls">{controls}</div> : null}
        {actions ? <div className="lc-toolbar__actions">{actions}</div> : null}
      </div>
      {below ? <div className="lc-toolbar__below">{below}</div> : null}
    </div>
  )
}
