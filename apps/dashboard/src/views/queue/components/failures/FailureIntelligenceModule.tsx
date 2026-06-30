import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { QueueItem } from '../../../../domain/queue/queue.types'
import { MobileBottomSheet } from '../../../../modules/mobile/MobileBottomSheet'
import {
  buildFailureStats,
  deriveFailureCause,
  filterFailureStats,
  summarizeFailureTaxonomy,
  type FailureCategoryFilter,
  type FailureRetryFilter,
} from '../../failure-taxonomy-stats'
import { FAILURE_CATEGORY_TONE } from '../../failure-taxonomy-stats'
import { FailureDossierPanel } from './FailureDossierPanel'
import { FailureFleetCards } from './FailureFleetCards'
import { FailureIntelligenceHeader } from './FailureIntelligenceHeader'
import './failure-intelligence.css'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const truncate = (s: string | null | undefined, max: number) =>
  !s ? '—' : s.length > max ? s.slice(0, max) + '…' : s

interface FailureIntelligenceModuleProps {
  items: QueueItem[]
  selectedCause: string | null
  onSelectCause: (cause: string | null) => void
  onFilterCause: (cause: string) => void
  isMobileLayout?: boolean
  globalRangeLabel?: string
}

export function FailureIntelligenceModule({
  items,
  selectedCause,
  onSelectCause,
  onFilterCause,
  isMobileLayout = false,
  globalRangeLabel = 'selected range',
}: FailureIntelligenceModuleProps) {
  const [categoryFilter, setCategoryFilter] = useState<FailureCategoryFilter>('all')
  const [retryFilter, setRetryFilter] = useState<FailureRetryFilter>('all')

  const stats = useMemo(() => buildFailureStats(items), [items])
  const filtered = useMemo(
    () => filterFailureStats(stats, categoryFilter, retryFilter),
    [stats, categoryFilter, retryFilter],
  )
  const summary = useMemo(() => summarizeFailureTaxonomy(stats), [stats])
  const selected = stats.find((s) => s.cause === selectedCause) ?? null
  const previewRows = selected
    ? items.filter((i) => deriveFailureCause(i) === selected.cause).slice(0, 8)
    : []

  return (
    <div className={cls('occ-fail-intel', isMobileLayout && 'occ-fail-intel--mobile')}>
      <FailureIntelligenceHeader
        summary={summary}
        rangeLabel={globalRangeLabel}
        isMobileLayout={isMobileLayout}
        categoryFilter={categoryFilter}
        retryFilter={retryFilter}
        onCategoryFilter={setCategoryFilter}
        onRetryFilter={setRetryFilter}
      />

      {stats.length === 0 ? (
        <div className="occ-module-empty">No failures or blocks in the loaded page/range.</div>
      ) : isMobileLayout ? (
        <FailureFleetCards
          causes={filtered}
          selectedCause={selectedCause}
          onSelect={onSelectCause}
          onViewRows={onFilterCause}
        />
      ) : (
        <div className="occ-fail-intel__body">
          <div className="occ-fail-intel__grid">
            {filtered.length === 0 && (
              <div className="occ-module-empty">No failure families match this filter.</div>
            )}
            {filtered.map((s) => {
              const tone = FAILURE_CATEGORY_TONE[s.category] ?? 'amber'
              const selectedRow = selectedCause === s.cause
              return (
                <button
                  key={s.cause}
                  type="button"
                  className={cls(
                    'occ-fail-intel-card',
                    `is-${tone}`,
                    `is-sev-${s.severity}`,
                    selectedRow && 'is-selected',
                  )}
                  onClick={() => onSelectCause(selectedRow ? null : s.cause)}
                >
                  <div className="occ-fail-intel-card__head">
                    <span className={cls('occ-fail-intel-card__dot', `is-${tone}`)} />
                    <span className="occ-fail-intel-card__label">{s.label}</span>
                    <span className={cls('occ-fail-intel-card__count', `is-${tone}`)}>{s.count}</span>
                  </div>
                  <div className="occ-fail-intel-card__meta">
                    <span className="occ-tag">{s.category}</span>
                    <span className={cls('occ-tag', s.retryable ? 'is-green' : 'is-muted')}>
                      {s.retryable ? 'retryable' : 'non-retryable'}
                    </span>
                    {s.suppression && <span className="occ-tag is-red">suppress</span>}
                    <span className="occ-tag is-muted">{s.pctOfTotal}%</span>
                  </div>
                  <div className="occ-fail-intel-card__scope">
                    <span>{s.failedCount} failed</span>
                    <span>· {s.blockedCount} blocked</span>
                    <span>· {s.markets.length} markets</span>
                    <span>· {s.senders.length} senders</span>
                  </div>
                  {s.topMarket && (
                    <div className="occ-fail-intel-card__top-market">Top: {truncate(s.topMarket, 24)}</div>
                  )}
                  <p className="occ-fail-intel-card__action">{truncate(s.action, 120)}</p>
                  <span
                    role="button"
                    tabIndex={0}
                    className="occ-fail-intel-card__cta"
                    onClick={(e) => { e.stopPropagation(); onFilterCause(s.cause) }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onFilterCause(s.cause) } }}
                  >
                    View rows →
                  </span>
                </button>
              )
            })}
          </div>

          {selected && (
            <FailureDossierPanel
              stat={selected}
              previewRows={previewRows}
              onViewRows={onFilterCause}
            />
          )}
        </div>
      )}

      {stats.length > 0 && (
        <div className="occ-module-foot">
          {summary.total} failed/blocked rows · {summary.causeCount} families · {globalRangeLabel}
        </div>
      )}

      {isMobileLayout && selected && typeof document !== 'undefined' && createPortal(
        <MobileBottomSheet open snap="expanded" onClose={() => onSelectCause(null)} className="occ-fail-mobile-sheet">
          <FailureDossierPanel
            stat={selected}
            previewRows={previewRows}
            onViewRows={(cause) => { onFilterCause(cause); onSelectCause(null) }}
            onClose={() => onSelectCause(null)}
            compact
          />
        </MobileBottomSheet>,
        document.body,
      )}
    </div>
  )
}