import { useEffect, useMemo, useState } from 'react'
import { pushRoutePath } from '../../../app/router'
import { Icon } from '../../../shared/icons'
import { fetchCampaignTargetsPageData } from '../campaigns.adapter'
import type { CampaignSummary, CampaignTarget } from '../campaigns.types'
import { formatPhone } from './mobile-format'

/**
 * Campaign Detail — Audience, mobile.
 *
 * What was wrong:
 *
 *   TEN FILTERS, THREE REAL. Target status only ever holds ready, planned or
 *   blocked — across every campaign in production — so Queued, Scheduled,
 *   Sent, Delivered, Failed and Opted out always returned nothing. A seller's
 *   send outcome lives in the queue, not on the target. Only filters that can
 *   match are offered, each with its count.
 *
 *   ROWS THAT DID NOTHING. Every row was a button whose handler was never
 *   passed. A row now opens the property in Deal Intelligence when there is
 *   one to open.
 *
 *   CLIPPED AND RAW. The address and market were forced onto one line and cut
 *   mid-word; the number read +17542466988; an unlabelled "98" sat beside the
 *   name. Addresses wrap, numbers read (754) 246-6988, the score says Priority.
 */

const PAGE_SIZE = 50

type Filter = 'all' | 'ready' | 'planned' | 'blocked'

const STATUS_LABEL: Record<string, string> = { ready: 'Ready', planned: 'Planned', blocked: 'Left out' }

const nf = (n: number) => n.toLocaleString()
const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

function openProperty(t: CampaignTarget) {
  if (!t.property_id) return
  const q = new URLSearchParams({ property_id: t.property_id })
  if (t.master_owner_id) q.set('master_owner_id', t.master_owner_id)
  pushRoutePath(`/deal-intelligence?${q.toString()}`)
}

export function CampaignTargetsMobile({ campaign }: { campaign: CampaignSummary }) {
  const [targets, setTargets] = useState<CampaignTarget[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [totalCount, setTotalCount] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [blockedCount, setBlockedCount] = useState<number | null>(null)
  const [attempt, setAttempt] = useState(0)

  // Search as you type, without a request per keystroke.
  useEffect(() => {
    const id = window.setTimeout(() => { setSearch(query.trim()); setPage(1) }, 300)
    return () => window.clearTimeout(id)
  }, [query])

  // "Left out" has no count on the campaign row, so ask for it once.
  useEffect(() => {
    let active = true
    fetchCampaignTargetsPageData(campaign.id, { page: 1, page_size: 10, status: 'blocked' })
      .then((d) => { if (active) setBlockedCount(d.total_count) })
      .catch(() => { if (active) setBlockedCount(null) })
    return () => { active = false }
  }, [campaign.id])

  useEffect(() => {
    let active = true
    setLoading(true)
    setFailed(false)
    fetchCampaignTargetsPageData(campaign.id, {
      page,
      page_size: PAGE_SIZE,
      status: filter === 'all' ? undefined : filter,
      search: search || undefined,
    })
      .then((data) => {
        if (!active) return
        setTargets(data.targets)
        setTotalCount(data.total_count)
        setTotalPages(data.total_pages)
      })
      .catch(() => { if (active) { setTargets([]); setFailed(true) } })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [campaign.id, filter, page, search, attempt])

  const chips = useMemo(() => {
    const all: Array<{ id: Filter; label: string; count: number | null }> = [
      { id: 'all', label: 'All', count: Number(campaign.total_targets ?? 0) || null },
      { id: 'ready', label: 'Ready', count: Number(campaign.ready_targets ?? 0) },
      { id: 'planned', label: 'Planned', count: Number(campaign.planned_targets ?? 0) },
      { id: 'blocked', label: 'Left out', count: blockedCount },
    ]
    // A filter that can't match anything is not offered. The active one always stays.
    return all.filter((c) => c.id === 'all' || c.id === filter || (c.count ?? 0) > 0)
  }, [campaign.total_targets, campaign.ready_targets, campaign.planned_targets, blockedCount, filter])

  const from = totalCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1
  const to = Math.min(page * PAGE_SIZE, totalCount)

  return (
    <div className="cau">
      <label className="cau-search">
        <Icon name="search" size={15} />
        <input
          type="search"
          inputMode="search"
          placeholder="Search name, address or phone"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search the audience"
        />
      </label>

      {chips.length > 1 && (
        <div className="cau-chips" role="group" aria-label="Filter the audience">
          {chips.map((c) => (
            <button
              key={c.id}
              type="button"
              className={cls('cau-chip', filter === c.id && 'is-on')}
              aria-pressed={filter === c.id}
              onClick={() => { setFilter(c.id); setPage(1) }}
            >
              {c.label}
              {c.count != null && <span className="cau-chip__n">{nf(c.count)}</span>}
            </button>
          ))}
        </div>
      )}

      {loading && targets.length === 0 ? (
        <div className="cq-card" aria-busy="true">
          {[0, 1, 2, 3, 4].map((i) => <div key={i} className="cq-skel is-tall" />)}
        </div>
      ) : failed ? (
        <section className="cov2-card is-warn" role="status">
          <h3 className="cov2-card__h">The audience couldn’t be loaded</h3>
          <p className="cov2-note">Nothing about the campaign has changed.</p>
          <button type="button" className="cex-retry" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
        </section>
      ) : targets.length === 0 ? (
        <section className="cov2-card">
          <h3 className="cq-empty__title">{search ? `No one matches “${search}”` : 'No one here'}</h3>
          {search && <p className="cov2-note">Search looks at names, addresses and phone numbers.</p>}
        </section>
      ) : (
        <div className={cls('cq-card cau-card', loading && 'is-refreshing')}>
          <ul className="cau-list">
            {targets.map((t) => {
              const status = String(t.target_status ?? '').toLowerCase()
              const phone = formatPhone(t.canonical_e164)
              const meta = [
                t.market,
                phone,
                t.language && !/^en(glish)?$/i.test(t.language) ? t.language : null,
              ].filter(Boolean).join(' · ')
              const Row = t.property_id ? 'button' : 'div'
              return (
                <li key={t.id}>
                  <Row
                    {...(t.property_id ? { type: 'button' as const, onClick: () => openProperty(t) } : {})}
                    className={cls('cau-row', t.property_id && 'is-link')}
                  >
                    <span className="cau-row__top">
                      <span className="cau-row__who">{t.seller_full_name || 'Owner unknown'}</span>
                      <span className={cls('cq-pill', status === 'ready' && 'is-ok', status === 'blocked' && 'is-muted')}>
                        {STATUS_LABEL[status] ?? (status ? status.charAt(0).toUpperCase() + status.slice(1) : '—')}
                      </span>
                    </span>
                    {t.property_address_full && <span className="cau-row__addr">{t.property_address_full}</span>}
                    <span className="cau-row__meta">
                      <span>{meta || 'No number on file'}</span>
                      {t.final_acquisition_score != null && (
                        <span className="cau-row__score">Priority {t.final_acquisition_score}</span>
                      )}
                    </span>
                  </Row>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {totalPages > 1 && !failed && (
        <nav className="cau-pager" aria-label="Pages">
          <button type="button" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            <Icon name="chevron-left" size={15} /> Previous
          </button>
          <span>{nf(from)}–{nf(to)} of {nf(totalCount)}</span>
          <button type="button" disabled={page >= totalPages || loading} onClick={() => setPage((p) => p + 1)}>
            Next <Icon name="chevron-right" size={15} />
          </button>
        </nav>
      )}
    </div>
  )
}

export default CampaignTargetsMobile
