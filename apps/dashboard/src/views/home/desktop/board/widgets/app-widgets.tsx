import { useSyncExternalStore } from 'react'
import { ObjectMenu, dealObject, handleObjectClick, objectAttrs, propertyObject } from '../../../../../modules/desktop/objects'
import { openInboxDealIntelligence } from '../../../../../modules/mobile/mobile-inbox-bridge'
import { readRecent } from '../../../../../modules/browser/session-store'
import { launchBrowser } from '../../../../../modules/browser/research-launch'
import { newNonce } from '../../../../../modules/browser/intent'
import { holdLabel } from '../../../../queue/desk/queue-desk-model'
import { relativeTime } from '../../../home-signals'
import { money } from '../../command/home-command-model'
import { instrumentSource, type DealItem } from '../board-data'
import { cx, fmt, openPath, useNow, useWidgetSource } from '../widget-runtime'
import { WEmpty, WFacts, WFigure, WState } from '../widget-ui'
import type { WidgetRenderProps } from '../widget-registry'

/**
 * App instruments for Deal Intelligence, Comps, Buyer Match, Entity Graph,
 * Queue and Browser. The first five read /api/cockpit/home/instruments (one
 * narrow cached read per app, the app's own tables and rules); Browser reads
 * the Browser's own on-device recent-research list. Nothing is estimated to
 * fill a space; an empty reading says what it means.
 */

const short = (s: string | null | undefined, n = 42) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s ?? '')
const tierLabel = (t: string | null) => (t ? t.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : 'Not scored')
const rowsFor = (h: number, reserve = 3) => Math.max(1, Math.min(8, h - reserve))

/* ── Deal Intelligence ─────────────────────────────────────────────── */

function DealRow({ d }: { d: DealItem }) {
  const ref = dealObject({ opportunityId: d.opportunityId, propertyId: d.propertyId, threadKey: d.threadKey, masterOwnerId: d.masterOwnerId, stage: d.stage, label: d.address, source: 'home' })
  return (
    <li>
      <ObjectMenu object={ref}>
        <button type="button" className="hb-list__row" {...objectAttrs(ref)} onClick={(e) => handleObjectClick(e, ref, () => openInboxDealIntelligence({ propertyId: d.propertyId, threadKey: d.threadKey, masterOwnerId: d.masterOwnerId }))}>
          <span className={cx('hb-dot', d.tier === 'REVIEW_REQUIRED' ? 'is-attn' : 'is-exec')} aria-hidden="true" />
          <span className="hb-list__main"><strong>{short(d.address) || 'Property'}</strong><small>{[tierLabel(d.tier), d.market].filter(Boolean).join(' · ')}</small></span>
          <em title="Engine confidence / valuation confidence">{d.confidence ?? '—'} / {d.valuationConfidence ?? '—'}</em>
        </button>
      </ObjectMenu>
    </li>
  )
}

export function DealIntelWidget({ size, cells }: WidgetRenderProps) {
  const { load, reload } = useWidgetSource(instrumentSource('deal'))
  return (
    <WState load={load} what="deal decisions" onRetry={reload} shape={size === 'compact' ? 'metric' : 'lines'}>
      {(d) => (
        <div className={cx('hb-di', `is-${size}`)}>
          <div className="hb-row">
            <WFigure value={fmt(d.review)} label="need review" tone={d.review ? 'attn' : null} onClick={() => openPath('/deal-intelligence')} />
            <WFigure value={fmt(d.lowConfidence)} label="low confidence" tone={d.lowConfidence ? 'attn' : null} />
            {size !== 'compact' ? <WFigure value={fmt(d.offersAwaiting)} label="offers awaiting" tone={d.offersAwaiting ? 'exec' : null} /> : null}
          </div>
          {size !== 'compact' ? <WFacts items={[{ label: 'Scored deals', value: `${fmt(d.scored)} of ${fmt(d.active)}`, title: 'Active opportunities with an acquisition score' }, { label: 'Not yet scored', value: fmt(d.unscored) }]} /> : null}
          {size === 'compact' || size === 'small' ? null : (d.reviewItems.length || d.lowItems.length) ? (
            <ul className="hb-list">{[...d.reviewItems, ...d.lowItems].slice(0, rowsFor(cells.h)).map((x) => <DealRow key={x.opportunityId} d={x} />)}</ul>
          ) : <WEmpty>No scored deal needs a decision.</WEmpty>}
          {size === 'large' || size === 'tall' ? <p className="hb-muted">Low confidence: {d.rules.lowConfidence}.</p> : null}
        </div>
      )}
    </WState>
  )
}

/* ── Comps ──────────────────────────────────────────────────────────── */

export function CompsWidget({ size, cells }: WidgetRenderProps) {
  const { load, reload } = useWidgetSource(instrumentSource('comps'))
  return (
    <WState load={load} what="recent sales" onRetry={reload} shape={size === 'compact' ? 'metric' : 'lines'}>
      {(c) => {
        const stale = c.freshnessDays != null && c.freshnessDays > 45
        return (
          <div className={cx('hb-comps', `is-${size}`)}>
            <div className="hb-row">
              <WFigure value={c.freshnessDays == null ? '—' : `${c.freshnessDays}d`} label="newest priced sale" tone={stale ? 'attn' : 'ok'} sub={c.newestSale ? new Date(`${c.newestSale}T12:00:00Z`).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : null} onClick={() => openPath('/comp-intelligence')} />
              {size !== 'compact' ? <WFigure value={fmt(c.sales90)} label="priced sales · 90 days" sub={`${fmt(c.activity90)} recorded sales incl. unpriced`} /> : null}
            </div>
            {stale && size !== 'compact' ? <p className="hb-muted">The newest priced sale on record is {c.freshnessDays} days old — recorded sales arrive with a lag.</p> : null}
            {size !== 'compact' && size !== 'small' && c.activeMarkets.length ? (
              <WFacts items={c.activeMarkets.map((m) => ({ label: m.market, value: `${fmt(m.comps90)} sales`, title: `${m.deals} active deals · priced sales within ~25 mi of them, last 90 days` }))} />
            ) : null}
            {size === 'large' || size === 'tall' || size === 'wide' ? (
              c.recent.length ? (
                <ul className="hb-list">
                  {c.recent.slice(0, rowsFor(cells.h, 4)).map((s) => {
                    const ref = s.propertyId ? propertyObject({ propertyId: s.propertyId, label: s.address, lat: s.lat, lng: s.lng, source: 'home' }) : null
                    const row = (
                      <button type="button" className="hb-list__row" {...objectAttrs(ref)} disabled={!ref} onClick={(e) => { if (ref) handleObjectClick(e, ref) }}>
                        <span className="hb-dot is-ok" aria-hidden="true" />
                        <span className="hb-list__main"><strong>{short(s.address) || 'Sale'}</strong><small>{[s.type, s.ppsf ? `$${Math.round(s.ppsf)}/sf` : null, new Date(`${s.soldOn}T12:00:00Z`).toLocaleDateString([], { month: 'short', day: 'numeric' })].filter(Boolean).join(' · ')}</small></span>
                        <em>{money(s.price)}</em>
                      </button>
                    )
                    return <li key={s.id}>{ref ? <ObjectMenu object={ref}>{row}</ObjectMenu> : row}</li>
                  })}
                </ul>
              ) : <WEmpty icon="clock">No priced sales on record.</WEmpty>
            ) : null}
          </div>
        )
      }}
    </WState>
  )
}

/* ── Buyer Match ────────────────────────────────────────────────────── */

export function BuyersWidget({ size, cells }: WidgetRenderProps) {
  const { load, reload } = useWidgetSource(instrumentSource('buyers'))
  return (
    <WState load={load} what="buyer matches" onRetry={reload} shape={size === 'compact' ? 'metric' : 'lines'}>
      {(b) => (
        <div className={cx('hb-buyers', `is-${size}`)}>
          <div className="hb-row">
            <WFigure value={`${fmt(b.dealsWithMatches)}`} label={`of ${fmt(b.activeDeals)} deals matched`} onClick={() => openPath('/buyer-match')} />
            {size !== 'compact' ? <WFigure value={fmt(b.candidates)} label="candidates" tone="flow" /> : null}
            {size !== 'compact' && size !== 'small' ? <WFigure value={fmt(b.contacted)} label="contacted" /> : null}
          </div>
          {size === 'compact' ? null : b.strongest.length ? (
            <ul className="hb-list">
              {b.strongest.slice(0, size === 'small' ? 1 : rowsFor(cells.h, size === 'medium' ? 3 : 5)).map((s) => {
                const ref = propertyObject({ propertyId: s.propertyId, threadKey: s.threadKey, opportunityId: s.opportunityId, label: s.address, source: 'home' })
                return (
                  <li key={s.propertyId}>
                    <ObjectMenu object={ref}>
                      <button type="button" className="hb-list__row" {...objectAttrs(ref)} onClick={(e) => handleObjectClick(e, ref, () => openPath(`/buyer-match?property_id=${encodeURIComponent(s.propertyId)}`))}>
                        <span className="hb-dot is-flow" aria-hidden="true" />
                        <span className="hb-list__main"><strong>{short(s.address) || 'Deal'}</strong><small>{[s.bestGrade ? `Grade ${s.bestGrade}` : null, s.bestBuyerType, `${s.candidates} candidates`].filter(Boolean).join(' · ')}</small></span>
                        <em title="Best match score">{s.bestScore != null ? Math.round(s.bestScore) : '—'}</em>
                      </button>
                    </ObjectMenu>
                  </li>
                )
              })}
            </ul>
          ) : <WEmpty icon="clock">No buyer matches have been run for active deals.</WEmpty>}
          {(size === 'large' || size === 'wide' || size === 'tall') && b.demand.length ? (
            <section aria-label="Investor demand by market">
              <p className="hb-eyebrow">Investor purchases · 90 days</p>
              <WFacts items={b.demand.map((m) => ({ label: m.market, value: `${fmt(m.investorPurchases90)} of ${fmt(m.sales90)}`, title: 'Recorded purchases by non-individual buyers / all recorded sales, last 90 days' }))} />
            </section>
          ) : null}
          {size !== 'compact' ? <p className="hb-muted">{b.privacy}</p> : null}
        </div>
      )}
    </WState>
  )
}

/* ── Entity Graph ───────────────────────────────────────────────────── */

export function EntityWidget({ size, cells }: WidgetRenderProps) {
  const { load, reload } = useWidgetSource(instrumentSource('entity'))
  return (
    <WState load={load} what="the entity graph" onRetry={reload} shape={size === 'compact' ? 'metric' : 'lines'}>
      {(e) => (
        <div className={cx('hb-entity', `is-${size}`)}>
          <div className="hb-row">
            <WFigure value={fmt(e.owners)} label="owners resolved" sub={e.ownersEstimated ? 'planner estimate' : null} onClick={() => openPath('/entity-graph')} />
            {size !== 'compact' && e.connected[0] ? <WFigure value={fmt(e.connected[0].properties)} label="largest portfolio" /> : null}
          </div>
          {size === 'compact' ? null : e.connected.length ? (
            <ul className="hb-list">
              {e.connected.slice(0, size === 'small' ? 2 : rowsFor(cells.h)).map((o) => (
                <li key={o.id}>
                  <button type="button" className="hb-list__row" onClick={() => openPath("/entity-graph")} title="Open Entity Graph">
                    <span className="hb-dot is-flow" aria-hidden="true" />
                    <span className="hb-list__main"><strong>{short(o.name, 36)}</strong><small>{[o.markets.join(', '), o.value ? money(o.value) : null].filter(Boolean).join(' · ')}</small></span>
                    <em>{fmt(o.properties)} props</em>
                  </button>
                </li>
              ))}
            </ul>
          ) : <WEmpty>No multi-property owners resolved yet.</WEmpty>}
        </div>
      )}
    </WState>
  )
}

/* ── Queue ──────────────────────────────────────────────────────────── */

export function QueueWidget({ size, cells }: WidgetRenderProps) {
  const { load, reload } = useWidgetSource(instrumentSource('queue'))
  return (
    <WState load={load} what="the queue" onRetry={reload} shape={size === 'compact' ? 'metric' : 'lines'}>
      {(q) => {
        const max = q.reasons[0]?.count ?? 1
        return (
          <div className={cx('hb-queue', `is-${size}`)}>
            <div className="hb-row">
              <WFigure value={fmt(q.held)} label="held" tone={q.held ? 'attn' : null} onClick={() => openPath('/queue')} />
              <WFigure value={fmt(q.senders.remainingToday)} label="sends left today" tone="exec" sub={`of ${fmt(q.senders.dailyCapacity)} daily`} />
              {size !== 'compact' ? <WFigure value={`${q.senders.active}/${q.senders.total}`} label="senders active" tone={q.senders.flagged ? 'crit' : null} /> : null}
            </div>
            {size !== 'compact' && (q.senders.cooling || q.senders.flagged) ? <WFacts items={[{ label: 'Cooling', value: fmt(q.senders.cooling), tone: q.senders.cooling ? 'attn' : null }, { label: 'Spam-flagged', value: fmt(q.senders.flagged), tone: q.senders.flagged ? 'crit' : null }]} /> : null}
            {size === 'compact' || size === 'small' ? null : q.reasons.length ? (
              <section aria-label="Held by reason">
                <p className="hb-eyebrow">Held by reason</p>
                <ul className="hb-bars-list">
                  {q.reasons.slice(0, rowsFor(cells.h, 4)).map((r) => (
                    <li key={r.code}><span>{holdLabel(r.code)}</span><b>{fmt(r.count)}</b><i style={{ width: `${Math.max(4, (r.count / max) * 100)}%` }} aria-hidden="true" /></li>
                  ))}
                </ul>
              </section>
            ) : <WEmpty>Nothing is held.</WEmpty>}
            {size !== 'compact' ? <p className="hb-muted">Capacity uses {q.note}.</p> : null}
          </div>
        )
      }}
    </WState>
  )
}

/* ── Browser ────────────────────────────────────────────────────────── */

const RECENT_KEY_PREFIX = 'lc.browser'
let recentVersion = 0
const subscribeRecent = (l: () => void) => {
  const on = (e: StorageEvent) => { if (!e.key || e.key.startsWith(RECENT_KEY_PREFIX)) { recentVersion += 1; l() } }
  const focus = () => { recentVersion += 1; l() }
  window.addEventListener('storage', on)
  window.addEventListener('focus', focus)
  return () => { window.removeEventListener('storage', on); window.removeEventListener('focus', focus) }
}
let recentCache: { v: number; list: ReturnType<typeof readRecent> } | null = null
const getRecent = () => { if (!recentCache || recentCache.v !== recentVersion) recentCache = { v: recentVersion, list: readRecent() }; return recentCache.list }

export function BrowserWidget({ size, cells }: WidgetRenderProps) {
  const recent = useSyncExternalStore(subscribeRecent, getRecent, getRecent)
  const now = useNow()
  return (
    <div className={cx('hb-browser', `is-${size}`)}>
      <div className="hb-row">
        <WFigure value={fmt(recent.length)} label="recent research" onClick={() => openPath('/browser')} />
        {size !== 'compact' && recent[0] ? <WFigure value={relativeTime(new Date(recent[0].at).toISOString(), now)} label="last opened" /> : null}
      </div>
      {size === 'compact' ? null : recent.length ? (
        <ul className="hb-list">
          {recent.slice(0, size === 'small' ? 1 : rowsFor(cells.h)).map((r) => (
            <li key={r.url}>
              <button type="button" className="hb-list__row" onClick={() => launchBrowser({ do: 'search', q: r.url, nonce: newNonce() })} title={r.url}>
                <span className="hb-dot is-exec" aria-hidden="true" />
                <span className="hb-list__main"><strong>{short(r.title || r.host, 40)}</strong><small>{[r.host, r.context].filter(Boolean).join(' · ')}</small></span>
                <em>{relativeTime(new Date(r.at).toISOString(), now)}</em>
              </button>
            </li>
          ))}
        </ul>
      ) : <WEmpty icon="clock">No research opened on this device yet.</WEmpty>}
      {size !== 'compact' ? <p className="hb-muted">Recent research is kept on this device; saved sources live with each property in the Browser.</p> : null}
    </div>
  )
}
