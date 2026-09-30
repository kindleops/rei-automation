import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { Icon } from '../../../shared/icons'
import { pushRoutePath } from '../../../app/router'
import { openInboxThread } from '../../../modules/mobile/mobile-inbox-bridge'
import type { CampaignSummary } from '../campaigns.types'
import { describeException } from '../campaign-exceptions'
import { describeIntent, intentRows } from '../campaign-responses'
import type { CockpitRead, CockpitSender, CockpitTargetRow } from './cockpit-api'
import { ago, feederSkipWords, holdWords, nf, releaseWords, sourceOf, whenIn } from './cockpit-model'
import { useCaseWords } from './CockpitRoom'
import { queueWords, isOverdueRow } from './CockpitTargets'
import { Section, Skeleton, Spec, Unavailable, cls, formatPhone } from './cockpit-ui'

export type InspectorTab = 'overview' | 'audience' | 'channels' | 'sequence' | 'performance' | 'technical'

export const INSPECTOR_TABS: Array<{ key: InspectorTab; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'audience', label: 'Audience' },
  { key: 'channels', label: 'Channels' },
  { key: 'sequence', label: 'Sequence' },
  { key: 'performance', label: 'Performance' },
  { key: 'technical', label: 'Technical' },
]

export type InspectorContext =
  | { kind: 'target'; row: CockpitTargetRow }
  | { kind: 'sender'; phone: string }
  | null

const STATUS_WORDS: Record<string, string> = {
  active: 'Active', activating: 'Activating', live_limited: 'Active', paused: 'Paused', scheduled: 'Scheduled', queued: 'Scheduled',
  draft: 'Draft', built: 'Audience built', previewed: 'Previewed', ready: 'Ready', failed: 'Failed', completed: 'Completed', archived: 'Archived',
}

const yesNo = (v: boolean | null | undefined) => (v === null || v === undefined ? null : v ? 'On' : 'Off')

// ── tabs ────────────────────────────────────────────────────────────────────

function OverviewTab({ c, k }: { c: CampaignSummary; k: CockpitRead | null }) {
  const tz = k?.window.timezone ?? c.lineage?.timezone ?? null
  const source = sourceOf(c, k)
  const caps = k?.caps
  return (
    <>
      <Section title="Campaign">
        <dl className="cpk-specs">
          <Spec label="State" value={STATUS_WORDS[String(c.status)] ?? String(c.status)} />
          <Spec label="Source" value={`${source.label}${source.detail ? ` · ${source.detail}` : ''}`} />
          <Spec label="Created" value={k ? whenIn(k.lifecycle.created_at, tz) : null} />
          {k?.lifecycle.scheduled_for ? <Spec label="Scheduled start" value={whenIn(k.lifecycle.scheduled_for, tz)} /> : null}
          {k?.lifecycle.activated_at ? <Spec label="Went live" value={whenIn(k.lifecycle.activated_at, tz)} /> : null}
          {k?.lifecycle.paused_at ? <Spec label="Last paused" value={whenIn(k.lifecycle.paused_at, tz)} /> : null}
          {k?.lifecycle.resumed_at ? <Spec label="Last resumed" value={whenIn(k.lifecycle.resumed_at, tz)} /> : null}
          {k?.lifecycle.last_transition_reason ? <Spec label="Last change" value={k.lifecycle.last_transition_reason} sub={whenIn(k.lifecycle.last_transition_at, tz)} /> : null}
        </dl>
      </Section>
      <Section title="Pacing">
        {!k ? <Skeleton lines={3} /> : (
          <dl className="cpk-specs">
            <Spec label="Daily cap" value={caps?.daily_cap ? nf(caps.daily_cap) : 'None'} />
            <Spec label="Total cap" value={caps?.total_cap ? nf(caps.total_cap) : 'None'} />
            <Spec label="Spacing" value={caps?.send_interval_seconds ? `One message every ${caps.send_interval_seconds}s` : 'Default'} />
            <Spec label="Per-number limit" value={caps?.per_sender_cap ? `${nf(caps.per_sender_cap)} a day (this campaign)` : caps?.configured_per_number_cap ? `${nf(caps.configured_per_number_cap)} a day (system)` : null} />
            <Spec label="Contact window" value={k.window.window ?? null} sub={k.window.timezone ? `${k.window.timezone} · ${k.window.source === 'campaign' ? 'set on the campaign' : 'operator default'}` : undefined} />
          </dl>
        )}
      </Section>
    </>
  )
}

function Composition({ k }: { k: CockpitRead }) {
  const t = k.targets
  if (!t || !t.total) return null
  const parts = [
    { key: 'planned', label: 'Handed to queue', n: Number(t.by_status.planned ?? 0), tone: 'exec' },
    { key: 'ready', label: 'Ready', n: Number(t.by_status.ready ?? 0), tone: 'plan' },
    { key: 'blocked', label: 'Held', n: Number(t.by_status.blocked ?? 0), tone: 'warn' },
  ]
  const other = t.total - parts.reduce((s, p) => s + p.n, 0)
  if (other > 0) parts.push({ key: 'other', label: 'Other', n: other, tone: 'muted' })
  return (
    <div className="cpk-comp">
      <div className="cpk-comp__bar" role="img" aria-label={parts.map((p) => `${p.label} ${p.n}`).join(', ')}>
        {parts.filter((p) => p.n > 0).map((p) => <i key={p.key} className={`is-${p.tone}`} style={{ flexGrow: p.n }} />)}
      </div>
      <ul className="cpk-comp__legend">
        {parts.filter((p) => p.n > 0).map((p) => <li key={p.key} className={`is-${p.tone}`}><i aria-hidden="true" />{p.label}<b>{nf(p.n)}</b></li>)}
      </ul>
    </div>
  )
}

function AudienceTab({ c, k, onOpenTargets }: { c: CampaignSummary; k: CockpitRead | null; onOpenTargets: () => void }) {
  if (!k) return <Skeleton lines={6} />
  const held = Object.entries(k.targets?.held_by_reason ?? {}).sort((a, b) => b[1] - a[1])
  const advisories = Object.entries(k.targets?.advisories ?? {}).flatMap(([status, bag]) => Object.entries(bag).map(([code, n]) => ({ status, code, n })))
    .sort((a, b) => b.n - a.n)
  const exec = k.exceptions?.execution.groups ?? []
  const suppressed = exec.filter((g) => g.failure_category.includes('compliance'))
  const failed = exec.filter((g) => !g.failure_category.includes('compliance') && !['template_held', 'sender_held', 'health_guard_hold', 'held_incomplete'].includes(g.failure_category))
  const heldAtSend = exec.filter((g) => ['template_held', 'sender_held', 'health_guard_hold', 'held_incomplete'].includes(g.failure_category))
  const r = k.responses
  return (
    <>
      <Section title="Audience" meta={k.targets ? `${nf(k.targets.total)} sellers` : null} action={<button type="button" className="cpk-link" onClick={onOpenTargets}>Open targets</button>}>
        {!k.targets ? <Unavailable what="Targets" /> : <Composition k={k} />}
      </Section>
      <Section title="Held" meta={k.targets ? nf(k.targets.held) : null}>
        {!k.targets ? <Unavailable what="Holds" /> : !held.length && !heldAtSend.length ? <p className="cpk-muted">No seller is held.</p> : (
          <ul className="cpk-reasons">
            {held.map(([code, n]) => <li key={code}><span>{holdWords(code)}</span><b>{nf(n)}</b></li>)}
            {heldAtSend.map((g) => <li key={g.failure_category}><span>{describeException('sending', g.failure_category).title} <em>at send</em></span><b>{nf(g.count)}</b></li>)}
          </ul>
        )}
      </Section>
      <Section title="Failed" meta={k.exceptions ? nf(failed.reduce((s, g) => s + g.count, 0)) : null}>
        {!k.exceptions ? <Unavailable what="Failures" /> : !failed.length ? <p className="cpk-muted">No failed messages.</p> : (
          <ul className="cpk-reasons">
            {failed.map((g) => {
              const copy = describeException('sending', g.failure_category)
              return <li key={g.failure_category} className={`is-${copy.tone}`}><span title={copy.body}>{copy.title}</span><b>{nf(g.count)}</b></li>
            })}
          </ul>
        )}
      </Section>
      <Section title="Suppressed" meta={k.exceptions ? nf(suppressed.reduce((s, g) => s + g.count, 0)) : null}>
        {!k.exceptions ? <Unavailable what="Suppression" /> : !suppressed.length ? <p className="cpk-muted">No carrier or opt-out refusals.</p> : (
          <ul className="cpk-reasons">
            {suppressed.map((g) => <li key={g.failure_category}><span>{describeException('sending', g.failure_category).title}</span><b>{nf(g.count)}</b></li>)}
          </ul>
        )}
      </Section>
      <Section title="Completed" meta={k.send_states ? `${nf(k.send_states.delivered)} delivered` : null}>
        {!k.send_states ? <Unavailable what="Delivery" /> : (
          <dl className="cpk-specs">
            <Spec label="Messages delivered" value={nf(k.send_states.delivered)} sub={k.send_states.sent ? `of ${nf(k.send_states.sent)} sent` : undefined} />
            <Spec label="Sellers messaged" value={r ? nf(r.sellers_messaged) : null} />
          </dl>
        )}
      </Section>
      {advisories.length ? (
        <Section title="Notes on queued sellers" meta="not holds">
          <ul className="cpk-reasons is-quiet">
            {advisories.slice(0, 6).map((a) => <li key={`${a.status}-${a.code}`}><span>{holdWords(a.code)} <em>{a.status === 'planned' ? 'queued' : a.status}</em></span><b>{nf(a.n)}</b></li>)}
          </ul>
        </Section>
      ) : null}
      {c.total_targets === 0 && !k.targets?.total ? <p className="cpk-muted">No audience has been built for this campaign.</p> : null}
    </>
  )
}

function SenderRow({ s, cap, onOpen }: { s: CockpitSender; cap: number | null; onOpen: () => void }) {
  const chips: Array<{ label: string; tone: string }> = []
  if (s.operator_blocked) chips.push({ label: 'Blocked by operator', tone: 'warn' })
  if (s.status && s.status !== 'active') chips.push({ label: s.status === 'paused' ? 'Paused' : s.status, tone: 'muted' })
  if (s.health_state === 'cooling') chips.push({ label: 'Cooling', tone: 'warn' })
  else if (s.health_state === 'unverified') chips.push({ label: 'Health unverified', tone: 'muted' })
  else if (s.health_state) chips.push({ label: s.health_state, tone: 'muted' })
  if (!s.known) chips.push({ label: 'Not in the fleet', tone: 'warn' })
  return (
    <button type="button" className={cls('cpk-sender', s.carrying_campaign && 'is-carrying')} onClick={onOpen}>
      <span className="cpk-sender__name">{s.label ?? formatPhone(s.phone)}</span>
      <span className="cpk-sender__phone">{formatPhone(s.phone)}{s.market ? ` · ${s.market}` : ''}</span>
      <span className="cpk-sender__load">
        {s.campaign_queued ? <span><b>{nf(s.campaign_queued)}</b> queued</span> : null}
        <span><b>{nf(s.campaign_sent_today)}</b> today{cap ? ` / ${nf(cap)}` : ''}</span>
      </span>
      {chips.length ? <span className="cpk-sender__chips">{chips.map((ch) => <span key={ch.label} className={cls('cpk-pill', `is-${ch.tone}`)}>{ch.label}</span>)}</span> : null}
    </button>
  )
}

function ChannelsTab({ k, onSender }: { k: CockpitRead | null; onSender: (phone: string) => void }) {
  if (!k) return <Skeleton lines={6} />
  const cap = k.caps.per_sender_cap ?? k.caps.configured_per_number_cap
  const carrying = k.senders.filter((s) => s.carrying_campaign)
  const pool = k.senders.filter((s) => !s.carrying_campaign)
  return (
    <>
      <Section title="SMS senders" meta={k.unavailable.includes('senders') ? 'partly unavailable' : `${nf(carrying.length)} carrying this campaign`}>
        {!carrying.length ? <p className="cpk-muted">No number has carried this campaign yet.</p> : (
          <div className="cpk-senders">{carrying.map((s) => <SenderRow key={s.phone} s={s} cap={cap} onOpen={() => onSender(s.phone)} />)}</div>
        )}
      </Section>
      {pool.length ? (
        <Section title="Other numbers in these markets" meta="not carrying it">
          <div className="cpk-senders">{pool.map((s) => <SenderRow key={s.phone} s={s} cap={cap} onOpen={() => onSender(s.phone)} />)}</div>
        </Section>
      ) : null}
      <Section title="Email" meta="separate channel">
        <dl className="cpk-specs">
          <Spec label="Campaign emails" value={k.email.campaign_rows === null ? null : nf(k.email.campaign_rows)} sub="This campaign sends by SMS only" />
          <Spec label="Sender identities" value={k.email.sender_identities === null ? null : nf(k.email.sender_identities)} sub="Email sending is off in production" />
        </dl>
      </Section>
    </>
  )
}

function SequenceTab({ c, k }: { c: CampaignSummary; k: CockpitRead | null }) {
  const lineage = k?.lineage ?? c.lineage ?? null
  return (
    <>
      <Section title="Sequence">
        <ol className="cpk-steps">
          <li>
            <span className="cpk-steps__n">1</span>
            <span className="cpk-steps__body">
              <b>First text · SMS</b>
              <span>{[lineage?.stage_code ? `Stage ${lineage.stage_code}` : null, useCaseWords(lineage?.template_use_case)].filter(Boolean).join(' · ') || 'Template set not recorded'}</span>
              <span className="cpk-muted">Sent once per seller, inside the contact window, from a number in the seller’s market.</span>
            </span>
          </li>
          <li>
            <span className="cpk-steps__n">↺</span>
            <span className="cpk-steps__body">
              <b>If the carrier filters it</b>
              <span className="cpk-muted">One retry on a different approved template (feeder rule).</span>
            </span>
          </li>
          <li>
            <span className="cpk-steps__n">→</span>
            <span className="cpk-steps__body">
              <b>When the seller replies</b>
              <span className="cpk-muted">The conversation continues in Inbox.</span>
            </span>
          </li>
        </ol>
      </Section>
      <Section title="Workflow">
        <p className="cpk-muted">No Workflow Studio workflow is attached to this campaign, so there is no workflow version to show or open.</p>
      </Section>
    </>
  )
}

function PerformanceTab({ k }: { k: CockpitRead | null }) {
  if (!k) return <Skeleton lines={6} />
  const r = k.responses
  const rows = r ? intentRows(r.intents) : []
  const s = k.send_states
  return (
    <>
      <Section title="Outcomes" meta={r?.truncated ? 'counts are a floor' : null}>
        {!r ? <Unavailable what="Replies" /> : (
          <dl className="cpk-specs">
            <Spec label="Sellers replied" value={nf(r.sellers_replied)} sub={r.sellers_messaged ? `${Math.round((r.sellers_replied / r.sellers_messaged) * 1000) / 10}% of ${nf(r.sellers_messaged)} messaged` : undefined} />
            <Spec label="Asked to stop" value={nf(r.sellers_asked_to_stop)} tone={r.sellers_asked_to_stop ? 'warn' : null} />
            <Spec label="Latest reply" value={r.latest_reply_at ? whenIn(r.latest_reply_at, k.window.timezone) : 'None yet'} />
          </dl>
        )}
      </Section>
      {rows.length ? (
        <Section title="What sellers said">
          <ul className="cpk-reasons">
            {rows.map((row) => <li key={row.key} className={`is-intent-${row.tone}`}><span>{row.label}</span><b>{nf(row.count)}</b></li>)}
          </ul>
        </Section>
      ) : null}
      <Section title="Delivery">
        {!s ? <Unavailable what="Delivery" /> : (
          <dl className="cpk-specs">
            <Spec label="Delivered" value={nf(s.delivered)} sub={s.sent ? `${Math.round((s.delivered / Math.max(1, s.sent)) * 100)}% of ${nf(s.sent)} sent` : undefined} />
            <Spec label="Failed" value={nf(s.failed)} tone={s.failed ? 'bad' : null} />
          </dl>
        )}
      </Section>
    </>
  )
}

function TechnicalTab({ c, k }: { c: CampaignSummary; k: CockpitRead | null }) {
  if (!k) return <Skeleton lines={8} />
  const tz = k.window.timezone
  const fl = k.feeder.campaign_last
  const q = k.queue
  return (
    <>
      <Section title="Identifiers">
        <dl className="cpk-specs">
          <Spec label="Campaign id" value={c.id} mono />
          <Spec label="Current run" value={k.exceptions?.run_id ?? 'None recorded'} mono />
        </dl>
      </Section>
      <Section title="Worker">
        <dl className="cpk-specs">
          <Spec label="Batch max" value={k.caps.batch_max ? nf(k.caps.batch_max) : 'Not set'} sub="Worker batch size — not the audience size" />
          <Spec label="Feeder buffer" value={k.feed ? `${nf(k.feed.buffer_target)} rows ahead · ${nf(k.feed.chunk)} per pass` : null} />
          <Spec label="Market cap" value={k.caps.market_cap ? nf(k.caps.market_cap) : 'None'} />
        </dl>
      </Section>
      <Section title="Feeder">
        <dl className="cpk-specs">
          <Spec label="Heartbeat" value={k.feeder.heartbeat_at ? ago(k.feeder.heartbeat_at) : 'None'} sub={k.feeder.heartbeat_at ? whenIn(k.feeder.heartbeat_at, tz) : undefined} />
          <Spec label="Last batch (any campaign)" value={k.feeder.last_batch_at ? whenIn(k.feeder.last_batch_at, tz) : 'None'} />
          {fl ? <Spec label="Last pass here" value={`${fl.bound ?? '—'}${fl.reason && fl.reason !== fl.bound ? ` · ${fl.reason}` : ''}`} sub={`${fl.at ? ago(fl.at) : ''}${fl.inserted ? ` · placed ${nf(fl.inserted)}` : ' · placed none'}${fl.stalled ? ' · stalled' : ''}`} /> : <Spec label="Last pass here" value="Never fed" />}
          {fl && Object.keys(fl.skipped_counts_by_reason).length ? (
            <Spec label="Skipped" value={Object.entries(fl.skipped_counts_by_reason).map(([code, n]) => `${feederSkipWords(code)} ${nf(n)}`).join(' · ')} />
          ) : null}
          {fl?.last_refill_at ? <Spec label="Last refill" value={whenIn(fl.last_refill_at, tz)} /> : null}
          {k.timeline.idle_feeder_checks ? <Spec label="Idle checks" value={nf(k.timeline.idle_feeder_checks.count)} sub={k.timeline.idle_feeder_checks.last_at ? `last ${ago(k.timeline.idle_feeder_checks.last_at)}` : undefined} /> : null}
        </dl>
      </Section>
      <Section title="Queue processor">
        <dl className="cpk-specs">
          <Spec label="Mode" value={k.processor.mode} sub={k.processor.execution_mode ? `execution ${k.processor.execution_mode}` : undefined} />
          <Spec label="Auto-send (system)" value={yesNo(k.processor.auto_send)} />
          <Spec label="Outbound SMS" value={yesNo(k.processor.outbound_sms)} />
          <Spec label="Emergency stop" value={k.processor.emergency_stop_at ? whenIn(k.processor.emergency_stop_at, tz) : 'Not set'} tone={k.processor.emergency_stop_at ? 'bad' : null} />
          <Spec label="Heartbeat" value={k.processor.heartbeat_at ? ago(k.processor.heartbeat_at) : 'None'} />
          <Spec label="Last claim" value={k.processor.last_claimed_at ? whenIn(k.processor.last_claimed_at, tz) : 'None'} />
        </dl>
      </Section>
      <Section title="This campaign’s queue">
        {!q ? <Unavailable what="Queue" /> : (
          <dl className="cpk-specs">
            <Spec label="Live rows" value={nf(q.live)} sub={q.proof ? `${nf(q.proof)} no-send (test) rows apart` : undefined} />
            <Spec label="Due / overdue" value={`${nf(q.due)} / ${nf(q.overdue)}`} tone={q.overdue ? 'bad' : null} />
            {q.spam_retries ? <Spec label="Filtered-text retries" value={nf(q.spam_retries)} /> : null}
            {Object.keys(q.release_reasons).length ? <Spec label="Last release reason" value={Object.entries(q.release_reasons).map(([code, n]) => `${releaseWords(code)} (${nf(n)})`).join(' · ')} /> : null}
            {q.truncated ? <Spec label="Scan" value="Truncated — more rows than read" tone="warn" /> : null}
          </dl>
        )}
      </Section>
      <Section title="Flags and time">
        <dl className="cpk-specs">
          <Spec label="Auto-queue" value={yesNo(k.flags.auto_queue_enabled)} />
          <Spec label="Auto-send flag" value={yesNo(k.flags.auto_send_enabled)} sub="Campaign row flag" />
          <Spec label="Auto-reply" value={k.flags.auto_reply_mode ?? '—'} />
          <Spec label="Day boundary" value={`${k.sends.day_timezone}${k.sends.day_timezone_basis === 'feeder_default' ? ' (feeder default)' : ''}`} sub={`today began ${whenIn(k.sends.day_start, k.sends.day_timezone)}`} />
          <Spec label="Window policy" value={k.window.policy_version ?? null} mono />
          {k.unavailable.length ? <Spec label="Unavailable" value={k.unavailable.join(', ')} tone="warn" /> : null}
        </dl>
      </Section>
    </>
  )
}

// ── contexts ────────────────────────────────────────────────────────────────

function TargetContext({ row, c, k, onBack }: { row: CockpitTargetRow; c: CampaignSummary; k: CockpitRead | null; onBack: () => void }) {
  const tz = k?.window.timezone ?? c.lineage?.timezone ?? null
  const lineage = k?.lineage ?? c.lineage ?? null
  const q = row.queue
  const qWords = queueWords(q?.status)
  const overdue = isOverdueRow(row)
  const why = lineage?.kind === 'map_area' ? 'Its property is in the drawn Map area cohort.'
    : lineage?.kind === 'entity_graph' ? 'Its property was selected in Entity Graph.'
      : lineage?.kind === 'filters' ? 'It matched the campaign’s filters when the audience was built.'
        : 'It is in the campaign’s built audience.'
  const next = row.target_status === 'blocked' ? 'Held — nothing will be sent unless the hold is resolved.'
    : overdue ? 'Overdue in the queue — waiting on the dispatch fix.'
      : q && ['queued', 'scheduled', 'pending', 'ready', 'approved'].includes(String(q.status)) ? `Queued for ${whenIn(q.scheduled_for, tz) ?? 'the next window'}.`
        : row.reply ? 'Replied — continue in the conversation.'
          : q?.status === 'delivered' ? 'Delivered — waiting for a reply.'
            : row.target_status === 'ready' ? 'Ready — the feeder queues it on a coming pass.'
              : q ? `${qWords.label}.` : '—'
  const intent = row.reply ? describeIntent(row.reply.intent) : null
  const openProperty = () => {
    if (!row.property_id) return
    const params = new URLSearchParams({ property_id: row.property_id })
    if (row.master_owner_id) params.set('master_owner_id', row.master_owner_id)
    pushRoutePath(`/deal-intelligence?${params.toString()}`)
  }
  return (
    <div className="cpk-ctx">
      <button type="button" className="cpk-ctx__back" onClick={onBack}><Icon name="chevron-left" size={13} /> Back to campaign</button>
      <h3 className="cpk-ctx__title">{row.seller ?? 'Seller'}</h3>
      <p className="cpk-ctx__sub">{row.property ?? '—'}</p>
      <Section title="Contact">
        <dl className="cpk-specs">
          <Spec label="Phone" value={formatPhone(row.phone)} />
          <Spec label="Market" value={row.market ?? '—'} />
          <Spec label="Identity" value={row.identity_status?.replace(/_/g, ' ') ?? '—'} />
          <Spec label="Routing" value={row.routing_status?.replace(/_/g, ' ') ?? '—'} />
          <Spec label="Suppression" value={row.suppression_status?.replace(/_/g, ' ') ?? '—'} tone={row.suppression_status && row.suppression_status !== 'clear' ? 'warn' : null} />
        </dl>
      </Section>
      <Section title="History">
        <dl className="cpk-specs">
          <Spec label="Latest message" value={q ? `${qWords.label}${overdue ? ' · overdue' : ''}` : 'Never queued'} tone={overdue ? 'bad' : null} sub={q?.reason ? q.reason.replace(/_/g, ' ') : undefined} />
          {q?.scheduled_for ? <Spec label="Scheduled" value={whenIn(q.scheduled_for, tz)} /> : null}
          {q?.sent_at ? <Spec label="Sent" value={whenIn(q.sent_at, tz)} sub={q.from ? `from ${formatPhone(q.from)}` : undefined} /> : null}
          {q?.delivered_at ? <Spec label="Delivered" value={whenIn(q.delivered_at, tz)} /> : null}
          <Spec label="Messages queued" value={nf(row.queue_rows)} sub={row.proof_rows ? `${nf(row.proof_rows)} test rows apart` : undefined} />
          <Spec label="Reply" value={row.reply ? intent?.label ?? 'Replied' : 'None'} sub={row.reply ? whenIn(row.reply.at, tz) : undefined} tone={row.reply?.asked_to_stop ? 'warn' : null} />
        </dl>
      </Section>
      <Section title="Why">
        <dl className="cpk-specs">
          <Spec label="Included" value={why} />
          {row.target_status === 'blocked' ? <Spec label="Held" value={row.block_reason ? holdWords(row.block_reason) : 'Held'} tone="warn" /> : null}
          <Spec label="Next" value={next} />
        </dl>
      </Section>
      <div className="cpk-ctx__actions">
        <button type="button" className="cpk-btn is-solid" disabled={!row.thread_key} onClick={() => row.thread_key && openInboxThread({ threadKey: row.thread_key, propertyId: row.property_id })}>
          <Icon name="message" size={13} /> Open conversation
        </button>
        <button type="button" className="cpk-btn is-ghost" disabled={!row.property_id} onClick={() => row.property_id && pushRoutePath(`/entity-graph/property/${encodeURIComponent(row.property_id)}`)}>
          <Icon name="link" size={13} /> Entity Graph
        </button>
        <button type="button" className="cpk-btn is-ghost" disabled={!row.property_id} onClick={openProperty}>
          <Icon name="home" size={13} /> Property
        </button>
      </div>
      {!row.thread_key ? <p className="cpk-muted">No conversation exists until a message has gone out.</p> : null}
    </div>
  )
}

function SenderContext({ phone, k, onBack }: { phone: string; k: CockpitRead | null; onBack: () => void }) {
  const s = k?.senders.find((x) => x.phone === phone) ?? null
  const tz = k?.window.timezone ?? null
  const cap = k ? k.caps.per_sender_cap ?? k.caps.configured_per_number_cap : null
  return (
    <div className="cpk-ctx">
      <button type="button" className="cpk-ctx__back" onClick={onBack}><Icon name="chevron-left" size={13} /> Back to campaign</button>
      <h3 className="cpk-ctx__title">{s?.label ?? formatPhone(phone)}</h3>
      <p className="cpk-ctx__sub">{formatPhone(phone)}{s?.market ? ` · ${s.market}` : ''}</p>
      {!s ? <Unavailable what="This number" /> : (
        <>
          <Section title="This campaign">
            <dl className="cpk-specs">
              <Spec label="Carrying it" value={s.carrying_campaign ? 'Yes' : 'No'} />
              <Spec label="Queued" value={nf(s.campaign_queued)} />
              <Spec label="Sent today" value={nf(s.campaign_sent_today)} sub={cap ? `limit ${nf(cap)} a day` : undefined} />
              <Spec label="Last sent" value={s.campaign_last_sent_at ? whenIn(s.campaign_last_sent_at, tz) : 'Never'} />
            </dl>
          </Section>
          <Section title="The number">
            <dl className="cpk-specs">
              <Spec label="Status" value={s.status ?? (s.known ? '—' : 'Not in the fleet')} />
              <Spec label="Operator block" value={s.operator_blocked ? 'Blocked' : 'Not blocked'} tone={s.operator_blocked ? 'warn' : null} />
              <Spec label="Health" value={s.health_state ?? '—'} sub={s.health_reason ? s.health_reason.replace(/_/g, ' ') : undefined} />
              {s.spam_flagged_at ? <Spec label="Spam-flagged" value={whenIn(s.spam_flagged_at, tz)} tone="warn" /> : null}
              {s.cooling_until ? <Spec label="Cooling until" value={whenIn(s.cooling_until, tz)} /> : null}
              <Spec label="Daily limit" value={s.daily_limit ? nf(s.daily_limit) : '—'} />
              <Spec label="Last used" value={s.last_used_at ? whenIn(s.last_used_at, tz) : '—'} />
            </dl>
          </Section>
        </>
      )}
    </div>
  )
}

// ── the inspector ───────────────────────────────────────────────────────────

export function CockpitInspector({
  c, k, kLoading, tab, onTab, context, onContext, width, onResize, onClose, onOpenTargets, overlay,
}: {
  c: CampaignSummary
  k: CockpitRead | null
  kLoading: boolean
  tab: InspectorTab
  onTab: (t: InspectorTab) => void
  context: InspectorContext
  onContext: (ctx: InspectorContext) => void
  width: number
  onResize: (w: number) => void
  onClose: () => void
  onOpenTargets: () => void
  overlay: boolean
}) {
  const drag = useRef<{ x: number; w: number } | null>(null)
  const onPointerDown = (e: ReactPointerEvent) => {
    drag.current = { x: e.clientX, w: width }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drag.current) return
    onResize(drag.current.w + (drag.current.x - e.clientX))
  }
  const onPointerUp = () => { drag.current = null }

  const k2 = k ?? null
  return (
    <aside className={cls('cpk-insp', overlay && 'is-overlay')} aria-label="Inspector" style={{ ['--cpk-insp-w' as string]: `${width}px` }}>
      {!overlay ? (
        <div
          className="cpk-insp__grip"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize inspector"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={(e) => { if (e.key === 'ArrowLeft') onResize(width + 16); if (e.key === 'ArrowRight') onResize(width - 16) }}
          tabIndex={0}
        />
      ) : null}
      <div className="cpk-insp__head">
        {context ? <span className="cpk-insp__ctx">{context.kind === 'target' ? 'Target' : 'Sender'}</span> : (
          <div className="cpk-insp__tabs" role="tablist" aria-label="Inspector">
            {INSPECTOR_TABS.map((t) => (
              <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={cls('cpk-insp__tab', tab === t.key && 'is-on')} onClick={() => onTab(t.key)}>
                {t.label}
              </button>
            ))}
          </div>
        )}
        <button type="button" className="cpk-icon-btn cpk-insp__close" aria-label="Close inspector" onClick={onClose}><Icon name="close" size={13} /></button>
      </div>
      <div className="cpk-insp__body">
        {context?.kind === 'target' ? <TargetContext row={context.row} c={c} k={k2} onBack={() => onContext(null)} />
          : context?.kind === 'sender' ? <SenderContext phone={context.phone} k={k2} onBack={() => onContext(null)} />
            : tab === 'overview' ? <OverviewTab c={c} k={k2} />
              : tab === 'audience' ? <AudienceTab c={c} k={k2} onOpenTargets={onOpenTargets} />
                : tab === 'channels' ? <ChannelsTab k={k2} onSender={(phone) => onContext({ kind: 'sender', phone })} />
                  : tab === 'sequence' ? <SequenceTab c={c} k={k2} />
                    : tab === 'performance' ? <PerformanceTab k={k2} />
                      : <TechnicalTab c={c} k={k2} />}
        {!k && !kLoading && !context ? <Unavailable what="Live state" /> : null}
      </div>
    </aside>
  )
}
