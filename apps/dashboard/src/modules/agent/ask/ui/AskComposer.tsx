import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { cx } from '../../../../shared/lc'
import { setUi, useAgentUi } from '../../runtime/agent-store'
import { addChip, budgetMeter, composerKeyAction, isBlockingFailure, mentionAt, MENTION_KINDS, modelIndicator, parseSlash, removeMentionText, slashMatches, QUESTION_MAX, type MentionChip, type MentionKind, type MentionQuery, type SlashCommand } from '../ask-model'
import { ask, dismissAuto, getAsk, learnLabels, runningTurn, setChips, stopTurn, useAsk } from '../ask-store'
import { resolveHotLeadProperties, resolveOwnerProperties, searchMentions, type MentionHit } from '../ask-transport'
import { Glyph, KIND_GLYPH } from './glyphs'

export interface ComposerProps {
  surface: 'dock' | 'palette'
  /** the current selection, auto-attached (removable) */
  autoChips: MentionChip[]
  onClose: () => void
  quickScan: { available: boolean; reason: string | null; run: () => void }
}

type Option =
  | { type: 'kind'; kind: Exclude<MentionKind, 'selection'>; label: string; hint: string }
  | { type: 'hit'; hit: MentionHit }
  | { type: 'chip'; chip: MentionChip; hint: string }
  | { type: 'slash'; cmd: SlashCommand; disabled: string | null }

/**
 * THE COMPOSER — a multi-line field that grows with its text, context pills
 * above it (the current selection auto-attached; @-mentions added), a single
 * popover for @-typeahead and /commands, the resolved model and today's
 * budget below it. ⌘↩ / ↩ sends, ⇧↩ breaks a line, Esc closes, ⌘⌫ stops.
 */
export function AskComposer({ surface, autoChips, onClose, quickScan }: ComposerProps) {
  const ui = useAgentUi()
  const s = useAsk()
  const ta = useRef<HTMLTextAreaElement>(null)
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  const [closedFor, setClosedFor] = useState<string | null>(null)
  const text = ui.composer
  const running = runningTurn(s)
  const blocked = isBlockingFailure(s.status.failure)
  const chips = useMemo(() => [...autoChips.filter((c) => !s.dismissedAuto.includes(c.key) && !s.chips.some((x) => x.key === c.key)), ...s.chips], [autoChips, s.chips, s.dismissedAuto])

  // focus on mount and whenever a shortcut asks for this surface
  useEffect(() => { ta.current?.focus({ preventScroll: true }) }, [])
  useEffect(() => { if (s.focus.tick && s.focus.target === surface) { const el = ta.current; if (el) { el.focus({ preventScroll: true }); el.setSelectionRange(el.value.length, el.value.length); setCaret(el.value.length); setClosedFor(null) } } }, [s.focus.tick, s.focus.target, surface])
  // auto-grow
  useLayoutEffect(() => { const el = ta.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(surface === 'palette' ? 180 : 240, el.scrollHeight)}px` }, [text, surface])

  const slash = parseSlash(text)
  const mq: MentionQuery | null = mentionAt(text, caret)
  const popKey = mq ? `@${mq.start}:${mq.query}` : slash.partial !== null ? `/${slash.partial}` : null
  const options = useOptions(mq, slash.partial, chips, autoChips, quickScan)
  const popoverOpen = Boolean(popKey && popKey !== closedFor && options.items.length)
  useEffect(() => { setActive(0) }, [popKey])

  // a programmatic edit places the caret in the same commit (never a later frame: typing continues meanwhile)
  const pendingCaret = useRef<number | null>(null)
  useLayoutEffect(() => {
    const c = pendingCaret.current
    const el = ta.current
    if (c === null || !el) return
    pendingCaret.current = null
    const at = Math.min(c, el.value.length)
    el.setSelectionRange(at, at)
    setCaret(at)
  }, [text])
  const setText = (t: string, c?: number) => {
    if (c !== undefined) pendingCaret.current = c
    setUi({ composer: t })
  }

  const attach = (chip: MentionChip) => {
    setChips(addChip(getAsk().chips, chip))
    if (mq) { const r = removeMentionText(text, mq); setText(r.text, r.caret) }
  }

  const pick = (o: Option) => {
    if (o.type === 'slash') {
      if (o.disabled) return
      if (o.cmd.id === 'quick-scan') { setText(''); quickScan.run(); return }
      setText(`${o.cmd.label} `, o.cmd.label.length + 1)
      return
    }
    if (o.type === 'kind' && mq) {
      if (o.kind === 'hot_leads') { void attachHotLeads(attach); return }
      const before = text.slice(0, mq.start)
      const next = `${before}@${o.kind} ${text.slice(mq.end)}`
      setText(next, before.length + o.kind.length + 2)
      return
    }
    if (o.type === 'chip') { attach(o.chip); return }
    if (o.type === 'hit') {
      const h = o.hit
      if (h.kind === 'property') { learnLabels({ [h.id]: h.label }); attach({ key: `property:${h.id}`, kind: 'property', id: h.id, label: h.label, detail: h.detail, property_ids: [h.id] }); return }
      if (h.kind === 'campaign') { attach({ key: `campaign:${h.id}`, kind: 'campaign', id: h.id, label: h.label, detail: h.detail, property_ids: [] }); return }
      if (h.kind === 'market') { attach({ key: `market:${h.id}`, kind: 'market', id: h.id, label: h.label, detail: 'named in the question', property_ids: [] }); return }
      if (h.kind === 'owner') {
        const key = `owner:${h.id}`
        attach({ key, kind: 'owner', id: h.id, label: h.label, detail: 'resolving properties…', property_ids: [] })
        void resolveOwnerProperties(h.id).then((ids) => setChips(getAsk().chips.map((c) => (c.key === key ? { ...c, property_ids: ids, detail: ids.length ? `${ids.length} propert${ids.length === 1 ? 'y' : 'ies'}` : 'no properties resolved' } : c))))
      }
    }
  }

  const send = () => {
    if (blocked || running) return
    const parsed = parseSlash(text)
    if (parsed.command?.id === 'quick-scan') { if (quickScan.available) { setText(''); quickScan.run() } return }
    const body = parsed.command ? parsed.rest : text
    if (!body.trim() && !parsed.command) return
    setText('')
    void ask({ text: body, command: parsed.command, chips })
  }

  const removeChip = (c: MentionChip) => {
    if (c.auto) dismissAuto(c.key)
    else setChips(getAsk().chips.filter((x) => x.key !== c.key))
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // ⌘K inside the agent focuses here (the Command Deck keeps ⌘K everywhere else)
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); e.stopPropagation(); return }
    const action = composerKeyAction(e, { popoverOpen, empty: !text, running: Boolean(running), chips: chips.length })
    if (!action) return
    switch (action) {
      case 'popover-next': e.preventDefault(); setActive((a) => (a + 1) % options.items.length); break
      case 'popover-prev': e.preventDefault(); setActive((a) => (a - 1 + options.items.length) % options.items.length); break
      case 'popover-pick': e.preventDefault(); pick(options.items[Math.min(active, options.items.length - 1)]); break
      case 'popover-close': e.preventDefault(); e.stopPropagation(); setClosedFor(popKey); break
      case 'send': e.preventDefault(); send(); break
      case 'newline': break
      case 'close': e.preventDefault(); e.stopPropagation(); onClose(); break
      case 'stop': e.preventDefault(); if (running) stopTurn(running.thread.id, running.turn.id); break
      case 'remove-last-chip': e.preventDefault(); removeChip(chips[chips.length - 1]); break
    }
  }

  const model = modelIndicator(s.status.data)
  const budget = budgetMeter(s.status.data)
  const canSend = !blocked && !running && (text.trim().length > 0 || Boolean(slash.command))
  const over = text.length > QUESTION_MAX

  return (
    <div className={cx('ak-composer', `is-${surface}`, blocked && 'is-blocked')}>
      {popoverOpen ? <Popover options={options} active={active} onHover={setActive} onPick={pick} /> : null}
      <div className="ak-composer__chips" aria-label="Context">
        {chips.map((c) => (
          <span key={c.key} className={cx('ak-chip', `is-${c.kind}`, c.auto && 'is-auto')} title={c.detail ?? undefined}>
            <Glyph name={KIND_GLYPH[c.kind] ?? 'property'} size={11} />
            <b>{c.label}</b>
            {c.auto ? <small>current</small> : c.detail && (c.kind === 'owner' || c.kind === 'hot_leads' || c.kind === 'selection') ? <small>{c.detail}</small> : null}
            <button type="button" aria-label={`Remove ${c.label} from the context`} onClick={() => removeChip(c)}>×</button>
          </span>
        ))}
        <button type="button" className="ak-chip is-add" onClick={() => { const el = ta.current; const t = text && !/\s$/.test(text) ? `${text} @` : `${text}@`; setText(t, t.length); el?.focus() }} aria-label="Add context">
          <Glyph name="at" size={11} />{chips.length ? null : <span>Add context</span>}
        </button>
      </div>
      <textarea
        ref={ta}
        value={text}
        rows={1}
        disabled={blocked}
        spellCheck
        placeholder={blocked ? 'The research agent is not available for this session' : surface === 'palette' ? 'Ask about a property, owner, campaign or market…' : 'Ask anything · @ for context · / for commands'}
        aria-label="Ask the research agent"
        aria-autocomplete="list"
        aria-expanded={popoverOpen}
        onChange={(e) => { setUi({ composer: e.target.value }); setCaret(e.target.selectionStart ?? e.target.value.length); setClosedFor(null) }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={onKeyDown}
      />
      <div className="ak-composer__foot">
        <span className={cx('ak-model', !model.ok && 'is-warn')} title={model.note ?? undefined}>
          <Glyph name="model" size={11} />
          {model.primary ?? (s.status.phase === 'loading' || s.status.phase === 'idle' ? 'Resolving…' : 'Model —')}
          {model.escalation ? <small>→ {model.escalation}</small> : null}
        </span>
        {budget ? <BudgetMeterView meter={budget} /> : null}
        <span className="ak-composer__sp" />
        {over ? <span className="ak-over">{text.length}/{QUESTION_MAX}</span> : <span className="ak-hint" aria-hidden="true"><kbd>⌘</kbd><kbd>↩</kbd></span>}
        {running ? (
          <button type="button" className="ak-send is-stop" onClick={() => stopTurn(running.thread.id, running.turn.id)} aria-label="Stop watching this run"><Glyph name="stop" size={12} /></button>
        ) : (
          <button type="button" className="ak-send" disabled={!canSend} onClick={send} aria-label="Send"><Glyph name="up" size={14} /></button>
        )}
      </div>
    </div>
  )
}

export function BudgetMeterView({ meter }: { meter: NonNullable<ReturnType<typeof budgetMeter>> }) {
  return (
    <span className={cx('ak-budget', `is-${meter.tone}`)} title={meter.detail} role="meter" aria-label="Agent spend today" aria-valuemin={0} aria-valuemax={meter.cap} aria-valuenow={Number(meter.spent.toFixed(4))} aria-valuetext={meter.detail}>
      <span className="ak-budget__bar"><i style={{ width: `${Math.round(meter.fraction * 100)}%` }} /></span>
      <span className="ak-budget__t">{meter.label}</span>
    </span>
  )
}

/* ── the popover (one list for @ and /) ─────────────────────────────────── */

interface OptionSet { title: string; items: Option[]; loading: boolean }

function useOptions(mq: MentionQuery | null, slashPartial: string | null, chips: MentionChip[], autoChips: MentionChip[], quickScan: ComposerProps['quickScan']): OptionSet {
  const [hits, setHits] = useState<{ key: string; rows: MentionHit[]; loading: boolean }>({ key: '', rows: [], loading: false })
  const key = mq ? `${mq.kind ?? '*'}:${mq.term}` : ''
  useEffect(() => {
    if (!mq) return
    const needsServer = mq.kind === 'campaign' || mq.kind === 'market' || mq.term.length >= 2
    if (!needsServer || mq.kind === 'hot_leads') { setHits({ key, rows: [], loading: false }); return }
    const ctl = new AbortController()
    setHits((h) => ({ key, rows: h.key.split(':')[0] === key.split(':')[0] ? h.rows : [], loading: true }))
    const t = setTimeout(() => {
      void searchMentions(mq.kind as MentionHit['kind'] | null, mq.term, ctl.signal).then((rows) => { if (!ctl.signal.aborted) setHits({ key, rows, loading: false }) }, () => { if (!ctl.signal.aborted) setHits({ key, rows: [], loading: false }) })
    }, 160)
    return () => { clearTimeout(t); ctl.abort() }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  if (slashPartial !== null) {
    const items: Option[] = slashMatches(slashPartial, { quickScan: true }).map((cmd) => ({ type: 'slash', cmd, disabled: cmd.id === 'quick-scan' && !quickScan.available ? quickScan.reason ?? 'Link a property first' : null }))
    return { title: 'Commands', items, loading: false }
  }
  if (!mq) return { title: '', items: [], loading: false }
  const have = new Set(chips.map((c) => c.key))
  const items: Option[] = []
  const t = mq.term.toLowerCase()
  // the current selection first (re-attach after removing it)
  for (const c of autoChips) if (!have.has(c.key) && (!t || c.label.toLowerCase().includes(t))) items.push({ type: 'chip', chip: { ...c, auto: false }, hint: 'Current selection' })
  if (!mq.kind) for (const k of MENTION_KINDS) if (!t || k.token.startsWith(t) || k.label.toLowerCase().startsWith(t)) items.push({ type: 'kind', kind: k.kind, label: k.label, hint: k.hint })
  if (mq.kind === 'hot_leads') items.push({ type: 'kind', kind: 'hot_leads', label: 'HOT LEADS', hint: 'Attach the Priority inbox properties (up to 10)' })
  for (const h of hits.key === key ? hits.rows : hits.rows) if (!have.has(`${h.kind}:${h.id}`)) items.push({ type: 'hit', hit: h })
  return { title: mq.kind ? MENTION_KINDS.find((k) => k.kind === mq.kind)?.label ?? 'Context' : 'Add context', items: items.slice(0, 12), loading: hits.loading }
}

function Popover({ options, active, onHover, onPick }: { options: OptionSet; active: number; onHover: (i: number) => void; onPick: (o: Option) => void }) {
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-ix="${active}"]`)?.scrollIntoView({ block: 'nearest' }) }, [active])
  return (
    <div className="ak-pop" role="presentation">
      <div className="ak-pop__h"><span>{options.title}</span>{options.loading ? <span className="ak-pop__ld">Searching…</span> : null}</div>
      <ul ref={list} role="listbox" aria-label={options.title}>
        {options.items.map((o, i) => {
          const { glyph, title, sub, tag, disabled } = describe(o)
          return (
            <li key={`${o.type}:${title}:${i}`} role="option" aria-selected={i === active} aria-disabled={disabled || undefined} data-ix={i}>
              <button type="button" className={cx('ak-opt', i === active && 'is-active', disabled && 'is-off')} onMouseEnter={() => onHover(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(o)}>
                <span className="ak-opt__ic"><Glyph name={glyph} size={12} /></span>
                <span className="ak-opt__t"><b>{title}</b>{sub ? <small>{sub}</small> : null}</span>
                {tag ? <span className="ak-opt__tag">{tag}</span> : null}
              </button>
            </li>
          )
        })}
      </ul>
      <div className="ak-pop__f"><kbd>↑</kbd><kbd>↓</kbd> navigate <kbd>↩</kbd> select <kbd>esc</kbd> dismiss</div>
    </div>
  )
}

function describe(o: Option): { glyph: Parameters<typeof Glyph>[0]['name']; title: string; sub: string | null; tag: string | null; disabled: boolean } {
  switch (o.type) {
    case 'slash': return { glyph: 'slash', title: o.cmd.label, sub: o.disabled ?? o.cmd.hint, tag: o.cmd.id === 'quick-scan' ? '$0' : o.cmd.mode === 'research' ? null : o.cmd.mode.replace(/_/g, ' '), disabled: Boolean(o.disabled) }
    case 'kind': return { glyph: KIND_GLYPH[o.kind], title: o.label, sub: o.hint, tag: null, disabled: false }
    case 'chip': return { glyph: KIND_GLYPH[o.chip.kind] ?? 'property', title: o.chip.label, sub: o.hint, tag: 'current', disabled: false }
    case 'hit': return { glyph: KIND_GLYPH[o.hit.kind], title: o.hit.label, sub: o.hit.detail, tag: o.hit.kind === 'owner' ? 'owner' : o.hit.kind, disabled: false }
  }
}

async function attachHotLeads(attach: (c: MentionChip) => void) {
  const key = 'hot_leads:priority'
  attach({ key, kind: 'hot_leads', id: 'priority', label: 'HOT LEADS', detail: 'resolving…', property_ids: [] })
  const ids = await resolveHotLeadProperties()
  setChips(getAsk().chips.map((c) => (c.key === key ? { ...c, property_ids: ids, detail: ids.length ? `${ids.length} propert${ids.length === 1 ? 'y' : 'ies'}` : 'none in Priority' } : c)))
}
