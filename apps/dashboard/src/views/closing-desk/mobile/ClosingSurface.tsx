import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { replaceRoutePath } from '../../../app/router'
import {
  fetchDemoPortfolio, fetchPortfolio, isDemoMode,
  type Closing, type Portfolio, type RailStep,
} from './closing-execution-api'
import { countdown, money, OWNER_LABEL, shortDate, whenLabel } from './closing-format'
import './closing-surface.css'

const ClosingRoom = lazy(() => import('./ClosingRoom').then((m) => ({ default: m.ClosingRoom })))

/**
 * CLOSING DESK — mobile. Attention first, then what closes next, then every
 * live closing. Every word on screen is a derived fact from the server model;
 * there is no score, no inferred readiness, no demo fallback.
 */

type Filter = 'all' | 'attention' | 'soon' | 'external' | 'ready' | 'closed' | 'cancelled'
const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'attention', label: 'Needs attention' },
  { key: 'soon', label: 'Closing soon' },
  { key: 'external', label: 'Waiting external' },
  { key: 'ready', label: 'Ready' },
  { key: 'closed', label: 'Closed' },
  { key: 'cancelled', label: 'Cancelled' },
]
const SORTS = [
  { key: 'most_urgent', label: 'Most urgent' },
  { key: 'next_closing', label: 'Next closing' },
  { key: 'recently_updated', label: 'Recently updated' },
  { key: 'recently_closed', label: 'Recently closed' },
]

const matches = (x: Closing, f: Filter) => {
  if (f === 'all') return !x.terminal
  if (f === 'cancelled') return x.terminal
  if (f === 'closed') return x.closed
  if (x.terminal || x.closed) return false
  if (f === 'attention') return x.state.tone === 'blocked' || x.state.tone === 'attention'
  if (f === 'soon') return x.closing?.confirmed === true && x.closing.daysOut !== null && x.closing.daysOut <= 7
  if (f === 'external') return x.state.tone === 'external'
  if (f === 'ready') return x.ready
  return true
}

const searchText = (x: Closing) => [x.property.address, x.seller.name, x.buyer?.name, x.title.company, x.id, x.title.escrowFile].filter(Boolean).join(' ').toLowerCase()

const readParam = (k: string) => { try { return new URLSearchParams(window.location.search).get(k) } catch { return null } }
/** Keep the open room in the URL (?case=) so a refresh or a shared link lands on it. */
const setCaseParam = (id: string | null) => {
  try {
    const url = new URL(window.location.href)
    if (id) url.searchParams.set('case', id); else url.searchParams.delete('case')
    const qs = url.searchParams.toString()
    replaceRoutePath(`${url.pathname}${qs ? `?${qs}` : ''}`)
  } catch { /* URL sync is best-effort */ }
}

export function ClosingSurface() {
  const demo = useMemo(isDemoMode, [])
  const [data, setData] = useState<Portfolio | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState('most_urgent')
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [openId, setOpenId] = useState<string | null>(() => readParam('case'))
  const rootRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    try {
      const next = demo ? await fetchDemoPortfolio() : await fetchPortfolio(sort, signal)
      setData(next)
      setError(null)
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      setError((err as Error)?.message || 'unavailable')
    } finally {
      setLoading(false)
    }
  }, [demo, sort])

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  // Other apps hand off with ?property_id= / ?opp= — open that transaction's room.
  useEffect(() => {
    if (!data || openId) return
    const pid = readParam('property_id')
    const opp = readParam('opp') || readParam('opportunity_id')
    const hit = data.items.find((x) => (pid && x.propertyId === pid) || (opp && x.opportunityId === opp))
    if (hit) setOpenId(hit.id)
  }, [data, openId])

  const openRoom = useCallback((id: string) => {
    setOpenId(id)
    setCaseParam(id)
  }, [])
  const closeRoom = useCallback(() => {
    setOpenId(null)
    setCaseParam(null)
  }, [])

  const items = data?.items ?? []
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter((x) => matches(x, filter) && (!q || searchText(x).includes(q)))
  }, [items, filter, query])

  const attention = useMemo(() => items
    .filter((x) => !x.terminal && !x.closed && (x.blockers.length || x.state.tone === 'attention'))
    .flatMap((x) => (x.blockers.length ? x.blockers.map((b) => ({ x, what: b.what, owner: OWNER_LABEL[b.owner], blocked: true, key: `${x.id}:${b.key}` }))
      : x.next ? [{ x, what: x.next.what, owner: x.next.ownerLabel ?? 'You', blocked: false, key: `${x.id}:next` }] : []))
    .slice(0, 6), [items])

  const counts = data?.summary.counts
  const next = data?.summary.nextClosing ? items.find((x) => x.id === data.summary.nextClosing?.id) ?? null : null
  const recentClosed = items.filter((x) => x.closed).slice(0, 3)
  const ambient = next?.state.tone || (counts?.needsYou ? 'blocked' : 'active')

  return (
    <div ref={rootRef} className={`cd2 is-amb-${ambient}${openId ? ' has-room' : ''}`} data-testid="closing-surface">
      <header className="cd2-head">
        <span className="cd2-eyebrow"><i />Closing Desk{demo ? <b className="cd2-demo">Demo data</b> : null}</span>
        {counts ? (
          <>
            <h1><span>{counts.active}</span> active</h1>
            <div className="cd2-counts" role="list">
              <button type="button" role="listitem" className={`cd2-count is-bad${counts.needsYou ? '' : ' is-zero'}`} onClick={() => setFilter('attention')}><b>{counts.needsYou}</b>Need{counts.needsYou === 1 ? 's' : ''} you</button>
              <button type="button" role="listitem" className={`cd2-count is-ext${counts.waitingExternal ? '' : ' is-zero'}`} onClick={() => setFilter('external')}><b>{counts.waitingExternal}</b>Waiting external</button>
              <button type="button" role="listitem" className={`cd2-count is-good${counts.ready ? '' : ' is-zero'}`} onClick={() => setFilter('ready')}><b>{counts.ready}</b>Ready</button>
              {counts.closed ? <button type="button" role="listitem" className="cd2-count is-gold" onClick={() => setFilter('closed')}><b>{counts.closed}</b>Closed</button> : null}
            </div>
          </>
        ) : null}
      </header>

      {error && !data ? (
        <section className="cd2-state is-error" role="alert">
          <Icon name="alert" />
          <strong>Closing Desk is unavailable</strong>
          <p>The closing records could not be read. Nothing is shown rather than a guess.</p>
          <button type="button" className="cd2-btn" onClick={() => void load()}>Try again</button>
        </section>
      ) : loading && !data ? (
        <Skeleton />
      ) : data ? (
        <>
          {data.degraded.length ? (
            <p className="cd2-degraded"><Icon name="alert" />{data.degraded.map((d) => d.source.replace(/_/g, ' ')).join(', ')} unavailable — those details are hidden, not zero.</p>
          ) : null}

          {counts && counts.active === 0 ? (
            <section className="cd2-state is-empty">
              <span className="cd2-empty-mark" aria-hidden><Icon name="shield" /></span>
              <strong>No active closings</strong>
              <p>Deals appear here automatically once a seller contract is accepted. Nothing is in contract or escrow right now.</p>
              {counts.cancelled ? <button type="button" className="cd2-link" onClick={() => setFilter('cancelled')}>{counts.cancelled} cancelled — view history</button> : null}
            </section>
          ) : null}

          {next ? <NextClosing x={next} onOpen={() => openRoom(next.id)} /> : null}

          {attention.length ? (
            <section className="cd2-section" aria-label="Needs attention">
              <h2 className="cd2-h2">Needs attention</h2>
              <ul className="cd2-attn">
                {attention.map((a) => (
                  <li key={a.key}>
                    <button type="button" className={`cd2-attn__row${a.blocked ? ' is-bad' : ''}`} onClick={() => openRoom(a.x.id)}>
                      <i aria-hidden />
                      <span>
                        <b>{a.what}</b>
                        <small>{a.x.property.line || a.x.property.address}</small>
                      </span>
                      <em>{a.owner}</em>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {items.length && (counts?.active || filter !== 'all') ? (
            <section className="cd2-section" aria-label="Closings">
              <div className="cd2-toolbar">
                <h2 className="cd2-h2">{filter === 'cancelled' ? 'Cancelled' : filter === 'closed' ? 'Closed' : 'Closings'}</h2>
                <div className="cd2-toolbar__acts">
                  <button type="button" className={`cd2-icon${searching ? ' is-on' : ''}`} aria-label="Search closings" onClick={() => setSearching((v) => !v)}><Icon name="search" /></button>
                  <label className="cd2-sort">
                    <span className="cd2-sr">Sort</span>
                    <select value={sort} onChange={(e) => setSort(e.target.value)} disabled={demo}>
                      {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                    </select>
                  </label>
                </div>
              </div>
              {searching ? (
                <input className="cd2-search" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Property, seller, buyer, title, closing ID" aria-label="Search closings" />
              ) : null}
              <div className="cd2-chips" role="tablist">
                {FILTERS.map((f) => (
                  <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} className={`cd2-chip${filter === f.key ? ' is-on' : ''}`} onClick={() => setFilter(f.key)}>{f.label}</button>
                ))}
              </div>
              {visible.length ? (
                <ul className="cd2-list">
                  {visible.map((x, i) => <li key={x.id} style={{ ['--i' as string]: Math.min(i, 10) }}><ClosingCard x={x} onOpen={() => openRoom(x.id)} /></li>)}
                </ul>
              ) : (
                <p className="cd2-none">{query ? `Nothing matches “${query}”.` : 'No closings match this filter.'}</p>
              )}
            </section>
          ) : null}

          {filter !== 'closed' && recentClosed.length ? (
            <section className="cd2-section" aria-label="Recently closed">
              <h2 className="cd2-h2">Recently closed</h2>
              <ul className="cd2-list">{recentClosed.map((x) => <li key={x.id}><ClosingCard x={x} onOpen={() => openRoom(x.id)} /></li>)}</ul>
            </section>
          ) : null}

          <p className="cd2-prov">From closing cases, buyer offers & agreements, EMD receipts and settlement records{data.recentDays ? ` · closed & cancelled from the last ${data.recentDays} days` : ''}.</p>
        </>
      ) : null}

      {openId ? (
        <Suspense fallback={<div className="cd2-room is-loading" />}>
          <ClosingRoom id={openId} demo={demo} fallback={items.find((x) => x.id === openId) ?? null} onClose={closeRoom} onChanged={() => void load()} />
        </Suspense>
      ) : null}
    </div>
  )
}

/* ── pieces ── */

const RAIL_KEYS = ['contract', 'buyer', 'emd', 'title', 'settlement'] as const
const RAIL_SHORT: Record<string, string> = { contract: 'Contract', buyer: 'Buyer', emd: 'EMD', title: 'Title', settlement: 'Settlement' }

export function MiniRail({ rail }: { rail: RailStep[] }) {
  return (
    <ol className="cd2-mini" aria-label="Execution">
      {RAIL_KEYS.map((k) => {
        const s = rail.find((r) => r.key === k)
        return <li key={k} className={`is-${s?.status ?? 'not_started'}`}><i aria-hidden>{s?.status === 'complete' ? <Icon name="check" /> : null}</i><span>{RAIL_SHORT[k]}</span></li>
      })}
    </ol>
  )
}

function NextClosing({ x, onOpen }: { x: Closing; onOpen: () => void }) {
  const w = whenLabel(x.closing)
  const cd = x.closing?.confirmed ? countdown(x.closing.daysOut) : null
  return (
    <button type="button" className={`cd2-next is-${x.state.tone}`} onClick={onOpen} data-testid="closing-next">
      <span className="cd2-next__eyebrow">{cd ? cd : x.closing?.confirmed ? 'Next closing' : 'Next target closing'}</span>
      <strong className="cd2-next__when">{w.main}</strong>
      {w.alt ? <small className="cd2-next__alt">{w.alt}</small> : null}
      <span className="cd2-next__addr">{x.property.line || x.property.address}</span>
      <span className="cd2-next__city">{[x.property.city, x.property.state].filter(Boolean).join(', ')}</span>
      <span className={`cd2-pill is-${x.state.tone}`}>{x.state.label}</span>
      <MiniRail rail={x.rail} />
      {x.next ? <span className="cd2-next__action"><em>Next</em>{x.next.what}{x.next.ownerLabel ? <b> · {x.next.ownerLabel}</b> : null}</span> : null}
    </button>
  )
}

export function ClosingCard({ x, onOpen }: { x: Closing; onOpen: () => void }) {
  const w = whenLabel(x.closing)
  const actual = x.money.actual
  return (
    <button type="button" className={`cd2-card is-${x.state.tone}`} onClick={onOpen} data-closing-id={x.id}>
      <span className="cd2-card__top">
        <span className={`cd2-pill is-${x.state.tone}`}>{x.state.label}</span>
        {x.stage ? <span className="cd2-stage">{x.stage.code} · {x.stage.label}</span> : null}
      </span>
      <strong className="cd2-card__addr">{x.property.line || x.property.address || 'Address not on record'}</strong>
      <span className="cd2-card__city">{[x.property.city, x.property.state].filter(Boolean).join(', ') || '—'}</span>
      <span className="cd2-card__when">
        {x.closed
          ? <>Closed {shortDate(actual?.legs[0]?.closedAt?.slice(0, 10) || x.closing?.date)}{actual?.netProceeds !== null && actual ? <> · Net <b>{money(actual.netProceeds)}</b></> : null}</>
          : x.terminal ? 'Cancelled'
            : x.closing ? <>{x.closing.confirmed ? 'Closing' : 'Target'} {w.main}{x.closing.confirmed && x.closing.daysOut !== null && x.closing.daysOut >= 0 && x.closing.daysOut <= 3 ? <em> · {countdown(x.closing.daysOut)?.replace('Closing ', '')}</em> : null}</>
              : 'No closing date'}
      </span>
      {!x.terminal ? <MiniRail rail={x.rail} /> : null}
      {x.next ? (
        <span className={`cd2-card__next${x.next.blocker ? ' is-bad' : ''}`}>
          <em>Next</em><span>{x.next.what}</span>{x.next.ownerLabel ? <b>{x.next.ownerLabel}</b> : null}
        </span>
      ) : null}
    </button>
  )
}

function Skeleton() {
  return (
    <div className="cd2-skel" aria-busy="true" aria-label="Loading closings">
      <span className="cd2-skel__hero" />
      {[0, 1, 2].map((i) => <span key={i} className="cd2-skel__card"><i /><i /><i /></span>)}
    </div>
  )
}
