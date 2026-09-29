import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { replaceRoutePath } from '../../../app/router'
import { fetchHome, isDemoMode, type Home, type OpState, type ThreadSummary } from './email-command-api'
import { AUTOMATION_LABEL, ROLE_LABEL, STATE_LABEL, STATE_TONE, ago, businessLine, human, until, where, who } from './email-format'
import { LiquidField, Monogram } from './Monogram'
import './email-surface.css'

const EmailThreadRoom = lazy(() => import('./EmailThreadRoom').then((m) => ({ default: m.EmailThreadRoom })))

/**
 * EMAIL COMMAND — mobile. Not an inbox: the first screen answers what needs
 * you, what LeadCommand is handling, and who we are waiting on. Every state,
 * context line and next action is derived on the server; a failed read shows
 * an error, never an empty mailbox.
 */

type Filter = 'all' | OpState | 'seller' | 'closings' | 'buyer' | 'title' | 'recent'
const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'Overview' },
  { key: 'needs_you', label: 'Needs you' },
  { key: 'system_handling', label: 'System handling' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'seller', label: 'Sellers' },
  { key: 'closings', label: 'Closings' },
  { key: 'buyer', label: 'Buyers' },
  { key: 'title', label: 'Title' },
  { key: 'failed', label: 'Failed' },
  { key: 'unresolved', label: 'Unresolved' },
  { key: 'recent', label: 'Recent' },
]
const SERVER_FILTERS = new Set(['seller', 'closings', 'buyer', 'title'])

const readParam = (k: string) => { try { return new URLSearchParams(window.location.search).get(k) } catch { return null } }
const setThreadParam = (id: string | null) => {
  try {
    const url = new URL(window.location.href)
    if (id) url.searchParams.set('thread', id); else url.searchParams.delete('thread')
    const qs = url.searchParams.toString()
    replaceRoutePath(`${url.pathname}${qs ? `?${qs}` : ''}`)
  } catch { /* best-effort */ }
}

export function EmailSurface() {
  const [home, setHome] = useState<Home | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [openId, setOpenId] = useState<string | null>(() => readParam('thread'))
  const demo = useMemo(isDemoMode, [])

  useEffect(() => { const t = setTimeout(() => setDebounced(query.trim()), 280); return () => clearTimeout(t) }, [query])

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    try {
      const next = await fetchHome({ filter: SERVER_FILTERS.has(filter) ? filter : undefined, q: debounced || undefined }, signal)
      setHome(next)
      setError(null)
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      setError((err as Error)?.message || 'unavailable')
    } finally { setLoading(false) }
  }, [filter, debounced])

  useEffect(() => { const ac = new AbortController(); void load(ac.signal); return () => ac.abort() }, [load])
  // Near-realtime: refresh while visible (the dispatcher ticks every minute).
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible' && !openId) void load() }, 45_000)
    return () => clearInterval(t)
  }, [load, openId])

  const open = useCallback((id: string) => { setOpenId(id); setThreadParam(id) }, [])
  const close = useCallback(() => { setOpenId(null); setThreadParam(null) }, [])

  const counts = home?.counts
  const all = useMemo(() => {
    if (!home) return []
    const seen = new Map<string, ThreadSummary>()
    for (const t of [...home.needs_you, ...home.system_handling, ...home.waiting, ...home.failed, ...home.unresolved, ...home.recent]) seen.set(t.id, t)
    return [...seen.values()]
  }, [home])
  const list = useMemo(() => {
    if (!home) return []
    if (filter === 'recent' || SERVER_FILTERS.has(filter)) return home.recent
    if (filter === 'all') return []
    return all.filter((t) => t.state === filter)
  }, [home, all, filter])

  const degraded = home?.delivery.health && home.delivery.health.status === 'degraded'
  const ambient = counts?.needs_you ? 'attention' : degraded ? 'blocked' : 'active'
  const total = all.length

  return (
    <div className={`em2 is-amb-${ambient}${openId ? ' has-room' : ''}`} data-testid="email-surface">
      <LiquidField needs={Boolean(counts?.needs_you)} live={Boolean(counts?.system_handling)} />
      <header className="em2-head">
        <span className="em2-eyebrow"><i />Email Command{demo ? <b className="em2-demo">Demo data</b> : null}</span>
        <label className="em2-search">
          <Icon name="search" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="People, emails, properties, subjects" aria-label="Search email" />
          {query ? <button type="button" aria-label="Clear search" onClick={() => setQuery('')}><Icon name="close" /></button> : null}
        </label>
      </header>

      {counts ? <SystemHero home={home!} onFilter={setFilter} onOpen={open} /> : null}

      {home && !home.delivery.send_enabled ? (
        <p className="em2-banner is-muted" role="status"><Icon name="pause" />Email sending is off — {home.delivery.operator_switch ? 'deployment not enabled' : 'operator switch off'}. Messages wait; nothing is lost.</p>
      ) : null}
      {degraded ? (
        <p className="em2-banner is-bad" role="alert"><Icon name="alert" />Email delivery degraded — {home!.delivery.health!.issues.map((i) => i.replace(/^email_/, '').replace(/_/g, ' ')).join(', ')}</p>
      ) : null}

      <nav className="em2-chips" role="tablist" aria-label="Filter">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} className={`em2-chip${filter === f.key ? ' is-on' : ''}`} onClick={() => setFilter(f.key)}>
            {f.label}{f.key !== 'all' && counts && f.key in counts && counts[f.key as OpState] ? <b>{counts[f.key as OpState]}</b> : null}
          </button>
        ))}
      </nav>

      {error && !home ? (
        <section className="em2-state is-error" role="alert">
          <Icon name="alert" />
          <strong>Email Command is unavailable</strong>
          <p>Conversations could not be read. Nothing is shown rather than an empty inbox.</p>
          <button type="button" className="em2-btn" onClick={() => void load()}>Try again</button>
        </section>
      ) : loading && !home ? (
        <Skeleton />
      ) : home ? (
        filter === 'all' ? (
          <>
            <Section title="Needs you" tone="attention" rows={home.needs_you} onOpen={open} empty={total ? { title: 'Nothing needs you', body: 'LeadCommand is handling active conversations.' } : null} />
            <Section title="Active automations" tone="active" rows={home.system_handling} onOpen={open} />
            <Section title="Waiting on reply" tone="external" rows={home.waiting.slice(0, 12)} onOpen={open} more={home.waiting.length > 12 ? () => setFilter('waiting') : null} />
            {home.failed.length ? <Section title="Failed" tone="blocked" rows={home.failed} onOpen={open} /> : null}
            {!total ? (
              <section className="em2-state is-empty">
                <span className="em2-empty-mark" aria-hidden><Icon name="mail" /></span>
                <strong>No email conversations yet</strong>
                <p>Seller replies, title and buyer threads appear here as soon as email is used. Nothing is simulated.</p>
              </section>
            ) : null}
            {home.unresolved.length ? <Section title="Unresolved senders" tone="muted" rows={home.unresolved.slice(0, 5)} onOpen={open} more={home.unresolved.length > 5 ? () => setFilter('unresolved') : null} /> : null}
          </>
        ) : (
          <section className="em2-section">
            {list.length ? (
              <ul className="em2-list">{list.map((t, i) => <li key={t.id} style={{ ['--i' as string]: Math.min(i, 10) }}><ThreadRow t={t} onOpen={() => open(t.id)} /></li>)}</ul>
            ) : (
              <p className="em2-none">{debounced ? `Nothing matches “${debounced}”.` : filter === 'needs_you' ? 'Nothing needs you. LeadCommand is handling active conversations.' : `No ${FILTERS.find((f) => f.key === filter)?.label.toLowerCase()} conversations.`}</p>
            )}
          </section>
        )
      ) : null}

      {home?.truncated ? <p className="em2-prov">Showing the most recent conversations — search to reach older ones.</p> : null}

      {openId ? (
        <Suspense fallback={<div className="em2-room is-loading" />}>
          <EmailThreadRoom id={openId} fallback={all.find((t) => t.id === openId) ?? null} onClose={close} onChanged={() => void load()} />
        </Suspense>
      ) : null}
    </div>
  )
}

function Section({ title, tone, rows, onOpen, empty = null, more = null }: { title: string; tone: string; rows: ThreadSummary[]; onOpen: (id: string) => void; empty?: { title: string; body: string } | null; more?: (() => void) | null }) {
  if (!rows.length && !empty) return null
  return (
    <section className="em2-section" aria-label={title}>
      <h2 className={`em2-h2 is-${tone}`}>{title}{rows.length ? <span>{rows.length}</span> : null}</h2>
      {rows.length ? (
        <ul className="em2-list">{rows.map((t, i) => <li key={t.id} style={{ ['--i' as string]: Math.min(i, 10) }}><ThreadRow t={t} onOpen={() => onOpen(t.id)} /></li>)}</ul>
      ) : empty ? (
        <div className="em2-calm"><Icon name="check" /><span><b>{empty.title}</b>{empty.body}</span></div>
      ) : null}
      {more ? <button type="button" className="em2-link" onClick={more}>Show all</button> : null}
    </section>
  )
}

function CountUp({ n }: { n: number }) {
  const [v, setV] = useState(0)
  useEffect(() => {
    if (!n || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setV(n); return }
    const start = performance.now()
    let raf = 0
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / 700)
      setV(Math.round(n * (1 - Math.pow(1 - p, 3))))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [n])
  return <>{v}</>
}

function SystemHero({ home, onFilter, onOpen }: { home: Home; onFilter: (f: Filter) => void; onOpen: (id: string) => void }) {
  const c = home.counts
  const handling = c.system_handling
  const needs = c.needs_you
  const nextUp = [...home.system_handling].filter((t) => t.next).sort((a, b) => String(a.next!.at).localeCompare(String(b.next!.at)))[0] || null
  const headline = needs ? `${needs} need${needs === 1 ? 's' : ''} you` : handling ? 'LeadCommand is handling it' : 'All clear'
  const sub = [handling ? `${handling} automated` : null, c.waiting ? `${c.waiting} waiting on reply` : null, c.failed ? `${c.failed} failed` : null].filter(Boolean).join(' · ') || 'No open email conversations'
  const total = Math.max(1, needs + handling + c.waiting)
  return (
    <section className={`em2-sys-hero${needs ? ' is-needs' : ''}`} aria-label="Email system state">
      <span className="em2-sheen" aria-hidden />
      <div className="em2-sys-hero__top">
        <span className={`em2-orb${handling ? ' is-live' : ''}${needs ? ' is-needs' : ''}`} aria-hidden><i /><i /><i /><b /></span>
        <span className="em2-sys-hero__copy">
          <strong>{headline}</strong>
          <small>{sub}</small>
        </span>
      </div>
      <div className="em2-instr" role="list">
        {([['needs_you', 'Needs you', needs, 'gold'], ['system_handling', 'System handling', handling, 'cobalt'], ['waiting', 'Waiting', c.waiting, 'ext']] as Array<[Filter, string, number, string]>).map(([k, label, n, tone]) => (
          <button key={k} type="button" role="listitem" className={`em2-instr__seg is-${tone}${n ? '' : ' is-zero'}`} onClick={() => onFilter(k)}>
            <b><CountUp n={n} /></b><span>{label}</span>
            <i style={{ ['--w' as string]: `${Math.round((n / total) * 100)}%` }} aria-hidden />
          </button>
        ))}
      </div>
      {nextUp ? (
        <button type="button" className="em2-ticker" onClick={() => onOpen(nextUp.id)}>
          <span className="em2-ticker__dot" aria-hidden />
          <span className="em2-ticker__body">
            <em>Next automation · {until(nextUp.next!.at)}</em>
            <span className="em2-ticker__what">{who(nextUp)} — {nextUp.next!.sequence && nextUp.next!.sequence > 1 ? `follow-up #${nextUp.next!.sequence}` : 'send'}{where(nextUp) ? ` · ${where(nextUp)}` : ''}</span>
          </span>
          <Icon name="chevron-right" />
        </button>
      ) : null}
    </section>
  )
}

export function ThreadRow({ t, onOpen }: { t: ThreadSummary; onOpen: () => void }) {
  const tone = STATE_TONE[t.state]
  const line = businessLine(t)
  const place = where(t)
  return (
    <button type="button" className={`em2-row is-${tone}${t.operator_unread ? ' is-unread' : ''}`} onClick={onOpen} data-thread-id={t.id}>
      <span className="em2-row__rail" aria-hidden />
      <span className="em2-row__top">
        <Monogram t={t} />
        <span className="em2-row__id">
          <strong className="em2-row__who">{who(t)}</strong>
          <span className="em2-role">{ROLE_LABEL[t.category] || t.category}</span>
        </span>
        <time>{ago(t.last_message.at)}</time>
      </span>
      {place ? <span className="em2-row__place">{place}</span> : null}
      {line ? <span className={`em2-row__line${t.needs ? ' is-needs' : ''}`}>{line}</span> : null}
      {t.last_message.preview ? <span className="em2-row__preview">{t.last_message.direction === 'inbound' ? '' : 'You: '}{t.last_message.preview}</span> : null}
      <span className="em2-row__foot">
        <span className={`em2-pill is-${tone}`}>{STATE_LABEL[t.state]}</span>
        {t.next ? <span className="em2-next"><Icon name="clock" />{t.next.sequence && t.next.sequence > 1 ? `Follow-up #${t.next.sequence}` : 'Next'} · {until(t.next.at)}</span>
          : t.state === 'waiting' ? <span className="em2-next">{t.counterparty.role === 'seller' ? 'Seller' : ROLE_LABEL[t.counterparty.role] || 'They'} {t.counterparty.role === 'seller' ? 'has' : 'have'} the ball</span>
            : t.needs ? <span className="em2-next">{human(t.needs.code)}</span>
              : t.state === 'failed' && t.last_failure ? <span className="em2-next">{human(t.last_failure.code)}</span>
                : <span className="em2-next">{t.state === 'needs_you' ? '' : AUTOMATION_LABEL[t.automation] || ''}</span>}
      </span>
    </button>
  )
}

function Skeleton() {
  return (
    <div className="em2-skel" aria-busy="true" aria-label="Loading email">
      {[0, 1, 2, 3].map((i) => <span key={i} className="em2-skel__row"><i /><i /><i /></span>)}
    </div>
  )
}
