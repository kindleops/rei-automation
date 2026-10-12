import { useEffect, useRef, useState } from 'react'
import { cx } from '../../../../shared/lc'
import { buildTimeline, citationsOf, dur, escalationOf, FAILURE_TITLE, followUpsOf, outcomeCopy, shortModelName, sourcesOf, SLASH_COMMANDS, summarizeTimeline, usd, type AskTool, type Citation, type FollowUp, type MentionChip, type TimelineStep } from '../ask-model'
import type { AskTurn } from '../ask-store'
import { AskMarkdown } from '../AskMarkdown'
import { Glyph, KIND_GLYPH } from './glyphs'

export interface TurnHandlers {
  onOpen: (href: string) => void
  onFollowUp: (f: FollowUp, chips: MentionChip[]) => void
  onStop: () => void
  onResume: () => void
  onRevealed: () => void
}

/**
 * ONE TURN — the question as asked (its context pills), then the run: a
 * Cursor-style step timeline of the server's tool and model calls (each row
 * expands), the escalation badge, the answer (revealed as it lands), evidence
 * cards that deep-link, sources, cost · latency, copy, follow-ups.
 */
export function AskTurnView({ turn, tools, labels, reduced, now, handlers }: { turn: AskTurn; tools: AskTool[]; labels: Record<string, string>; reduced: boolean; now: number; handlers: TurnHandlers }) {
  const run = turn.run
  const steps = buildTimeline(run, tools)
  const running = turn.phase === 'running' || turn.phase === 'sending'
  const esc = escalationOf(run)
  const answer = run?.answer?.answer_md ?? ''
  const shown = useReveal(answer, Boolean(turn.fresh) && !reduced, handlers.onRevealed)
  const cites = citationsOf(run, turn.chips, labels)
  const follow = followUpsOf(run, turn.chips, turn.command)
  const note = run ? outcomeCopy(run) : null
  const cmd = turn.command ? SLASH_COMMANDS.find((c) => c.id === turn.command) : null
  const elapsed = run?.latency_ms ?? (running ? now - turn.sentAt : null)
  return (
    <article className={cx('ak-turn', running && 'is-running')} aria-busy={running}>
      <header className="ak-q">
        {turn.chips.length || cmd ? (
          <div className="ak-q__ctx">
            {cmd ? <span className="ak-pill is-cmd"><Glyph name="slash" size={11} />{cmd.label.slice(1)}</span> : null}
            {turn.chips.map((c) => <span key={c.key} className={cx('ak-pill', `is-${c.kind}`)}><Glyph name={KIND_GLYPH[c.kind] ?? 'property'} size={11} />{c.label}</span>)}
          </div>
        ) : null}
        {turn.text ? <p className="ak-q__t">{turn.text}</p> : <p className="ak-q__t is-implicit">{cmd?.hint ?? 'Question'}</p>}
      </header>

      {turn.phase === 'failed' && turn.failure ? (
        <div className="ak-fail" role="alert"><b>{FAILURE_TITLE[turn.failure.kind]}</b><span>{turn.failure.message}</span></div>
      ) : (
        <Timeline steps={steps} running={running} sending={turn.phase === 'sending'} elapsed={elapsed} reduced={reduced} />
      )}

      {esc ? (
        <div className="ak-esc" title={`${esc.calls} escalated call${esc.calls === 1 ? '' : 's'} · ${usd(esc.usd)}`}>
          <Glyph name="lift" size={12} /><b>Escalated to {esc.model ?? 'the deeper model'}</b>{esc.reason ? <span>· {esc.reason}</span> : null}
        </div>
      ) : null}

      {answer ? (
        <div className="ak-answer">
          <AskMarkdown md={shown} citeIds={run?.answer?.property_ids ?? []} onCite={(id) => handlers.onOpen(`/entity-graph/property/${encodeURIComponent(id)}`)} labelOf={(id) => labels[id] ?? null} />
          {shown.length < answer.length ? <span className="ak-caret" aria-hidden="true" /> : null}
          {run?.answer?.persisted === false ? <p className="ak-note">This answer could not be stored on the server; it is shown once.</p> : null}
        </div>
      ) : null}

      {note ? <p className={cx('ak-note', run?.state !== 'completed' && 'is-warn')}>{note}</p> : null}

      {turn.phase === 'stopped' ? (
        <div className="ak-stopped">
          <span>Stopped watching. The server run still ends inside its own caps (≤ 4 min, ≤ {usd(2.5)}).</span>
          <button type="button" className="ak-link" onClick={handlers.onResume}>Resume</button>
        </div>
      ) : null}

      {cites.length && turn.phase === 'done' && shown.length >= answer.length ? <Evidence cites={cites} onOpen={handlers.onOpen} /> : null}

      {run && turn.phase === 'done' ? (
        <footer className="ak-foot">
          <span className="ak-foot__m" title="Cost settled from the provider's usage × the price table">{usd(run.cost_usd)}</span>
          <span className="ak-foot__m">{dur(run.latency_ms)}</span>
          <span className="ak-foot__m">{[shortModelName(run.models.default), run.counters.escalated_calls ? shortModelName(run.models.escalation) : null].filter(Boolean).join(' + ')}</span>
          {sourcesOf(run).length ? <span className="ak-foot__src" title={sourcesOf(run).join(', ')}>{sourcesOf(run).length} source{sourcesOf(run).length === 1 ? '' : 's'}</span> : null}
          <span className="ak-foot__sp" />
          {answer ? <CopyButton text={answer} /> : null}
        </footer>
      ) : null}

      {running && turn.phase === 'running' ? (
        <div className="ak-live"><button type="button" className="ak-ghost" onClick={handlers.onStop}><Glyph name="stop" size={11} />Stop<kbd>⌘⌫</kbd></button></div>
      ) : null}

      {follow.length && turn.phase === 'done' ? (
        <div className="ak-follow" aria-label="Follow-up suggestions">
          {follow.map((f) => <button key={f.id} type="button" className="ak-follow__b" onClick={() => handlers.onFollowUp(f, turn.chips)}><Glyph name="arrow" size={11} />{f.label}</button>)}
        </div>
      ) : null}
    </article>
  )
}

/* ── the step timeline ──────────────────────────────────────────────────── */

const STEP_GLYPH: Record<TimelineStep['kind'], 'tool' | 'model' | 'lift' | 'refused'> = { tool: 'tool', model: 'model', escalation: 'lift', declined: 'refused', refused: 'refused', budget: 'refused', error: 'refused' }

export function Timeline({ steps, running, sending = false, elapsed, reduced }: { steps: TimelineStep[]; running: boolean; sending?: boolean; elapsed: number | null; reduced: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null)
  const expanded = open ?? running
  const sum = summarizeTimeline(steps)
  const head = sending ? 'Sending to the research agent…' : running ? (steps.length ? `Working · ${sum.tools} read${sum.tools === 1 ? '' : 's'}` : 'Planning…') : `Worked for ${dur(elapsed)} · ${sum.tools} read${sum.tools === 1 ? '' : 's'} · ${sum.rows.toLocaleString('en-US')} row${sum.rows === 1 ? '' : 's'}`
  if (!running && !steps.length) return null
  return (
    <section className={cx('ak-tl', expanded && 'is-open', running && 'is-running')} aria-label="Agent steps">
      <button type="button" className="ak-tl__head" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
        <span className={cx('ak-spin', running && !reduced && 'is-on')} aria-hidden="true" />
        <span className={cx('ak-tl__t', running && !reduced && 'ak-shimmer')}>{head}</span>
        {running && elapsed !== null ? <span className="ak-tl__m">{dur(elapsed)}</span> : sum.failed ? <span className="ak-tl__m is-warn">{sum.failed} issue{sum.failed === 1 ? '' : 's'}</span> : null}
        <span className="ak-tl__chev"><Glyph name="chev" size={11} /></span>
      </button>
      {expanded && steps.length ? (
        <ol className="ak-steps">
          {steps.map((s) => <StepRow key={s.key} s={s} />)}
        </ol>
      ) : null}
    </section>
  )
}

function StepRow({ s }: { s: TimelineStep }) {
  const [open, setOpen] = useState(false)
  const meta = [s.rows !== null && s.kind === 'tool' ? `${s.rows.toLocaleString('en-US')} row${s.rows === 1 ? '' : 's'}` : null, s.latency_ms !== null ? dur(s.latency_ms) : null, s.cost_usd ? usd(s.cost_usd) : null].filter(Boolean).join(' · ')
  return (
    <li className={cx('ak-step', `is-${s.kind}`, !s.ok && 'is-bad', open && 'is-open')}>
      <button type="button" className="ak-step__row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="ak-step__ic"><Glyph name={STEP_GLYPH[s.kind]} size={12} /></span>
        <span className="ak-step__t">{s.title}</span>
        {s.name && s.kind === 'tool' ? <code className="ak-step__n">{s.name}</code> : s.name ? <span className="ak-step__n is-model">{s.name}</span> : null}
        <span className="ak-step__m">{meta}</span>
      </button>
      {open ? (
        <dl className="ak-step__d">
          <div><dt>Outcome</dt><dd>{s.outcome ?? '—'}</dd></div>
          {s.detail ? <div><dt>{s.kind === 'model' ? 'Tokens' : 'Detail'}</dt><dd>{s.detail}</dd></div> : null}
          {s.at ? <div><dt>At</dt><dd>{new Date(s.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</dd></div> : null}
          {s.kind === 'tool' ? <div><dt>Access</dt><dd>Read-only · masked before the model</dd></div> : null}
        </dl>
      ) : null}
    </li>
  )
}

/* ── evidence cards ─────────────────────────────────────────────────────── */

const CITE_GLYPH: Record<Citation['kind'], 'property' | 'campaign' | 'selection' | 'market'> = { property: 'property', campaign: 'campaign', eg_filter: 'selection', market: 'market' }

function Evidence({ cites, onOpen }: { cites: Citation[]; onOpen: (href: string) => void }) {
  return (
    <section className="ak-ev" aria-label="Evidence">
      <span className="ak-eyebrow">Evidence</span>
      <div className="ak-ev__grid">
        {cites.map((c) => (
          <button key={c.key} type="button" className={cx('ak-card', `is-${c.kind}`, c.cited && 'is-cited')} onClick={() => onOpen(c.href)}>
            <span className="ak-card__ic"><Glyph name={CITE_GLYPH[c.kind]} size={13} /></span>
            <span className="ak-card__t"><b>{c.title}</b><small>{c.detail}</small></span>
            <span className="ak-card__go"><Glyph name="arrow" size={11} /></span>
          </button>
        ))}
      </div>
    </section>
  )
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  useEffect(() => { if (!done) return; const t = setTimeout(() => setDone(false), 1600); return () => clearTimeout(t) }, [done])
  return (
    <button type="button" className="ak-ghost" aria-label="Copy answer" onClick={() => { void navigator.clipboard?.writeText(text).then(() => setDone(true), () => setDone(false)) }}>
      <Glyph name={done ? 'check' : 'copy'} size={12} />{done ? 'Copied' : 'Copy'}
    </button>
  )
}

/** Reveal a freshly arrived answer progressively (the server returns it whole). */
function useReveal(text: string, animate: boolean, onDone: () => void): string {
  const [n, setN] = useState(animate ? 0 : text.length)
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    if (!animate || !text) { setN(text.length); return }
    let raf = 0
    const t0 = performance.now()
    const total = Math.min(1100, 260 + text.length * 1.4)
    const step = (t: number) => {
      const f = Math.min(1, (t - t0) / total)
      const eased = 1 - Math.pow(1 - f, 2)
      setN(Math.round(text.length * eased))
      if (f < 1) raf = requestAnimationFrame(step)
      else done.current()
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [text, animate])
  if (!animate) return text
  // cut at a word boundary so the markdown never shows half a token
  const cut = text.slice(0, n)
  const sp = cut.lastIndexOf(' ')
  return n >= text.length ? text : sp > 0 ? cut.slice(0, sp) : cut
}
