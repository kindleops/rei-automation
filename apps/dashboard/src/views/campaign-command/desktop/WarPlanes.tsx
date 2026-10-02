import { memo, type CSSProperties, type ReactNode } from 'react'
import { Icon } from '../../../shared/icons'
import { LCActivityFeed, LCLink, LCProgress, LCSkeleton, LCTooltip, cx } from '../../../shared/lc'
import type { CampaignIntel, FleetNumber, WarSystem } from './war-room-api'
import { SECOND_CLOCK, useNow } from './war-room-hooks'
import type { WarEvent } from './war-room-activity'
import {
  GATE_LABEL, SENDER_STATE_LABEL, SENDER_STATE_TONE, counterDrift, formatPhone, nf, pct, plural, relative, zoneAbbr, zoneFamily,
  type FunnelStep, type HeldReason, type MoneyLine, type Pace, type WaterStep, type WindowTrack,
} from './war-room-model'
import type { ReplyBucketKey } from './war-room-api'

/* ── plane chrome ──────────────────────────────────────────────────────── */

export function Plane({ title, meta, action, children, className, tone, id }: { title: ReactNode; meta?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; tone?: string; id?: string }) {
  return (
    <section className={cx('cc3-plane', className)} data-tone={tone} aria-labelledby={id ? `${id}-t` : undefined}>
      <header className="cc3-plane__head">
        <h3 className="cc3-plane__title" id={id ? `${id}-t` : undefined}>{title}</h3>
        {meta ? <span className="cc3-plane__meta">{meta}</span> : null}
        {action ? <span className="cc3-plane__action">{action}</span> : null}
      </header>
      {children}
    </section>
  )
}

/* ── time & runtime ────────────────────────────────────────────────────── */

const HOURS = [0, 6, 12, 18, 24]

function Heartbeat({ label, at, staleMs, cadence }: { label: string; at: string | null; staleMs: number; cadence: string }) {
  const now = useNow(SECOND_CLOCK)
  const t = Date.parse(String(at ?? ''))
  const ok = Number.isFinite(t) && now - t < staleMs
  return (
    <span className="cc3-beat" data-ok={ok ? '' : undefined}>
      <span className="cc3-beat__dot" aria-hidden="true" />
      <span className="cc3-beat__label">{label}</span>
      <span className="cc3-beat__value lc-num">{Number.isFinite(t) ? relative(at, now) : 'no heartbeat'}</span>
      <span className="cc3-beat__cadence">{ok ? cadence : 'stale'}</span>
    </span>
  )
}

export const TimePlane = memo(function TimePlane({
  tz, tzs = [], track, zones, pace, buffer, system, lastRefill, lastPass, onOpen,
}: {
  tz: string | null
  /** Every recipient zone; several means tz is null by design. */
  tzs?: string[]
  track: WindowTrack | null
  zones: Record<string, number> | null
  pace: Pace
  buffer: { live: number | null; target: number; chunk: number; remaining: number | null; overdue: number }
  system: WarSystem | null
  lastRefill: string | null
  lastPass: { at: string | null; inserted: number; why: string | null } | null
  onOpen: () => void
}) {
  const now = useNow()
  const zoneList = zones ? Object.entries(zones).filter(([z]) => z !== 'unknown').sort((a, b) => b[1] - a[1]) : []
  const fill = buffer.live === null ? null : Math.min(100, (buffer.live / Math.max(1, buffer.target)) * 100)
  return (
    <Plane title="Time & runtime" meta={tz ? `${zoneFamily(tz)} time · ${tz}` : tzs.length > 1 ? `${tzs.length} recipient zones · ${tzs.map((z) => zoneAbbr(z) ?? z).join(' · ')}` : 'No time zone'} action={<LCLink icon="chevron-right" onClick={onOpen}>Execution</LCLink>} className="cc3-time" id="cc3-time">
      {track ? (
        <div className="cc3-window">
          <div className="cc3-window__head">
            <span className="cc3-window__state" data-open={track.open ? '' : undefined}>{track.open ? 'Window open' : 'Window closed'}</span>
            <span className="cc3-window__label lc-num">{track.label}</span>
          </div>
          <div className="cc3-window__track" role="img" aria-label={`Contact window ${track.label}; now ${track.nowLabel}`}>
            <span className="cc3-window__span" style={{ left: `${(track.start / 24) * 100}%`, width: `${((track.end - track.start) / 24) * 100}%` }} />
            <span className="cc3-window__now" style={{ left: `${(track.now / 24) * 100}%`, ['--p' as string]: Math.min(1, Math.max(0, track.now / 24)) } as CSSProperties}><b className="lc-num">{track.nowLabel}</b></span>
            {HOURS.map((h) => <i key={h} className="cc3-window__tick" style={{ left: `${(h / 24) * 100}%` }} />)}
          </div>
          <div className="cc3-window__scale lc-num" aria-hidden="true">{HOURS.map((h) => <span key={h} style={{ left: `${(h / 24) * 100}%` }}>{String(h).padStart(2, '0')}</span>)}</div>
          <p className="cc3-window__foot">
            {zoneList.length ? <span>Sellers: {zoneList.slice(0, 3).map(([z, n]) => `${zoneFamily(z)} ${nf(n)}`).join(' · ')}{zoneList.length > 3 ? ` · +${zoneList.length - 3} zones` : ''}</span> : null}
            {track.operatorLabel ? <span>{track.operatorLabel}</span> : null}
          </p>
        </div>
      ) : <p className="cc3-muted">The contact window could not be read — the campaign has no time zone.</p>}

      <div className="cc3-buffer">
        <div className="cc3-buffer__head">
          <span className="cc3-kicker">Queue buffer</span>
          <span className="cc3-buffer__value lc-num"><b>{buffer.live === null ? '—' : nf(buffer.live)}</b> / {nf(buffer.target)}</span>
        </div>
        <LCProgress value={fill ?? 0} max={100} tone={buffer.overdue ? 'crit' : 'exec'} label="Queue buffer" />
        <dl className="cc3-facts">
          <div><dt>Refill adds up to</dt><dd className="lc-num">{nf(buffer.chunk)} per pass</dd></div>
          <div><dt>Remaining cohort</dt><dd className="lc-num">{buffer.remaining === null ? '—' : plural(buffer.remaining, 'seller')}</dd></div>
          <div><dt>Last refill</dt><dd>{lastRefill ? relative(lastRefill, now) : 'none yet'}</dd></div>
          <div><dt>Last pass</dt><dd>{lastPass ? `${relative(lastPass.at, now) ?? '—'} · ${lastPass.inserted ? `placed ${nf(lastPass.inserted)}` : 'placed none'}` : 'not fed yet'}</dd></div>
        </dl>
        {lastPass?.why ? <p className="cc3-buffer__why">{lastPass.why}</p> : null}
        <p className="cc3-buffer__note">Buffer telemetry — the campaign still owns every remaining seller.</p>
      </div>

      <div className="cc3-pace">
        <span className="cc3-kicker">Pace</span>
        <p className="cc3-pace__line">
          {pace.dayIndex ? <b>Day {nf(pace.dayIndex)}</b> : null}
          {pace.daily ? <span className="lc-num">{nf(pace.daily)}/day · {pace.basis}</span> : <span>No limit read</span>}
          <span className="lc-num">{plural(pace.remaining, 'seller')} left to place</span>
          {pace.days !== null && pace.remaining > 0 ? <span className="cc3-est">≈ {pace.days <= 1 ? 'finishes within a day' : `${pace.days} days`} · estimate</span> : null}
        </p>
      </div>

      <div className="cc3-beats">
        <Heartbeat label="Feeder" at={system?.feeder.heartbeat_at ?? null} staleMs={15 * 60_000} cadence="every 5 min" />
        <Heartbeat label="Processor" at={system?.processor.heartbeat_at ?? null} staleMs={5 * 60_000} cadence="every minute" />
      </div>
    </Plane>
  )
})

/* ── outcomes ──────────────────────────────────────────────────────────── */

export const OutcomePlane = memo(function OutcomePlane({
  replied, delivered, segments, funnel, money, loading, onOpenReplies, onOpenOutcomes,
}: {
  replied: number | null
  delivered: number | null
  segments: Array<{ key: ReplyBucketKey; label: string; value: number; tone: string }>
  funnel: FunnelStep[]
  money: MoneyLine[]
  loading: boolean
  onOpenReplies: (k?: ReplyBucketKey) => void
  onOpenOutcomes: () => void
}) {
  const total = segments.reduce((s, x) => s + x.value, 0)
  const shown = funnel.filter((s) => ['delivered', 'replied', 'interested', 'advanced', 'opportunities', 'offers'].includes(s.key))
  return (
    <Plane title="Outcomes" meta={replied !== null && delivered ? `${pct(replied, delivered)} of delivered replied` : null} action={<LCLink icon="chevron-right" onClick={() => onOpenReplies()}>Replies</LCLink>} className="cc3-outcomes" id="cc3-out">
      <div className="cc3-replies">
        <button type="button" className="cc3-replies__big" onClick={() => onOpenReplies()}>
          <b className="lc-num">{replied === null ? '—' : nf(replied)}</b>
          <span>{replied === 1 ? 'seller replied' : 'sellers replied'}</span>
        </button>
        {total > 0 ? (
          <>
            <LCProgress segments={segments.filter((s) => s.value > 0).map((s) => ({ value: s.value, tone: s.tone as 'ok', label: s.label }))} max={total} label="Reply composition" />
            <ul className="cc3-legend">
              {segments.map((s) => (
                <li key={s.key} data-zero={s.value ? undefined : ''}>
                  <button type="button" onClick={() => onOpenReplies(s.key)} disabled={!s.value}>
                    <i data-tone={s.tone} aria-hidden="true" />
                    <span>{s.label}</span>
                    <b className="lc-num">{nf(s.value)}</b>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : loading ? <LCSkeleton shape="lines" count={2} /> : <p className="cc3-muted">{replied === 0 ? 'No seller has replied yet.' : 'Replies not available.'}</p>}
      </div>
      <ol className="cc3-funnel" aria-label="Business funnel">
        {shown.map((s, i) => (
          <li key={s.key}>
            {i > 0 ? <Icon name="chevron-right" size={11} className="cc3-funnel__arrow" /> : null}
            <LCTooltip content={s.basis ? `${s.label} · ${s.basis}` : s.label}>
              <button type="button" className="cc3-funnel__step" onClick={onOpenOutcomes}>
                <b className="lc-num">{s.value === null ? '—' : nf(s.value)}</b>
                <span>{s.label}</span>
              </button>
            </LCTooltip>
          </li>
        ))}
      </ol>
      {money.length ? (
        <dl className="cc3-money">
          {money.filter((m) => m.key !== 'contracts').map((m) => (
            <div key={m.key} data-basis={m.basis}>
              <dt>{m.label}<span className="cc3-basis">{m.basis}</span></dt>
              <dd className="lc-num">{m.value}{m.n ? <small>{nf(m.n)}</small> : null}</dd>
            </div>
          ))}
        </dl>
      ) : loading ? <LCSkeleton shape="lines" count={2} /> : null}
    </Plane>
  )
})

/* ── audience ──────────────────────────────────────────────────────────── */

export const AudiencePlane = memo(function AudiencePlane({ steps, held, onOpen, onReason }: { steps: WaterStep[]; held: HeldReason[]; onOpen: () => void; onReason: (code: string) => void }) {
  const max = Math.max(1, ...steps.map((s) => s.value ?? 0))
  return (
    <Plane title="Audience" meta={steps.find((s) => s.key === 'eligible')?.value !== undefined ? `${nf(steps.find((s) => s.key === 'eligible')?.value)} executable` : null} action={<LCLink icon="chevron-right" onClick={onOpen}>Inspect</LCLink>} className="cc3-audience" id="cc3-aud">
      <ol className="cc3-water">
        {steps.map((s) => (
          <li key={s.key} data-tone={s.tone} data-key={s.key}>
            <button type="button" onClick={onOpen}>
              <span className="cc3-water__label">{s.label}</span>
              <span className="cc3-water__bar"><i style={{ width: `${Math.max(s.value ? 1.5 : 0, ((s.value ?? 0) / max) * 100)}%` }} /></span>
              <b className="cc3-water__value lc-num">{s.value === null ? '—' : nf(s.value)}</b>
            </button>
            {s.detail ? <span className="cc3-water__detail">{s.detail}</span> : null}
          </li>
        ))}
      </ol>
      {held.length ? (
        <ul className="cc3-reasons" aria-label="Why sellers are held">
          {held.slice(0, 3).map((r) => (
            <li key={r.code}>
              <button type="button" onClick={() => onReason(r.code)}>
                <span className="cc3-reasons__gate">{GATE_LABEL[r.gate]}</span>
                <span className="cc3-reasons__label">{r.label}</span>
                <b className="lc-num">{nf(r.n)}</b>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </Plane>
  )
})

/* ── sender fleet (compact) ────────────────────────────────────────────── */

export function SenderRail({ s, onOpen, dense }: { s: FleetNumber; onOpen: () => void; dense?: boolean }) {
  const used = s.sent_today
  const limit = s.limit ?? s.daily_limit ?? null
  return (
    <button type="button" className={cx('cc3-sender', dense && 'is-dense', !s.eligible && 'is-out')} data-state={s.state} onClick={onOpen}>
      <span className="cc3-sender__id">
        <b className="lc-num">{formatPhone(s.phone)}</b>
        <span>{s.label ?? s.market ?? '—'}</span>
      </span>
      <span className="cc3-sender__state" data-tone={SENDER_STATE_TONE[s.state]}>
        <i aria-hidden="true" />{SENDER_STATE_LABEL[s.state]}{s.state === 'unverified' ? <em>health unverified</em> : null}
      </span>
      <span className="cc3-sender__cap">
        <LCProgress value={limit ? Math.min(used, limit) : 0} max={limit || 1} tone={s.eligible ? 'exec' : 'attn'} label={`${formatPhone(s.phone)} sent today`} />
        <span className="lc-num">{nf(used)} / {limit ? nf(limit) : '—'} today</span>
      </span>
      {counterDrift(s) ? <span className="cc3-sender__drift" title="textgrid_numbers.messages_sent_today is never reset; the router compares it with the daily limit.">router counter {nf(s.router_counter)}</span> : null}
    </button>
  )
}

export const FleetPlane = memo(function FleetPlane({ intel, onSender, onOpen }: { intel: CampaignIntel | null; onSender: (phone: string) => void; onOpen: () => void }) {
  const fleet = intel?.fleet ?? null
  const routing = intel?.routing ?? null
  const local = fleet ? fleet.numbers.filter((s) => s.in_campaign_market || s.campaign.carrying) : []
  const eligible = local.filter((s) => s.eligible)
  const remaining = eligible.reduce((sum, s) => sum + s.remaining_today, 0)
  const blockedMarkets = routing ? routing.filter((r) => r.ready > 0 && r.eligible === 0) : []
  return (
    <Plane title="Sender capacity" meta={fleet ? `${plural(eligible.length, 'eligible number')}` : null} action={<LCLink icon="chevron-right" onClick={onOpen}>Fleet</LCLink>} className="cc3-fleet" id="cc3-fleet">
      {!fleet ? <LCSkeleton shape="rows" count={3} /> : (
        <>
          <p className={cx('cc3-route', blockedMarkets.length && 'is-blocked')}>
            {blockedMarkets.length ? (
              <><b>No eligible sender</b> in {blockedMarkets.slice(0, 2).map((r) => r.market).join(', ')}{blockedMarkets.length > 2 ? ` +${blockedMarkets.length - 2}` : ''} — {nf(blockedMarkets.reduce((s, r) => s + r.ready, 0))} sellers can’t be routed.</>
            ) : (
              <><b className="lc-num">{nf(remaining)}</b> texts of room today across {plural(eligible.length, 'local number')} · least-used local number first</>
            )}
          </p>
          <div className="cc3-senders">
            {local.slice(0, 5).map((s) => <SenderRail key={s.phone} s={s} onOpen={() => onSender(s.phone)} dense />)}
            {local.length > 5 ? <LCLink onClick={onOpen}>+{nf(local.length - 5)} more numbers</LCLink> : null}
            {!local.length ? <p className="cc3-muted">No fleet number serves this campaign’s markets.</p> : null}
          </div>
          {fleet.blocked_count ? <p className="cc3-foot">{plural(fleet.blocked_count, 'number')} on the operator blocklist fleet-wide · system limit {nf(fleet.system_cap)} / sender / day</p> : null}
        </>
      )}
    </Plane>
  )
})

/* ── latest activity ───────────────────────────────────────────────────── */

export const LatestActivity = memo(function LatestActivity({ events, tz, loading, onAll }: { events: WarEvent[]; tz: string | null; loading: boolean; onAll: () => void }) {
  return (
    <Plane title="Latest activity" meta={events.length ? `${nf(events.length)} events` : null} action={<LCLink icon="chevron-right" onClick={onAll}>All activity</LCLink>} className="cc3-latest" id="cc3-act">
      <LCActivityFeed events={events} loading={loading} tz={tz ?? undefined} max={8} windowMs={60 * 60_000} empty={{ title: 'No execution yet', body: 'Batches, deliveries and replies appear here as they happen.' }} label="Latest campaign activity" />
    </Plane>
  )
})

export function NotAvailable({ what }: { what: string }) {
  return <p className="cc3-muted">{what} not available — the read did not answer. Nothing is assumed.</p>
}
