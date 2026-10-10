/**
 * FIXTURE SCENARIOS — dev-only, SIMULATED. Imported only through the lazily
 * loaded agent host, which is mounted only when AGENT_PROTOTYPE_ENABLED (DEV,
 * or an explicit VITE_LC_AGENT_PROTOTYPE=1 build). Production builds never
 * reach this module.
 */
import type { FixtureScenario, ScenarioId } from './fixture-kit'
import { singleDeepScenario } from './scenario-single'
import { blockedConflictScenario } from './scenario-blocked'
import { batchScenario, batchProperties } from './scenario-batch'
import { conversationScenario, DEFAULT_ASK as FIXTURE_ASK } from './scenario-conversation'

/**
 * false in every production build — the same expression as agent-bridge
 * AGENT_FIXTURES_ENABLED, written inline on purpose: Vite substitutes the env
 * text here, the minifier folds the ternaries below to null / '' / 0, and the
 * scenario modules become unused and are tree-shaken (an imported constant is
 * not folded across modules). Verified by agent-fixture-bundle-check.mjs.
 */
export const FIXTURES_AVAILABLE: boolean = import.meta.env.DEV || import.meta.env.VITE_LC_AGENT_FIXTURES === '1'

const cache = new Map<ScenarioId, FixtureScenario>()
const BUILD: Record<ScenarioId, () => FixtureScenario> | null = (import.meta.env.DEV || import.meta.env.VITE_LC_AGENT_FIXTURES === '1')
  ? { 'single-deep': singleDeepScenario, 'blocked-conflict': blockedConflictScenario, 'batch-25': batchScenario, conversation: conversationScenario }
  : null

/** Has a scenario (false for any id in a production build). */
export const hasScenario = (id: string | null | undefined): id is ScenarioId => Boolean(BUILD && id && id in BUILD)

export function getScenario(id: ScenarioId): FixtureScenario {
  if (!BUILD) throw new Error('FIXTURES_DISABLED')
  let s = cache.get(id)
  if (!s) { s = BUILD[id](); cache.set(id, s) }
  return s
}

export const SCENARIO_IDS = (BUILD ? Object.keys(BUILD) : []) as ScenarioId[]
export const DEFAULT_ASK: string = (import.meta.env.DEV || import.meta.env.VITE_LC_AGENT_FIXTURES === '1') ? FIXTURE_ASK : ''
export const fixtureBatchSize = (): number => ((import.meta.env.DEV || import.meta.env.VITE_LC_AGENT_FIXTURES === '1') ? batchProperties().length : 0)
export type { FixtureScenario, ScenarioId, FixtureControl, SyntheticProperty } from './fixture-kit'
