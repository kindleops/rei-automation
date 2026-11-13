/**
 * WORKFORCE — build flags.
 *
 * Fixture data (a request double that answers the §7 Workforce routes with
 * SYNTHETIC records for visual QA) exists ONLY in a dev server started with
 * VITE_LC_WF_FIXTURES=1. A production build replaces import.meta.env.DEV with
 * `false`, so every guarded import folds away and the fixture module never
 * reaches a bundle.
 *
 * Use sites INLINE the expression (the bundler folds an inline literal; a
 * re-exported constant is not always propagated across chunks).
 */
export const WF_FIXTURES_ENABLED: boolean = import.meta.env.DEV && import.meta.env.VITE_LC_WF_FIXTURES === '1'

/** Pure form of the gate (tested against both build modes). */
export function wfFixturesGate(env: { DEV?: boolean; VITE_LC_WF_FIXTURES?: string | undefined }): boolean {
  return env.DEV === true && env.VITE_LC_WF_FIXTURES === '1'
}
