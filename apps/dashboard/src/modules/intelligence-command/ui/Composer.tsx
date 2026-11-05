import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { cx } from '../../../shared/lc'
import { budgetMeter, mentionAt, MENTION_KINDS, modelIndicator, removeMentionText, type MentionChip, type MentionQuery } from '../../agent/ask/ask-model'
import { refreshStatus, runningTurn, useAsk } from '../../agent/ask/ask-store'
import { resolveHotLeadProperties, resolveOwnerProperties, searchMentions, type MentionHit } from '../../agent/ask/ask-transport'
import { proposalsFor, type ActProposal } from '../model/act-model'
import { composerKey, MODES, nextMode } from '../model/composer-model'
import { fromMention, visibleChips, type IcChip, type PageContext } from '../model/context-model'
import { cancelTurn, createMission, dropChip, historyDown, historyUp, mentionChip, proposeAct, refreshCapabilities, sendQuestion, setDraft, setMode, setOverlay, setSection, syncContext, useIc } from '../store/ic-store'
import { IcGlyph, Kbd, PlaneNotice } from './primitives'

const CHIP_GLYPH: Record<IcChip['kind'], 'db' | 'research' | 'chat' | 'mission' | 'workforce' | 'web' | 'finding'> = { property: 'db', campaign: 'mission', thread: 'chat', deal: 'finding', eg_filter: 'workforce', owner: 'research', market: 'web', hot_leads: 'finding' }

/** The mission context: exactly what the ask body accepts (≤ 10 property ids, one campaign). */
function toContext(chips: IcChip[]): { campaign_id?: string; property_ids?: string[] } | null {
  const ids = [...new Set(chips.flatMap((c) => c.property_ids))].slice(0, 10)
  const campaign = chips.find((c) => c.kind === 'campaign' && /^[0-9a-f-]{36}$/i.test(c.id))?.id
  if (!ids.length && !campaign) return null
  return { ...(campaign ? { campaign_id: campaign } : {}), ...(ids.length ? { property_ids: ids } : {}) }
}

type Pop = { q: MentionQuery; hits: MentionHit[]; index: number; loading: boolean } | null

/**
 * THE COMPOSER — docked in Intelligence Command and in the overlay. Context
 * chips come from the current page (removable, never carried across pages),
 * @ adds explicit mentions, the inline selector picks Ask / Plan / Act.
 */
export function Composer({ page, surface }: { page: PageContext; surface: 'dock' | 'overlay' }) {
  const ic = useIc()
  const askState = useAsk()
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const [pop, setPop] = useState<Pop>(null)
  const [actPick, setActPick] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const running = runningTurn(askState)
  const status = askState.status

  useEffect(() => { syncContext(page) }, [page])
  useEffect(() => { if (status.phase === 'idle') void refreshStatus() }, [status.phase])
  useEffect(() => { if (ic.mode === 'act' && ic.capabilities.phase === 'idle') void refreshCapabilities() }, [ic.mode, ic.capabilities.phase])
  useEffect(() => { ref.current?.focus() }, [ic.focusTick])

  const chips = useMemo(() => visibleChips(ic.chips, page), [ic.chips, page])
  const proposals = useMemo<ActProposal[]>(() => proposalsFor(chips, ic.capabilities.data), [chips, ic.capabilities.data])
  const proposal = proposals.find((p) => p.capability_id + p.chipKey === actPick) ?? proposals.find((p) => p.available) ?? null
  const model = modelIndicator(status.data)
  const budget = budgetMeter(status.data)

  // @-mention typeahead over the existing read endpoints (debounced)
  useEffect(() => {
    if (!pop?.q || pop.q.kind === null && !pop.q.term) return
    const ac = new AbortController()
    const t = window.setTimeout(async () => {
      const hits = await searchMentions(pop.q.kind, pop.q.term, ac.signal)
      if (!ac.signal.aborted) setPop((p) => (p ? { ...p, hits, loading: false } : p))
    }, 180)
    return () => { ac.abort(); window.clearTimeout(t) }
  }, [pop?.q?.kind, pop?.q?.term]) // eslint-disable-line react-hooks/exhaustive-deps

  const onText = (text: string, caret: number) => {
    setDraft(text)
    const q = mentionAt(text, caret)
    setPop(q ? { q, hits: [], index: 0, loading: Boolean(q.kind || q.term) } : null)
  }

  const pickKind = (token: string) => {
    if (!pop) return
    const text = ic.draft.slice(0, pop.q.start) + `@${token} ` + ic.draft.slice(pop.q.end)
    setDraft(text)
    const caret = pop.q.start + token.length + 2
    requestAnimationFrame(() => { ref.current?.setSelectionRange(caret, caret) })
    setPop({ q: { start: pop.q.start, end: caret, query: `${token} `, kind: MENTION_KINDS.find((k) => k.token === token)?.kind ?? null, term: '' }, hits: [], index: 0, loading: true })
  }

  const pickHit = async (h: MentionHit) => {
    if (!pop) return
    const { text } = removeMentionText(ic.draft, pop.q)
    setDraft(text)
    setPop(null)
    const ids = h.kind === 'property' ? [h.id] : h.kind === 'owner' ? await resolveOwnerProperties(h.id) : h.kind === 'hot_leads' ? await resolveHotLeadProperties() : []
    const m: MentionChip = { key: `${h.kind}:${h.id}`, kind: h.kind, id: h.id, label: h.label, detail: h.detail, property_ids: ids }
    mentionChip(fromMention(m))
  }

  const send = () => {
    if (ic.mode === 'act') {
      if (!proposal || !proposal.available) return
      const input = proposal.build(values, ic.draft)
      if (!input) return
      void proposeAct({ capability_id: proposal.capability_id, title: proposal.title, input, reason: ic.draft.trim() })
      return
    }
    sendQuestion(chips)
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget
    const before = el.value.slice(0, el.selectionStart)
    const after = el.value.slice(el.selectionEnd)
    const kinds = pop && pop.q.kind === null && !pop.q.term ? MENTION_KINDS.length : 0
    const total = (pop?.hits.length ?? 0) + kinds
    const a = composerKey(e, { mentionOpen: Boolean(pop) && total > 0, running: Boolean(running), empty: !el.value, chips: chips.length, caretAtStart: !before.includes('\n'), caretAtEnd: !after.includes('\n'), overlay: surface === 'overlay' })
    if (!a) return
    e.preventDefault()
    e.stopPropagation()
    switch (a) {
      case 'send': send(); break
      case 'newline': { const v = `${before}\n${after}`; setDraft(v); requestAnimationFrame(() => el.setSelectionRange(before.length + 1, before.length + 1)); break }
      case 'history-prev': historyUp(); break
      case 'history-next': historyDown(); break
      case 'cycle-mode': setMode(nextMode(ic.mode)); break
      case 'stop': if (running) void cancelTurn(running.thread.id, running.turn.id); break
      case 'close': setOverlay(false); break
      case 'remove-chip': { const last = chips[chips.length - 1]; if (last) dropChip(page, last); break }
      case 'mention-next': setPop((p) => (p ? { ...p, index: (p.index + 1) % total } : p)); break
      case 'mention-prev': setPop((p) => (p ? { ...p, index: (p.index - 1 + total) % total } : p)); break
      case 'mention-pick': if (pop) { if (pop.index < kinds) pickKind(MENTION_KINDS[pop.index].token); else void pickHit(pop.hits[pop.index - kinds]) } break
      case 'mention-close': setPop(null); break
    }
  }

  const canSend = ic.mode === 'act' ? Boolean(proposal?.available && proposal.build(values, ic.draft)) : Boolean(ic.draft.trim())
  const placeholder = ic.mode === 'act' ? (proposal ? 'Why this change? (the reason is recorded on the approval)' : 'Act needs a deal or campaign in context') : ic.mode === 'plan' ? 'Describe the mission to plan — @ to add context' : 'Ask LeadCommand — @ for a property, campaign, owner or market'
  const kindsShown = pop && pop.q.kind === null && !pop.q.term

  return (
    <div className={cx('ic-composer', `is-${surface}`, running && 'is-busy')} data-mode={ic.mode}>
      <div className="ic-composer__top">
        <div className="ic-modes" role="radiogroup" aria-label="Mode">
          {MODES.map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={ic.mode === m.id} className={cx('ic-modes__b', ic.mode === m.id && 'is-on')} onClick={() => setMode(m.id)} title={m.hint}>{m.label}</button>
          ))}
        </div>
        <div className="ic-chips" aria-label="Context">
          {chips.map((c) => (
            <span key={c.key} className={cx('ic-chip', `is-${c.kind}`, !c.sends && 'is-local')} title={`${c.detail ?? ''}${c.sends ? ` · sends ${c.sends}` : ' · nothing sent'}`}>
              <IcGlyph name={CHIP_GLYPH[c.kind]} size={11} />
              <span className="ic-chip__l">{c.label}</span>
              <button type="button" aria-label={`Remove ${c.label}`} onClick={() => dropChip(page, c)}><IcGlyph name="close" size={9} /></button>
            </span>
          ))}
          {!chips.length ? <span className="ic-chips__none">No page context · @ to add</span> : null}
        </div>
      </div>

      {ic.mode === 'act' ? (
        <div className="ic-act-form">
          {ic.capabilities.phase === 'failed' && ic.capabilities.failure ? <PlaneNotice failure={ic.capabilities.failure} title={ic.capabilities.failure.state === 'not_enabled' ? 'Actions plane not enabled' : undefined} onRetry={() => void refreshCapabilities()} compact />
            : ic.capabilities.phase !== 'ready' ? <p className="ic-empty">Reading the capability matrix…</p>
            : !proposals.length ? <p className="ic-empty">Act prepares a change for approval on a <b>deal</b> (stage change) or a <b>campaign</b> (launch). Open one, or select a property with a deal, and its chip appears here.</p>
            : (
              <div className="ic-act-form__grid">
                {proposals.map((p) => (
                  <label key={p.capability_id + p.chipKey} className={cx('ic-act-opt', proposal === p && 'is-on', !p.available && 'is-off')}>
                    <input type="radio" name={`act-${surface}`} checked={proposal === p} disabled={!p.available} onChange={() => setActPick(p.capability_id + p.chipKey)} />
                    <span><b>{p.title}</b><code>{p.capability_id}</code>{p.why ? <small>{p.why}</small> : null}</span>
                  </label>
                ))}
                {proposal?.fields.map((f) => (
                  <label key={f.name} className="ic-field">
                    <span>{f.label}</span>
                    {f.kind === 'select' ? (
                      <select value={values[f.name] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}>
                        <option value="">Choose…</option>
                        {f.options?.map((o) => <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>)}
                      </select>
                    ) : <input value={values[f.name] ?? ''} placeholder={f.kind === 'datetime' ? '2026-10-15T14:00:00Z' : ''} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))} />}
                  </label>
                ))}
              </div>
            )}
        </div>
      ) : null}

      <div className="ic-composer__field">
        <textarea
          ref={ref}
          value={ic.draft}
          rows={surface === 'overlay' ? 2 : 1}
          placeholder={placeholder}
          aria-label="Composer"
          onChange={(e) => onText(e.target.value, e.target.selectionStart)}
          onKeyDown={onKey}
          onBlur={() => window.setTimeout(() => setPop(null), 160)}
          spellCheck
        />
        {pop && (kindsShown || pop.hits.length || pop.loading) ? (
          <div className="ic-pop" role="listbox" aria-label="Mentions">
            {kindsShown ? MENTION_KINDS.map((k, i) => (
              <button key={k.token} type="button" role="option" aria-selected={pop.index === i} className={cx('ic-pop__o', pop.index === i && 'is-on')} onMouseDown={(e) => { e.preventDefault(); pickKind(k.token) }}>
                <b>@{k.token}</b><small>{k.hint}</small>
              </button>
            )) : null}
            {pop.hits.map((h, i) => {
              const idx = i + (kindsShown ? MENTION_KINDS.length : 0)
              return (
                <button key={`${h.kind}:${h.id}`} type="button" role="option" aria-selected={pop.index === idx} className={cx('ic-pop__o', pop.index === idx && 'is-on')} onMouseDown={(e) => { e.preventDefault(); void pickHit(h) }}>
                  <b>{h.label}</b><small>{h.kind.replace('_', ' ')}{h.detail ? ` · ${h.detail}` : ''}</small>
                </button>
              )
            })}
            {pop.loading && !pop.hits.length && !kindsShown ? <span className="ic-pop__none">Searching…</span> : null}
            {!pop.loading && !pop.hits.length && !kindsShown ? <span className="ic-pop__none">No match in the existing reads.</span> : null}
          </div>
        ) : null}
        {running && ic.mode !== 'act' ? (
          <button type="button" className="ic-send is-stop" onClick={() => void cancelTurn(running.thread.id, running.turn.id)} aria-label="Cancel the running run" title="Cancel on the server (Esc)"><IcGlyph name="stop" size={12} /></button>
        ) : (
          <button type="button" className="ic-send" onClick={send} disabled={!canSend} aria-label={ic.mode === 'act' ? 'Prepare for approval' : 'Send'} title={ic.mode === 'act' ? 'Prepare for approval (⌘↵)' : 'Send (⌘↵)'}><IcGlyph name="send" size={13} /></button>
        )}
      </div>

      <div className="ic-composer__foot">
        <span className={cx('ic-model', !model.ok && 'is-bad')} title={model.note ?? ''}><IcGlyph name="model" size={11} />{status.phase === 'failed' && !status.data ? 'Research agent off' : model.primary ?? 'Resolving model'}{model.escalation ? <small> → {model.escalation}</small> : null}</span>
        {budget ? <span className={cx('ic-budget', `is-${budget.tone}`)} title={budget.detail}><i style={{ width: Math.round(budget.fraction * 28) }} />{budget.label} today</span> : null}
        {ic.mode === 'plan' ? (
          <button type="button" className="ic-btn is-quiet ic-asmission" disabled={!ic.draft.trim()} title="Run on the server as a persistent mission (POST /api/cockpit/agent/missions) — keeps running with the browser closed"
            onClick={() => { const ctx = toContext(chips); void createMission({ kind: 'mission.research', question: ic.draft.trim(), ...(ctx ? { context: ctx } : {}) }).then((id) => { if (id) { setDraft(''); if (surface === 'dock') setSection('missions') } }) }}>
            <IcGlyph name="mission" size={11} />Run as background mission
          </button>
        ) : null}
        <span className="ic-keys"><Kbd>↵</Kbd> send <Kbd>⇧↵</Kbd> line <Kbd>↑</Kbd> history <Kbd>⇧⇥</Kbd> mode <Kbd>esc</Kbd> {running ? 'cancel' : surface === 'overlay' ? 'close' : ''}</span>
      </div>
    </div>
  )
}
