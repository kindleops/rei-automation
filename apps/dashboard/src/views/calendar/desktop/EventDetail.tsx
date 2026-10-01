import { useState } from 'react'
import { Icon } from '../../../shared/icons'
import { LCButton, LCFacts, LCIconButton, LCInspector, LCInspectorSection, LCStatus, cx } from '../../../shared/lc'
import type { DeskEvent } from '../../../domain/calendar/calendar-timeline-api'
import { humanReason } from '../../../domain/calendar/calendar-timeline-api'
import { APP_NAME, destinations, writeDeadline, type Destination } from './desk-actions'
import { LANES, OWNER_WORD, SOURCE_LABEL, STATUS_LABEL, laneOf, sourceOf, statusOf, timeText, toneOf, waitingOn } from './temporal-model'
import { HOUR, MIN, clock, dayKey, localStamp, longDay, monthDay, relative, span, zoneAbbr, zonedInstant } from './temporal-time'

/**
 * EVENT DETAIL (§46, §111–113) — a contextual plane, not a modal: when (in
 * every zone that matters), who owns it, why it exists, why it needs
 * attention, what happens next, where it came from, and the ways out. A
 * change is offered only where the read model grants a canonical write
 * path (event.actions); everything else states the app that owns it.
 */

export interface DetailProps {
  e: DeskEvent
  tz: string
  now: number
  canSplit: boolean
  onClose: () => void
  onOpen: (d: Destination) => void
  onBeside: (d: Destination) => void
  onRequestReschedule: (e: DeskEvent, toMs: number) => void
  onRequestCancel: (e: DeskEvent) => void
}

const STATE_KEY: Record<string, 'scheduled' | 'running' | 'waiting_seller' | 'needs_you' | 'overdue' | 'done' | 'inactive' | 'failed' | 'workflow' | 'due'> = {
  scheduled: 'scheduled', running: 'running', waiting: 'waiting_seller', needs_you: 'needs_you', attention: 'due', overdue: 'overdue', missed: 'due', failed: 'failed', completed: 'done', cancelled: 'inactive',
}

const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v).toLocaleString('en-US'))

export function EventDetail({ e, tz, now, canSplit, onClose, onOpen, onBeside, onRequestReschedule, onRequestCancel }: DetailProps) {
  const lane = LANES.find((l) => l.key === laneOf(e))!
  const status = statusOf(e)
  const t = timeText(e, tz)
  const dest = destinations(e)
  const primary = dest[0] ?? null
  const d = e.detail as Record<string, unknown> & {
    feeder?: { at?: string | null; reason?: string | null; stalled?: boolean; sent_today?: number | null } | null
    next_nodes?: Array<{ label: string; exit: string | null }>; steps?: Array<{ node: string; status: string; exit: string | null; at: string; reason?: string | null }>
    requirements?: Array<{ key: string; label: string; met: boolean; detail?: string | null; owner?: string | null }>
    blockers?: Array<{ key: string; label?: string; detail?: string | null }>
    counts?: Record<string, number>; members?: Array<{ id: string; start: string; subtitle: string | null; reason: string | null; status: string }>
  }
  const wait = waitingOn(e, tz)
  const at = e.undated ? null : Date.parse(e.start)
  const title = e.type === 'campaign_window' || e.type === 'campaign_start' || e.type === 'campaign_sends' ? String(e.subtitle || e.title) : e.title
  const sub = e.type === 'campaign_window' || e.type === 'campaign_start' || e.type === 'campaign_sends' ? e.title : e.subtitle
  const statusLabel = status === 'running' && e.type === 'campaign_window' ? 'Sending' : STATUS_LABEL[status]
  return (
    <LCInspector open onClose={onClose} id="calendar-event" mode="dock" width={392} minWidth={320} maxWidth={560}
      eyebrow={<span className="tcc-insp__eyebrow"><Icon name={lane.key === 'campaigns' ? 'send' : lane.key === 'sellers' ? 'message' : lane.key === 'workflows' ? 'layers' : lane.key === 'deals' ? 'briefcase' : lane.key === 'closings' ? 'key' : 'mail'} size={11} />{lane.label} · {SOURCE_LABEL[sourceOf(e)]}</span>}
      title={title}
      subtitle={sub}
      contentKey={e.id}
      label={`${e.title} — detail`}
      status={<span className="tcc-insp__status"><LCStatus state={STATE_KEY[status]} label={statusLabel} tone={toneOf(e)} />{wait ? <span className="tcc-insp__wait">{wait}</span> : null}</span>}
      actions={primary && canSplit ? <LCIconButton icon="layout-split" label={`Open ${APP_NAME[primary.app] || primary.app} beside`} size="sm" onClick={() => onBeside(primary)} /> : null}
      footer={primary ? (
        <div className="tcc-insp__foot">
          <LCButton variant="primary" size="sm" icon="arrow-up-right" onClick={() => onOpen(primary)}>{primary.label}</LCButton>
          {canSplit ? <LCButton variant="secondary" size="sm" icon="layout-split" onClick={() => onBeside(primary)}>Beside</LCButton> : null}
        </div>
      ) : null}
    >
      {/* WHEN */}
      <LCInspectorSection title="When">
        <div className="tcc-when">
          <b className="tcc-when__main">{t.main}</b>
          {t.alt ? <span className="tcc-when__alt">{t.alt}</span> : null}
          {!t.alt && at && e.contact_window?.tz && e.contact_window.tz !== tz && clock(at, e.contact_window.tz) !== clock(at, tz) ? <span className="tcc-when__alt">{clock(at, e.contact_window.tz)} {e.contact_window.abbr} for the seller</span> : null}
          <span className="tcc-when__day">{e.undated ? 'No date on record' : e.all_day && e.date ? longDay(e.date) : at ? `${longDay(dayKey(at, tz))} · ${relative(at, now)}` : null}</span>
        </div>
        <p className="tcc-insp__basis">{e.provenance.timezone_basis}{e.provenance.timezone && e.provenance.timezone !== tz ? ` · ${zoneAbbr(e.provenance.timezone)}` : ''}</p>
        {e.contact_window && !e.history ? (
          <p className={cx('tcc-insp__note', e.contact_window.deferred && 'is-attn')}>
            Seller's contact window {e.contact_window.window} {e.contact_window.abbr}.{' '}
            {e.contact_window.deferred ? `Outside it — the earliest it can send is ${clock(e.contact_window.earliest_at, e.contact_window.tz)} ${e.contact_window.abbr} (${clock(e.contact_window.earliest_at, tz)} ${zoneAbbr(tz)}).` : 'Planned inside it.'}
          </p>
        ) : null}
      </LCInspectorSection>

      {/* CAMPAIGN EXECUTION — window progress and audience progress are different facts (§13) */}
      {e.type === 'campaign_window' ? <CampaignFacts e={e} now={now} tz={tz} /> : null}
      {e.type === 'campaign_sends' ? (
        <LCInspectorSection title="Campaign texts this day">
          <LCFacts rows={[
            { label: 'Sent', value: num(d.counts?.sent) },
            { label: 'Waiting', value: num((d.counts?.scheduled ?? 0) + (d.counts?.sending ?? 0)) },
            { label: 'Did not go out', value: num(d.counts?.blocked) },
            { label: 'Cancelled', value: num(d.counts?.cancelled) },
            { label: 'Next queued send', value: d.next_send_at ? `${clock(String(d.next_send_at), tz)} ${zoneAbbr(tz)}` : 'None queued' },
            { label: 'Last row', value: d.last_send_at ? `${clock(String(d.last_send_at), tz)} ${zoneAbbr(tz)}` : null },
          ]} />
        </LCInspectorSection>
      ) : null}

      {/* WHY ATTENTION? — evidence, not a score (§113) */}
      {e.attention && !e.history ? (
        <LCInspectorSection title="Why attention">
          <p className="tcc-insp__why is-attn">{humanReason(e.reason) || 'Flagged by the read model.'}</p>
          {at && at < now ? <p className="tcc-insp__basis">Its time passed {span(now - at)} ago.</p> : null}
        </LCInspectorSection>
      ) : null}

      {/* WHY? — the system's reason (§112) */}
      {e.why || e.provenance.scheduled_by ? (
        <LCInspectorSection title="Why it is on the calendar">
          {e.why ? <p className="tcc-insp__why">{e.why}</p> : null}
          <LCFacts rows={[
            { label: 'Scheduled by', value: e.provenance.scheduled_by || null },
            ...(d.followup_reason ? [{ label: 'Reason', value: String(d.followup_reason) }] : []),
            ...(e.provenance.policy ? [{ label: 'Policy', value: e.provenance.policy }] : []),
            { label: 'Source record', value: <code className="tcc-code">{e.source}</code> },
          ]} />
        </LCInspectorSection>
      ) : null}

      {e.next || (e.reason && !e.attention) ? (
        <LCInspectorSection title="What happens next">
          <p className="tcc-insp__why">{e.next || humanReason(e.reason)}</p>
        </LCInspectorSection>
      ) : null}

      {/* WORKFLOW — only the temporal facts, never the whole graph (§19) */}
      {laneOf(e) === 'workflows' ? (
        <LCInspectorSection title="Workflow">
          <LCFacts rows={[
            { label: 'Workflow', value: String(d.workflow_name || '') || null },
            { label: 'Version', value: d.version !== undefined ? `v${d.version} (pinned)` : null },
            { label: 'Waiting at', value: String(d.node_label || '') || null },
            { label: 'Timer', value: d.duration_hours ? `${d.duration_hours} h from ${d.anchor === 'trigger' ? 'the trigger' : 'entering the step'}` : null },
            { label: 'Then', value: d.next_nodes?.length ? d.next_nodes.map((n) => `${n.label}${n.exit ? ` (${n.exit})` : ''}`).join(' → ') : null },
          ]} />
          {d.steps?.length ? (
            <ol className="tcc-steps">
              {d.steps.map((s, i) => <li key={i}><span className="tcc-dot" data-tone={s.status === 'succeeded' || s.status === 'resolved' ? 'ok' : s.status === 'waiting' ? 'flow' : 'neutral'} aria-hidden="true" /><b>{s.node}</b><em>{s.status}{s.exit ? ` · ${s.exit}` : ''}</em><time>{clock(s.at, tz)}</time></li>)}
            </ol>
          ) : null}
        </LCInspectorSection>
      ) : null}

      {/* CLOSING — Closing Desk truth: requirements and blockers (§20, §102) */}
      {laneOf(e) === 'closings' && (d.requirements?.length || d.blockers?.length) ? (
        <LCInspectorSection title="Closing Desk">
          {d.requirements?.length ? (
            <ul className="tcc-reqs">
              {d.requirements.map((r) => <li key={r.key} className={cx(r.met && 'is-met')}><Icon name={r.met ? 'check' : 'clock'} size={11} /><b>{r.label}</b>{r.detail ? <em>{r.detail}</em> : null}{!r.met && r.owner ? <span className="tcc-owner">{OWNER_WORD[r.owner as keyof typeof OWNER_WORD] || r.owner}</span> : null}</li>)}
            </ul>
          ) : null}
          {d.blockers?.length ? <p className="tcc-insp__why is-attn">{d.blockers.map((b) => b.label || b.detail || humanReason(b.key)).join(' · ')}</p> : null}
        </LCInspectorSection>
      ) : null}

      {/* a group's members, each still reachable */}
      {d.members?.length ? (
        <LCInspectorSection title={`${d.members.length} messages`}>
          <ul className="tcc-members">
            {d.members.slice(0, 20).map((m) => <li key={m.id}><time>{clock(m.start, tz)}</time><b>{m.subtitle || 'Seller'}</b><em>{humanReason(m.reason) || m.status}</em></li>)}
          </ul>
        </LCInspectorSection>
      ) : null}

      {/* SUBJECT + ways out (§47, §49) */}
      {dest.length > 1 || e.place ? (
        <LCInspectorSection title="Related">
          {e.place ? <p className="tcc-insp__place"><Icon name="pin" size={12} />{e.place}</p> : null}
          <div className="tcc-links">
            {dest.slice(1).map((x) => (
              <span key={x.key} className="tcc-link">
                <button type="button" onClick={() => onOpen(x)}><Icon name="arrow-up-right" size={11} />{x.label}</button>
                {canSplit ? <button type="button" className="tcc-link__beside" onClick={() => onBeside(x)} aria-label={`${x.label} beside`} title="Open beside"><Icon name="layout-split" size={11} /></button> : null}
              </span>
            ))}
          </div>
        </LCInspectorSection>
      ) : null}

      {/* HISTORY — only what the records say (§111) */}
      <History e={e} tz={tz} />

      {/* AUTHORITY — read-only, or the canonical write path (§88–89) */}
      <LCInspectorSection title="Authority">
        {e.actions?.reschedule ? (
          <Reschedule e={e} tz={tz} now={now} onRequest={onRequestReschedule} onCancel={() => onRequestCancel(e)} />
        ) : (
          <p className="tcc-insp__basis"><Icon name="shield" size={11} /> Read-only here. {e.editable.how}</p>
        )}
      </LCInspectorSection>
    </LCInspector>
  )
}

function CampaignFacts({ e, now, tz }: { e: DeskEvent; now: number; tz: string }) {
  const d = e.detail as { audience?: number | null; eligible?: number | null; held?: number | null; committed?: number | null; sent?: number | null; remaining?: number | null; scheduled?: number | null; daily_cap?: number | null; daily_pace?: number; day_index?: number; projected_days?: number; halted?: string | null; market?: string | null; window?: string | null; feeder?: { at?: string | null; reason?: string | null; stalled?: boolean } | null; tz?: string | null }
  const s = Date.parse(e.start)
  const end = Date.parse(e.end || e.start)
  const elapsed = Math.min(1, Math.max(0, (now - s) / Math.max(1, end - s)))
  const eligible = Number(d.eligible ?? 0)
  const sent = Number(d.sent ?? 0)
  return (
    <LCInspectorSection title="Campaign execution">
      <div className="tcc-meters">
        <div className="tcc-meter">
          <span className="tcc-meter__head"><b>Window</b><em>{now < s ? `opens ${relative(s, now)}` : now >= end ? 'closed' : `${span(now - s)} of ${span(end - s)} elapsed`}</em></span>
          <span className="tcc-meter__bar is-time"><i style={{ width: `${elapsed * 100}%` }} /></span>
        </div>
        <div className="tcc-meter">
          <span className="tcc-meter__head"><b>Audience</b><em>{eligible ? `${sent.toLocaleString('en-US')} of ${eligible.toLocaleString('en-US')} eligible sent` : 'No eligible audience on record'}</em></span>
          <span className="tcc-meter__bar"><i style={{ width: `${eligible ? Math.min(100, (sent / eligible) * 100) : 0}%` }} /></span>
        </div>
      </div>
      <LCFacts rows={[
        { label: 'Audience', value: num(d.audience), hint: 'All campaign targets (Campaign Command)' },
        { label: 'Held', value: num(d.held), hint: 'Targets blocked from sending' },
        { label: 'Eligible', value: num(d.eligible), hint: 'Audience minus held' },
        { label: 'Already planned', value: num(d.committed), hint: 'Eligible targets already planned into the queue' },
        { label: 'Sent', value: num(d.sent), hint: 'Send-queue rows sent or delivered' },
        { label: 'Ready', value: num(d.remaining), hint: 'Targets ready to be queued' },
        { label: 'Queued', value: num(d.scheduled), hint: 'Rows in the queue waiting to go out' },
        { label: 'Window', value: d.window ? `${d.window} ${zoneAbbr(d.tz)}` : null },
        ...(d.market ? [{ label: 'Market', value: d.market }] : []),
        { label: 'Day plan', value: d.daily_pace ? `Day ${d.day_index} of ${d.projected_days} · ${d.daily_pace.toLocaleString('en-US')}/day cap` : 'No cap on record — not projected', hint: 'Deterministic: ready + queued ÷ the campaign\'s daily cap (or per-sender cap × senders). Not a completion estimate.' },
      ]} />
      {d.feeder?.at ? <p className="tcc-insp__basis">Feeder's last word {clock(d.feeder.at, tz)}: {humanReason(d.feeder.reason) || '—'}{d.feeder.stalled ? ' · stalled' : ''}</p> : null}
      {d.halted ? <p className="tcc-insp__why is-crit">{d.halted === 'emergency_stop' ? 'Emergency stop is on — this window will not send.' : 'The queue processor is not live — this window will not send.'}</p> : null}
    </LCInspectorSection>
  )
}

function History({ e, tz }: { e: DeskEvent; tz: string }) {
  const d = e.detail as Record<string, unknown>
  const rows: Array<{ label: string; value: string }> = []
  const when = (v: unknown) => { const t = Date.parse(String(v || '')); return Number.isFinite(t) ? `${monthDay(dayKey(t, tz))} · ${clock(t, tz)}` : null }
  if (d.started_at) rows.push({ label: 'Started', value: when(d.started_at) || '' })
  if (d.outcome_at) rows.push({ label: e.state === 'superseded' ? 'Seller wrote again' : 'Completed', value: when(d.outcome_at) || '' })
  if (d.finished_at) rows.push({ label: 'Finished', value: when(d.finished_at) || '' })
  if (d.cancel_reason) rows.push({ label: 'Cancelled', value: `${humanReason(String(d.cancel_reason))}${d.cancelled_by ? ` · by ${humanReason(String(d.cancelled_by))}` : ''}` })
  if (d.queue_status) rows.push({ label: 'Queue status', value: humanReason(String(d.queue_status)) })
  if (e.updated_at) rows.push({ label: 'Record updated', value: when(e.updated_at) || '' })
  if (!rows.length) return null
  return (
    <LCInspectorSection title="History">
      <LCFacts rows={rows.filter((r) => r.value)} />
    </LCInspectorSection>
  )
}

/** Reschedule a message you scheduled: pick a time (your zone), see the seller's, confirm. */
function Reschedule({ e, tz, now, onRequest, onCancel }: { e: DeskEvent; tz: string; now: number; onRequest: (e: DeskEvent, toMs: number) => void; onCancel: () => void }) {
  const start = Date.parse(e.start)
  const local = (ms: number) => localStamp(ms, tz)
  const [value, setValue] = useState(() => local(start + HOUR))
  const target = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? zonedInstant(value.slice(0, 10), value.slice(11, 16), tz) : NaN
  const lead = (e.actions?.reschedule?.min_lead_minutes ?? 10) * MIN
  const tooClose = writeDeadline(e) <= now
  const targetOk = Number.isFinite(target) && target - now > lead && Math.abs(target - start) >= MIN
  const seller = e.contact_window?.tz && e.contact_window.tz !== tz ? e.contact_window.tz : null
  return (
    <div className="tcc-resched">
      <p className="tcc-insp__basis"><Icon name="check" size={11} /> {e.editable.how}</p>
      {tooClose ? <p className="tcc-insp__why is-attn">It sends in under {e.actions?.reschedule?.min_lead_minutes} minutes — the queue may already hold it. Change it in the Queue.</p> : (
        <>
          <label className="tcc-resched__field">
            <span className="lc-eyebrow">New time · {zoneAbbr(tz)}</span>
            <input type="datetime-local" value={value} min={local(now + lead + MIN)} onChange={(ev) => setValue(ev.target.value)} />
          </label>
          {Number.isFinite(target) ? <p className="tcc-insp__basis">{seller ? `Seller's local time ${clock(target, seller)} ${zoneAbbr(seller)} · ` : ''}{target - now <= lead ? `Must be at least ${lead / MIN} minutes from now.` : relative(target, now)}</p> : null}
          <div className="tcc-resched__acts">
            <LCButton variant="secondary" size="sm" icon="clock" disabled={!targetOk} onClick={() => onRequest(e, target)}>Reschedule…</LCButton>
            <LCButton variant="ghost" size="sm" onClick={onCancel}>Cancel message…</LCButton>
          </div>
          <p className="tcc-insp__basis">Or drag it on the canvas. Nothing changes until you confirm.</p>
        </>
      )}
    </div>
  )
}
