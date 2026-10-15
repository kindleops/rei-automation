/**
 * COMPOSER MODEL — the Cursor-style composer, pure.
 *
 * Modes (inline selector, ⇧Tab cycles):
 *   Ask   research question → POST /ask (read-only research agent)
 *   Plan  the same agent asked to PLAN a mission: numbered steps, the read
 *         tools per step, what it would need approved — nothing executes.
 *         A plan can be queued as a persistent runtime mission only for kinds
 *         the runtime has a handler for (ic-client KNOWN_MISSION_KINDS).
 *   Act   capability calls → approvals: an operator-initiated
 *         POST /actions/invoke whose approval-tier result is a PENDING
 *         approval rendered as a diff and decided through /decide.
 *
 * KEY MAP (final, audited against every shell binding — see the report):
 *   ⌘⇧E        open Intelligence Command (full screen)          [global]
 *   ⌘'         toggle the composer overlay on any page           [global]
 *   ⌘L / ⌘⇧L   unchanged: the agent dock / floating ask palette  [AgentHost]
 *   ⌘K         unchanged: the Command Deck                       [CommandCenterApp]
 *   in the composer:
 *   ↵ / ⌘↵     send            ⇧↵   newline
 *   ↑ / ↓      prompt history (caret on the first / last line)
 *   ⇧Tab       cycle Ask → Plan → Act
 *   Esc        stop the running run; else close the overlay
 *   ⌫ (empty)  remove the last chip
 */
import type { SlashCommand } from '../../agent/ask/ask-model'

export type ComposerMode = 'ask' | 'plan' | 'act'
export const MODES: ReadonlyArray<{ id: ComposerMode; label: string; hint: string }> = [
  { id: 'ask', label: 'Ask', hint: 'Research with the read-only agent' },
  { id: 'plan', label: 'Plan', hint: 'A mission plan — steps, tools, approvals needed; nothing runs' },
  { id: 'act', label: 'Act', hint: 'Prepare a platform change for approval' },
]
export const nextMode = (m: ComposerMode): ComposerMode => (m === 'ask' ? 'plan' : m === 'plan' ? 'act' : 'ask')

/** Plan framing: the research agent writes a plan; its registry is read-only, so nothing can execute. */
export const PLAN_COMMAND: SlashCommand = {
  id: 'research',
  label: 'Plan',
  hint: 'Mission plan',
  mode: 'research',
  minProperties: 0,
  framing: 'PLAN A MISSION — do not answer the question yet. Write a numbered plan: for each step the goal, the LeadCommand read tools (or public-web search) you would use and why, what evidence would change the plan, and which steps would need a human approval (any send, launch or stage change). Read only what is needed to make the plan concrete, cite the tools you read, and end with the open questions for the operator.',
}

/* ── keys ──────────────────────────────────────────────────────────────── */

export interface KeyLike { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; isComposing?: boolean }

export type ComposerKey = 'send' | 'newline' | 'history-prev' | 'history-next' | 'cycle-mode' | 'stop' | 'close' | 'remove-chip' | 'mention-next' | 'mention-prev' | 'mention-pick' | 'mention-close' | null

export function composerKey(e: KeyLike, s: { mentionOpen: boolean; running: boolean; empty: boolean; chips: number; caretAtStart: boolean; caretAtEnd: boolean; overlay: boolean }): ComposerKey {
  if (e.isComposing) return null
  const mod = Boolean(e.metaKey || e.ctrlKey)
  if (s.mentionOpen) {
    if (e.key === 'ArrowDown') return 'mention-next'
    if (e.key === 'ArrowUp') return 'mention-prev'
    if ((e.key === 'Enter' && !mod && !e.shiftKey) || e.key === 'Tab') return 'mention-pick'
    if (e.key === 'Escape') return 'mention-close'
  }
  if (e.key === 'Tab' && e.shiftKey && !mod && !e.altKey) return 'cycle-mode'
  if (e.key === 'Enter' && mod) return 'send'
  if (e.key === 'Enter' && e.shiftKey) return 'newline'
  if (e.key === 'Enter' && !e.altKey) return 'send'
  if (e.key === 'ArrowUp' && !mod && !e.shiftKey && !e.altKey && s.caretAtStart) return 'history-prev'
  if (e.key === 'ArrowDown' && !mod && !e.shiftKey && !e.altKey && s.caretAtEnd) return 'history-next'
  if (e.key === 'Escape') return s.running ? 'stop' : s.overlay ? 'close' : null
  if (e.key === 'Backspace' && !mod && s.empty && s.chips > 0) return 'remove-chip'
  return null
}

export type GlobalIcKey = 'open-ic' | 'toggle-composer' | null
/** ⌘⇧E opens Intelligence Command; ⌘' toggles the composer overlay. Nothing else is claimed. */
export function globalIcKey(e: KeyLike): GlobalIcKey {
  const mod = Boolean(e.metaKey || e.ctrlKey)
  if (!mod || e.altKey) return null
  if (e.shiftKey && (e.key === 'e' || e.key === 'E')) return 'open-ic'
  if (!e.shiftKey && (e.key === "'" || e.key === 'Quote')) return 'toggle-composer'
  return null
}

/* ── prompt history (↑ / ↓) ────────────────────────────────────────────── */

export interface History { items: string[]; cursor: number | null; stash: string }
export const EMPTY_HISTORY: History = { items: [], cursor: null, stash: '' }
export const HISTORY_MAX = 50

export function pushHistory(h: History, text: string): History {
  const t = text.trim()
  if (!t) return { ...h, cursor: null, stash: '' }
  const items = [t, ...h.items.filter((x) => x !== t)].slice(0, HISTORY_MAX)
  return { items, cursor: null, stash: '' }
}

/** Step back (older). Returns the new history and the text to show. */
export function historyPrev(h: History, current: string): { h: History; text: string } {
  if (!h.items.length) return { h, text: current }
  const cursor = h.cursor === null ? 0 : Math.min(h.cursor + 1, h.items.length - 1)
  return { h: { ...h, cursor, stash: h.cursor === null ? current : h.stash }, text: h.items[cursor] }
}

/** Step forward (newer); past the newest returns the stashed draft. */
export function historyNext(h: History, current: string): { h: History; text: string } {
  if (h.cursor === null) return { h, text: current }
  if (h.cursor === 0) return { h: { ...h, cursor: null }, text: h.stash }
  const cursor = h.cursor - 1
  return { h: { ...h, cursor }, text: h.items[cursor] }
}
