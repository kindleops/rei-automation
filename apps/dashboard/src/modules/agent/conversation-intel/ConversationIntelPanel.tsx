import { useEffect } from 'react'
import { Icon } from '../../../shared/icons'
import { LCIconButton, cx } from '../../../shared/lc'
import { fmtUsd } from '../ui/format'
import { OUTCOME_LABEL, STAGE_LABEL, humanize, loadIntel, setIntel, summarize, useIntel, visibleRecords, type Outcome, type ShadowRecord } from './conversation-intel-model'
import './conversation-intel.css'

const FILTERS: Array<Outcome | 'ALL'> = ['ALL', 'REPLY_CANDIDATE', 'NEEDS_REVIEW', 'NO_RESPONSE', 'UPDATE_ONLY', 'SUPPRESS']
const ms = (n: number | null | undefined) => (n == null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`)

/**
 * CONVERSATION INTELLIGENCE — read-only shadow review (Conversation Engine 2.0 R1/R2).
 * seller message → understood → facts → stage evidence → decision → model → draft →
 * validation → send status (always "not sent — shadow"). No action here can send.
 */
export function ConversationIntelPanel() {
  const s = useIntel()
  useEffect(() => { if (s.status === 'idle') void loadIntel() }, [s.status])
  const rows = visibleRecords(s)
  const sel = rows.find((r) => r.idempotency_key === s.selectedKey) ?? rows[0] ?? null
  const sum = summarize(rows)
  return (
    <div className="agx-canvas cix" aria-label="Conversation intelligence (shadow)">
      <header className="cix-head">
        <div className="cix-head__t">
          <span className="cix-eyebrow">Conversation intelligence <i className="cix-shadow">Shadow · nothing sends</i>{s.source === 'fixture' ? <i className="cix-fixture">FIXTURE</i> : null}</span>
          <h2>Inbound decisions</h2>
          <p>{sum.count} records · {sum.validated} validated drafts · {fmtUsd(sum.total_usd)} model cost · p50 {ms(sum.p50_ms)} · p95 {ms(sum.p95_ms)}</p>
        </div>
        <div className="cix-head__tools">
          <div className="cix-filters" role="tablist" aria-label="Outcome filter">
            {FILTERS.map((f) => <button key={f} type="button" role="tab" aria-selected={s.filter === f} className={cx('cix-chip', s.filter === f && 'is-on')} onClick={() => setIntel({ filter: f })}>{f === 'ALL' ? 'All' : OUTCOME_LABEL[f]}</button>)}
          </div>
          <LCIconButton icon="refresh-cw" label="Reload shadow records" size="sm" onClick={() => void loadIntel()} />
          <LCIconButton icon="x" label="Close conversation intelligence" size="sm" onClick={() => setIntel({ open: false })} />
        </div>
      </header>
      {s.note ? <p className="cix-note">{s.note}</p> : null}
      {s.status === 'loading' ? <div className="cix-empty is-computing"><span className="cix-pulse" />Reading shadow records…</div>
        : !rows.length ? <div className="cix-empty">{s.status === 'ready' ? 'No records for this filter.' : 'No shadow records to show.'}</div>
        : (
          <div className="cix-body">
            <ol className="cix-list" aria-label="Shadow records">
              {rows.map((r) => (
                <li key={r.idempotency_key}>
                  <button type="button" className={cx('cix-row', sel?.idempotency_key === r.idempotency_key && 'is-active', `is-${r.validation.status}`)} onClick={() => setIntel({ selectedKey: r.idempotency_key })}>
                    <span className="cix-row__k"><b>{humanize(r.understood.intent)}</b><span className={cx('cix-out', `is-${r.decision.outcome.toLowerCase()}`)}>{OUTCOME_LABEL[r.decision.outcome]}</span></span>
                    <span className="cix-row__m">{r.seller_message_masked}</span>
                    <span className="cix-row__f">{STAGE_LABEL[r.stage_evidence?.stage] ?? r.stage_evidence?.stage} · {r.model.path} · {fmtUsd(r.cost.total_usd)}</span>
                  </button>
                </li>
              ))}
            </ol>
            {sel ? <RecordDetail r={sel} /> : null}
          </div>
        )}
    </div>
  )
}

function Step({ n, title, children, tone }: { n: number; title: string; children: React.ReactNode; tone?: 'resolved' | 'computing' | 'blocked' }) {
  return (
    <section className={cx('cix-step', tone && `is-${tone}`)}>
      <h5><span className="cix-step__n">{n}</span>{title}</h5>
      <div className="cix-step__b">{children}</div>
    </section>
  )
}

function RecordDetail({ r }: { r: ShadowRecord }) {
  const v = r.validation
  return (
    <article className="cix-detail" aria-label="Decision pipeline">
      {r.our_last_message_masked ? <p className="cix-ours"><Icon name="message" size={11} />Our last message: {r.our_last_message_masked}</p> : null}
      <Step n={1} title="Seller message"><blockquote className="cix-quote">{r.seller_message_masked}</blockquote></Step>
      <Step n={2} title="Understood"><p><b>{humanize(r.understood.intent)}</b> · interest {humanize(r.understood.seller_interest)} · confidence {Math.round((r.understood.confidence || 0) * 100)}%</p></Step>
      <Step n={3} title="Facts">
        {r.facts.extracted.length ? <ul className="cix-facts">{r.facts.extracted.map((f, i) => <li key={i}><b>{humanize(f.fact)}</b> {String(f.value)} <span className="cix-muted">seller-stated · {Math.round(f.confidence * 100)}%</span></li>)}</ul> : <p className="cix-muted">No new facts.</p>}
        {r.facts.already_known.length ? <p className="cix-muted">Already known: {r.facts.already_known.map(humanize).join(', ')}</p> : null}
      </Step>
      <Step n={4} title="Stage evidence"><p><b>{STAGE_LABEL[r.stage_evidence.stage] ?? r.stage_evidence.stage}</b> — {r.stage_evidence.rationale}</p></Step>
      <Step n={5} title="Decision" tone={r.decision.outcome === 'SUPPRESS' ? 'blocked' : undefined}>
        <p><b>{OUTCOME_LABEL[r.decision.outcome]}</b> · next {humanize(r.decision.next_objective)}{r.decision.escalation_required ? ` · escalated (${humanize(r.decision.escalation_reason)})` : ''}</p>
        {r.decision.fail_closed ? <p className="cix-muted">Fail-closed: {r.decision.fail_closed.errors.slice(0, 3).join(', ')}</p> : null}
      </Step>
      <Step n={6} title="Model">
        <p>{r.model.path === 'deterministic_precheck' ? 'Deterministic pre-check — no model call' : r.model.path}</p>
        {r.model.calls.length ? <ul className="cix-calls">{r.model.calls.map((c, i) => <li key={i}><span>{c.model ?? 'refused'}</span><span>{fmtUsd(c.usd)}</span><span>{ms(c.latency_ms)}</span>{c.valid === false ? <span className="cix-muted">invalid</span> : null}</li>)}</ul> : null}
      </Step>
      <Step n={7} title="Draft">{r.draft ? <blockquote className="cix-draft">{r.draft.text}</blockquote> : <p className="cix-muted">No draft.</p>}{r.draft?.needs_approval ? <p className="cix-muted">Contains an authoritative offer amount — approval required.</p> : null}</Step>
      <Step n={8} title="Validation" tone={v.status === 'validated_draft' ? 'resolved' : v.status === 'rejected_with_reasons' ? 'blocked' : undefined}>
        <p><b>{humanize(v.status)}</b></p>
        {v.reasons.length ? <ul className="cix-reasons">{v.reasons.map((x) => <li key={x}>{humanize(x)}</li>)}</ul> : null}
      </Step>
      <Step n={9} title="Send status"><p className="cix-notsent"><Icon name="shield" size={12} />Not sent — shadow{r.policy_code ? ` · ${humanize(r.policy_code)}` : ''}</p></Step>
      <footer className="cix-cost"><span>Cost <b>{fmtUsd(r.cost.total_usd)}</b> (Haiku {fmtUsd(r.cost.haiku_usd)} · Sonnet {fmtUsd(r.cost.sonnet_usd)})</span><span>Latency <b>{ms(r.latency_ms)}</b></span>{r.before ? <span>Before: {humanize(r.before.recorded_intent ?? 'none')} · {r.before.queued_reply.length ? r.before.queued_reply.map((q) => `${q.use_case} (${q.status})`).join(', ') : 'no reply queued'}</span> : null}</footer>
    </article>
  )
}
