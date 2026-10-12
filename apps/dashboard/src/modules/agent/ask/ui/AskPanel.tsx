import { useEffect, useRef, useState } from 'react'
import { cx, useLcReducedMotion } from '../../../../shared/lc'
import { openApp } from '../../../desktop/workspace/workspace-store'
import { setUi } from '../../runtime/agent-store'
import { isBlockingFailure, usd, type MentionChip } from '../ask-model'
import { activeThread, deleteThread, markRevealed, newThread, openThread, refreshStatus, requestFocus, resumeTurn, setChips, showHistory, stopTurn, useAsk, type AskThread } from '../ask-store'
import { AskComposer, type ComposerProps } from './AskComposer'
import { AskTurnView } from './AskTurnView'
import { LockedState } from './AskStates'
import { Glyph } from './glyphs'

/** Deep links open in the workspace beside what the operator is doing. */
export function openHref(href: string) {
  try { openApp(href) } catch { window.location.assign(href) }
}

function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { if (!on) return; const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t) }, [on])
  return now
}

/**
 * THE ASK PANEL — the body both surfaces share (docked sidebar and floating
 * palette): the active thread (or history, or the empty state) and the
 * composer. A non-allowlisted / signed-out / switched-off session sees one
 * clean state instead — no composer, no fixtures, nothing to click that
 * would fail.
 */
export function AskPanel({ surface, autoChips, onClose, quickScan, suggestions }: ComposerProps & { suggestions: Array<{ id: string; label: string; text: string }> }) {
  const s = useAsk()
  const reduced = useLcReducedMotion()
  const thread = activeThread(s)
  const running = Boolean(thread?.turns.some((t) => t.phase === 'running' || t.phase === 'sending'))
  const now = useNow(running)
  const scroller = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const tools = s.status.data?.tools ?? []

  useEffect(() => { if (s.status.phase === 'idle') void refreshStatus() }, [s.status.phase])
  useEffect(() => { const el = scroller.current; if (el && follow.current) el.scrollTop = el.scrollHeight })

  if (isBlockingFailure(s.status.failure)) return <LockedState kind={s.status.failure!.kind} message={s.status.failure!.message} />

  const body = s.view === 'history' ? <History threads={s.threads} activeId={s.activeThreadId} /> : thread && thread.turns.length ? (
    <div className="ak-thread">
      {thread.turns.map((t) => (
        <AskTurnView key={t.id} turn={t} tools={tools} labels={s.labels} reduced={reduced} now={now}
          handlers={{
            onOpen: openHref,
            onStop: () => stopTurn(thread.id, t.id),
            onResume: () => resumeTurn(thread.id, t.id),
            onRevealed: () => markRevealed(thread.id, t.id),
            onFollowUp: (f, chips) => { setChips(mergeChips(s.chips, chips.filter((c) => !c.auto))); setUi({ composer: f.text }); requestFocus(surface) },
          }} />
      ))}
    </div>
  ) : <EmptyState suggestions={suggestions} surface={surface} />

  return (
    <div className={cx('ak-panel', `is-${surface}`)}>
      <div className="ak-scroll" ref={scroller} onScroll={(e) => { const el = e.currentTarget; follow.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 32 }}>
        {body}
      </div>
      <AskComposer surface={surface} autoChips={autoChips} onClose={onClose} quickScan={quickScan} />
    </div>
  )
}

const mergeChips = (a: MentionChip[], b: MentionChip[]) => [...a, ...b.filter((c) => !a.some((x) => x.key === c.key))]

function EmptyState({ suggestions, surface }: { suggestions: Array<{ id: string; label: string; text: string }>; surface: 'dock' | 'palette' }) {
  return (
    <div className={cx('ak-empty', `is-${surface}`)}>
      {surface === 'dock' ? (
        <div className="ak-empty__hero">
          <span className="ak-empty__mark" aria-hidden="true"><Glyph name="model" size={18} /></span>
          <b>Research anything in LeadCommand</b>
          <p>Ask about properties, owners, campaigns and markets. Every answer cites the records it read.</p>
        </div>
      ) : null}
      {suggestions.length ? (
        <div className="ak-sugg" aria-label="Suggestions">
          {suggestions.map((x) => (
            <button key={x.id} type="button" className="ak-sugg__b" onClick={() => { setUi({ composer: x.text }); requestFocus(surface) }}>
              <Glyph name="arrow" size={11} /><span>{x.label}</span>
            </button>
          ))}
        </div>
      ) : null}
      <dl className="ak-keys" aria-label="Shortcuts">
        <div><dt><kbd>@</kbd></dt><dd>property · campaign · owner · market · HOT LEADS</dd></div>
        <div><dt><kbd>/</kbd></dt><dd>research · compare · inconsistencies · explain</dd></div>
        <div><dt><kbd>⌘</kbd><kbd>L</kbd></dt><dd>focus · <kbd>⌘</kbd><kbd>⇧</kbd><kbd>L</kbd> palette</dd></div>
      </dl>
      <p className="ak-ro"><Glyph name="refused" size={11} />Read-only. It reads and cites records; it cannot send, make offers or change anything.</p>
    </div>
  )
}

function History({ threads, activeId }: { threads: AskThread[]; activeId: string | null }) {
  if (!threads.length) return <div className="ak-hist is-empty"><p>No questions in this session yet.</p><button type="button" className="ak-link" onClick={() => showHistory(false)}>Ask one</button></div>
  return (
    <div className="ak-hist">
      <div className="ak-hist__h"><span className="ak-eyebrow">This session</span><button type="button" className="ak-link" onClick={() => newThread()}><Glyph name="plus" size={11} /> New</button></div>
      <ul>
        {threads.map((t) => {
          const last = t.turns[t.turns.length - 1]
          const cost = t.turns.reduce((n, u) => n + (u.run?.cost_usd ?? 0), 0)
          const live = t.turns.some((u) => u.phase === 'running' || u.phase === 'sending')
          return (
            <li key={t.id}>
              <button type="button" className={cx('ak-hrow', t.id === activeId && 'is-active')} onClick={() => openThread(t.id)}>
                <span className={cx('ak-hrow__dot', live ? 'is-live' : last?.phase === 'failed' ? 'is-bad' : 'is-ok')} aria-hidden="true" />
                <span className="ak-hrow__t"><b>{t.title}</b><small>{t.turns.length} question{t.turns.length === 1 ? '' : 's'} · {usd(cost)} · {new Date(t.updatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</small></span>
              </button>
              <button type="button" className="ak-hrow__x" aria-label={`Remove “${t.title}” from this session`} onClick={() => deleteThread(t.id)}>×</button>
            </li>
          )
        })}
      </ul>
      <p className="ak-note">Answers are re-read from the agent's durable store when a thread opens.</p>
    </div>
  )
}
