import type { CommandResult } from '../../../domain/command-center/command.types'
import { FALLBACK_CATALOGUE, type CatalogueEntry, type PeriodKind } from './goals-model'

/**
 * GOALS COMMANDS for the Command Deck — pure: query + catalogue → results.
 *
 *   goals · show goals · my goals              → Analytics, Goals lens
 *   set goal · new goal                        → the goal composer
 *   set goal sellers reached [monthly|weekly|quarterly]
 *                                              → the composer on that metric / period
 * ("add goals widget" is answered by the Home grammar.)
 */

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const PERIOD_WORDS: Array<[RegExp, PeriodKind]> = [[/\b(?:week|weekly)\b/, 'week'], [/\b(?:month|monthly)\b/, 'month'], [/\b(?:quarter|quarterly)\b/, 'quarter']]
const result = (id: string, title: string, subtitle: string, route: string, score = 1040): CommandResult => ({
  id: `goals:${id}`, type: 'system_action', title, subtitle, icon: 'flag', score, route, meta: { provider: 'goals', groupLabel: 'Goals', hint: 'Open' },
})

export function goalsDeckCommands(query: string, catalogue: ReadonlyArray<CatalogueEntry> = FALLBACK_CATALOGUE): CommandResult[] {
  const q = norm(query)
  if (q.length < 3) return []
  const out: CommandResult[] = []
  if (/^(?:show |open |my )?goals?$/.test(q) || (q.length >= 4 && 'show goals'.startsWith(q))) out.push(result('lens', 'Show goals', 'Targets on Analytics metrics — progress, pace and run-rate', '/analytics?lens=goals'))
  const m = /^(?:set|new|add|create)(?: an?)? goal(?: (?:for|on))? ?(.*)$/.exec(q)
  if (m || (q.length >= 4 && 'set goal'.startsWith(q))) {
    let rest = (m?.[1] ?? '').trim()
    let period: PeriodKind | null = null
    for (const [re, p] of PERIOD_WORDS) if (re.test(rest)) { period = p; rest = rest.replace(re, '').replace(/\b(?:per|a|each|this)\b/g, '').trim() }
    const metrics = rest ? catalogue.filter((c) => norm(c.label).startsWith(rest) || norm(c.label).includes(rest) || c.id.startsWith(rest.replace(/ /g, '_'))) : []
    const p = period ? `&period=${period}` : ''
    if (metrics.length) for (const c of metrics.slice(0, 4)) out.push(result(`new-${c.id}`, `Set a goal: ${c.label}${period ? ` (${period})` : ''}`, 'Opens the goal composer in Analytics', `/analytics?lens=goals&goal=new&metric=${c.id}${p}`, 1045))
    else out.push(result('new', 'Set a goal…', 'A target on a metric Analytics measures', `/analytics?lens=goals&goal=new${p}`))
  }
  return out
}
