import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../../shared/icons'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export interface PipelineScopeOption {
  id: string
  label: string
}

/**
 * One command bar, replacing the previous header + toolbar stack.
 *
 * What it drops, and why:
 *  - the four coloured KPI tiles (~100px each, four different accents) become a
 *    single inline strip; only "needs attention" counts carry semantic colour,
 *    because those are the only ones that mean act now
 *  - "N deals matching filters" is gone; it restated the count already in the
 *    header
 *  - the FILTERS accordion whose entire contents was the word "Stage" is now a
 *    real sheet, opened from a compact trigger that shows its own state
 *
 * The two signal chips are operating shortcuts, not KPI decoration: they toggle
 * the same `needsResponse` / `followUpDue` filters the sheet owns, so the chip
 * state, the sheet state and the counts are one thing rather than three.
 */
export function PipelineMobileCommandBar({
  total,
  globalTotal,
  needsReply,
  followUpsDue,
  needsReplyOn,
  followUpOn,
  onNeedsReply,
  onFollowUp,
  scope,
  scopes,
  onScopeChange,
  query,
  onQueryChange,
  onOpenFilters,
  filterCount,
  sortLabel,
  refreshing,
}: {
  total: number
  globalTotal: number
  needsReply: number
  followUpsDue: number
  needsReplyOn: boolean
  followUpOn: boolean
  onNeedsReply: () => void
  onFollowUp: () => void
  scope: string
  scopes: PipelineScopeOption[]
  onScopeChange: (id: string) => void
  query: string
  onQueryChange: (q: string) => void
  onOpenFilters: () => void
  filterCount: number
  sortLabel: string
  refreshing?: boolean
}) {
  const [searchOpen, setSearchOpen] = useState(false)
  // "258 of 751" was ambiguous; name the scope the number belongs to.
  const scopeLabel = scopes.find((s) => s.id === scope)?.label ?? 'in view'

  // The scope rail scrolls rather than wrapping, so the selected scope has to be
  // brought into view or "Closed" is unreachable-looking at 375px.
  const railRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = railRef.current?.querySelector<HTMLElement>('.plm-scope.is-active')
    el?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [scope])

  return (
    <header className={cls('plm-bar', refreshing && 'is-refreshing')}>
      <div className="plm-bar__top">
        <h1 className="plm-bar__title">Pipeline</h1>
        <span className="plm-bar__total">
          <strong>{total.toLocaleString()}</strong>
          <em>{scopeLabel.toLowerCase()} · {globalTotal.toLocaleString()} total</em>
        </span>
        <button
          type="button"
          className={cls('plm-icon-btn', searchOpen && 'is-on')}
          aria-label="Search pipeline"
          aria-expanded={searchOpen}
          onClick={() => setSearchOpen((v) => !v)}
        >
          <Icon name="search" />
        </button>
      </div>

      {(needsReply > 0 || followUpsDue > 0 || needsReplyOn || followUpOn) ? (
        <div className="plm-bar__signals">
          {needsReply > 0 || needsReplyOn ? (
            <button
              type="button"
              className={cls('plm-signal is-urgent', needsReplyOn && 'is-on')}
              aria-pressed={needsReplyOn}
              onClick={onNeedsReply}
            >
              <strong>{needsReply}</strong> need a reply
              {needsReplyOn ? <Icon name="x" /> : null}
            </button>
          ) : null}
          {followUpsDue > 0 || followUpOn ? (
            <button
              type="button"
              className={cls('plm-signal is-due', followUpOn && 'is-on')}
              aria-pressed={followUpOn}
              onClick={onFollowUp}
            >
              <strong>{followUpsDue}</strong> follow-up{followUpsDue === 1 ? '' : 's'} due
              {followUpOn ? <Icon name="x" /> : null}
            </button>
          ) : null}
        </div>
      ) : null}

      {searchOpen ? (
        <input
          className="plm-search"
          type="search"
          autoFocus
          value={query}
          placeholder="Seller, address, intent…"
          onChange={(e) => onQueryChange(e.target.value)}
        />
      ) : null}

      <div className="plm-bar__scopes">
        <div className="plm-scoperail" ref={railRef} role="tablist" aria-label="Pipeline scope">
          {scopes.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={s.id === scope}
              className={cls('plm-scope', s.id === scope && 'is-active')}
              onClick={() => onScopeChange(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        {/* Sort state rides with the filter control rather than occupying its
            own band — it is a property of the list, not a section of the bar. */}
        <button
          type="button"
          className={cls('plm-filterbtn', filterCount > 0 && 'is-active')}
          onClick={onOpenFilters}
          aria-label={filterCount > 0 ? `Filters, ${filterCount} active` : 'Filters'}
        >
          <Icon name="filter" />
          {/* One word, so the control stays a control and does not crowd the
              scope rail. The full phrasing lives in the sheet. */}
          <span className="plm-filterbtn__sort">{sortLabel.split(' ')[0]}</span>
          {filterCount > 0 ? <span className="plm-filterbtn__badge">{filterCount}</span> : null}
        </button>
      </div>
    </header>
  )
}
