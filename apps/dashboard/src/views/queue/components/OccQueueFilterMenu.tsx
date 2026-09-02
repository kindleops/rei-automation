import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import { MobileBottomSheet } from '../../../modules/mobile/MobileBottomSheet'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

type DatePreset = 'today' | '24h' | '7d' | '14d' | '30d' | '60d' | '90d' | 'all' | 'custom'
type QueueDateBasis = 'created_at' | 'scheduled_for' | 'updated_at'
type StatusBucket = 'all' | 'scheduled' | 'queued' | 'sending' | 'failed' | 'blocked' | 'approval' | 'delivered' | 'sent' | 'proof'

/** Presets that fit a single scroll rail — the long tail lives under Advanced. */
const PRIMARY_PRESETS: DatePreset[] = ['today', '24h', '7d', '14d', '30d', '90d']
const ADVANCED_PRESETS: DatePreset[] = ['60d', 'all', 'custom']

const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  today: 'Today', '24h': '24h', '7d': '7d', '14d': '14d', '30d': '30d',
  '60d': '60d', '90d': '90d', all: 'All time', custom: 'Custom',
}

const DATE_BASIS_LABELS: Record<QueueDateBasis, string> = {
  created_at: 'Created',
  scheduled_for: 'Scheduled',
  updated_at: 'Updated',
}

/** Attention-first ordering: what an operator filters for on a phone. */
const PRIMARY_STATUS: StatusBucket[] = ['all', 'failed', 'blocked', 'approval', 'queued', 'scheduled', 'sending']

interface FilterTab {
  key: StatusBucket
  label: string
  count: number
  tone?: string
}

interface OccQueueFilterMenuProps {
  open: boolean
  datePreset: DatePreset
  dateBasis: QueueDateBasis
  customFrom: string
  customTo: string
  statusFilter: StatusBucket
  marketFilter: string
  templateFilter: string
  senderFilter: string
  searchQuery: string
  filterTabs: FilterTab[]
  marketOptions: string[]
  templateOptions: string[]
  senderOptions: string[]
  causeFilter: string | null
  causeLabel?: string
  onClose: () => void
  onDatePreset: (preset: DatePreset) => void
  onDateBasis: (basis: QueueDateBasis) => void
  onCustomFrom: (v: string) => void
  onCustomTo: (v: string) => void
  onStatusFilter: (key: StatusBucket) => void
  onMarketFilter: (v: string) => void
  onTemplateFilter: (v: string) => void
  onSenderFilter: (v: string) => void
  onSearchQuery: (v: string) => void
  onClearCause?: () => void
}

/**
 * Mobile queue filters, tiered: Range / Status / Search stay open; Market,
 * Template and Sender sit under Scope; date basis and rarely-used presets sit
 * under Advanced. Row density is intentionally absent — there is one designed
 * mobile density.
 */
export function OccQueueFilterMenu(props: OccQueueFilterMenuProps) {
  const [scopeOpen, setScopeOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const { open, onClose } = props

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const scopeActive = [props.marketFilter, props.templateFilter, props.senderFilter]
    .filter(v => v !== 'all').length

  if (!props.open || typeof document === 'undefined') return null

  const statusTabs = PRIMARY_STATUS
    .map(key => props.filterTabs.find(t => t.key === key))
    .filter(Boolean) as FilterTab[]
  const overflowTabs = props.filterTabs.filter(t => !PRIMARY_STATUS.includes(t.key))

  return createPortal(
    <MobileBottomSheet open snap="expanded" onClose={props.onClose} className="qm-filter-sheet">
      <header className="qm-filter__head">
        <strong>Filters</strong>
        <button type="button" className="qms-chrome__btn is-close" onClick={props.onClose} aria-label="Close filters">
          <Icon name="close" size={14} />
        </button>
      </header>

      <div className="qm-filter__body">
        <section className="qm-filter__section">
          <h3>Range</h3>
          <div className="qm-filter__rail">
            {PRIMARY_PRESETS.map(p => (
              <button
                key={p}
                type="button"
                className={cls('qm-chip', props.datePreset === p && 'is-active')}
                onClick={() => props.onDatePreset(p)}
              >
                {DATE_PRESET_LABELS[p]}
              </button>
            ))}
          </div>
        </section>

        <section className="qm-filter__section">
          <h3>Status</h3>
          <div className="qm-filter__grid">
            {statusTabs.map(t => (
              <button
                key={t.key}
                type="button"
                className={cls('qm-filter__status', t.tone && t.count > 0 && `has-${t.tone}`, props.statusFilter === t.key && 'is-active')}
                onClick={() => props.onStatusFilter(t.key)}
              >
                <span>{t.label}</span>
                {t.count > 0 && <em>{t.count > 999 ? '999+' : t.count}</em>}
              </button>
            ))}
          </div>
        </section>

        <section className="qm-filter__section">
          <h3>Search</h3>
          <input
            type="search"
            className="qm-filter__search"
            placeholder="Seller, property, campaign…"
            value={props.searchQuery}
            onChange={e => props.onSearchQuery(e.target.value)}
          />
        </section>

        {props.causeFilter && (
          <div className="qm-filter__active">
            <span>Failure: {props.causeLabel ?? props.causeFilter}</span>
            <button type="button" onClick={props.onClearCause}>Clear</button>
          </div>
        )}

        <section className="qm-tpl-collapse">
          <button
            type="button"
            className="qm-tpl-collapse__toggle"
            aria-expanded={scopeOpen}
            onClick={() => setScopeOpen(v => !v)}
          >
            <span>Scope{scopeActive > 0 ? ` · ${scopeActive} active` : ''}</span>
            <Icon name={scopeOpen ? 'chevron-up' : 'chevron-down'} size={13} />
          </button>
          {scopeOpen && (
            <div className="qm-tpl-collapse__body">
              <label className="qm-filter__field">
                <span>Market</span>
                <select className="qm-filter__select" value={props.marketFilter} onChange={e => props.onMarketFilter(e.target.value)}>
                  {props.marketOptions.map(o => <option key={o} value={o}>{o === 'all' ? 'All markets' : o}</option>)}
                </select>
              </label>
              <label className="qm-filter__field">
                <span>Template</span>
                <select className="qm-filter__select" value={props.templateFilter} onChange={e => props.onTemplateFilter(e.target.value)}>
                  {props.templateOptions.map(o => <option key={o} value={o}>{o === 'all' ? 'All templates' : o}</option>)}
                </select>
              </label>
              <label className="qm-filter__field">
                <span>Sender</span>
                <select className="qm-filter__select" value={props.senderFilter} onChange={e => props.onSenderFilter(e.target.value)}>
                  {props.senderOptions.map(o => <option key={o} value={o}>{o === 'all' ? 'All senders' : `···${o.slice(-4)}`}</option>)}
                </select>
              </label>
            </div>
          )}
        </section>

        <section className="qm-tpl-collapse">
          <button
            type="button"
            className="qm-tpl-collapse__toggle"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen(v => !v)}
          >
            <span>Advanced</span>
            <Icon name={advancedOpen ? 'chevron-up' : 'chevron-down'} size={13} />
          </button>
          {advancedOpen && (
            <div className="qm-tpl-collapse__body">
              <label className="qm-filter__field">
                <span>Date basis</span>
                <select
                  className="qm-filter__select"
                  value={props.dateBasis}
                  onChange={e => props.onDateBasis(e.target.value as QueueDateBasis)}
                >
                  {(['created_at', 'scheduled_for', 'updated_at'] as QueueDateBasis[]).map(b => (
                    <option key={b} value={b}>{DATE_BASIS_LABELS[b]}</option>
                  ))}
                </select>
              </label>

              <div className="qm-filter__rail">
                {ADVANCED_PRESETS.map(p => (
                  <button
                    key={p}
                    type="button"
                    className={cls('qm-chip', props.datePreset === p && 'is-active')}
                    onClick={() => props.onDatePreset(p)}
                  >
                    {DATE_PRESET_LABELS[p]}
                  </button>
                ))}
              </div>

              {props.datePreset === 'custom' && (
                <div className="qm-filter__dates">
                  <input
                    type="datetime-local"
                    className="qm-filter__select"
                    value={props.customFrom ? props.customFrom.slice(0, 16) : ''}
                    onChange={e => props.onCustomFrom(e.target.value ? new Date(e.target.value).toISOString() : '')}
                  />
                  <span>→</span>
                  <input
                    type="datetime-local"
                    className="qm-filter__select"
                    value={props.customTo ? props.customTo.slice(0, 16) : ''}
                    onChange={e => props.onCustomTo(e.target.value ? new Date(e.target.value).toISOString() : '')}
                  />
                </div>
              )}

              {overflowTabs.length > 0 && (
                <div className="qm-filter__rail">
                  {overflowTabs.map(t => (
                    <button
                      key={t.key}
                      type="button"
                      className={cls('qm-chip', props.statusFilter === t.key && 'is-active')}
                      onClick={() => props.onStatusFilter(t.key)}
                    >
                      {t.label}{t.count > 0 ? ` ${t.count}` : ''}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      <footer className="qm-filter__foot">
        <button type="button" className="qms-action is-primary" onClick={props.onClose}>Done</button>
      </footer>
    </MobileBottomSheet>,
    document.body,
  )
}
