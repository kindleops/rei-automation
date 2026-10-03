import type { CommandResult } from '../../domain/command-center/command.types'

/**
 * BRIEF COMMANDS for the Command Deck — pure: query → results.
 *
 *   brief me · brief · intelligence brief · daily brief · what did I miss
 *     → opens the Brief plane over the workspace (a workspace command, so the
 *       deck runs it in place — nothing navigates)
 */

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const PHRASES = ['brief me', 'brief', 'intelligence brief', 'daily brief', 'operator brief', 'show brief', 'open brief', 'what did i miss', 'catch me up']

export function briefDeckCommands(query: string): CommandResult[] {
  const q = norm(query)
  if (q.length < 3) return []
  if (!PHRASES.some((p) => p.startsWith(q) || q === p)) return []
  return [{
    id: 'brief:open', type: 'system_action', title: 'Brief me', subtitle: 'The Intelligence Brief — what needs you, every line citing its source', icon: 'briefing', score: 1080,
    payload: { __workspace: { kind: 'brief' } },
    meta: { provider: 'brief', groupLabel: 'Brief', hint: 'Open' },
  }]
}
