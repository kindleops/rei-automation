/**
 * ENTITY GRAPH · OVERVIEW PAGE (owner 2026-10-12: "I didn't mean an overview
 * in the properties tab. I meant an OVERVIEW PAGE").
 *
 * The first thing Entity Graph lands on: one dashboard across every table —
 * properties, pipeline, contacts, owners, people, phones, buyers, companies —
 * each a liquid-glass card with its total, KPIs and charts, under ONE set of
 * global filters (market, state) applied to every scope that has the field.
 * A scope without that field is shown whole and says so.
 *
 * Every number is a drill: a click opens that scope's grid with the global
 * filters + the clicked chip, so the grid counts exactly the bar. The page
 * never says "Computing": the properties family is live indexed counts on the
 * property facts read model; the other scopes are the snapshot or their own
 * Overview live. Every card states its "as of".
 *
 * Motion: cards rise in staggered, totals count up, bars grow and glide on a
 * filter change (the previous numbers stay, dimmed, until the new ones land);
 * prefers-reduced-motion and the LC Animations switch turn it all off.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { LCButton, LCCombobox, cx, type LCComboOption } from '../../../../shared/lc'
import { Icon } from '../../../../shared/icons'
import type { EntityGraphFieldFilter } from '../../../../domain/entity-graph/entity-graph-field-filters'
import type { EntityScope } from '../../mobile/entity-graph-mobile-format'
import type { UniverseGlobals } from '../desk-state'
import { useCountUp } from '../overview/DeskOverview'
import { fmtInt } from '../overview/overview-model'
import { fetchUniverseScope } from './universe-api'
import {
  CARD_ICON,
  CARD_SCOPE,
  CARD_TITLE,
  UNIVERSE_PAGE_SCOPES,
  asOfText,
  chartMax,
  drillTarget,
  globalsKey,
  hasGlobals,
  orderCards,
  share,
  toggleGlobal,
  universeHeadline,
  type UniverseCard,
  type UniverseChart,
  type UniverseOptions,
} from './universe-model'
import './universe.css'

type Drill = (scope: EntityScope, filters: EntityGraphFieldFilter[]) => void
type Slot = { key: string; cards: UniverseCard[] | null; error: string | null; loading: boolean }

const CONCURRENCY = 3

/** Every scope's cards for these globals: at most three requests in flight, the last answer kept (dimmed) until the next lands. */
export function useUniverse(globals: UniverseGlobals) {
  const key = globalsKey(globals)
  const [slots, setSlots] = useState<Partial<Record<EntityScope, Slot>>>({})
  const [options, setOptions] = useState<UniverseOptions | null>(null)
  const [attempt, setAttempt] = useState<Partial<Record<EntityScope, number>>>({})
  const attemptKey = JSON.stringify(attempt)
  useEffect(() => {
    const ctl = new AbortController()
    const queue = [...UNIVERSE_PAGE_SCOPES]
    setSlots((cur) => Object.fromEntries(UNIVERSE_PAGE_SCOPES.map((s) => [s, { key, cards: cur[s]?.cards ?? null, error: null, loading: true }])))
    const worker = async () => {
      while (queue.length && !ctl.signal.aborted) {
        const scope = queue.shift()!
        try {
          const res = await fetchUniverseScope(scope, globals, ctl.signal)
          if (ctl.signal.aborted) return
          if (res.options) setOptions(res.options)
          setSlots((cur) => ({ ...cur, [scope]: { key, cards: res.cards, error: null, loading: false } }))
        } catch (e) {
          if (ctl.signal.aborted) return
          setSlots((cur) => ({ ...cur, [scope]: { key, cards: cur[scope]?.cards ?? null, error: e instanceof Error ? e.message : 'did not load', loading: false } }))
        }
      }
    }
    for (let i = 0; i < CONCURRENCY; i += 1) void worker()
    return () => ctl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key encodes the globals; attemptKey the retries
  }, [key, attemptKey])
  const byScope = useMemo(() => Object.fromEntries(Object.entries(slots).filter(([, v]) => v?.cards).map(([k, v]) => [k, v!.cards!])) as Partial<Record<EntityScope, UniverseCard[]>>, [slots])
  return { slots, byScope, options, retry: (scope: EntityScope) => setAttempt((a) => ({ ...a, [scope]: (a[scope] ?? 0) + 1 })) }
}

function CountUp({ value }: { value: number | null }) {
  const v = useCountUp(value)
  return <>{v === null ? '—' : fmtInt(v)}</>
}

export function EntityGraphUniverse({ globals, onGlobalsChange, onDrill, now = Date.now() }: {
  globals: UniverseGlobals
  onGlobalsChange: (next: UniverseGlobals) => void
  onDrill: Drill
  /** injectable for tests */
  now?: number
}) {
  const { slots, byScope, options, retry } = useUniverse(globals)
  return <UniverseView globals={globals} onGlobalsChange={onGlobalsChange} onDrill={onDrill} slots={slots} byScope={byScope} options={options} onRetry={retry} now={now} />
}

/** The page body (pure render — EntityGraphUniverse feeds it; tests render it directly). */
export function UniverseView({ globals, onGlobalsChange, onDrill, slots, byScope, options, onRetry, now }: {
  globals: UniverseGlobals
  onGlobalsChange: (next: UniverseGlobals) => void
  onDrill: Drill
  slots: Partial<Record<EntityScope, Slot>>
  byScope: Partial<Record<EntityScope, UniverseCard[]>>
  options: UniverseOptions | null
  onRetry: (scope: EntityScope) => void
  now: number
}) {
  const cards = orderCards(byScope)
  const head = universeHeadline(byScope)
  const asOf = byScope.properties?.[0]?.as_of ?? null
  const marketOptions: LCComboOption[] = (options?.markets ?? []).filter((m) => !globals.markets.includes(m.value)).map((m) => ({ value: m.value, label: m.value, meta: fmtInt(m.count), icon: 'globe' as const }))
  const stateOptions: LCComboOption[] = (options?.states ?? []).filter((s) => !globals.states.includes(s.value)).map((s) => ({ value: s.value, label: s.value, meta: fmtInt(s.count), icon: 'pin' as const }))
  const anyLoading = Object.values(slots).some((s) => s?.loading)
  return (
    <section className="egu" aria-label="Entity Graph overview" aria-busy={anyLoading}>
      <header className="egu-hero">
        <div className="egu-hero__id">
          <span className="egu-eyebrow"><span className={cx('egu-pulse', anyLoading && 'is-busy')} aria-hidden="true" />Entity Graph · Overview</span>
          <h2 className="egu-hero__title">Every table, one picture</h2>
          <p className="egu-hero__asof">{asOf ? asOfText('facts', asOf, now) : anyLoading ? 'Reading the universe…' : 'Property facts not available'}</p>
        </div>
        <ol className="egu-hero__totals" aria-label="Records per table">
          {head.map((h, i) => (
            <li key={h.id} style={{ '--i': i } as CSSProperties}>
              <button type="button" className="egu-hero__total" onClick={() => onDrill(h.id as EntityScope, drillTarget({ scope: h.id as EntityScope, applied: byScope[h.id as EntityScope]?.[0]?.applied ?? [] }, null).filters)} title={`Open ${h.label} in the grid`}>
                <span>{h.label}</span>
                <b>{h.value === null ? <i className="lc-skel egu-skel-num" /> : <CountUp value={h.value} />}</b>
              </button>
            </li>
          ))}
        </ol>
      </header>

      <div className="egu-filters" role="toolbar" aria-label="Global filters">
        <span className="egu-filters__label"><Icon name="filter" size={12} /> Applied to every table that has the field</span>
        <div className="egu-filters__pick">
          <LCCombobox label="Add market" placeholder="Market…" icon="globe" options={marketOptions} value={null} onChange={(v) => onGlobalsChange(toggleGlobal(globals, 'markets', v))} emptyText={options ? 'No more markets' : 'Reading markets…'} className="egu-filters__combo" />
          <LCCombobox label="Add state" placeholder="State…" icon="pin" options={stateOptions} value={null} onChange={(v) => onGlobalsChange(toggleGlobal(globals, 'states', v))} emptyText={options ? 'No more states' : 'Reading states…'} className="egu-filters__combo is-narrow" />
        </div>
        <ul className="egu-chips" aria-label="Active global filters">
          {globals.markets.map((m) => <li key={`m:${m}`}><button type="button" className="egu-chip" onClick={() => onGlobalsChange(toggleGlobal(globals, 'markets', m))} aria-label={`Remove market ${m}`}><em>Market</em>{m}<Icon name="x" size={11} /></button></li>)}
          {globals.states.map((s) => <li key={`s:${s}`}><button type="button" className="egu-chip" onClick={() => onGlobalsChange(toggleGlobal(globals, 'states', s))} aria-label={`Remove state ${s}`}><em>State</em>{s}<Icon name="x" size={11} /></button></li>)}
        </ul>
        {hasGlobals(globals) ? <LCButton size="sm" variant="quiet" onClick={() => onGlobalsChange({ markets: [], states: [] })}>Clear</LCButton> : null}
      </div>

      <div className="egu-grid">
        {cards.map(({ id, card }, i) => {
          const scope = CARD_SCOPE[id]
          const slot = slots[scope]
          return (
            <UniverseCardView
              key={id}
              id={id}
              index={i}
              card={card}
              loading={Boolean(slot?.loading)}
              error={slot?.error ?? null}
              onRetry={() => onRetry(scope)}
              onDrill={onDrill}
              now={now}
            />
          )
        })}
      </div>
    </section>
  )
}

const SOURCE_WORD: Record<string, string> = { facts: 'Live', snapshot: 'Snapshot', live: 'Live' }

export function UniverseCardView({ id, index, card, loading, error, onRetry, onDrill, now }: {
  id: keyof typeof CARD_TITLE
  index: number
  card: UniverseCard | null
  loading: boolean
  error: string | null
  onRetry: () => void
  onDrill: Drill
  now: number
}) {
  const title = CARD_TITLE[id]
  const style = { '--i': index } as CSSProperties
  const drill = (chip: EntityGraphFieldFilter | null | undefined) => {
    if (!card) return
    const t = drillTarget(card, chip)
    onDrill(t.scope, t.filters)
  }
  if (!card) {
    return (
      <article className={cx('egu-card', `is-${id}`, error ? 'is-error' : 'is-skeleton')} style={style} aria-label={title} aria-busy={!error}>
        <CardHead id={id} title={title} />
        {error ? (
          <div className="egu-card__state" role="alert"><Icon name="alert-circle" size={14} /> {title} did not load — {error} <LCButton size="sm" variant="quiet" onClick={onRetry}>Retry</LCButton></div>
        ) : (
          <div className="egu-card__skel" aria-hidden="true"><i className="lc-skel egu-skel-hero" /><i className="lc-skel egu-skel-line" /><i className="lc-skel egu-skel-bars" /></div>
        )}
      </article>
    )
  }
  const total = card.total
  return (
    <article className={cx('egu-card', `is-${id}`, loading && 'is-stale')} style={style} aria-label={title} aria-busy={loading}>
      <CardHead id={id} title={title} source={card.source} asOf={asOfText(card.source, card.as_of, now)} />
      {card.unavailable ? (
        <div className="egu-card__state"><Icon name="clock" size={14} /> {card.unavailable}</div>
      ) : (
        <>
          <button type="button" className="egu-card__total" onClick={() => drill(card.totalFilter ?? null)} title={`Open these ${title.toLowerCase()} in the grid`}>
            <b><CountUp value={total} /></b>
            <em>{card.totalLabel ?? (id === 'contact_methods' ? 'phones' : title.toLowerCase())}</em>
            <Icon name="arrow-up-right" size={13} />
          </button>
          {card.kpis.length ? (
            <ul className="egu-kpis" aria-label={`${title} metrics`}>
              {card.kpis.map((k) => (
                <li key={k.key}>
                  <button type="button" className="egu-kpi" disabled={!k.filter} onClick={() => drill(k.filter)} title={k.filter ? `Open these in the ${CARD_SCOPE[id] === 'properties' ? 'properties' : title.toLowerCase()} grid` : undefined}>
                    <span>{k.label}</span>
                    <b>{k.value === null ? '—' : <CountUp value={k.value} />}</b>
                    <em>{id === 'pipeline' ? '' : share(k.value, card.total)}</em>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="egu-charts">
            {card.charts.map((c) => <UniverseChartView key={c.key} chart={c} onPick={drill} />)}
          </div>
        </>
      )}
      <footer className="egu-card__foot">
        {card.appliedMeans?.length ? <span className="egu-card__applied">{card.appliedMeans.map((a) => `${a.means}: ${a.value.join(', ')}`).join(' · ')}</span> : null}
        {card.ignored?.length ? <span className="egu-card__ignored" title={card.ignored.map((x) => x.reason).join('\n')}><Icon name="slash" size={11} /> {card.ignored.map((x) => (x.key === 'markets' ? 'every market' : 'every state')).join(' · ')}</span> : null}
        {card.partial ? <span className="egu-card__ignored">{card.partial}</span> : null}
        <button type="button" className="egu-link" onClick={() => drill(null)}>Open grid <Icon name="chevron-right" size={12} /></button>
      </footer>
    </article>
  )
}

function CardHead({ id, title, source, asOf }: { id: keyof typeof CARD_TITLE; title: string; source?: string | null; asOf?: string }) {
  return (
    <header className="egu-card__head">
      <span className="egu-card__glyph" aria-hidden="true"><Icon name={CARD_ICON[id]} size={14} /></span>
      <h3>{title}</h3>
      {source ? <span className={cx('egu-src', `is-${source}`)} title={asOf}><i aria-hidden="true" />{SOURCE_WORD[source] ?? source}</span> : null}
      {asOf ? <span className="egu-card__asof">{asOf.replace(/^As of /, '').replace(/ · .*$/, '')}</span> : null}
    </header>
  )
}

export function UniverseChartView({ chart, onPick }: { chart: UniverseChart; onPick: (f: EntityGraphFieldFilter | null) => void }) {
  if (chart.unavailable) return <div className="egu-chart is-na"><h4>{chart.label}</h4><p><Icon name="clock" size={12} /> {chart.unavailable}</p></div>
  const max = chartMax(chart.buckets)
  const histogram = chart.form === 'histogram'
  return (
    <figure className={cx('egu-chart', histogram ? 'is-histogram' : 'is-bars')} aria-label={chart.label}>
      <figcaption>{chart.label}</figcaption>
      <ol className="egu-chart__list">
        {chart.buckets.map((b, i) => {
          const pct = Math.max(b.count > 0 ? 0.015 : 0, Math.min(1, b.count / max))
          const body = (
            <>
              <span className="egu-bar__label">{b.label}</span>
              <span className="egu-bar__track" aria-hidden="true"><i className={cx('egu-bar__fill', b.tone && `is-${b.tone}`)} style={{ '--v': pct, '--i': i } as CSSProperties} /></span>
              <b className="egu-bar__n">{fmtInt(b.count)}</b>
            </>
          )
          return (
            <li key={`${b.key ?? 'none'}`}>
              {b.filter ? (
                <button type="button" className="egu-bar" onClick={() => onPick(b.filter)} title={`${b.label}: ${fmtInt(b.count)} — open in the grid`}>{body}</button>
              ) : (
                <div className="egu-bar is-context" title={b.tone === 'none' ? 'Not recorded — context, not a filter' : 'The rest, grouped — pick a value to filter'}>{body}</div>
              )}
            </li>
          )
        })}
      </ol>
    </figure>
  )
}
