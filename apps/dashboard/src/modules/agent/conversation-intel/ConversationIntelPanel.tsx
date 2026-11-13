import { useEffect, useState, type ReactNode } from 'react'
import { Icon } from '../../../shared/icons'
import { LCButton, LCConfirm, LCIconButton, cx } from '../../../shared/lc'
import { fmtUsd } from '../ui/format'
import {
  CONTROL_LABEL, DRAFT_LABEL, GATE_LABEL, JOB_STATE_LABEL, OUTCOME_LABEL, STAGE_LABEL, humanize, jobForRecord, loadControl, loadIntel, noResponseReason,
  runControl, setIntel, summarize, useIntel, visibleRecords, type ControlAction, type ControlJob, type ControlState, type GateKey, type Outcome, type ShadowRecord,
} from './conversation-intel-model'
import './conversation-intel.css'

const FILTERS: Array<Outcome | 'ALL'> = ['ALL', 'REPLY_CANDIDATE', 'NEEDS_REVIEW', 'ESCALATE_TO_SONNET', 'NO_RESPONSE', 'UPDATE_ONLY', 'SUPPRESS']
const ms = (n: number | null | undefined) => (n == null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`)
const usd = (n: number | null | undefined) => (n == null ? '—' : fmtUsd(n))
const pct = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n * 100)}%`)
const POLL_MS = 30_000

/** Keeps the runtime control state fresh while the panel is open. */
function useControlPolling(open: boolean) {
  useEffect(() => {
    if (!open) return
    void loadControl()
    const t = setInterval(() => { void loadControl() }, POLL_MS)
    return () => clearInterval(t)
  }, [open])
}

/**
 * CONVERSATION INTELLIGENCE — read-only shadow review (Conversation Engine 2.0 R1/R2).
 * incoming message → context → intent → facts → stage evidence → decision → model →
 * proposed reply (draft, never sent) → validation → worker job. No action here can send.
 */
export function ConversationIntelPanel() {
  const s = useIntel()
  useEffect(() => { if (s.status === 'idle') void loadIntel() }, [s.status])
  useControlPolling(s.open)
  const rows = visibleRecords(s)
  const sel = rows.find((r) => r.idempotency_key === s.selectedKey) ?? rows[0] ?? null
  const sum = summarize(rows)
  const shadow = s.control?.shadow.state ?? 'unknown'
  return (
    <div className="agx-canvas cix" aria-label="Conversation intelligence (shadow)">
      <header className="cix-head">
        <div className="cix-head__t">
          <span className="cix-eyebrow">
            Conversation intelligence
            <i className="cix-shadow">Mode: shadow · nothing sends</i>
            <i className={cx('cix-state', `is-${shadow}`)} data-testid="cix-shadow-state">Shadow {shadow}</i>
          </span>
          <h2>Inbound decisions</h2>
          <p>{sum.count} records · {sum.validated} validated drafts · {fmtUsd(sum.total_usd)} model cost · p50 {ms(sum.p50_ms)} · p95 {ms(sum.p95_ms)}</p>
        </div>
        <div className="cix-head__tools">
          <div className="cix-filters" role="tablist" aria-label="Outcome filter">
            {FILTERS.map((f) => <button key={f} type="button" role="tab" aria-selected={s.filter === f} className={cx('cix-chip', s.filter === f && 'is-on')} onClick={() => setIntel({ filter: f })}>{f === 'ALL' ? 'All' : OUTCOME_LABEL[f]}</button>)}
          </div>
          <LCIconButton icon="refresh-cw" label="Reload shadow records" size="sm" onClick={() => { void loadIntel(); void loadControl() }} />
          <LCIconButton icon="x" label="Close conversation intelligence" size="sm" onClick={() => setIntel({ open: false })} />
        </div>
      </header>
      {s.note ? <p className="cix-note">{s.note}</p> : null}
      {s.status === 'loading' ? <div className="cix-empty is-computing"><span className="cix-pulse" />Reading shadow records…</div>
        : !rows.length ? <div className="cix-empty">{s.status === 'ready' ? 'No records for this filter.' : 'No shadow records to show.'}</div>
        : (
          <div className="cix-body">
            <ol className="cix-list" aria-label="Shadow records">
              {rows.map((r) => {
                const job = jobForRecord(s.control, r)
                return (
                  <li key={r.idempotency_key}>
                    <button type="button" className={cx('cix-row', sel?.idempotency_key === r.idempotency_key && 'is-active', `is-${r.validation.status}`)} onClick={() => setIntel({ selectedKey: r.idempotency_key })}>
                      <span className="cix-row__k"><b>{humanize(r.understood.intent)}</b><span className={cx('cix-out', `is-${r.decision.outcome.toLowerCase()}`)}>{OUTCOME_LABEL[r.decision.outcome]}</span></span>
                      <span className="cix-row__m">{r.seller_message_masked}</span>
                      <span className="cix-row__f">{STAGE_LABEL[r.stage_evidence?.stage] ?? r.stage_evidence?.stage} · {r.model.path} · {fmtUsd(r.cost.total_usd)} · {ms(r.latency_ms)}{job ? ` · job ${JOB_STATE_LABEL[job.state] ?? job.state}` : ''}</span>
                    </button>
                  </li>
                )
              })}
            </ol>
            {sel ? <RecordDetail r={sel} job={jobForRecord(s.control, sel)} /> : null}
          </div>
        )}
    </div>
  )
}

function Step({ n, title, children, tone }: { n: number; title: string; children: ReactNode; tone?: 'resolved' | 'computing' | 'blocked' }) {
  return (
    <section className={cx('cix-step', tone && `is-${tone}`)}>
      <h5><span className="cix-step__n">{n}</span>{title}</h5>
      <div className="cix-step__b">{children}</div>
    </section>
  )
}

function RecordDetail({ r, job }: { r: ShadowRecord; job: ControlJob | null }) {
  const v = r.validation
  const cs = r.context_summary
  const reason = noResponseReason(r)
  const known = [...new Set([...(r.facts.already_known || []), ...(cs?.facts || [])])]
  return (
    <article className="cix-detail" aria-label="Decision pipeline">
      <Step n={1} title="Incoming message">
        {r.our_last_message_masked ? <p className="cix-ours"><Icon name="message" size={11} />Our last message: {r.our_last_message_masked}</p> : null}
        <blockquote className="cix-quote">{r.seller_message_masked}</blockquote>
        <p className="cix-muted">Received {new Date(r.created_at).toLocaleString()}{r.deterministic_engine?.intent ? ` · deterministic engine: ${humanize(r.deterministic_engine.intent)}` : ''}</p>
      </Step>
      <Step n={2} title="Context summary">
        {cs ? (
          <dl className="cix-kv">
            <dt>Stage before</dt><dd>{cs.stage?.stage ? STAGE_LABEL[cs.stage.stage] ?? cs.stage.stage : '—'}</dd>
            <dt>Messages read</dt><dd>{cs.message_count ?? '—'}</dd>
            <dt>Do not ask</dt><dd>{cs.do_not_ask?.length ? cs.do_not_ask.map(humanize).join(', ') : 'Nothing blocked'}</dd>
            <dt>Eligibility</dt><dd>{cs.eligibility ? (cs.eligibility.blocked ? `Blocked — ${cs.eligibility.reasons.map(humanize).join(', ')}` : 'Eligible (dry run)') : 'Not evaluated'}</dd>
          </dl>
        ) : <p className="cix-muted">No context summary on this record.</p>}
      </Step>
      <Step n={3} title="Intent"><p><b>{humanize(r.understood.intent)}</b> · interest {humanize(r.understood.seller_interest)} · confidence {pct(r.understood.confidence)}</p></Step>
      <Step n={4} title="Facts">
        <h6>Extracted from this message</h6>
        {r.facts.extracted.length ? <ul className="cix-facts">{r.facts.extracted.map((f, i) => <li key={i}><b>{humanize(f.fact)}</b> {String(f.value)} <span className="cix-muted">seller-stated · {pct(f.confidence)}</span></li>)}</ul> : <p className="cix-muted">No new facts.</p>}
        <h6>Already known</h6>
        <p className={known.length ? undefined : 'cix-muted'}>{known.length ? known.map(humanize).join(', ') : 'Nothing known before this message.'}</p>
      </Step>
      <Step n={5} title="Stage evidence"><p><b>{STAGE_LABEL[r.stage_evidence.stage] ?? r.stage_evidence.stage}</b> — {r.stage_evidence.rationale}</p>{r.stage_evidence.evidence_message_ids?.length ? <p className="cix-muted">{r.stage_evidence.evidence_message_ids.length} evidence message(s)</p> : null}</Step>
      <Step n={6} title="Decision" tone={r.decision.outcome === 'SUPPRESS' ? 'blocked' : undefined}>
        <p><b>{OUTCOME_LABEL[r.decision.outcome]}</b> · next {humanize(r.decision.next_objective)}</p>
        {reason ? <p className="cix-reason" data-testid="cix-reason">{reason}</p> : null}
      </Step>
      <Step n={7} title="Model">
        <p>{r.model.path === 'deterministic_precheck' ? 'Deterministic pre-check — no model call' : r.model.path}{r.model.models.length ? ` · ${r.model.models.join(', ')}` : ''}</p>
        {r.model.calls.length ? <ul className="cix-calls">{r.model.calls.map((c, i) => <li key={i}><span>{c.model ?? 'refused'}{c.route ? ` · ${c.route}` : ''}</span><span>{c.input_tokens ?? '—'}/{c.output_tokens ?? '—'} tok</span><span>{fmtUsd(c.usd)}</span><span>{ms(c.latency_ms)}</span>{c.valid === false ? <span className="cix-muted">invalid</span> : null}</li>)}</ul> : null}
      </Step>
      <Step n={8} title="Proposed reply">
        {r.draft ? (
          <>
            <p className="cix-draftlabel" data-testid="cix-draft-label"><Icon name="shield" size={11} />{DRAFT_LABEL}</p>
            <blockquote className="cix-draft">{r.draft.text}</blockquote>
            {r.draft.needs_approval ? <p className="cix-muted">Contains an authoritative offer amount — approval required.</p> : null}
          </>
        ) : <p className="cix-muted">No draft.</p>}
      </Step>
      <Step n={9} title="Validation" tone={v.status === 'validated_draft' ? 'resolved' : v.status === 'rejected_with_reasons' ? 'blocked' : undefined}>
        <p><b>{humanize(v.status)}</b>{v.question_kind ? ` · question ${humanize(v.question_kind)}` : ''}</p>
        {v.reasons.length ? <ul className="cix-reasons">{v.reasons.map((x) => <li key={x}>{humanize(x)}</li>)}</ul> : null}
      </Step>
      <Step n={10} title="Worker job">
        {job ? (
          <dl className="cix-kv">
            <dt>Status</dt><dd><b>{JOB_STATE_LABEL[job.state] ?? job.state}</b> · attempt {job.attempt}/{job.max_attempts}</dd>
            <dt>Timing</dt><dd>{job.wall_ms != null ? `${ms(job.wall_ms)} queue→end` : job.next_attempt_at ? `next attempt ${new Date(job.next_attempt_at).toLocaleTimeString()}` : '—'}</dd>
            <dt>Budget</dt><dd>reserve cap {usd(job.budget_cap_usd)}{job.result?.cost_usd != null ? ` · spent ${usd(job.result.cost_usd)}` : ''}</dd>
            {job.error_code ? <><dt>Error</dt><dd>{job.error_code}</dd></> : null}
          </dl>
        ) : <p className="cix-muted">No runtime job matched (outside the last 50 jobs, or the runtime is not readable).</p>}
      </Step>
      <footer className="cix-cost">
        <span className="cix-notsent"><Icon name="shield" size={12} />Not sent — shadow{r.policy_code ? ` · ${humanize(r.policy_code)}` : ''}</span>
        <span>Cost <b>{fmtUsd(r.cost.total_usd)}</b> (Haiku {fmtUsd(r.cost.haiku_usd)} · Sonnet {fmtUsd(r.cost.sonnet_usd)})</span>
        <span>Latency <b>{ms(r.latency_ms)}</b></span>
        {r.before ? <span>Before: {humanize(r.before.recorded_intent ?? 'none')} · {r.before.queued_reply.length ? r.before.queued_reply.map((q) => `${q.use_case} (${q.status})`).join(', ') : 'no reply queued'}</span> : null}
      </footer>
    </article>
  )
}

const GATE_ORDER: GateKey[] = ['env_shadow', 'env_runtime', 'db_runtime', 'emergency_stop_clear', 'kind_enabled', 'spend_enabled']
const gateText = (v: boolean | null) => (v == null ? 'unknown' : v ? 'on' : 'off')

/**
 * OPERATOR CONTROLS — shadow on/off (every gate), budget, runtime health, and the two stop
 * controls. Writes go only through the server route that calls agent.runtime_emergency_stop /
 * agent.runtime_pause_kind; nothing here can turn the shadow on.
 */
export function ConversationIntelControls() {
  const s = useIntel()
  const [ask, setAsk] = useState<ControlAction | null>(null)
  const c = s.control
  return (
    <div className="agx-insp cix-ctl" aria-label="Conversation shadow controls">
      <div className="agx-insp__tabs"><b className="agx-insp__t">Shadow controls</b></div>
      <div className="agx-insp__body">
        {s.controlStatus === 'loading' && !c ? <p className="cix-muted">Reading runtime state…</p> : null}
        {s.controlNote ? <p className="cix-note is-inline" role="status">{s.controlNote}</p> : null}
        {c ? <ControlBody c={c} onAsk={setAsk} /> : s.controlStatus === 'error' ? <p className="cix-muted">Runtime state unavailable. Controls are disabled until it can be read.</p> : null}
        <section className="agx-panel"><h5>What it never does</h5><p>It never sends, queues or schedules a message and never changes a seller record. STOP, suppression, wrong number, windows and offers are decided by the deterministic rules before any model is called.</p></section>
      </div>
      <LCConfirm
        open={ask === 'emergency_stop'} onOpenChange={(o) => { if (!o) setAsk(null) }} tone="danger" title="Emergency stop the agent runtime?" confirmLabel="Emergency stop"
        effects={[{ text: 'Every runtime job stops at its next step; nothing new is claimed.', kind: 'stops' }, { text: 'Applies to all runtime kinds, not only conversation shadow.', kind: 'stops' }, { text: 'Shadow records already written are kept.', kind: 'keeps' }, { text: 'Clearing the stop is an owner SQL action, not available here.', kind: 'note' }]}
        onConfirm={() => runControl('emergency_stop', 'review_panel_emergency_stop')}
      />
      <LCConfirm
        open={ask === 'pause_kind'} onOpenChange={(o) => { if (!o) setAsk(null) }} title="Pause conversation shadow?" confirmLabel="Pause conversation shadow"
        effects={[{ text: 'conversation.decide jobs are no longer claimed; queued jobs wait.', kind: 'stops' }, { text: 'Other runtime kinds keep running.', kind: 'keeps' }, { text: 'Re-arming the kind is an owner SQL action.', kind: 'note' }]}
        onConfirm={() => runControl('pause_kind', 'review_panel_pause')}
      />
    </div>
  )
}

function ControlBody({ c, onAsk }: { c: ControlState; onAsk: (a: ControlAction) => void }) {
  const rt = c.runtime
  const b = c.budget
  const stopped = rt?.emergency_stop === true
  const counts = (m: Record<string, number> | undefined) => Object.entries(m || {}).map(([k, n]) => `${JOB_STATE_LABEL[k] ?? k} ${n}`).join(' · ') || 'none'
  return (
    <>
      <section className="agx-panel cix-ctl__state">
        <h5>Shadow <i className={cx('cix-state', `is-${c.shadow.state}`)} data-testid="cix-ctl-state">{c.shadow.state}</i></h5>
        <ul className="cix-gates">
          {GATE_ORDER.map((g) => <li key={g} className={cx(`is-${gateText(c.shadow.gates[g])}`)}><span>{GATE_LABEL[g]}</span><b>{gateText(c.shadow.gates[g])}</b></li>)}
        </ul>
        <p className="cix-muted">Mode: shadow. Send path: none. Worker cron flag: {c.flags.cron_agent_runtime_enabled == null ? 'set on the Worker (not visible to the API)' : gateText(c.flags.cron_agent_runtime_enabled)}.</p>
      </section>
      <section className="agx-panel">
        <h5>Budget</h5>
        {b ? (
          <dl className="cix-kv">
            <dt>Model spend</dt><dd>{b.spend_enabled ? 'enabled' : 'disabled'}</dd>
            <dt>Today</dt><dd>{usd(b.spent_day_usd)} / {usd(b.day_cap_usd)} <span className="cix-muted">(conversation {usd(b.spent_day_kind_usd)})</span></dd>
            <dt>Cycle</dt><dd>{usd(b.spent_cycle_usd)} / {usd(b.cycle_cap_usd)}</dd>
            <dt>Per run</dt><dd>{usd(b.run_cap_usd)}</dd>
            <dt>Per event</dt><dd>{b.per_event_reserve_usd == null ? 'not set (reservations refused)' : usd(b.per_event_reserve_usd)}</dd>
          </dl>
        ) : <p className="cix-muted">Budget unreadable.</p>}
      </section>
      <section className="agx-panel">
        <h5>Runtime</h5>
        {rt ? (
          <dl className="cix-kv">
            <dt>Kind</dt><dd>{c.kind.configured ? `${c.kind.armed ? 'armed' : 'not armed'} · ${c.kind.enabled ? 'enabled' : 'paused'} · concurrency ${c.kind.max_concurrency ?? '—'}` : 'not configured'}</dd>
            <dt>Heartbeat</dt><dd>{rt.heartbeat?.age_s != null ? `${rt.heartbeat.age_s}s ago · ${rt.heartbeat.ticks ?? 0} ticks` : 'no tick recorded'}</dd>
            <dt>Open</dt><dd>{counts(rt.open)}</dd>
            <dt>Ended 24h</dt><dd>{counts(rt.ended_24h)}</dd>
            <dt>Limits</dt><dd>global {rt.max_concurrency_global ?? '—'} · per tick {rt.tick_max_jobs ?? '—'} · lease {rt.lease_seconds ?? '—'}s</dd>
            {stopped ? <><dt>Stopped</dt><dd>{rt.emergency_stop_at ? new Date(rt.emergency_stop_at).toLocaleString() : 'yes'}</dd></> : null}
          </dl>
        ) : <p className="cix-muted">Runtime unreadable{c.errors.length ? ` (${c.errors.join(', ')})` : ''}.</p>}
      </section>
      <section className="agx-panel cix-ctl__actions">
        <h5>Controls</h5>
        <LCButton size="sm" variant="secondary" block icon="pause" disabled={!c.kind.enabled} onClick={() => onAsk('pause_kind')}>{CONTROL_LABEL.pause_kind}</LCButton>
        <LCButton size="sm" variant="danger" block icon="shield" disabled={!rt || stopped} onClick={() => onAsk('emergency_stop')}>{stopped ? 'Emergency stop engaged' : CONTROL_LABEL.emergency_stop}</LCButton>
        <p className="cix-muted">Stop-only. Turning the shadow on, re-arming or clearing a stop are owner actions.</p>
      </section>
    </>
  )
}
