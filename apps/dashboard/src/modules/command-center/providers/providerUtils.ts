import { getSupabaseClient, hasSupabaseEnv } from '../../../lib/supabaseClient'
import type { CommandResult, GlobalCommandSearchContext } from '../command.types'

export const normalizeCommandQuery = (query: string): string =>
  query.trim().toLowerCase().replace(/\s+/g, ' ')

export const tokenizeCommandQuery = (query: string): string[] =>
  normalizeCommandQuery(query).split(' ').filter(Boolean)

export const sanitizeIlike = (query: string): string =>
  query.replace(/[%_]/g, '').trim()

const isSubsequence = (needle: string, haystack: string): boolean => {
  let needleIndex = 0
  for (let index = 0; index < haystack.length; index += 1) {
    if (haystack[index] === needle[needleIndex]) needleIndex += 1
    if (needleIndex >= needle.length) return true
  }
  return needleIndex >= needle.length
}

export const fuzzyCommandScore = (query: string, ...values: Array<string | null | undefined>): number => {
  const normalizedQuery = normalizeCommandQuery(query)
  if (!normalizedQuery) return 0
  const tokens = tokenizeCommandQuery(normalizedQuery)
  const haystacks = values
    .map((value) => normalizeCommandQuery(String(value ?? '')))
    .filter(Boolean)

  if (haystacks.length === 0) return 0

  let best = 0
  haystacks.forEach((haystack) => {
    let score = 0
    if (haystack === normalizedQuery) score += 140
    if (haystack.startsWith(normalizedQuery)) score += 90
    if (haystack.includes(normalizedQuery)) score += 70
    if (isSubsequence(normalizedQuery, haystack)) score += 26
    tokens.forEach((token) => {
      if (haystack.startsWith(token)) score += 18
      else if (haystack.includes(token)) score += 12
    })
    best = Math.max(best, score)
  })

  return best
}

export const contextBoost = (result: CommandResult, context: GlobalCommandSearchContext): number => {
  let boost = 0
  if (context.routePath === '/inbox' && (result.type === 'seller' || result.type === 'conversation' || result.type === 'filter')) boost += 14
  if ((context.routePath === '/queue' || context.currentView === 'queue') && (result.type === 'queue' || result.meta?.provider === 'queue')) boost += 16
  if ((context.routePath === '/buyer' || context.currentView === 'buyer_match') && result.type === 'buyer') boost += 16
  if (context.currentView === 'command_map' && (result.type === 'property' || result.type === 'market' || result.type === 'map_action')) boost += 18
  if (context.selectedMarket && normalizeCommandQuery(result.subtitle).includes(normalizeCommandQuery(context.selectedMarket))) boost += 8
  return boost
}

export const withScoredResult = (
  result: CommandResult,
  query: string,
  context: GlobalCommandSearchContext,
  ...searchValues: Array<string | null | undefined>
): CommandResult => ({
  ...result,
  score: result.score + fuzzyCommandScore(query, result.title, result.subtitle, result.description, ...(result.meta?.keywords ?? []), ...searchValues) + contextBoost(result, context),
})

export const limitResults = (results: CommandResult[], limit = 12): CommandResult[] =>
  results
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, limit)

export const canUseSupabaseSearch = (query: string): boolean =>
  hasSupabaseEnv && sanitizeIlike(query).length >= 2

export const getSupabaseSearchClient = () => getSupabaseClient()
