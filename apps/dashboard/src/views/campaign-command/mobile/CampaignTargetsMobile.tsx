import { useEffect, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { fetchCampaignTargetsPageData } from '../campaigns.adapter'
import type { CampaignTarget } from '../campaigns.types'

/**
 * Campaign Detail — Targets, mobile.
 *
 * Presentation only: same fetch, same status filter, same search, same page
 * size and pagination as before. This removes `.ccc-mobile-target-card` and the
 * toolbar's own chrome so Targets renders from the shared Detail bands.
 *
 * The row is the drilldown entry point — it stays a button so a future target
 * detail / Street View view has somewhere to attach without another redesign.
 */

const STATUS_OPTIONS = [
  'all', 'ready', 'planned', 'queued', 'scheduled',
  'sent', 'delivered', 'failed', 'blocked', 'opted_out',
] as const

/** READY is the state the operator scans for; failures are the other signal. */
function toneOf(status: string): 'live' | 'hold' | 'bad' | '' {
  const s = status.toLowerCase()
  if (s === 'ready') return 'live'
  if (s === 'delivered' || s === 'sent') return 'live'
  if (s === 'failed' || s === 'opted_out') return 'bad'
  if (s === 'blocked') return 'hold'
  return ''
}

export function CampaignTargetsMobile({
  campaignId,
  onOpenTarget,
}: {
  campaignId: string
  /** Reserved for the target drilldown / Street View entry point. */
  onOpenTarget?: (target: CampaignTarget) => void
}) {
  const [targets, setTargets] = useState<CampaignTarget[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize] = useState(50)
  const [totalCount, setTotalCount] = useState(0)
  const [totalPages, setTotalPages] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    fetchCampaignTargetsPageData(campaignId, {
      page,
      page_size: pageSize,
      status: filter === 'all' ? undefined : filter,
      search: search.trim() || undefined,
    })
      .then((data) => {
        if (!active) return
        setTargets(data.targets)
        setTotalCount(data.total_count)
        setTotalPages(data.total_pages)
      })
      .catch(() => {
        if (!active) return
        setTargets([])
        setTotalCount(0)
        setTotalPages(0)
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [campaignId, filter, page, pageSize, search])

  return (
    <div className="cdb">
      <div className="cdb__controls">
        <label className="cdb__search">
          <Icon name="search" size={14} />
          <input
            type="search"
            placeholder="Search owner, property, phone"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
            aria-label="Search targets"
          />
        </label>
        <div className="cdb__chips is-scroll" role="group" aria-label="Filter by status">
          {STATUS_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className={`cdb__chip${filter === s ? ' is-on' : ''}`}
              onClick={() => { setFilter(s); setPage(1) }}
            >
              {s === 'all' ? 'All' : s.replace(/_/g, ' ')}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="cdb__empty">Loading targets…</div>
      ) : targets.length === 0 ? (
        <div className="cdb__empty">No targets match this filter.</div>
      ) : (
        <>
          <section className="cdb__band is-last">
            <div className="cdb__key">
              TARGETS
              <span className="cdb__count">
                {totalCount.toLocaleString()} · page {page}/{Math.max(totalPages, 1)}
              </span>
            </div>
            <div className="cdb__rows">
              {targets.map((t) => {
                const status = String(t.target_status ?? '')
                const tone = toneOf(status)
                const geo = [t.market, t.property_address_state].filter(Boolean).join(' · ')
                return (
                  <button
                    key={t.id}
                    type="button"
                    className={`cdb__row is-tappable${t.canonical_e164 ? '' : ' is-nil'}`}
                    onClick={() => onOpenTarget?.(t)}
                  >
                    <span className="cdb__row-main">
                      <span className="cdb__row-id">{t.seller_full_name || t.property_address_full || 'Unknown owner'}</span>
                      {t.final_acquisition_score != null && (
                        <span className="cdb__row-value is-text">{t.final_acquisition_score}</span>
                      )}
                      <span className={`cdb__row-state${tone ? ` is-${tone}` : ''}`}>
                        {status.replace(/_/g, ' ').toUpperCase()}
                      </span>
                    </span>
                    <span className="cdb__row-sub">
                      {t.property_address_full || 'No address'}
                      {geo && <em>· {geo}</em>}
                    </span>
                    <span className="cdb__row-sub">
                      {t.canonical_e164 || 'No contact number'}
                    </span>
                  </button>
                )
              })}
            </div>
          </section>

          <div className="cdb__pager">
            <button type="button" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              Previous
            </button>
            <span>
              {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, totalCount)} of {totalCount.toLocaleString()}
            </span>
            <button type="button" disabled={page >= totalPages || loading} onClick={() => setPage((p) => p + 1)}>
              Next
            </button>
          </div>
        </>
      )}
    </div>
  )
}
