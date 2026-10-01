/**
 * PIPELINE DESK · OVERVIEW PLANES
 *
 *   Moving now   the machine's activity: what is in flight in the queue right
 *                now, what it drafted and is holding for review, and the real
 *                movement of the period (history + seller replies)
 *   Whose move   the machine-ownership read model — AUTOPILOT · SCHEDULED ·
 *                WAITING ON SELLER · EXTERNAL · NEEDS YOU · BLOCKED, plus the
 *                facets MOVING NOW and STALLED — and the exceptions, each with
 *                the evidence that put it there
 *   Offers       autonomous · system resolving · exception · not being worked
 */
import { useMemo, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { LCActivityFeed, LCButton, LCEmpty, LCError, LCHoverCard, LCLive, LCSkeleton, LCSparkline, LCStatus, cx } from '../../../shared/lc'
import { compactMoney } from '../../../domain/pipeline/pipeline-command-api'
import type { DeskCard, DeskFlow, DeskMove, DeskOffers, DeskOverview } from './pipeline-desk-api'
import {
  AUTONOMY_META,
  HOLD_META,
  LIVE_OWNERS,
  OWNER_META,
  fmtInt,
  intentWords,
  moveToActivity,
  relShort,
  stageTag,
  stampCT,
  stepWords,
  type LiveOwner,
} from './pipeline-desk-model'


/* ── Moving now ────────────────────────────────────────────────────────── */

export function MovingNowPlane({ flow, loading, error, onRetry, periodLong, onOpenDeal, liveAt, now }: {
  flow: DeskFlow | null
  loading: boolean
  error: string | null
  onRetry: () => void
  periodLong: string
  onOpenDeal: (id: string) => void
  liveAt: number | null
  now: number
}) {
  const events = useMemo(() => (flow?.movement ?? []).map((m: DeskMove) => moveToActivity(m, (x) => onOpenDeal(x.opportunityId))), [flow, onOpenDeal])
  const series = flow?.series.buckets.map((b) => b.moves) ?? []
  const t = flow?.totals
  const [shown, setShown] = useState(10)
  return (
    <section className="pd2-plane pd2-moving" aria-label="Moving now">
      <header className="pd2-plane__head">
        <span className="pd2-plane__glyph is-exec"><Icon name="activity" size={14} /></span>
        <div className="pd2-plane__title">
          <h2>Moving now</h2>
          <small>The machine’s activity · {periodLong}</small>
        </div>
        <LCLive live={!error} updatedAt={liveAt} />
      </header>

      {error && !flow ? <LCError what="Pipeline movement didn’t load" onRetry={onRetry} compact /> : null}

      <div className="pd2-moving__figs">
        <span><b className="lc-num">{t ? fmtInt(t.moved) : '—'}</b><small>deals moved</small></span>
        <span><b className="lc-num">{t ? fmtInt(t.replies) : '—'}</b><small>seller replies</small></span>
        <span><b className="lc-num">{t ? fmtInt(t.bySystem) : '—'}</b><small>by the autopilot</small></span>
        <span><b className="lc-num">{t ? fmtInt(t.byHuman) : '—'}</b><small>by you</small></span>
        {series.length > 1 ? <LCSparkline values={series} width={132} height={28} tone="exec" label={`Movement per ${flow?.series.hourly ? 'hour' : 'day'}`} className="pd2-moving__spark" /> : null}
      </div>

      <div className="pd2-inflight">
        <span className="lc-eyebrow">In flight</span>
        {!flow ? <LCSkeleton shape="lines" count={1} /> : flow.inFlight.length ? (
          <ul>
            {flow.inFlight.slice(0, 6).map((s) => (
              <li key={`${s.opportunityId}:${s.at}`}>
                <button type="button" onClick={() => onOpenDeal(s.opportunityId)}>
                  <LCStatus state={s.future ? 'scheduled' : 'running'} label={s.future ? `Scheduled ${relShort(s.at, now) ?? ''}` : 'Sending'} />
                  <b>{s.kind === 'follow_up' ? 'Follow-up' : 'Reply'}{s.useCase ? ` · ${stepWords(s.useCase)}` : ''}</b>
                  <small>{s.address || s.seller || 'Deal'} · S{s.stageIndex ?? '–'}</small>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="pd2-truth">
            <b>Nothing in flight.</b> No reply or follow-up is queued or scheduled for any live deal.
          </p>
        )}
      </div>

      {flow?.held.length ? (
        <div className="pd2-held">
          <span className="lc-eyebrow is-attn">Drafted, held for review · {fmtInt(flow.held.length)}</span>
          <ul>
            {flow.held.slice(0, 5).map((h) => (
              <li key={`${h.opportunityId}:${h.at}`}>
                <button type="button" onClick={() => onOpenDeal(h.opportunityId)}>
                  <Icon name="pause" size={12} />
                  <b>{stepWords(h.useCase) || 'Message'}</b>
                  <small>{h.address || h.seller || 'Deal'} · {h.by === 'human' ? 'your bulk send' : 'autopilot draft'} · {relShort(h.at, now)}</small>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="pd2-moving__feed">
        <span className="lc-eyebrow">Movement · {periodLong}</span>
        <LCActivityFeed
          events={events}
          loading={loading && !flow}
          tz="America/Chicago"
          max={shown}
          label="Pipeline movement"
          empty={{ title: 'No movement in this period', body: 'Stage changes, captured prices, offers, exits and seller replies appear here as they are recorded.' }}
        />
        {events.length > shown ? (
          <LCButton variant="quiet" size="sm" icon="chevron-down" onClick={() => setShown((n) => n + 20)} className="pd2-moving__more">
            Show more · {fmtInt(events.length - shown)} earlier
          </LCButton>
        ) : null}
      </div>
    </section>
  )
}

/* ── Whose move ────────────────────────────────────────────────────────── */

export function OwnershipPlane({ overview, rows, movedToday, owner, onOwner, onOpenDeal, now }: {
  overview: DeskOverview | null
  rows: DeskCard[] | null
  movedToday: number | null
  owner: LiveOwner | null
  onOwner: (o: LiveOwner | null) => void
  onOpenDeal: (card: DeskCard) => void
  now: number
}) {
  const counts = overview?.ownership
  const live = LIVE_OWNERS.reduce((n, k) => n + (counts?.[k] ?? 0), 0)
  const exceptions = useMemo(() => (rows ?? [])
    .filter((c) => c.owner === 'needs_you' || c.owner === 'blocked')
    .sort((a, b) => (a.owner === b.owner ? 0 : a.owner === 'needs_you' ? -1 : 1) || (Date.parse(b.lane.since || '') || 0) - (Date.parse(a.lane.since || '') || 0)), [rows])
  return (
    <section className="pd2-plane pd2-owners" aria-label="Whose move">
      <header className="pd2-plane__head">
        <span className="pd2-plane__glyph is-flow"><Icon name="users" size={14} /></span>
        <div className="pd2-plane__title">
          <h2>Whose move</h2>
          <small>Who holds the next action, proven from the queue · {counts ? `${fmtInt(live)} live deals` : 'reading…'}</small>
        </div>
      </header>

      <div className="pd2-ownbar" role="img" aria-label={`Live deals by who acts next: ${LIVE_OWNERS.map((k) => `${counts?.[k] ?? 0} ${OWNER_META[k].label}`).join(', ')}`}>
        {LIVE_OWNERS.map((k) => (counts?.[k] ? <i key={k} style={{ flexGrow: counts[k], background: OWNER_META[k].color }} className={cx(owner && owner !== k && 'is-dim')} /> : null))}
      </div>

      <ul className="pd2-ownlist">
        {LIVE_OWNERS.map((k) => {
          const n = counts?.[k] ?? 0
          return (
            <li key={k}>
              <button type="button" className={cx('pd2-own', owner === k && 'is-on', !n && 'is-zero')} onClick={() => onOwner(owner === k ? null : k)} aria-pressed={owner === k} title={OWNER_META[k].definition}>
                <i style={{ background: OWNER_META[k].color }} aria-hidden="true" />
                <span className="pd2-own__label">{k === 'scheduled' ? 'Scheduled next' : OWNER_META[k].label}</span>
                <b className="lc-num">{counts ? fmtInt(n) : '—'}</b>
                <small className="lc-num">{counts && live ? `${Math.round((n / live) * 100)}%` : ''}</small>
              </button>
            </li>
          )
        })}
      </ul>
      <div className="pd2-facets">
        <span><Icon name="arrow-up-right" size={12} /><b className="lc-num">{movedToday === null ? '—' : fmtInt(movedToday)}</b> moving now <small>(moved in 24h)</small></span>
        <span><Icon name="clock" size={12} /><b className="lc-num">{overview ? fmtInt(overview.totals.stalled) : '—'}</b> stalled <small>(past the stage clock)</small></span>
        {overview?.ownership?.dormant ? <span><Icon name="moon" size={12} /><b className="lc-num">{fmtInt(overview.ownership.dormant)}</b> dormant</span> : null}
      </div>

      <div className="pd2-excs">
        <span className="lc-eyebrow">Exceptions · {rows ? fmtInt(exceptions.length) : overview ? fmtInt((overview.totals.needsYou ?? 0) + (overview.totals.blocked ?? 0)) : '—'}</span>
        {!rows ? <LCSkeleton shape="rows" count={4} /> : exceptions.length ? (
          <ol>
            {exceptions.slice(0, 12).map((c) => <ExceptionRow key={c.id} card={c} now={now} onOpen={() => onOpenDeal(c)} />)}
          </ol>
        ) : (
          <LCEmpty title="Nothing needs you" body="Every live deal is the machine’s, the seller’s or an outside party’s." tone="calm" compact />
        )}
      </div>
    </section>
  )
}

export function WhyCard({ card, now }: { card: DeskCard; now: number }) {
  const hold = card.hold ? HOLD_META[card.hold] : null
  return (
    <div className="pd2-why">
      <span className="lc-eyebrow">Why it reads “{OWNER_META[card.owner].label}”</span>
      <p className="pd2-why__lead"><b>{card.lane.label}</b>{card.lane.detail ? ` — ${card.lane.detail}` : ''}</p>
      <dl>
        {hold ? <><dt>Rule</dt><dd>{hold.label}: {hold.rule}</dd></> : null}
        {card.lane.evidence ? <><dt>Queue</dt><dd>{card.lane.evidence}</dd></> : null}
        {card.intent_next ? (
          <>
            <dt>Last turn said</dt>
            <dd>{intentWords(card.intent_next.action)}{card.intent_next.due ? ` · due ${stampCT(card.intent_next.due)}` : ''}{card.intent_next.source ? ` · ${card.intent_next.source.replace(/_/g, ' ')}` : ''}</dd>
          </>
        ) : null}
        {card.lane.since ? <><dt>Since</dt><dd>{stampCT(card.lane.since)} ({relShort(card.lane.since, now)})</dd></> : null}
      </dl>
      <p className="pd2-why__note">The stated next action is the last turn’s intent; the queue shows what actually happened.</p>
    </div>
  )
}

/** The shortest true title: a failure by its name, a hold by what it is (the chip names the rule). */
function exceptionTitle(card: DeskCard): string {
  if (card.owner === 'blocked') return card.lane.label
  const detail = (card.lane.detail || card.lane.label).replace(/\s+—\s+held for your review$/i, '').replace(/\s+—\s+needs review$/i, '')
  return detail
}

function ExceptionRow({ card, now, onOpen }: { card: DeskCard; now: number; onOpen: () => void }) {
  const meta = OWNER_META[card.owner]
  const hold = card.hold ? HOLD_META[card.hold] : null
  return (
    <li className={cx('pd2-exc', `is-${card.owner}`)}>
      <LCHoverCard trigger={(
        <button type="button" className="pd2-exc__row" onClick={onOpen} data-pd2-deal={card.id}>
          <i className="pd2-exc__spine" style={{ background: meta.color }} aria-hidden="true" />
          <span className="pd2-exc__body">
            <b>{exceptionTitle(card)}</b>
            <small>{card.address || card.seller || 'Unaddressed deal'} · {stageTag(card.stageIndex, card.stage)}</small>
          </span>
          <span className="pd2-exc__side">
            {hold ? <LCStatus label={hold.label} tone={hold.tone} quiet /> : null}
            <small className="lc-num">{relShort(card.lane.since, now)}</small>
          </span>
        </button>
      )} side="left" width={340}>
        <WhyCard card={card} now={now} />
      </LCHoverCard>
    </li>
  )
}

/* ── Offers strip ──────────────────────────────────────────────────────── */

export function OffersStrip({ offers, error, onRetry, onOpenOffers }: { offers: DeskOffers | null; error: string | null; onRetry: () => void; onOpenOffers: () => void }) {
  if (error && !offers) return <LCError what="The offer picture didn’t load" onRetry={onRetry} compact className="pd2-offstrip" />
  const a = offers?.autonomy
  const states = ['autonomous', 'resolving', 'exception', 'parked'] as const
  const top = offers?.rows.filter((r) => r.autonomy?.state === 'exception').slice(0, 3) ?? []
  return (
    <section className="pd2-plane pd2-offstrip" aria-label="Offers">
      <header className="pd2-plane__head">
        <span className="pd2-plane__glyph is-attn"><Icon name="dollar-sign" size={14} /></span>
        <div className="pd2-plane__title">
          <h2>Offers</h2>
          <small>{offers ? `${fmtInt(offers.totals.priced)} engine-priced · ${fmtInt(offers.totals.authorized)} spendable by the engine’s own rule` : 'Reading the engine…'}</small>
        </div>
        <LCButton variant="quiet" size="sm" trailingIcon="arrow-up-right" onClick={onOpenOffers}>All offers</LCButton>
      </header>
      <div className="pd2-offstrip__states">
        {states.map((k) => (
          <button key={k} type="button" className={cx('pd2-offstate', `is-${k}`)} onClick={onOpenOffers} title={AUTONOMY_META[k].definition}>
            <LCStatus label={AUTONOMY_META[k].label} tone={AUTONOMY_META[k].tone} quiet={k === 'parked'} />
            <b className="lc-num">{a ? fmtInt(a[k]) : '—'}</b>
          </button>
        ))}
      </div>
      {top.length ? (
        <ul className="pd2-offstrip__top">
          {top.map((r) => (
            <li key={r.card.id}>
              <span className="pd2-offstrip__deal"><b>{r.card.address || r.card.seller || 'Deal'}</b><small>{stageTag(r.card.stageIndex, r.card.stage)}{r.engine?.recommended && !r.autonomy?.implausible ? ` · engine ${compactMoney(r.engine.recommended)}` : ''}</small></span>
              <span className="pd2-offstrip__why">{r.autonomy?.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
