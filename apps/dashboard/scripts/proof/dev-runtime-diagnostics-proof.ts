/**
 * Dev runtime diagnostics proof — pure state logic, no React, no network.
 * Run: npx tsx scripts/proof/dev-runtime-diagnostics-proof.ts
 */

import {
  resolveRuntimeDiagnosticsState,
  shouldAutoCollapseHealthy,
  shouldShowDevRuntimeDiagnostics,
} from '../../src/components/dev/devRuntimeDiagnosticsState.ts'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ❌ ${name}`)
    console.error(`     ${(err as Error).message}`)
    failed++
  }
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

const healthyInput = {
  isDev: true,
  dashboardSha: 'abc123def456',
  dashboardBranch: 'release/test',
  dashboardWorktreeId: 'inbox-outbound-lock',
  apiBaseUrl: 'http://localhost:3001',
  apiIdentity: {
    commit_sha: 'abc123def456',
    branch: 'release/test',
    worktree_id: 'inbox-outbound-lock',
    environment: 'development',
    api_port: 3001,
  },
  fetchError: null,
}

console.log('\n── Dev runtime diagnostics proof ──')

test('production hidden state', () => {
  const state = resolveRuntimeDiagnosticsState({
    ...healthyInput,
    isDev: false,
  })
  assertEqual(state.mode, 'hidden', 'production mode')
  assertEqual(shouldShowDevRuntimeDiagnostics(false), false, 'should not show in production')
})

test('healthy collapse indicator', () => {
  const state = resolveRuntimeDiagnosticsState(healthyInput)
  assertEqual(state.mode, 'indicator', 'healthy mode')
  assertEqual(shouldAutoCollapseHealthy(state), true, 'auto collapse')
})

test('SHA mismatch banner', () => {
  const state = resolveRuntimeDiagnosticsState({
    ...healthyInput,
    apiIdentity: {
      ...healthyInput.apiIdentity,
      commit_sha: 'different-sha',
    },
  })
  assertEqual(state.mode, 'banner', 'banner mode')
  if (state.mode === 'banner') {
    assertEqual(state.reason, 'sha_mismatch', 'sha mismatch reason')
  }
})

test('API unavailable banner', () => {
  const state = resolveRuntimeDiagnosticsState({
    ...healthyInput,
    fetchError: 'Failed to fetch',
    apiIdentity: null,
  })
  assertEqual(state.mode, 'banner', 'banner mode')
  if (state.mode === 'banner') {
    assertEqual(state.reason, 'api_unavailable', 'api unavailable reason')
  }
})

test('missing identity banner when API has no commit_sha', () => {
  const state = resolveRuntimeDiagnosticsState({
    ...healthyInput,
    apiIdentity: { branch: 'main' },
  })
  assertEqual(state.mode, 'banner', 'banner mode')
  if (state.mode === 'banner') {
    assertEqual(state.reason, 'missing_identity', 'missing identity reason')
  }
})

test('wrong worktree banner', () => {
  const state = resolveRuntimeDiagnosticsState({
    ...healthyInput,
    apiIdentity: {
      ...healthyInput.apiIdentity,
      worktree_id: 'other-worktree',
    },
  })
  assertEqual(state.mode, 'banner', 'banner mode')
  if (state.mode === 'banner') {
    assertEqual(state.reason, 'wrong_worktree', 'wrong worktree reason')
  }
})

console.log(`\nResult: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)