/**
 * INTELLIGENCE COMMAND — build flags.
 *
 * Dev fixtures (a fetch double that answers the agent routes with SYNTHETIC
 * data for visual QA) exist ONLY in a dev server started with
 * VITE_LC_IC_FIXTURES=1. A production build replaces import.meta.env.DEV with
 * `false`, so every guarded import folds away and the fixture module never
 * reaches a bundle (ic-flags.test.ts + scripts/proof/desktop/ic-fixture-bundle-check.mjs).
 *
 * Use sites INLINE the expression (the bundler folds an inline literal; a
 * re-exported constant is not always propagated across chunks).
 */
export const IC_FIXTURES_ENABLED: boolean = import.meta.env.DEV && import.meta.env.VITE_LC_IC_FIXTURES === '1'

/** Pure form of the gate (tested against both build modes). */
export function fixturesGate(env: { DEV?: boolean; VITE_LC_IC_FIXTURES?: string | undefined }): boolean {
  return env.DEV === true && env.VITE_LC_IC_FIXTURES === '1'
}

/** The shell-level agent surfaces (overlay, presence) ship with the agent flag, like AgentHost. */
export const IC_SHELL_ENABLED: boolean = import.meta.env.DEV || import.meta.env.VITE_LC_AGENT_PROTOTYPE === '1'
