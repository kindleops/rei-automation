import { useState } from 'react'
import { pushRoutePath } from '../../../app/router'
import { openInboxThread } from '../../../modules/mobile/mobile-inbox-bridge'
import { LCButton, LCFacts, LCInspector, LCInspectorSection, LCLink, LCSegmented, LCSkeleton, LCStatus, LCTooltip, cx } from '../../../shared/lc'
import { sound } from '../../../shared/sound'
import { describeIntent } from '../campaign-responses'
import type { CockpitTargetRow } from './cockpit-api'
import { feederSkipWords, holdWords } from './cockpit-model'
import type { Batch, ReplyBucketKey } from './war-room-api'
import { analyticsPath, calendarPath, dealIntelligencePath, entityGraphPath, pipelinePath, queuePath, workflowPath } from './war-room-links'
import {
  GATE_LABEL, OWNER_LABEL, REPLY_META, REPLY_ORDER, SENDER_STATE_LABEL, SENDER_STATE_TONE, audienceSteps, businessFunnel, capsTruth, clock, counterDrift,
  dayClock, facts, formatPhone, heldReasons, money, moneyLines, nf, pct, plural, relative, senderWhy, sourceWords, zoneFamily,
  type Gate, type GateKey, type Mission, type WarInput,
} from './war-room-model'
import { queueWordsOf } from './war-room-words'
import { BatchCard } from './WarExecution'
import { SenderRail } from './WarPlanes'

export type InspectorCtx =
  | { kind: 'campaign' }
  | { kind: 'gate'; gate: GateKey }
  | { kind: 'audience' }
  | { kind: 'senders' }
  | { kind: 'sender'; phone: string }
  | { kind: 'delivery' }
  | { kind: 'replies'; bucket?: ReplyBucketKey | null }
  | { kind: 'outcomes' }
  | { kind: 'queue' }
  | { kind: 'target'; row: CockpitTargetRow }
  | { kind: 'batch'; batch: Batch }

const FIELD_WORDS: Record<string, string> = {
  'properties.final_acquisition_score': 'Final acquisition score',
  'properties.property_type': 'Property type',
  'properties.market': 'Market',
  'properties.tax_delinquent': 'Tax delinquent',
  'properties.property_id': 'Pinned property ids',
}
const OP_WORDS: Record<string, string> = { gte: '≥', lte: '≤', gt: '>', lt: '<', eq: '=', in: 'is any of', is_any_of: 'is any of', is_true: 'is', is_false: 'is not', between: 'between' }

const fieldWords = (key: string) => FIELD_WORDS[key] ?? key.replace(/^[a-z_]+\./, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

type Handlers = {
  onClose: () => void
  onBack: (() => void) | null
  onContext: (ctx: InspectorCtx) => void
  onShowTargets: (status: 'all' | 'planned' | 'ready' | 'blocked', reason?: string | null) => void
  onAction: (id: string) => void
  onOpenMap: () => void
}

function Doors({ input, now, compact }: { input: WarInput; now: number; compact?: boolean }) {
  const f = facts(input)
  const id = input.book?.id ?? input.summary?.id ?? input.core?.campaign_id ?? ''
  const start = input.core?.lifecycle.activated_at ?? input.core?.lifecycle.created_at ?? null
  const market = input.intel?.routing?.[0]?.market ?? null
  return (
    <div className={cx('cc3-doors', compact && 'is-compact')}>
      <LCTooltip content="Queue owns dispatch. It has no campaign filter yet — it opens the full queue.">
        <span><LCButton size="sm" variant="secondary" icon="layers" onClick={() => pushRoutePath(queuePath(id))}>Open Queue</LCButton></span>
      </LCTooltip>
      <LCButton size="sm" variant="secondary" icon="stats" onClick={() => pushRoutePath(analyticsPath(id, { start, tz: f.tz, market: null }))}>Analytics</LCButton>
      {market ? <LCButton size="sm" variant="quiet" icon="stats" onClick={() => pushRoutePath(analyticsPath(id, { start, tz: f.tz, market }))}>{market} in Analytics</LCButton> : null}
      <LCButton size="sm" variant="secondary" icon="calendar" onClick={() => pushRoutePath(calendarPath(id, { scheduledFor: f.scheduledFor, tz: f.tz, status: f.status, now }))}>Calendar</LCButton>
      <LCButton size="sm" variant="secondary" icon="activity" onClick={() => pushRoutePath(workflowPath(input.intel?.batches?.list[0]?.run_id ?? null))}>Workflow Studio</LCButton>
    </div>
  )
}

function GateBody({ gate, input, now, h }: { gate: Gate; input: WarInput; now: number; h: Handlers }) {
  const f = facts(input)
  const tz = f.tz
  const held = heldReasons(input).filter((r) => r.gate === gate.key)
  const skips = Object.entries(f.feeder?.skipped_counts_by_reason ?? {}).filter(([, n]) => Number(n) > 0)
  return (
    <>
      <LCInspectorSection title="Now">
        <p className="cc3-insp__lead">{gate.detail}</p>
        <LCFacts rows={[
          { label: 'State', value: gate.state === 'block' ? 'Blocked' : gate.state === 'wait' ? 'Waiting' : gate.state === 'hold' ? 'Holding some sellers' : gate.state === 'warn' ? 'Watch' : gate.state === 'pass' ? 'Clear' : gate.state === 'idle' ? 'Not started' : 'Unknown' },
          { label: 'Value', value: gate.value },
          { label: 'Owner', value: gate.owner ? OWNER_LABEL[gate.owner] : 'No action needed' },
        ]} />
      </LCInspectorSection>
      {gate.key === 'schedule' ? (
        <LCInspectorSection title="Schedule">
          <LCFacts rows={[
            { label: 'Scheduled start', value: dayClock(input.core?.lifecycle.scheduled_for ?? f.scheduledFor, tz, now) },
            { label: 'Missed', value: f.missedFor ? dayClock(f.missedFor, tz, now) : 'No' },
            { label: 'Activated', value: dayClock(input.core?.lifecycle.activated_at, tz, now) },
            { label: 'Last change', value: input.core?.lifecycle.last_transition_reason },
          ]} />
          {f.missedFor ? (
            <div className="cc3-doors">
              <LCButton size="sm" variant="primary" onClick={() => h.onAction('reschedule')}>Reschedule</LCButton>
              <LCButton size="sm" variant="secondary" onClick={() => h.onAction('activate')}>Launch now…</LCButton>
            </div>
          ) : null}
          {f.missedFor ? <p className="cc3-foot">A start more than two hours stale is marked missed and never auto-fired — it waits for you.</p> : null}
        </LCInspectorSection>
      ) : null}
      {gate.key === 'window' ? (
        <LCInspectorSection title="Contact window">
          <LCFacts rows={[
            { label: 'Window', value: f.window?.window ? `${f.window.window} ${f.window.source === 'operator' ? '(operator default)' : '(campaign)'}` : null },
            { label: 'Zone', value: tz ? `${zoneFamily(tz)} · ${tz}` : null },
            { label: 'Closes', value: f.window?.closes_at ? clock(f.window.closes_at, tz) : '—' },
            { label: 'Opens', value: f.window?.next_open_at ? dayClock(f.window.next_open_at, tz, now) : '—' },
          ]} />
          <p className="cc3-foot">Waiting for the window is not a failure; the campaign stays live and resumes when it opens.</p>
        </LCInspectorSection>
      ) : null}
      {(gate.key === 'template' || gate.key === 'sender' || gate.key === 'capacity') && skips.length ? (
        <LCInspectorSection title="The feeder’s last pass" aside={<span className="cc3-dim">{relative(f.feeder?.at, now)}</span>}>
          <ul className="cc3-reasons is-plain">
            {skips.sort((a, b) => b[1] - a[1]).map(([code, n]) => <li key={code}><span className="cc3-reasons__label">{feederSkipWords(code)}</span><b className="lc-num">{nf(n)}</b></li>)}
          </ul>
          {f.feeder?.skip_summary ? <p className="cc3-foot">{f.feeder.skip_summary}</p> : null}
        </LCInspectorSection>
      ) : null}
      {gate.key === 'sender' && input.intel?.routing ? (
        <LCInspectorSection title="Routing by market">
          <ul className="cc3-routes is-stacked">
            {input.intel.routing.map((r) => (
              <li key={r.market} data-blocked={r.ready > 0 && r.eligible === 0 ? '' : undefined}>
                <b>{r.market}</b>
                <span className="lc-num">{nf(r.ready)} ready · {r.eligible ? plural(r.eligible, 'eligible sender') : 'no eligible sender'}</span>
                {Object.keys(r.by_state).length ? <span>{Object.entries(r.by_state).map(([s, n]) => `${n} ${s.replace(/_/g, ' ')}`).join(' · ')}</span> : <span>No local number in the fleet</span>}
              </li>
            ))}
          </ul>
          <LCLink icon="chevron-right" onClick={() => h.onContext({ kind: 'senders' })}>Sender fleet</LCLink>
        </LCInspectorSection>
      ) : null}
      {held.length ? (
        <LCInspectorSection title="Held here">
          <ul className="cc3-reasons">
            {held.map((r) => <li key={r.code}><button type="button" onClick={() => h.onShowTargets('blocked', r.code)}><span className="cc3-reasons__label">{r.label}</span><b className="lc-num">{nf(r.n)}</b></button></li>)}
          </ul>
        </LCInspectorSection>
      ) : null}
      {gate.key === 'queue' ? <QueueBody input={input} now={now} /> : null}
      {gate.key === 'delivery' || gate.key === 'provider' ? <DeliveryBody input={input} /> : null}
    </>
  )
}

function QueueBody({ input, now }: { input: WarInput; now: number }) {
  const q = input.core?.queue ?? null
  const f = facts(input)
  return (
    <LCInspectorSection title="Queue handoff" aside={<span className="cc3-dim">Campaign execution → Queue dispatch</span>}>
      <LCFacts rows={[
        { label: 'In the queue now', value: q ? nf(q.live) : f.queueLive === null ? null : nf(f.queueLive) },
        { label: 'Due / overdue', value: q ? `${nf(q.due)} / ${nf(q.overdue)}` : null },
        { label: 'Next due', value: q?.next_scheduled_at ? `${dayClock(q.next_scheduled_at, f.tz, now)} · ${relative(q.next_scheduled_at, now)}` : '—' },
        { label: 'Last claim', value: q?.last_claimed_at ? dayClock(q.last_claimed_at, f.tz, now) : '—' },
        { label: 'Last released', value: q?.last_release_reason ? `${q.last_release_reason.replace(/_/g, ' ')} · ${relative(q.last_released_at, now)}` : '—' },
        { label: 'Filtered-text retries queued', value: q ? nf(q.spam_retries) : null },
      ]} />
      <p className="cc3-foot">The buffer keeps up to {nf(input.intel?.feeder.buffer_target ?? 150)} rows ahead; it is telemetry, never the campaign’s size.</p>
    </LCInspectorSection>
  )
}

function DeliveryBody({ input }: { input: WarInput }) {
  const d = input.intel?.delivery ?? null
  const r = input.intel?.retries ?? null
  if (!d) return <LCSkeleton shape="lines" count={4} />
  return (
    <>
      <LCInspectorSection title="Transport" aside={<span className="cc3-dim lc-num">{nf(d.left_us)} texts left us</span>}>
        <LCFacts rows={[
          { label: 'Accepted by the provider', value: nf(d.accepted) },
          { label: 'Delivered', value: `${nf(d.delivered)} · ${pct(d.delivered, d.left_us) ?? '—'}` },
          { label: 'Sent, no receipt yet', value: nf(d.awaiting_receipt) },
          { label: 'Content filter', value: `${nf(d.filtered)} · ${pct(d.filtered, d.left_us) ?? '—'}`, hint: 'Carrier spam bucket — driven by wording' },
          { label: 'Invalid destination', value: nf(d.invalid_destination) },
          { label: 'Other carrier failures', value: nf(d.soft_bounce + d.carrier_dnc + d.carrier_undelivered) },
          { label: 'Refused by the provider', value: nf(d.provider_refused) },
          { label: 'Held at send', value: nf(d.held_at_send), hint: 'Sender or template health — a hold, not a failure' },
        ]} />
        {d.receipt_lag ? <p className="cc3-alert" data-tone="attn">{plural(d.receipt_lag, 'text')} read “sent” in the queue though the carrier reported them undelivered.</p> : null}
      </LCInspectorSection>
      {r ? (
        <LCInspectorSection title="Recovery lineage">
          <ol className="cc3-lineage is-compact">
            <li><b className="lc-num">{nf(r.originals_filtered)}</b><span>filtered first texts</span></li>
            <li><b className="lc-num">{nf(r.retry_rows)}</b><span>retried on another template</span></li>
            <li data-tone="ok"><b className="lc-num">{nf(r.retry_delivered)}</b><span>delivered on retry</span></li>
          </ol>
          <p className="cc3-foot">A retry supersedes its original under one logical communication — the seller is never counted twice.</p>
        </LCInspectorSection>
      ) : null}
    </>
  )
}

function RepliesBody({ input, now, bucket, onBucket }: { input: WarInput; now: number; bucket: ReplyBucketKey | null; onBucket: (b: ReplyBucketKey | null) => void }) {
  const r = input.intel?.replies ?? null
  const f = facts(input)
  if (!r) return <LCSkeleton shape="rows" count={6} />
  const list = bucket ? r.list.filter((s) => s.bucket === bucket) : r.list
  return (
    <>
      <LCInspectorSection title="Composition" aside={<span className="cc3-dim lc-num">{nf(r.sellers_replied)} of {nf(r.sellers_messaged)} messaged</span>}>
        <LCSegmented
          size="sm"
          label="Reply kind"
          value={bucket ?? 'all'}
          onChange={(v) => { sound.ui.select(); onBucket(v === 'all' ? null : (v as ReplyBucketKey)) }}
          options={[{ value: 'all', label: 'All' }, ...REPLY_ORDER.filter((k) => r.buckets[k]).map((k) => ({ value: k, label: `${REPLY_META[k].label} ${r.buckets[k]}` }))]}
        />
      </LCInspectorSection>
      <LCInspectorSection title={bucket ? REPLY_META[bucket].label : 'Every reply'} aside={<span className="cc3-dim">latest first</span>}>
        <ul className="cc3-replylist">
          {list.slice(0, 80).map((s) => {
            const d = describeIntent(s.intent)
            return (
              <li key={s.seller_phone}>
                <div className="cc3-replylist__head">
                  <b>{s.seller_name ?? formatPhone(s.seller_phone)}</b>
                  <span className="cc3-chip" data-tone={REPLY_META[s.bucket].tone}>{d.label}</span>
                  <time className="lc-num">{dayClock(s.latest_reply_at, f.tz, now)}</time>
                </div>
                {s.message ? <p className="cc3-replylist__msg">“{s.message}”</p> : null}
                {s.thread_key ? <LCLink icon="chevron-right" onClick={() => openInboxThread({ threadKey: s.thread_key! })}>Open conversation</LCLink> : null}
              </li>
            )
          })}
        </ul>
        {r.truncated ? <p className="cc3-foot">The message log hit its read ceiling — counts are a floor.</p> : null}
      </LCInspectorSection>
    </>
  )
}

function OutcomesBody({ input }: { input: WarInput }) {
  const o = input.intel?.outcomes ?? null
  const steps = businessFunnel(input)
  const m = moneyLines(input.intel)
  if (!o) return <LCSkeleton shape="rows" count={5} />
  return (
    <>
      <LCInspectorSection title="Business funnel">
        <ol className="cc3-bfunnel">
          {steps.map((s) => <li key={s.key}><span>{s.label}</span><b className="lc-num">{s.value === null ? '—' : nf(s.value)}</b>{s.basis ? <em>{s.basis}</em> : null}</li>)}
        </ol>
        <p className="cc3-foot">Attribution: the seller replied to this campaign’s number and the opportunity opened after its first text. A seller messaged by two campaigns counts in each.</p>
      </LCInspectorSection>
      <LCInspectorSection title="Opportunities" aside={<span className="cc3-dim lc-num">{nf(o.opportunities.length)}</span>}>
        {o.opportunities.length ? (
          <ul className="cc3-opps">
            {o.opportunities.map((x) => (
              <li key={x.id}>
                <div className="cc3-opps__head"><b>{x.seller ?? x.address ?? formatPhone(x.thread_key)}</b><span className="cc3-chip" data-tone={x.status === 'active' ? 'ok' : 'neutral'}>{(x.stage ?? '—').replace(/_/g, ' ')}</span></div>
                <span className="cc3-opps__sub">{x.status ?? '—'}{x.recommended_offer ? ` · recommended ${money(x.recommended_offer)} (modeled)` : ''}{x.moves.length ? ` · ${plural(x.moves.length, 'stage move')}` : ''}</span>
                <span className="cc3-doors is-compact">
                  <LCLink onClick={() => pushRoutePath(pipelinePath(x.id))}>Pipeline</LCLink>
                  {x.property_id ? <LCLink onClick={() => pushRoutePath(dealIntelligencePath(x.property_id!, x.master_owner_id))}>Deal Intelligence</LCLink> : null}
                  {x.thread_key ? <LCLink onClick={() => openInboxThread({ threadKey: x.thread_key!, propertyId: x.property_id })}>Conversation</LCLink> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : <p className="cc3-muted">No opportunity is attributable to this campaign yet.</p>}
      </LCInspectorSection>
      <LCInspectorSection title="Economics">
        <LCFacts rows={m.map((x) => ({ label: `${x.label} (${x.basis})`, value: x.n ? `${x.value} · ${nf(x.n)}` : 'None yet' }))} />
      </LCInspectorSection>
    </>
  )
}

function SenderBody({ phone, input, now }: { phone: string; input: WarInput; now: number }) {
  const s = input.intel?.fleet?.numbers.find((x) => x.phone === phone) ?? null
  const tz = facts(input).tz
  if (!s) return <LCSkeleton shape="lines" count={6} />
  return (
    <>
      <LCInspectorSection title="Eligibility">
        <p className="cc3-insp__lead">{senderWhy(s)}</p>
        <LCFacts rows={[
          { label: 'Market', value: s.market },
          { label: 'Fleet status', value: s.status },
          { label: 'Health', value: s.health_state ? `${s.health_state}${s.health_reason ? ` · ${s.health_reason.replace(/_/g, ' ')}` : ''}` : null },
          { label: 'Cooling until', value: s.cooling_until ? dayClock(s.cooling_until, tz, now) : s.state === 'cooling' ? 'No end date' : '—' },
          { label: 'Spam-flagged', value: s.spam_flagged_at ? dayClock(s.spam_flagged_at, tz, now) : '—' },
        ]} />
      </LCInspectorSection>
      <LCInspectorSection title="Capacity today">
        <LCFacts rows={[
          { label: 'Sent today (all campaigns)', value: nf(s.sent_today), hint: 'From the send queue, since the campaign’s local midnight' },
          { label: 'Limit', value: s.limit ? `${nf(s.limit)} / day (${s.limit_basis === 'campaign' ? 'campaign override' : s.limit_basis === 'system' ? 'system limit' : 'number'})` : null },
          { label: 'Room left', value: s.eligible ? nf(s.remaining_today) : 'Not eligible' },
          { label: 'Router counter', value: s.router_counter === null ? null : nf(s.router_counter), hint: 'textgrid_numbers.messages_sent_today' },
        ]} />
        {counterDrift(s) ? <p className="cc3-alert" data-tone="attn">The router’s counter ({nf(s.router_counter)}) has never been reset — it compares it with the {nf(s.daily_limit)}/day limit, so this number will be refused once it passes {nf(s.daily_limit)} even on a quiet day.</p> : null}
      </LCInspectorSection>
      <LCInspectorSection title="This campaign">
        <LCFacts rows={[
          { label: 'Carrying it', value: s.campaign.carrying ? 'Yes' : 'No' },
          { label: 'Queued now', value: nf(s.campaign.queued) },
          { label: 'Sent today', value: nf(s.campaign.sent_today) },
          { label: 'Last campaign text', value: s.campaign.last_sent_at ? `${dayClock(s.campaign.last_sent_at, tz, now)} · ${relative(s.campaign.last_sent_at, now)}` : 'Never' },
          { label: 'Delivered', value: s.campaign.left_us ? `${nf(s.campaign.delivered)} of ${nf(s.campaign.left_us)}${s.campaign.sample_ok ? ` · ${pct(s.campaign.delivered, s.campaign.left_us)}` : ' · small sample'}` : '—' },
          { label: 'Replies', value: s.campaign.sellers ? `${nf(s.campaign.sellers_replied)} of ${nf(s.campaign.sellers)} sellers` : '—' },
        ]} />
      </LCInspectorSection>
    </>
  )
}

function TargetBody({ row, input, now }: { row: CockpitTargetRow; input: WarInput; now: number }) {
  const tz = facts(input).tz
  const q = row.queue
  const qw = queueWordsOf(q?.status)
  const intent = row.reply ? describeIntent(row.reply.intent) : null
  return (
    <>
      <LCInspectorSection title="Seller">
        <LCFacts rows={[
          { label: 'Phone', value: formatPhone(row.phone) },
          { label: 'Property', value: row.property },
          { label: 'Market', value: row.market },
          { label: 'Eligibility', value: row.target_status === 'blocked' ? `Held · ${row.block_reason ? holdWords(row.block_reason) : 'held'}` : row.target_status === 'planned' ? 'Handed to the queue' : row.target_status === 'ready' ? 'Ready — waiting to be placed' : row.target_status },
          { label: 'Identity', value: row.identity_status?.replace(/_/g, ' ') },
          { label: 'Suppression', value: row.suppression_status?.replace(/_/g, ' ') },
        ]} />
      </LCInspectorSection>
      <LCInspectorSection title="Execution">
        <LCFacts rows={[
          { label: 'Latest text', value: q ? qw.label : 'Never queued' },
          { label: 'Scheduled', value: q?.scheduled_for ? dayClock(q.scheduled_for, tz, now) : '—' },
          { label: 'Sent', value: q?.sent_at ? `${dayClock(q.sent_at, tz, now)}${q.from ? ` · from ${formatPhone(q.from)}` : ''}` : '—' },
          { label: 'Delivered', value: q?.delivered_at ? dayClock(q.delivered_at, tz, now) : '—' },
          { label: 'Texts queued', value: `${nf(row.queue_rows)}${row.proof_rows ? ` · ${nf(row.proof_rows)} test rows apart` : ''}` },
          { label: 'Reply', value: row.reply ? `${intent?.label} · ${dayClock(row.reply.at, tz, now)}` : 'None' },
        ]} />
      </LCInspectorSection>
      <div className="cc3-doors">
        <LCButton size="sm" variant="primary" icon="message" disabled={!row.thread_key} onClick={() => row.thread_key && openInboxThread({ threadKey: row.thread_key, propertyId: row.property_id })}>Open conversation</LCButton>
        <LCButton size="sm" variant="secondary" icon="link" disabled={!row.property_id} onClick={() => row.property_id && pushRoutePath(entityGraphPath(row.property_id))}>Entity Graph</LCButton>
        <LCButton size="sm" variant="secondary" icon="home" disabled={!row.property_id} onClick={() => row.property_id && pushRoutePath(dealIntelligencePath(row.property_id, row.master_owner_id))}>Deal Intelligence</LCButton>
      </div>
      {!row.thread_key ? <p className="cc3-foot">No conversation exists until a text has gone out.</p> : null}
    </>
  )
}

function CampaignBody({ input, now, mission, h }: { input: WarInput; now: number; mission: Mission; h: Handlers }) {
  const core = input.core
  const lineage = core?.lineage ?? input.summary?.lineage ?? null
  const f = facts(input)
  const caps = capsTruth(input)
  const steps = audienceSteps(input)
  const tz = f.tz
  return (
    <>
      <LCInspectorSection title="Source cohort">
        {!lineage ? <LCSkeleton shape="lines" count={3} /> : (
          <>
            <LCFacts rows={[
              { label: 'Origin', value: sourceWords(lineage.kind) },
              { label: 'Exact cohort', value: lineage.explicit_property_count ? `${nf(lineage.explicit_property_count)} properties pinned by id` : lineage.kind === 'filters' ? 'Resolved from filters at build' : 'No ids pinned' },
              ...(lineage.kind === 'map_area' && lineage.area ? [{ label: 'Drawn area', value: `${lineage.area.vertices ? `${nf(lineage.area.vertices)}-point outline` : 'Outline'}${lineage.area.property_count ? ` · ${nf(lineage.area.property_count)} inside` : ''}${lineage.area.truncated ? ' · truncated at draw time' : ''}` }] : []),
              { label: 'Resolved targets', value: nf(steps.find((s) => s.key === 'resolved')?.value) },
            ]} />
            {lineage.kind === 'map_area' ? <p className="cc3-foot">The pinned id list is the exact cohort — execution never re-queries the area or stops at its first 5,000 properties.</p> : null}
          </>
        )}
      </LCInspectorSection>
      <LCInspectorSection title="Targeting filters">
        {!lineage ? null : lineage.filters.length ? (
          <ul className="cc3-filters">
            {lineage.filters.map((x, i) => (
              <li key={`${x.field_key}-${i}`}>
                <b>{fieldWords(x.field_key)}</b>
                <span>{OP_WORDS[String(x.operator)] ?? String(x.operator ?? '').replace(/_/g, ' ')}</span>
                <span className="cc3-filters__v">{x.value.kind === 'list' ? `${(x.value.sample ?? []).join(', ')}${(x.value.count ?? 0) > (x.value.sample?.length ?? 0) ? ` +${(x.value.count ?? 0) - (x.value.sample?.length ?? 0)}` : ''}` : x.value.kind === 'boolean' ? (x.value.value ? 'yes' : 'no') : String(x.value.value ?? '—')}</span>
              </li>
            ))}
          </ul>
        ) : lineage.kind === 'none' && !f.total ? (
          <div className="cc3-required"><b>Targeting required</b><span>Select a market, cohort, or filter set. A build with no targeting is refused — it never defaults to nationwide.</span></div>
        ) : <p className="cc3-muted">{lineage.kind === 'map_area' || lineage.kind === 'entity_graph' ? 'No filters — the pinned cohort is the targeting.' : 'No filter definition is stored on this campaign.'}</p>}
        {lineage && lineage.filters.length && !lineage.market_values.length ? <p className="cc3-foot">No market filter — the filters are the only narrowing.</p> : null}
      </LCInspectorSection>
      <LCInspectorSection title="Time">
        <LCFacts rows={[
          { label: 'Campaign zone', value: tz ? `${zoneFamily(tz)} · ${tz}` : 'Not set' },
          { label: 'Contact window', value: f.window?.window ? `${f.window.window}${f.window.source === 'operator' ? ' (operator default)' : ''}` : null },
          { label: 'Scheduled start', value: dayClock(core?.lifecycle.scheduled_for ?? f.scheduledFor, tz, now) ?? '—' },
          { label: 'Activated', value: dayClock(core?.lifecycle.activated_at, tz, now) ?? '—' },
          { label: 'Paused', value: core?.lifecycle.paused_at ? dayClock(core.lifecycle.paused_at, tz, now) : '—' },
          { label: 'Completed', value: core?.lifecycle.completed_at ? dayClock(core.lifecycle.completed_at, tz, now) : '—' },
        ]} />
      </LCInspectorSection>
      <LCInspectorSection title="Caps">
        <ul className="cc3-caps is-compact">
          {caps.map((c) => <li key={c.key} data-limiting={c.limiting ? '' : undefined}><span className="cc3-caps__label">{c.label}</span><b className="lc-num">{c.value}</b><span className="cc3-caps__meaning">{c.meaning}</span></li>)}
        </ul>
      </LCInspectorSection>
      <LCInspectorSection title="Open with this campaign">
        <Doors input={input} now={now} />
        <div className="cc3-doors">
          <LCButton size="sm" variant="quiet" icon="map" onClick={h.onOpenMap}>Map — exact cohort</LCButton>
          <LCButton size="sm" variant="quiet" icon="list" onClick={() => h.onShowTargets('all')}>Targets</LCButton>
        </div>
      </LCInspectorSection>
      <LCInspectorSection title="Identifiers">
        <LCFacts rows={[
          { label: 'Campaign', value: <span className="cc3-mono">{input.book?.id ?? input.summary?.id}</span> },
          { label: 'Latest run', value: input.intel?.batches?.list[0]?.run_id ? <span className="cc3-mono">{input.intel.batches.list[0].run_id}</span> : 'None' },
          { label: 'State', value: mission.label },
        ]} />
      </LCInspectorSection>
    </>
  )
}

function titleOf(ctx: InspectorCtx, input: WarInput): { eyebrow: string; title: string } {
  switch (ctx.kind) {
    case 'campaign': return { eyebrow: 'Campaign brief', title: input.book?.name ?? input.summary?.campaign_name ?? 'Campaign' }
    case 'gate': return { eyebrow: 'Gate', title: GATE_LABEL[ctx.gate] }
    case 'audience': return { eyebrow: 'Audience', title: 'Who is in, who is held' }
    case 'senders': return { eyebrow: 'Senders', title: 'Sender fleet' }
    case 'sender': return { eyebrow: 'Sender', title: formatPhone(ctx.phone) }
    case 'delivery': return { eyebrow: 'Delivery', title: 'Transport outcomes' }
    case 'replies': return { eyebrow: 'Replies', title: ctx.bucket ? REPLY_META[ctx.bucket].label : 'What sellers said' }
    case 'outcomes': return { eyebrow: 'Outcomes', title: 'Acquisition outcomes' }
    case 'queue': return { eyebrow: 'Queue', title: 'Queue handoff' }
    case 'target': return { eyebrow: 'Target', title: ctx.row.seller ?? formatPhone(ctx.row.phone) }
    case 'batch': return { eyebrow: 'Batch', title: `Batch ${nf(ctx.batch.n)}` }
  }
}

export function WarInspector({
  open, mode, ctx, input, now, mission, gates, h,
}: {
  open: boolean
  mode: 'dock' | 'float'
  ctx: InspectorCtx
  input: WarInput
  now: number
  mission: Mission
  gates: Gate[]
  h: Handlers
}) {
  const { eyebrow, title } = titleOf(ctx, input)
  const gate = ctx.kind === 'gate' ? gates.find((g) => g.key === ctx.gate) ?? null : null
  const status = ctx.kind === 'campaign' ? <LCStatus label={mission.label} tone={mission.tone} /> : gate ? <LCStatus label={gate.state === 'block' ? 'Blocked' : gate.state === 'wait' ? 'Waiting' : gate.state === 'pass' ? 'Clear' : gate.state === 'hold' ? 'Holding some' : gate.state} tone={gate.state === 'block' ? 'crit' : gate.state === 'hold' || gate.state === 'warn' ? 'attn' : gate.state === 'pass' ? 'ok' : 'neutral'} /> : ctx.kind === 'sender' ? (() => {
    const s = input.intel?.fleet?.numbers.find((x) => x.phone === ctx.phone)
    return s ? <LCStatus label={SENDER_STATE_LABEL[s.state]} tone={SENDER_STATE_TONE[s.state]} /> : null
  })() : null
  const key = `${ctx.kind}:${ctx.kind === 'gate' ? ctx.gate : ctx.kind === 'sender' ? ctx.phone : ctx.kind === 'target' ? ctx.row.id : ctx.kind === 'batch' ? ctx.batch.run_id : ''}`
  // the bucket a reply context opened on, until the operator picks another
  const [pick, setPick] = useState<{ key: string; bucket: ReplyBucketKey | null } | null>(null)
  const activeBucket = pick && pick.key === key ? pick.bucket : ctx.kind === 'replies' ? ctx.bucket ?? null : null
  return (
    <LCInspector
      open={open}
      onClose={h.onClose}
      id="campaign-command-3"
      mode={mode}
      width={380}
      minWidth={320}
      maxWidth={560}
      eyebrow={eyebrow}
      title={title}
      status={status}
      contentKey={key}
      back={h.onBack ? { label: 'Campaign brief', onBack: h.onBack } : undefined}
      className="cc3-insp"
    >
      {ctx.kind === 'campaign' ? <CampaignBody input={input} now={now} mission={mission} h={h} /> : null}
      {ctx.kind === 'gate' && gate ? <GateBody gate={gate} input={input} now={now} h={h} /> : null}
      {ctx.kind === 'audience' ? (
        <>
          <LCInspectorSection title="Waterfall">
            <ol className="cc3-water is-plain">
              {audienceSteps(input).map((s) => <li key={s.key} data-tone={s.tone}><span className="cc3-water__label">{s.label}</span><b className="cc3-water__value lc-num">{s.value === null ? '—' : nf(s.value)}</b>{s.detail ? <span className="cc3-water__detail">{s.detail}</span> : null}</li>)}
            </ol>
            <div className="cc3-doors">
              <LCButton size="sm" variant="secondary" onClick={() => h.onShowTargets('planned')}>Handed to queue</LCButton>
              <LCButton size="sm" variant="secondary" onClick={() => h.onShowTargets('ready')}>Ready</LCButton>
              <LCButton size="sm" variant="secondary" onClick={() => h.onShowTargets('blocked')}>Held</LCButton>
            </div>
          </LCInspectorSection>
          <LCInspectorSection title="Why sellers are held" aside={<span className="cc3-dim">held is not failed</span>}>
            {heldReasons(input).length ? (
              <ul className="cc3-reasons">
                {heldReasons(input).map((r) => <li key={r.code}><button type="button" onClick={() => h.onShowTargets('blocked', r.code)}><span className="cc3-reasons__gate">{GATE_LABEL[r.gate]}</span><span className="cc3-reasons__label">{r.label}</span><b className="lc-num">{nf(r.n)}</b></button></li>)}
              </ul>
            ) : <p className="cc3-muted">No seller is held.</p>}
          </LCInspectorSection>
        </>
      ) : null}
      {ctx.kind === 'senders' ? (
        <LCInspectorSection title="Numbers" aside={input.intel?.fleet ? <span className="cc3-dim lc-num">{nf(input.intel.fleet.numbers.length)} in the fleet</span> : null}>
          <div className="cc3-senders">{input.intel?.fleet ? input.intel.fleet.numbers.map((s) => <SenderRail key={s.phone} s={s} onOpen={() => h.onContext({ kind: 'sender', phone: s.phone })} />) : <LCSkeleton shape="rows" count={5} />}</div>
        </LCInspectorSection>
      ) : null}
      {ctx.kind === 'sender' ? <SenderBody phone={ctx.phone} input={input} now={now} /> : null}
      {ctx.kind === 'delivery' ? <><DeliveryBody input={input} /><Doors input={input} now={now} compact /></> : null}
      {ctx.kind === 'replies' ? <RepliesBody input={input} now={now} bucket={activeBucket} onBucket={(b) => setPick({ key, bucket: b })} /> : null}
      {ctx.kind === 'outcomes' ? <OutcomesBody input={input} /> : null}
      {ctx.kind === 'queue' ? <><QueueBody input={input} now={now} /><Doors input={input} now={now} compact /></> : null}
      {ctx.kind === 'target' ? <TargetBody row={ctx.row} input={input} now={now} /> : null}
      {ctx.kind === 'batch' ? (
        <>
          <BatchCard b={ctx.batch} tz={facts(input).tz} now={now} />
          <LCInspectorSection title="Senders in this batch">
            <ul className="cc3-reasons is-plain">{ctx.batch.senders.map((s, i) => <li key={`${s.value}-${i}`}><span className="cc3-reasons__label lc-num">{formatPhone(s.value ?? s.label)}</span><b className="lc-num">{nf(s.count)}</b></li>)}</ul>
            <p className="cc3-foot">{plural(ctx.batch.templates, 'template')} rotated across this batch.</p>
          </LCInspectorSection>
          <div className="cc3-doors"><LCButton size="sm" variant="secondary" icon="activity" onClick={() => pushRoutePath(workflowPath(ctx.batch.run_id))}>Open run in Workflow Studio</LCButton></div>
        </>
      ) : null}
    </LCInspector>
  )
}
