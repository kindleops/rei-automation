import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import {
  QUEUE_DENSITY_LABEL,
  QUEUE_DENSITY_ORDER,
  type QueueDensity,
  type QueueSection,
} from '../queue-ui-helpers'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

type DatePreset = 'today' | '24h' | '7d' | '14d' | '30d' | '60d' | '90d' | 'all' | 'custom'
type QueueDateBasis = 'created_at' | 'scheduled_for' | 'updated_at'
type StatusBucket = 'all' | 'scheduled' | 'queued' | 'sending' | 'failed' | 'blocked' | 'approval' | 'delivered' | 'sent' | 'proof'

const DATE_PRESETS: DatePreset[] = ['today', '24h', '7d', '14d', '30d', '60d', '90d', 'all', 'custom']

const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  today: 'Today', '24h': '24h', '7d': '7d', '14d': '14d', '30d': '30d',
  '60d': '60d', '90d': '90d', all: 'All', custom: 'Custom',
}

const DATE_BASIS_LABELS: Record<QueueDateBasis, string> = {
  created_at: 'Created',
  scheduled_for: 'Scheduled',
  updated_at: 'Updated',
}

interface FilterTab {
  key: StatusBucket
  label: string
  count: number
  tone?: string
}

interface OccQueueFilterMenuProps {
  datePreset: DatePreset
  dateBasis: QueueDateBasis
  customFrom: string
  customTo: string
  statusFilter: StatusBucket
  marketFilter: string
  templateFilter: string
  senderFilter: string
  searchQuery: string
  density: QueueDensity
  section: QueueSection
  filterTabs: FilterTab[]
  marketOptions: string[]
  templateOptions: string[]
  senderOptions: string[]
  causeFilter: string | null
  causeLabel?: string
  onDatePreset: (preset: DatePreset) => void
  onDateBasis: (basis: QueueDateBasis) => void
  onCustomFrom: (v: string) => void
  onCustomTo: (v: string) => void
  onStatusFilter: (key: StatusBucket) => void
  onMarketFilter: (v: string) => void
  onTemplateFilter: (v: string) => void
  onSenderFilter: (v: string) => void
  onSearchQuery: (v: string) => void
  onDensity: (d: QueueDensity) => void
  onClearCause?: () => void
}

function activeFilterCount(props: OccQueueFilterMenuProps): number {
  let n = 0
  if (props.statusFilter !== 'all') n++
  if (props.marketFilter !== 'all') n++
  if (props.templateFilter !== 'all') n++
  if (props.senderFilter !== 'all') n++
  if (props.searchQuery.trim()) n++
  if (props.causeFilter) n++
  if (props.datePreset !== '7d') n++
  return n
}

export function OccQueueFilterMenu(props: OccQueueFilterMenuProps) {
  const [open, setOpen] = useState(false)
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({})
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const extras = activeFilterCount(props)

  const close = useCallback(() => setOpen(false), [])

  const updatePanelPosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const margin = 10
    const top = rect.bottom + 6
    const maxHeight = Math.max(180, Math.min(window.innerHeight - top - margin, 520))
    setPanelStyle({
      position: 'fixed',
      top,
      left: margin,
      right: margin,
      maxHeight,
      zIndex: 1200,
    })
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    updatePanelPosition()
    const onLayout = () => updatePanelPosition()
    window.addEventListener('resize', onLayout)
    window.addEventListener('scroll', onLayout, true)
    return () => {
      window.removeEventListener('resize', onLayout)
      window.removeEventListener('scroll', onLayout, true)
    }
  }, [open, updatePanelPosition])

  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  const statusLabel = props.filterTabs.find(t => t.key === props.statusFilter)?.label ?? 'All'
  const summary = [
    DATE_PRESET_LABELS[props.datePreset],
    statusLabel !== 'All' ? statusLabel : null,
    props.marketFilter !== 'all' ? props.marketFilter : null,
  ].filter(Boolean).join(' · ')

  const panel = open && typeof document !== 'undefined' ? createPortal(
    <>
      <button
        type="button"
        className="occ-liquid-filter__backdrop"
        aria-label="Close filters"
        onClick={close}
      />
      <div
        id={panelId}
        className="occ-liquid-filter__panel is-portaled"
        role="dialog"
        aria-label="Queue filters"
        aria-modal="true"
        style={panelStyle}
        onClick={e => e.stopPropagation()}
      >
        <div className="occ-liquid-filter__panel-head">
          <strong>Queue filters</strong>
          <button type="button" className="occ-liquid-filter__close" onClick={close} aria-label="Close filters">
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className="occ-liquid-filter__body">
          <section className="occ-liquid-filter__section">
            <h3>Time range</h3>
            <div className="occ-liquid-filter__pills">
              {DATE_PRESETS.map(p => (
                <button
                  key={p}
                  type="button"
                  className={cls('occ-mpill', 'occ-mpill--date', props.datePreset === p && 'is-active')}
                  onClick={() => props.onDatePreset(p)}
                >
                  {DATE_PRESET_LABELS[p]}
                </button>
              ))}
            </div>
            {props.datePreset === 'custom' && (
              <div className="occ-liquid-filter__custom-dates">
                <input
                  type="datetime-local"
                  className="occ-liquid-filter__date-input"
                  value={props.customFrom ? props.customFrom.slice(0, 16) : ''}
                  onChange={e => props.onCustomFrom(e.target.value ? new Date(e.target.value).toISOString() : '')}
                />
                <span>→</span>
                <input
                  type="datetime-local"
                  className="occ-liquid-filter__date-input"
                  value={props.customTo ? props.customTo.slice(0, 16) : ''}
                  onChange={e => props.onCustomTo(e.target.value ? new Date(e.target.value).toISOString() : '')}
                />
              </div>
            )}
            <label className="occ-liquid-filter__field">
              <span>Date basis</span>
              <select
                className="occ-liquid-filter__select"
                value={props.dateBasis}
                onChange={e => props.onDateBasis(e.target.value as QueueDateBasis)}
              >
                {(['created_at', 'scheduled_for', 'updated_at'] as QueueDateBasis[]).map(b => (
                  <option key={b} value={b}>{DATE_BASIS_LABELS[b]}</option>
                ))}
              </select>
            </label>
          </section>

          {props.section === 'queue' && (
            <>
              <section className="occ-liquid-filter__section">
                <h3>Pipeline status</h3>
                <div className="occ-liquid-filter__pills occ-liquid-filter__pills--wrap">
                  {props.filterTabs.map(t => (
                    <button
                      key={t.key}
                      type="button"
                      className={cls(
                        'occ-mpill',
                        'occ-mpill--status',
                        t.tone && t.count > 0 && `has-${t.tone}`,
                        props.statusFilter === t.key && 'is-active',
                      )}
                      onClick={() => props.onStatusFilter(t.key)}
                    >
                      <span>{t.label}</span>
                      {t.count > 0 && <span className="occ-mpill__count">{t.count > 999 ? '999+' : t.count}</span>}
                    </button>
                  ))}
                </div>
              </section>

              <section className="occ-liquid-filter__section">
                <h3>Scope</h3>
                <div className="occ-liquid-filter__fields">
                  <label className="occ-liquid-filter__field">
                    <span>Market</span>
                    <select className="occ-liquid-filter__select" value={props.marketFilter} onChange={e => props.onMarketFilter(e.target.value)}>
                      {props.marketOptions.map(o => (
                        <option key={o} value={o}>{o === 'all' ? 'All markets' : o}</option>
                      ))}
                    </select>
                  </label>
                  <label className="occ-liquid-filter__field">
                    <span>Template</span>
                    <select className="occ-liquid-filter__select" value={props.templateFilter} onChange={e => props.onTemplateFilter(e.target.value)}>
                      {props.templateOptions.map(o => (
                        <option key={o} value={o}>{o === 'all' ? 'All templates' : o}</option>
                      ))}
                    </select>
                  </label>
                  <label className="occ-liquid-filter__field">
                    <span>Sender</span>
                    <select className="occ-liquid-filter__select" value={props.senderFilter} onChange={e => props.onSenderFilter(e.target.value)}>
                      {props.senderOptions.map(o => (
                        <option key={o} value={o}>{o === 'all' ? 'All senders' : `···${o.slice(-4)}`}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </section>

              <section className="occ-liquid-filter__section">
                <h3>Search</h3>
                <input
                  type="search"
                  className="occ-liquid-filter__search"
                  placeholder="Seller, property, campaign…"
                  value={props.searchQuery}
                  onChange={e => props.onSearchQuery(e.target.value)}
                />
              </section>

              <section className="occ-liquid-filter__section">
                <h3>Row density</h3>
                <div className="occ-liquid-filter__density" role="group" aria-label="Row density">
                  {QUEUE_DENSITY_ORDER.map(d => (
                    <button
                      key={d}
                      type="button"
                      className={cls('occ-liquid-filter__density-btn', props.density === d && 'is-active')}
                      onClick={() => props.onDensity(d)}
                    >
                      {QUEUE_DENSITY_LABEL[d]}
                    </button>
                  ))}
                </div>
              </section>
            </>
          )}

          {props.causeFilter && (
            <div className="occ-liquid-filter__active">
              <span>Failure: {props.causeLabel ?? props.causeFilter}</span>
              <button type="button" onClick={props.onClearCause}>Clear</button>
            </div>
          )}
        </div>
      </div>
    </>,
    document.body,
  ) : null

  return (
    <div className={cls('occ-liquid-filter', open && 'is-open')}>
      <button
        ref={triggerRef}
        type="button"
        className="occ-liquid-filter__trigger"
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="dialog"
        onClick={() => {
          if (open) close()
          else {
            updatePanelPosition()
            setOpen(true)
          }
        }}
      >
        <span className="occ-liquid-filter__trigger-icon" aria-hidden="true">
          <Icon name="filter" size={14} />
        </span>
        <span className="occ-liquid-filter__trigger-copy">
          <span className="occ-liquid-filter__trigger-title">Filters</span>
          <span className="occ-liquid-filter__trigger-sub">{summary || 'All queue rows'}</span>
        </span>
        {extras > 0 && <span className="occ-liquid-filter__badge">{extras}</span>}
        <span className={cls('occ-liquid-filter__chev', open && 'is-open')} aria-hidden="true">
          <Icon name="chevron-down" size={14} />
        </span>
      </button>
      {panel}
    </div>
  )
}