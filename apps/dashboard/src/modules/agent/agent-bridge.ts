/**
 * AGENT BRIDGE — the only agent code the shell imports statically.
 *
 * It holds the feature flag and turns shell gestures (⌘K rows, the deck
 * indicator, ⌘J) into commands for the lazily loaded agent host. It imports
 * no fixture, store or UI code, so a production build — where the flag folds
 * to `false` — tree-shakes the whole agent module away.
 *
 * Flag: on in DEV; in a build only with VITE_LC_AGENT_PROTOTYPE=1 (never set
 * for production). The S2 prototype renders SIMULATED fixture data only.
 */
import type { CommandResult } from '../../domain/command-center/command.types'

export const AGENT_PROTOTYPE_ENABLED: boolean = import.meta.env.DEV || import.meta.env.VITE_LC_AGENT_PROTOTYPE === '1'

/**
 * SIMULATED design fixtures ship in DEV builds only — never in a production
 * build, even with VITE_LC_AGENT_PROTOTYPE=1 (a dedicated design-review build
 * may opt in with VITE_LC_AGENT_FIXTURES=1). Constant-folded at build time, so
 * every fixture scenario is tree-shaken out of production bundles.
 * scripts/proof/desktop/agent-fixture-bundle-check.mjs proves it on a build.
 */
export const AGENT_FIXTURES_ENABLED: boolean = import.meta.env.DEV || import.meta.env.VITE_LC_AGENT_FIXTURES === '1'

export type AgentCommand =
  | { kind: 'agent'; action: 'ask'; query: string }
  | { kind: 'agent'; action: 'research'; query: string }
  | { kind: 'agent'; action: 'workspace'; query: string }
  | { kind: 'agent'; action: 'toggle-dock'; query: string }

export const AGENT_COMMAND_EVENT = 'lc:agent-command'
let pending: AgentCommand | null = null

/** Deliver a command to the host (queued if the host chunk is still loading). */
export function sendAgentCommand(cmd: AgentCommand) {
  if (!AGENT_PROTOTYPE_ENABLED || typeof window === 'undefined') return
  pending = cmd
  window.dispatchEvent(new CustomEvent<AgentCommand>(AGENT_COMMAND_EVENT, { detail: cmd }))
}
/** The host takes a command that arrived before it mounted. */
export function takePendingAgentCommand(): AgentCommand | null { const c = pending; pending = null; return c }
export function clearPendingAgentCommand() { pending = null }

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const RESEARCH_WORDS = ['research', 'deep research', 'investigate', 'diligence']
const WORKSPACE_WORDS = ['agent', 'agent workspace', 'ai', 'assistant', 'research queue']

/**
 * ⌘K rows (arch §9.3): "Ask LeadCommand: <query>" plus deterministic agent
 * commands. Deterministic navigation stays deterministic — these rows only
 * open the agent surfaces; they never navigate or act on a record.
 */
export function agentDeckCommands(query: string, ctx: { subject: string | null }): CommandResult[] {
  if (!AGENT_PROTOTYPE_ENABLED) return []
  const q = norm(query)
  if (q.length < 2) return []
  const out: CommandResult[] = []
  const tag = 'Prototype · simulated'
  if (AGENT_FIXTURES_ENABLED && RESEARCH_WORDS.some((w) => w.startsWith(q) || q.startsWith(w))) {
    out.push({ id: 'agent:research', type: 'system_action', title: ctx.subject ? `Deep Research · ${ctx.subject}` : 'Deep Research', subtitle: 'Open the research workspace (fixture replay on a synthetic property)', icon: 'radar', score: 1070, payload: { __workspace: { kind: 'agent', action: 'research', query } }, meta: { provider: 'agent', groupLabel: 'Agent', hint: tag } })
  }
  if (WORKSPACE_WORDS.some((w) => w.startsWith(q))) {
    out.push({ id: 'agent:workspace', type: 'system_action', title: 'Open the agent workspace', subtitle: 'Runs · canvas · inspector', icon: 'layout-split', score: 1060, payload: { __workspace: { kind: 'agent', action: 'workspace', query } }, meta: { provider: 'agent', groupLabel: 'Agent', hint: '⌘⇧J' } })
  }
  // 8.5.10: the read-only research agent answers for real, so this row ships
  // (it only fills the composer — nothing is sent until the operator sends it)
  out.push({ id: 'agent:ask', type: 'system_action', title: `Ask LeadCommand: ${query.trim()}`, subtitle: ctx.subject ? `Opens the agent with your question and the current context (${ctx.subject})` : 'Opens the agent with your question and the current context', icon: 'spark', score: 1000, payload: { __workspace: { kind: 'agent', action: 'ask', query: query.trim() } }, meta: { provider: 'agent', groupLabel: 'Agent', hint: '⌘L · read-only' } })
  return out
}
