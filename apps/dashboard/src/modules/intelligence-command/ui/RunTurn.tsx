import { useMemo } from 'react'
import { cx } from '../../../shared/lc'
import { buildTimeline, FAILURE_TITLE, outcomeCopy, runFailureOf, shortModelName, type AskTool } from '../../agent/ask/ask-model'
import type { AskThread, AskTurn } from '../../agent/ask/ask-store'
import { PlainAnswer, ResultBlocks } from '../../agent/ask/ui/ResultBlocks'
import { openApp } from '../../desktop/workspace/workspace-store'
import { isTerminalPhase, reduceRunEvents, statusLine, type RunState, type RunStep } from '../model/run-reducer'
import type { ComposerMode } from '../model/composer-model'
import { cancelTurn, inspect, retryTurn, toggleExpanded, useIc } from '../store/ic-store'
import { IcGlyph, Spec, ms, usd } from './primitives'

/** Steps for a turn: the live event fold while events exist; the durable audit timeline after a reload. */
export function runStateOf(turn: AskTurn, tools: AskTool[]): RunState {
  const st = reduceRunEvents(turn.events ?? [], tools)
  if ((turn.events?.length ?? 0) > 0 || !turn.run) return st
  const steps: RunStep[] = buildTimeline(turn.run, tools).map((t) => ({ key: t.key, kind: t.kind === 'model' || t.kind === 'escalation' ? 'model' : t.kind === 'refused' || t.kind === 'declined' ? 'refused' : t.name === 'web.search' || t.name === 'web_search' || t.name === 'web.fetch' ? 'web' : 'tool', state: t.ok ? 'ok' : t.kind === 'refused' ? 'refused' : 'failed', title: t.title, name: t.name, call: null, rows: t.rows, latency_ms: t.latency_ms, cost_usd: t.cost_usd, tokens: null, outcome: t.outcome, detail: t.detail, at: t.at, publicWeb: /web/.test(t.name ?? '') }))
  const r = turn.run
  return { ...st, steps, phase: r.state === 'completed' ? 'completed' : r.state === 'cancelled' ? 'cancelled' : r.state === 'running' ? 'thinking' : 'failed', answer: r.answer?.answer_md ?? null, costUsd: r.cost_usd, latencyMs: r.latency_ms, modelCalls: r.counters.model_calls, toolCalls: r.counters.tool_calls, webSearches: r.counters.web_searches ?? 0, outcome: r.outcome, models: [r.models.default, r.models.escalation].filter((x): x is string => Boolean(x)) }
}

const STEP_GLYPH = { model: 'model', tool: 'db', web: 'web', result: 'finding', refused: 'cross' } as const

export function StepList({ steps, limit }: { steps: RunStep[]; limit: number | null }) {
  const shown = limit && steps.length > limit ? steps.slice(-limit) : steps
  const hidden = steps.length - shown.length
  return (
    <ol className="ic-steps" aria-label="Tool steps">
      {hidden > 0 ? <li className="ic-steps__more">{hidden} earlier step{hidden === 1 ? '' : 's'}</li> : null}
      {shown.map((s) => (
        <li key={s.key} className={cx('ic-step', `is-${s.state}`, s.publicWeb && 'is-web')}>
          <span className="ic-step__ic"><IcGlyph name={STEP_GLYPH[s.kind]} size={12} /></span>
          <span className="ic-step__t">{s.title}</span>
          <span className="ic-step__m">
            <Spec items={[
              s.name && s.kind !== 'model' ? <code key="n">{s.name}</code> : s.kind === 'model' && s.name ? shortModelName(s.name) : null,
              s.rows != null ? `${s.rows} row${s.rows === 1 ? '' : 's'}` : null,
              s.tokens ? `${s.tokens.input.toLocaleString('en-US')} in · ${s.tokens.output.toLocaleString('en-US')} out` : null,
              s.latency_ms != null ? ms(s.latency_ms) : s.state === 'running' ? 'running' : null,
              s.cost_usd ? usd(s.cost_usd) : null,
            ]} />
          </span>
          {s.detail && s.state !== 'running' && s.kind !== 'model' ? <span className="ic-step__d">{s.detail}</span> : null}
        </li>
      ))}
    </ol>
  )
}

export function RunTurn({ thread, turn, tools, mode, labelOf, compact = false }: { thread: AskThread; turn: AskTurn; tools: AskTool[]; mode: ComposerMode; labelOf: (id: string) => string | null; compact?: boolean }) {
  const ic = useIc()
  const st = useMemo(() => runStateOf(turn, tools), [turn, tools])
  const expanded = Boolean(ic.expanded[turn.id])
  const running = turn.phase === 'running' || turn.phase === 'sending'
  const done = !running
  const fail = turn.run ? runFailureOf(turn.run) : null
  const note = turn.run ? outcomeCopy(turn.run) : null
  const selected = ic.inspector?.kind === 'turn' && ic.inspector.turnId === turn.id
  const answerMd = turn.run?.answer?.answer_md ?? st.answer ?? ''
  const open = (href: string) => { openApp(href, 'beside') }
  const status = turn.phase === 'sending' ? 'Sending to the research agent' : turn.cancelling && running ? 'Cancelling on the server' : turn.phase === 'failed' && turn.failure ? FAILURE_TITLE[turn.failure.kind] : turn.phase === 'stopped' ? 'Stopped following (the run may still finish)' : statusLine(st)
  return (
    <article className={cx('ic-turn', selected && 'is-selected', compact && 'is-compact')} aria-label="Agent run">
      <header className="ic-turn__q">
        <span className={cx('ic-mode-tag', `is-${mode}`)}>{mode === 'plan' ? 'Plan' : 'Ask'}</span>
        <p>{turn.text || (turn.command ? `/${turn.command}` : 'Question')}</p>
        {turn.chips.length ? <span className="ic-turn__chips">{turn.chips.map((c) => <span key={c.key} className="ic-chip is-static">{c.label}</span>)}</span> : null}
      </header>

      <div className={cx('ic-turn__status', running && 'is-running', st.phase === 'failed' || turn.phase === 'failed' ? 'is-bad' : null, st.phase === 'completed' && 'is-done')} role="status" aria-live="polite">
        <span className="ic-turn__pulse" aria-hidden="true" />
        <b>{status}</b>
        <Spec items={[
          st.modelCalls ? `${st.modelCalls} model call${st.modelCalls === 1 ? '' : 's'}` : null,
          st.toolCalls ? `${st.toolCalls} read${st.toolCalls === 1 ? '' : 's'}` : null,
          st.webSearches ? `${st.webSearches} web search${st.webSearches === 1 ? '' : 'es'}` : null,
          st.costUsd ? usd(st.costUsd) : null,
          st.latencyMs != null ? ms(st.latencyMs) : null,
        ]} />
        <span className="ic-turn__acts">
          {running && turn.runId ? <button type="button" className="ic-btn is-quiet" onClick={() => void cancelTurn(thread.id, turn.id)} disabled={turn.cancelling}><IcGlyph name="stop" size={11} />{turn.cancelling ? 'Cancelling' : 'Cancel'}</button> : null}
          {done ? <button type="button" className="ic-btn is-quiet" onClick={() => retryTurn(thread.id, turn.id)} title="Ask again as a new run"><IcGlyph name="retry" size={12} />Retry</button> : null}
          {st.steps.length ? <button type="button" className="ic-btn is-quiet" onClick={() => toggleExpanded(turn.id)} aria-expanded={expanded}><IcGlyph name={expanded ? 'collapse' : 'expand'} size={12} />{expanded ? 'Collapse' : `Steps · ${st.steps.length}`}</button> : null}
          {!compact ? <button type="button" className="ic-btn is-quiet" onClick={() => inspect({ kind: 'turn', threadId: thread.id, turnId: turn.id })}>Inspect</button> : null}
        </span>
      </div>

      {st.steps.length && (running || expanded) ? <StepList steps={st.steps} limit={expanded ? null : 5} /> : null}

      {turn.phase === 'failed' && turn.failure ? <p className="ic-turn__fail"><b>{FAILURE_TITLE[turn.failure.kind]}</b> {turn.failure.message} <code>{turn.failure.code}</code></p> : null}
      {fail ? <p className="ic-turn__fail"><b>{fail.title}</b> {fail.message}{fail.detail ? <small> {fail.detail}</small> : null} <code>{fail.code}</code></p> : null}

      {running && st.draft ? <div className="ic-turn__draft"><PlainAnswer md={st.draft} citeIds={[]} onCite={() => {}} labelOf={labelOf} /><span className="ic-caret" aria-hidden="true" /></div> : null}
      {done && (answerMd || turn.run?.result) ? (
        <div className="ic-turn__answer">
          <ResultBlocks result={turn.run?.result ?? null} answerMd={answerMd} citeIds={turn.run?.answer?.property_ids ?? []} onCite={(id) => open(`/entity-graph/property/${encodeURIComponent(id)}`)} labelOf={labelOf} onOpen={open} />
        </div>
      ) : null}
      {done && note && !fail ? <p className="ic-turn__note">{note}</p> : null}
      {done && st.phase === 'completed' && !answerMd && !turn.run ? <p className="ic-turn__note">Completed · reading the durable run…</p> : null}
      {isTerminalPhase(st.phase) && st.fromDurable ? <p className="ic-turn__note">This run finished outside the live stream; shown from its durable record.</p> : null}
    </article>
  )
}
