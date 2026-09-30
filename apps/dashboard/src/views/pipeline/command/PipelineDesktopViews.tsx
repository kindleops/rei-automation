/**
 * PIPELINE · DESKTOP VIEWS — Board, Table and Offers.
 *
 * Desktop only: PipelineCommandCenter mounts these when the modern product
 * runs on a wide screen. Phones keep the Overview command center unchanged.
 *
 * Every view is VIEW-ONLY. Stages move only through the autopilot and the
 * authority registry, so the Board has no drag-to-change-stage, the Table has
 * no inline edits, and Offers can only hand off to Deal Intelligence (where the
 * engine re-run already sits behind its own confirmation). Clicking a deal
 * opens the existing deal inspector. Every figure is a real field; an absent
 * one is omitted, never estimated.
 */
import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Icon, type IconName } from '../../../shared/icons'
import {
  fetchPipelineFeed,
  compactMoney,
  relTime,
  LANE_META,
  STAGE_TONE,
  type PipelineCommandCard,
  type PipelineCommandParams,
  type PipelineStageSummary,
} from '../../../domain/pipeline/pipeline-command-api'
import { validationReasons, type OfferReadinessState, type PipelineOfferRow, type PipelineOffers } from './pipeline-offers-api'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')
const fmt = (n: number) => Math.round(n).toLocaleString()

/* ── modes ─────────────────────────────────────────────────────────────── */

export type PipelineMode = 'overview' | 'board' | 'table' | 'offers'
export const PIPELINE_MODES: Array<{ key: PipelineMode; label: string; icon: IconName }> = [
  { key: 'overview', label: 'Overview', icon: 'stats' },
  { key: 'board', label: 'Board', icon: 'layout-split' },
  { key: 'table', label: 'Table', icon: 'list' },
  { key: 'offers', label: 'Offers', icon: 'dollar-sign' },
]
const MODE_KEY = 'nexus.pipeline.desktop.mode'
const MODE_PARAM = 'pv'
const isMode = (v: unknown): v is PipelineMode => PIPELINE_MODES.some((m) => m.key === v)

/** URL (?pv=) first, so a view is shareable; then the operator's last choice. */
export function readPipelineMode(location?: string | null): PipelineMode {
  try {
    const search = typeof location === 'string'
      ? (location.includes('?') ? location.slice(location.indexOf('?')) : '')
      : window.location.search
    const fromUrl = new URLSearchParams(search).get(MODE_PARAM)
    if (isMode(fromUrl)) return fromUrl
    const stored = window.localStorage.getItem(MODE_KEY)
    if (isMode(stored)) return stored
  } catch { /* private mode */ }
  return 'overview'
}

/** Persist the choice; mirror it in the URL only when this pane owns the URL. */
export function writePipelineMode(mode: PipelineMode, ownsUrl: boolean) {
  try { window.localStorage.setItem(MODE_KEY, mode) } catch { /* private mode */ }
  if (!ownsUrl) return
  try {
    const url = new URL(window.location.href)
    if (mode === 'overview') url.searchParams.delete(MODE_PARAM)
    else url.searchParams.set(MODE_PARAM, mode)
    window.history.replaceState(window.history.state, '', url.toString())
  } catch { /* ignore */ }
}

export function PipelineModeSwitch({ mode, onPick, badges }: {
  mode: PipelineMode
  onPick: (mode: PipelineMode) => void
  badges?: Partial<Record<PipelineMode, number | null>>
}) {
  return (
    <nav className="pmx" role="tablist" aria-label="Pipeline view">
      {PIPELINE_MODES.map((m) => (
        <button
          key={m.key}
          type="button"
          role="tab"
          aria-selected={mode === m.key}
          className={cls('pmx__tab', mode === m.key && 'is-on')}
          onClick={() => onPick(m.key)}
        >
          <Icon name={m.icon} size={14} />
          <span>{m.label}</span>
          {typeof badges?.[m.key] === 'number' ? <em>{badges[m.key]}</em> : null}
        </button>
      ))}
    </nav>
  )
}

/* ── shared hooks ──────────────────────────────────────────────────────── */

/** A clock that ticks, so relative times stay true without a refetch. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(t)
  }, [intervalMs])
  return now
}

const PAGE = 100
const MAX_PAGES = 6

export type AllRows = { rows: PipelineCommandCard[]; total: number; loading: boolean; error: string | null; complete: boolean }

/**
 * Every deal in the current view, paged from the feed (≤ 100 a page, ≤ 600
 * total). The server memoises the scope, so pages after the first are cheap.
 */
export function useAllPipelineRows(enabled: boolean, params: PipelineCommandParams, view: string, sort: string, reloadKey: number): AllRows & { retry: () => void } {
  const key = JSON.stringify({ params, view, sort })
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<AllRows & { key: string }>({ key: '', rows: [], total: 0, loading: true, error: null, complete: false })
  useEffect(() => {
    if (!enabled) return
    const ctrl = new AbortController()
    let rows: PipelineCommandCard[] = []
    setState((s) => (s.key === key ? { ...s, loading: true, error: null } : { key, rows: [], total: 0, loading: true, error: null, complete: false }))
    void (async () => {
      try {
        let cursor = 0
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const f = await fetchPipelineFeed({ ...params, view, sort: sort || undefined, limit: PAGE, cursor: cursor || undefined }, ctrl.signal)
          rows = page === 0 ? f.rows : [...rows, ...f.rows]
          const done = f.nextCursor === null
          setState({ key, rows, total: f.total, loading: !done && page < MAX_PAGES - 1, error: null, complete: done })
          if (done) break
          cursor = f.nextCursor as number
        }
      } catch (e) {
        if (!ctrl.signal.aborted) setState((s) => ({ ...s, key, loading: false, error: e instanceof Error ? e.message : 'failed' }))
      }
    })()
    return () => ctrl.abort()
  }, [enabled, key, reloadKey, attempt]) // eslint-disable-line react-hooks/exhaustive-deps -- key encodes params/view/sort
  const current = state.key === key ? state : { key, rows: [], total: 0, loading: true, error: null, complete: false }
  return { ...current, retry: () => setAttempt((a) => a + 1) }
}

/* ── small pieces ──────────────────────────────────────────────────────── */

type DotTone = 'attn' | 'bad' | 'hot' | 'warm' | 'cold' | 'none'
function dotFor(card: PipelineCommandCard): { tone: DotTone; label: string } {
  if (card.lane.key === 'operator') return { tone: 'attn', label: 'Needs you' }
  if (card.lane.key === 'blocked') return { tone: 'bad', label: card.lane.label || 'Blocked' }
  const t = (card.temperature || '').toLowerCase()
  if (card.hot || t === 'hot') return { tone: 'hot', label: 'Hot' }
  if (t === 'warm' || t === 'warming') return { tone: 'warm', label: 'Warm' }
  if (t === 'cold') return { tone: 'cold', label: 'Cold' }
  return { tone: 'none', label: '' }
}

function moneyFigures(card: PipelineCommandCard): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const push = (k: string, v: number | null) => { const m = compactMoney(v); if (m) out.push([k, m]) }
  push('Value', card.money.value)
  push('Ask', card.money.asking)
  push('Offer', card.money.offer)
  push('Counter', card.money.counter)
  return out
}

function StateBlock({ icon, title, detail, action }: { icon: IconName; title: string; detail?: string | null; action?: ReactNode }) {
  return (
    <div className="pdv-state" role="status">
      <Icon name={icon} size={28} />
      <b>{title}</b>
      {detail ? <span>{detail}</span> : null}
      {action}
    </div>
  )
}

/* ── BOARD ─────────────────────────────────────────────────────────────── */

const BOARD_STAGES: Array<{ code: string; short: string; label: string }> = [
  { code: 'ownership_confirmation', short: 'S1', label: 'Ownership' },
  { code: 'offer_interest', short: 'S2', label: 'Interest' },
  { code: 'asking_price', short: 'S3', label: 'Asking price' },
  { code: 'property_condition', short: 'S4', label: 'Condition' },
  { code: 'offer', short: 'S5', label: 'Offer' },
  { code: 'formal_contract', short: 'S6', label: 'Contract' },
  { code: 'disposition', short: 'S7', label: 'Dispo' },
  { code: 'under_contract', short: 'S8', label: 'Under contract' },
  { code: 'prepared_to_close', short: 'S9', label: 'Escrow' },
  { code: 'closed', short: 'S10', label: 'Closed' },
]

export function PipelineBoard({ data, stages, onOpen }: {
  data: AllRows & { retry: () => void }
  stages: PipelineStageSummary[] | null
  onOpen: (card: PipelineCommandCard) => void
}) {
  const columns = useMemo(() => BOARD_STAGES.map((s) => {
    const live = stages?.find((x) => x.code === s.code)
    return { ...s, label: live?.label || s.label }
  }), [stages])
  const byStage = useMemo(() => {
    const map = new Map<string, PipelineCommandCard[]>()
    for (const r of data.rows) {
      const list = map.get(r.stage) ?? []
      list.push(r)
      map.set(r.stage, list)
    }
    return map
  }, [data.rows])

  if (data.error && !data.rows.length) {
    return <StateBlock icon="alert-circle" title="The board didn’t load" detail="Nothing was changed. Try again in a moment." action={<button type="button" className="pdv-btn" onClick={data.retry}>Retry</button>} />
  }
  const booting = data.loading && !data.rows.length
  return (
    <section className="pkb" aria-label="Pipeline board" aria-busy={data.loading}>
      <div className="pkb__lanes">
        {columns.map((s, i) => {
          const cards = byStage.get(s.code) ?? []
          const value = cards.reduce((n, c) => n + (c.money.value || 0), 0)
          const needYou = cards.filter((c) => c.lane.key === 'operator' || c.lane.key === 'blocked').length
          const empty = !booting && cards.length === 0
          return (
            <div
              key={s.code}
              className={cls('pkb-col', empty && 'is-empty')}
              style={{ '--tone': STAGE_TONE[s.code] ?? 'var(--plc-s-early)', '--i': Math.min(i, 8) } as CSSProperties}
              aria-label={`${s.short} ${s.label}: ${cards.length} deals`}
            >
              <header className="pkb-col__head">
                <span className="pkb-col__stage"><i />{s.short}</span>
                <b className="pkb-col__label">{s.label}</b>
                <span className="pkb-col__count">{booting ? '' : cards.length}</span>
                {!empty && !booting ? (
                  <span className="pkb-col__meta">
                    <span>{compactMoney(value) ?? 'No values yet'}</span>
                    {needYou ? <em>{needYou} need{needYou === 1 ? 's' : ''} you</em> : null}
                  </span>
                ) : null}
              </header>
              <div className="pkb-col__list">
                {booting
                  ? Array.from({ length: i < 5 ? 3 : 1 }).map((_, k) => <span key={k} className="pdv-ghost is-card" />)
                  : cards.map((c, j) => <BoardCard key={c.id} card={c} index={j} onOpen={onOpen} />)}
                {empty ? <p className="pkb-col__none">No deals</p> : null}
              </div>
            </div>
          )
        })}
      </div>
      {!data.complete && !data.loading && data.total > data.rows.length ? (
        <p className="pdv-note">Showing {fmt(data.rows.length)} of {fmt(data.total)} deals — narrow the view or search to see the rest.</p>
      ) : null}
    </section>
  )
}

function BoardCard({ card, index, onOpen }: { card: PipelineCommandCard; index: number; onOpen: (card: PipelineCommandCard) => void }) {
  const lane = LANE_META[card.lane.key] ?? LANE_META.system
  const dot = dotFor(card)
  const figures = moneyFigures(card).slice(0, 3)
  const spec = [card.market, card.propertyType, card.units && card.units > 1 ? `${card.units} units` : null].filter(Boolean).join(' · ')
  return (
    <button
      type="button"
      className={cls('pkb-card', card.lane.key === 'dormant' && 'is-dormant', (card.lane.key === 'operator' || card.lane.key === 'blocked') && 'is-exception')}
      style={{ '--i': Math.min(index, 8), '--lane': lane.tone } as CSSProperties}
      onClick={() => onOpen(card)}
    >
      <span className="pkb-card__top">
        {dot.tone !== 'none' ? <i className={cls('pdv-dot', `is-${dot.tone}`)} title={dot.label} aria-label={dot.label} /> : null}
        <b>{card.seller || 'Owner not resolved'}</b>
        {card.daysInStage !== null ? <em title="Days in stage">{card.daysInStage}d</em> : null}
      </span>
      <span className="pkb-card__addr">{card.address || 'Address not on file'}</span>
      {spec ? <span className="pkb-card__spec">{spec}</span> : null}
      {figures.length ? (
        <span className="pkb-card__figs">
          {figures.map(([k, v]) => <span key={k}><b>{v}</b><small>{k}</small></span>)}
        </span>
      ) : null}
      <span className="pkb-card__lane">
        <i aria-hidden="true" />
        <b>{card.lane.label}</b>
        {card.lane.detail ? <span>{card.lane.detail}</span> : null}
      </span>
      {card.stall ? <span className="pkb-card__stall"><Icon name="clock" size={11} />{card.stall.label}</span> : null}
    </button>
  )
}

/* ── TABLE ─────────────────────────────────────────────────────────────── */

type SortKey = 'seller' | 'property' | 'stage' | 'value' | 'asking' | 'offer' | 'lane' | 'activity' | 'age'
const COLUMNS: Array<{ key: SortKey; label: string; num?: boolean; col: string }> = [
  { key: 'seller', label: 'Seller', col: 'seller' },
  { key: 'property', label: 'Property', col: 'property' },
  { key: 'stage', label: 'Stage', col: 'stage' },
  { key: 'value', label: 'Value', num: true, col: 'value' },
  { key: 'asking', label: 'Asking', num: true, col: 'asking' },
  { key: 'offer', label: 'Offer', num: true, col: 'offer' },
  { key: 'lane', label: 'Whose move', col: 'lane' },
  { key: 'activity', label: 'Activity', num: true, col: 'activity' },
  { key: 'age', label: 'In stage', num: true, col: 'age' },
]
const time = (iso: string | null) => (iso ? Date.parse(iso) || 0 : 0)
const text = (v: string | null | undefined) => (v || '').toLocaleLowerCase()
const SORT_VALUE: Record<SortKey, (c: PipelineCommandCard) => number | string> = {
  seller: (c) => text(c.seller),
  property: (c) => text(c.address),
  stage: (c) => c.stageIndex ?? 0,
  value: (c) => c.money.value ?? -1,
  asking: (c) => c.money.asking ?? -1,
  offer: (c) => c.money.offer ?? -1,
  lane: (c) => text(c.lane.label),
  activity: (c) => time(c.lastActivityAt),
  age: (c) => c.daysInStage ?? -1,
}

export function PipelineTable({ data, onOpen }: { data: AllRows & { retry: () => void }; onOpen: (card: PipelineCommandCard) => void }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'activity', dir: -1 })
  const now = useNow(30_000)
  const sorted = useMemo(() => {
    const get = SORT_VALUE[sort.key]
    return [...data.rows].sort((a, b) => {
      const x = get(a)
      const y = get(b)
      const d = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))
      return d * sort.dir
    })
  }, [data.rows, sort])
  const toggle = (key: SortKey) => setSort((cur) => (cur.key === key ? { key, dir: cur.dir === 1 ? -1 : 1 } : { key, dir: COLUMNS.find((c) => c.key === key)?.num ? -1 : 1 }))

  if (data.error && !data.rows.length) {
    return <StateBlock icon="alert-circle" title="Deals didn’t load" detail="Nothing was changed. Try again in a moment." action={<button type="button" className="pdv-btn" onClick={data.retry}>Retry</button>} />
  }
  const booting = data.loading && !data.rows.length
  return (
    <section className="ptb" aria-label="Pipeline deals" aria-busy={data.loading}>
      <table className="ptb__table">
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th key={c.key} className={cls(`ptb-col--${c.col}`, c.num && 'is-num', sort.key === c.key && 'is-sorted')} aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                <button type="button" onClick={() => toggle(c.key)}>
                  <span>{c.label}</span>
                  <Icon name={sort.key === c.key && sort.dir === 1 ? 'chevron-up' : 'chevron-down'} size={12} />
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {booting
            ? Array.from({ length: 8 }).map((_, i) => <tr key={i} className="is-ghost"><td colSpan={COLUMNS.length}><span className="pdv-ghost is-row" /></td></tr>)
            : sorted.map((c, i) => {
              const lane = LANE_META[c.lane.key] ?? LANE_META.system
              const dot = dotFor(c)
              return (
                <tr
                  key={c.id}
                  tabIndex={0}
                  style={{ '--i': Math.min(i, 8), '--lane': lane.tone, '--tone': STAGE_TONE[c.stage] ?? 'var(--plc-s-early)' } as CSSProperties}
                  className={cls(c.lane.key === 'dormant' && 'is-dormant')}
                  onClick={() => onOpen(c)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(c) } }}
                >
                  <td className="ptb-col--seller">
                    <span className="ptb-seller">
                      {dot.tone !== 'none' ? <i className={cls('pdv-dot', `is-${dot.tone}`)} title={dot.label} aria-label={dot.label} /> : <i className="pdv-dot is-none" aria-hidden="true" />}
                      <b>{c.seller || 'Owner not resolved'}</b>
                    </span>
                  </td>
                  <td className="ptb-col--property">
                    <span className="ptb-prop"><b>{c.address || 'Address not on file'}</b><small>{[c.market, c.propertyType].filter(Boolean).join(' · ')}</small></span>
                  </td>
                  <td className="ptb-col--stage"><span className="ptb-stage"><i />S{c.stageIndex ?? '–'}<em>{c.stageLabel}</em></span></td>
                  <td className="ptb-col--value is-num">{compactMoney(c.money.value) ?? <span className="ptb-none">—</span>}</td>
                  <td className="ptb-col--asking is-num">{compactMoney(c.money.asking) ?? <span className="ptb-none">—</span>}</td>
                  <td className="ptb-col--offer is-num">{compactMoney(c.money.offer) ?? <span className="ptb-none">—</span>}</td>
                  <td className="ptb-col--lane"><span className="ptb-lane"><i /><b>{c.lane.label}</b>{c.lane.detail ? <small>{c.lane.detail}</small> : null}</span></td>
                  <td className="ptb-col--activity is-num">{relTime(c.lastActivityAt, now) ?? <span className="ptb-none">—</span>}</td>
                  <td className="ptb-col--age is-num">{c.daysInStage !== null ? `${c.daysInStage}d` : <span className="ptb-none">—</span>}</td>
                </tr>
              )
            })}
        </tbody>
      </table>
      {!booting && !data.error && sorted.length === 0 ? <StateBlock icon="list" title="No deals in this view" detail="Pick another view or clear the search." /> : null}
      {!data.complete && !data.loading && data.total > data.rows.length ? (
        <p className="pdv-note">Showing {fmt(data.rows.length)} of {fmt(data.total)} deals — narrow the view or search to see the rest.</p>
      ) : null}
    </section>
  )
}

/* ── OFFERS ────────────────────────────────────────────────────────────── */

const READINESS_META: Record<OfferReadinessState, { label: string; icon: IconName }> = {
  authorized: { label: 'Authorized', icon: 'check' },
  needs_validation: { label: 'Needs validation', icon: 'alert' },
  not_priced: { label: 'Not priced', icon: 'slash' },
}
const STRATEGY_LABEL: Record<string, string> = {
  CASH_ASSIGNMENT: 'Cash assignment', SELLER_FINANCE: 'Seller finance', SUBJECT_TO: 'Subject-to',
  LEASE_OPTION: 'Lease option', NOVATION: 'Novation', NURTURE: 'Nurture',
}
const titleize = (s: string | null | undefined) => (s ? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : null)

function ReadinessBadge({ state }: { state: OfferReadinessState }) {
  const meta = READINESS_META[state]
  return <span className={cls('pof-ready', `is-${state}`)}><i aria-hidden="true" />{meta.label}</span>
}

type OfferFilter = 'all' | 'needs_validation' | 'authorized' | 'offer_stage'

/**
 * What of the engine's numbers can be put on a scale. The engine's valuation
 * is believed only when it sits in the same range as the property's recorded
 * value (a contaminated comp set can price a duplex at $300M); a
 * recommendation far outside the value is shown and named, never charted.
 */
function offerSanity(row: PipelineOfferRow) {
  const { card, engine } = row
  const pos = (v: number | null | undefined) => (typeof v === 'number' && v > 0 ? v : null)
  const recorded = pos(card.money.value)
  const engineMid = pos(engine?.mid)
  const engineValueOff = Boolean(engineMid && recorded && (engineMid > recorded * 3 || engineMid < recorded / 3))
  const value = engineValueOff ? recorded : (engineMid ?? recorded)
  const recommended = pos(engine?.recommended)
  const floor = pos(engine?.floor)
  const outOfRange = Boolean(recommended && (engineValueOff || (value && recommended > value * 3)))
  return {
    recorded,
    engineMid,
    engineValueOff,
    value,
    valueLabel: engineMid && !engineValueOff ? 'Engine value' : 'Recorded value',
    recommended,
    floor,
    outOfRange,
    low: engineValueOff ? null : pos(engine?.low),
    high: engineValueOff ? null : pos(engine?.high),
  }
}

export function PipelineOffersView({ data, loading, error, onRetry, onOpen, onValidate, now }: {
  data: PipelineOffers | null
  loading: boolean
  error: string | null
  onRetry: () => void
  onOpen: (card: PipelineCommandCard) => void
  onValidate: (card: PipelineCommandCard) => void
  now: number
}) {
  const [filter, setFilter] = useState<OfferFilter>('all')
  if (!data) {
    if (error) return <StateBlock icon="alert-circle" title="Offers didn’t load" detail={/404|not.?found/i.test(error) ? 'The offers read isn’t available on this API yet.' : 'Nothing was changed. Try again in a moment.'} action={<button type="button" className="pdv-btn" onClick={onRetry}>Retry</button>} />
    return (
      <section className="pof" aria-busy="true">
        <div className="pof-figs">{Array.from({ length: 6 }).map((_, i) => <span key={i} className="pdv-ghost is-fig" />)}</div>
        <div className="pof-grid">{Array.from({ length: 4 }).map((_, i) => <span key={i} className="pdv-ghost is-offer" />)}</div>
      </section>
    )
  }
  const t = data.totals
  const rows = data.rows.filter((r) => (
    filter === 'all' ? true
      : filter === 'offer_stage' ? r.card.stage === 'offer'
        : r.readiness.state === filter))
  const filters: Array<{ key: OfferFilter; label: string; n: number }> = [
    { key: 'all', label: 'All', n: data.rows.length },
    { key: 'needs_validation', label: 'Needs validation', n: data.rows.filter((r) => r.readiness.state === 'needs_validation').length },
    { key: 'authorized', label: 'Authorized', n: data.rows.filter((r) => r.readiness.state === 'authorized').length },
    { key: 'offer_stage', label: 'Offer stage', n: data.rows.filter((r) => r.card.stage === 'offer').length },
  ]
  return (
    <section className={cls('pof', loading && 'is-refreshing')} aria-label="Offers">
      <div className="pof-figs">
        <Fig label="Engine-priced deals" value={fmt(t.priced)} hint={`${fmt(t.withEngineOffer)} with an engine offer`} />
        <Fig label="At the Offer stage" value={fmt(t.atOfferStage)} />
        <Fig label="Authorized to present" value={fmt(t.authorized)} tone={t.authorized ? 'good' : undefined} />
        <Fig label="Need validation" value={fmt(t.needsValidation)} tone={t.needsValidation ? 'warn' : undefined} hint={t.thinCoverage ? `${fmt(t.thinCoverage)} on thin comp coverage` : null} />
        <Fig label="Offers sent" value={fmt(t.sent)} hint={t.offerRecords ? `${fmt(t.offerRecords)} offer record${t.offerRecords === 1 ? '' : 's'} on file` : 'No offer records yet'} />
        <Fig label="Accepted" value={fmt(t.accepted)} tone={t.accepted ? 'good' : undefined} hint={t.countered ? `${fmt(t.countered)} with a seller counter` : null} />
      </div>

      <div className="pof-layout">
        <div className="pof-main">
          <div className="pof-bar">
            <nav className="pof-filter" role="tablist" aria-label="Offer readiness">
              {filters.map((f) => (
                <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} className={cls(filter === f.key && 'is-on')} onClick={() => setFilter(f.key)}>
                  {f.label}<em>{f.n}</em>
                </button>
              ))}
            </nav>
            <span className="pof-bar__note">Engine numbers are recommendations, not offers — only the negotiation can present one.</span>
          </div>
          {rows.length ? (
            <div className="pof-grid">
              {rows.map((r, i) => <OfferCard key={r.card.id} row={r} index={i} now={now} onOpen={onOpen} onValidate={onValidate} />)}
            </div>
          ) : (
            <StateBlock icon="dollar-sign" title="Nothing here" detail="No deal in the current view matches this filter." />
          )}
          {data.truncated ? <p className="pdv-note">Showing the first {fmt(data.rows.length)} priced deals.</p> : null}
        </div>

        <aside className="pof-aside">
          <section className="pof-cover">
            <header>
              <h3>Comp coverage by market</h3>
              <small>Median qualified comps per priced deal · under {data.thresholds.compCoverageMin} is thin</small>
            </header>
            {data.markets.length ? (
              <ul>
                {data.markets.map((m, i) => (
                  <li key={m.market} className={cls(m.thinCoverage && 'is-thin')} style={{ '--i': Math.min(i, 8) } as CSSProperties}>
                    <span className="pof-cover__market">
                      <b>{m.market}</b>
                      <small>{m.deals} deal{m.deals === 1 ? '' : 's'}{m.needsValidation ? ` · ${m.needsValidation} to validate` : ''}{m.authorized ? ` · ${m.authorized} authorized` : ''}</small>
                    </span>
                    <span className="pof-cover__comps">
                      <b>{m.medianComps ?? '—'}</b>
                      <small>{m.thinCoverage ? 'thin' : 'comps'}</small>
                    </span>
                  </li>
                ))}
              </ul>
            ) : <p className="pdv-empty">No priced deals in this view.</p>}
          </section>
          <section className="pof-policy">
            <h3>When an offer is authorized</h3>
            <ul>
              <li>The engine tier is an offer tier (hard or range offer).</li>
              <li>At least {data.thresholds.compCoverageMin} qualified comps back the valuation.</li>
              <li>The negotiation policy hasn’t withheld the number.</li>
            </ul>
            <p>Anything else is validated in Deal Intelligence, where the evidence and the engine re-run live.</p>
          </section>
        </aside>
      </div>
    </section>
  )
}

function Fig({ label, value, hint, tone }: { label: string; value: string; hint?: string | null; tone?: 'good' | 'warn' }) {
  return (
    <div className={cls('pdv-fig', tone && `is-${tone}`)}>
      <b>{value}</b>
      <span>{label}</span>
      {hint ? <small>{hint}</small> : null}
    </div>
  )
}

function OfferCard({ row, index, now, onOpen, onValidate }: {
  row: PipelineOfferRow
  index: number
  now: number
  onOpen: (card: PipelineCommandCard) => void
  onValidate: (card: PipelineCommandCard) => void
}) {
  const { card, engine, offer, readiness } = row
  const reasons = validationReasons(row)
  const failedGates = readiness.gates.filter((g) => !g.pass)
  const ask = row.askImplausible ? null : card.money.asking
  // A recommendation (or valuation) far outside the property's own value is
  // shown, and named, but kept off the ladder so it cannot flatten the range.
  const { value, valueLabel, recommended, floor, outOfRange, engineValueOff, engineMid, recorded, low, high } = offerSanity(row)
  const spreadAsk = recommended && ask && !outOfRange ? Math.round((recommended / ask) * 100) : null
  const spreadValue = recommended && value && !outOfRange ? Math.round((recommended / value) * 100) : null
  const evidence = [
    engine?.compCount !== null && engine?.compCount !== undefined ? `${engine.compCount} comp${engine.compCount === 1 ? '' : 's'}` : null,
    engine?.confidence !== null && engine?.confidence !== undefined ? `confidence ${Math.round(engine.confidence)}` : null,
    engine?.valuationConfidence !== null && engine?.valuationConfidence !== undefined ? `valuation ${Math.round(engine.valuationConfidence)}` : null,
    engine?.strategy ? STRATEGY_LABEL[engine.strategy] ?? titleize(engine.strategy) : null,
    engine?.computedAt ? `priced ${relTime(engine.computedAt, now) ?? ''} ago` : null,
  ].filter(Boolean)
  const offerStatus = offer
    ? `${titleize(offer.status) ?? 'Recorded'}${offer.version ? ` · v${offer.version}` : ''}${offer.price ? ` · ${compactMoney(offer.price)}` : ''}${relTime(offer.sentAt || offer.createdAt, now) ? ` · ${relTime(offer.sentAt || offer.createdAt, now)} ago` : ''}`
    : 'No offer sent'
  return (
    <article className={cls('pof-card', `is-${readiness.state}`)} style={{ '--i': Math.min(index, 8), '--tone': STAGE_TONE[card.stage] ?? 'var(--plc-s-early)' } as CSSProperties}>
      <header className="pof-card__head">
        <span className="pof-stage"><i />S{card.stageIndex ?? '–'}<em>{card.stageLabel}</em></span>
        <ReadinessBadge state={readiness.state} />
      </header>
      <button type="button" className="pof-card__title" onClick={() => onOpen(card)}>
        <b>{card.address || 'Address not on file'}</b>
        <small>{[card.seller, card.market, card.propertyType].filter(Boolean).join(' · ') || 'Seller not resolved'}</small>
      </button>

      <div className="pof-card__figs">
        <div className={cls('is-offer', outOfRange && 'is-flag')}>
          <b>{recommended ? (floor && floor < recommended ? `${compactMoney(floor)}–${compactMoney(recommended)}` : compactMoney(recommended)) : '—'}</b>
          <span>{outOfRange ? 'Engine offer · unvalidated' : 'Engine offer'}</span>
        </div>
        <div className={cls(row.askImplausible && 'is-flag')}>
          <b>{compactMoney(card.money.asking) ?? '—'}</b>
          <span>{row.askImplausible ? 'Ask · looks mis-captured' : 'Seller ask'}</span>
        </div>
        <div>
          <b>{compactMoney(value) ?? '—'}</b>
          <span>{valueLabel}</span>
        </div>
        <div>
          <b>{spreadAsk !== null ? `${spreadAsk}%` : spreadValue !== null ? `${spreadValue}%` : '—'}</b>
          <span>{spreadAsk !== null ? 'Offer / ask' : spreadValue !== null ? 'Offer / value' : 'Spread'}</span>
        </div>
      </div>

      <OfferLadder low={low} high={high} value={value} floor={floor} recommended={outOfRange ? null : recommended} ask={ask} />
      {engineValueOff ? (
        <p className="pof-card__warn"><Icon name="alert" size={13} />The engine valued this at {compactMoney(engineMid)} against a recorded {compactMoney(recorded)} — its numbers are shown, not charted, and treated as unvalidated.</p>
      ) : outOfRange ? (
        <p className="pof-card__warn"><Icon name="alert" size={13} />The engine offer ({compactMoney(recommended)}) is far outside this property’s value — treat it as unvalidated.</p>
      ) : null}

      {evidence.length ? <p className="pof-card__evidence">{evidence.join(' · ')}{engine?.tierLabel ? <em>{engine.tierLabel}</em> : null}</p> : null}

      {reasons.length ? (
        <ul className="pof-card__reasons">
          {reasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      ) : null}
      {failedGates.length ? (
        <p className="pof-card__gates" title="The engine's hard-offer gates — informational for range offers">
          <span>Hard-offer gates</span>
          {failedGates.map((g) => <em key={g.key}>{g.label}</em>)}
        </p>
      ) : null}

      <footer className="pof-card__foot">
        <span className={cls('pof-status', offer && 'has-offer')}>
          <Icon name={offer ? 'send' : 'clock'} size={12} />
          {offerStatus}
          {card.money.counter ? <em className={cls(row.counterImplausible && 'is-flag')}>Counter {compactMoney(card.money.counter)}{row.counterImplausible ? ' · looks mis-captured' : ''}</em> : null}
        </span>
        <span className="pof-actions">
          <button type="button" className="pdv-btn is-ghost" onClick={() => onOpen(card)}>Open deal</button>
          <button type="button" className={cls('pdv-btn', readiness.state === 'needs_validation' && 'is-attn')} onClick={() => onValidate(card)} disabled={!card.threadKey && !card.propertyId}>
            {readiness.state === 'needs_validation' ? 'Validate in Deal Intelligence' : 'Deal Intelligence'}<Icon name="arrow-up-right" size={12} />
          </button>
        </span>
      </footer>
    </article>
  )
}

/** Value range, engine offer band, value and ask marks on one scale. */
function OfferLadder({ low, high, value, floor, recommended, ask }: {
  low: number | null
  high: number | null
  value: number | null
  floor: number | null
  recommended: number | null
  ask: number | null
}) {
  // The floor only means something beside a recommendation it bounds.
  const pts = [low, high, value, recommended ? floor : null, recommended, ask].filter((v): v is number => typeof v === 'number' && v > 0)
  if (pts.length < 2) return null
  const min = Math.min(...pts) * 0.94
  const max = Math.max(...pts) * 1.06
  const at = (v: number) => `${((v - min) / (max - min)) * 100}%`
  return (
    <div className="pof-ladder" aria-label="Offer against value and ask">
      <div className="pof-ladder__track">
        {low && high ? <span className="pof-ladder__value" style={{ left: at(low), width: `calc(${at(high)} - ${at(low)})` }} /> : null}
        {recommended ? <span className="pof-ladder__offer" style={{ left: at(floor && floor < recommended ? floor : recommended), width: floor && floor < recommended ? `calc(${at(recommended)} - ${at(floor)})` : '3px' }} /> : null}
        {value ? <span className="pof-ladder__mark is-value" style={{ left: at(value) }} /> : null}
        {ask ? <span className="pof-ladder__mark is-ask" style={{ left: at(ask) }} /> : null}
      </div>
      <div className="pof-ladder__legend">
        {recommended ? <span className="is-offer"><i />Offer</span> : null}
        {low && high ? <span className="is-range"><i />Value {compactMoney(low)}–{compactMoney(high)}</span> : null}
        {ask ? <span className="is-ask"><i />Ask</span> : null}
      </div>
    </div>
  )
}

/** Overview: the offer picture in one card, with a way into the full view. */
export function OffersOverviewCard({ data, loading, error, onOpenOffers, onOpen }: {
  data: PipelineOffers | null
  loading: boolean
  error: string | null
  onOpenOffers: () => void
  onOpen: (card: PipelineCommandCard) => void
}) {
  const top = (data?.rows ?? []).filter((r) => r.card.stage === 'offer' || r.readiness.state !== 'not_priced').slice(0, 4)
  return (
    <section className="pov" aria-label="Offers">
      <header className="pov__head">
        <span className="pdv-chip"><Icon name="dollar-sign" size={14} /></span>
        <span className="pov__title">
          <b>Offers</b>
          <small>{data ? `${data.totals.priced} engine-priced · ${data.totals.atOfferStage} at the Offer stage` : error ? 'Offers are unavailable right now' : 'Reading the engine…'}</small>
        </span>
        <button type="button" className="plc-link" onClick={onOpenOffers}>All offers</button>
      </header>
      {data ? (
        <>
          <div className="pov__figs">
            <Fig label="Authorized" value={fmt(data.totals.authorized)} tone={data.totals.authorized ? 'good' : undefined} />
            <Fig label="Need validation" value={fmt(data.totals.needsValidation)} tone={data.totals.needsValidation ? 'warn' : undefined} />
            <Fig label="Thin comp coverage" value={fmt(data.totals.thinCoverage)} />
            <Fig label="Offers sent" value={fmt(data.totals.sent)} />
          </div>
          {top.length ? (
            <ul className="pov__list">
              {top.map((r, i) => {
                const sane = offerSanity(r)
                const engineText = sane.recommended ? (sane.outOfRange ? 'Engine number out of range' : `Engine ${compactMoney(sane.recommended)}`) : null
                return (
                <li key={r.card.id} style={{ '--i': Math.min(i, 8), '--tone': STAGE_TONE[r.card.stage] ?? 'var(--plc-s-early)' } as CSSProperties}>
                  <button type="button" onClick={() => onOpen(r.card)}>
                    <span className="pov__stage"><i />S{r.card.stageIndex ?? '–'}</span>
                    <span className="pov__body">
                      <b>{r.card.address || 'Address not on file'}</b>
                      <small>{[engineText, compactMoney(r.card.money.asking) && !r.askImplausible ? `Ask ${compactMoney(r.card.money.asking)}` : null, r.engine?.compCount !== null && r.engine?.compCount !== undefined ? `${r.engine.compCount} comp${r.engine.compCount === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ') || r.card.seller || 'No figures yet'}</small>
                    </span>
                    <ReadinessBadge state={r.readiness.state} />
                  </button>
                </li>
                )
              })}
            </ul>
          ) : <p className="pdv-empty">No engine-priced deals in this view.</p>}
        </>
      ) : loading ? (
        <div className="pov__figs">{Array.from({ length: 4 }).map((_, i) => <span key={i} className="pdv-ghost is-fig" />)}</div>
      ) : null}
    </section>
  )
}
