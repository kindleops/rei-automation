/**
 * Dev runtime diagnostics proof — pure state logic, no React, no network.
 * Run: npx tsx scripts/proof/dev-runtime-diagnostics-proof.ts
 */

import {
  formatApiBaseLabel,
  isProxyDevBaseUrl,
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
  dashboardBranch: 'main',
  dashboardWorktreeId: 'inbox-outbound-lock',
  apiBaseUrl: 'http://localhost:3001',
  apiIdentity: {
    commit_sha: 'abc123def456',
    branch: 'main',
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

test('healthy development hidden by default', () => {
  const state = resolveRuntimeDiagnosticsState(healthyInput)
  assertEqual(state.mode, 'hidden', 'healthy mode')
  assertEqual(shouldAutoCollapseHealthy(state), true, 'auto collapse')
})

test('healthy proxy mode with empty base URL', () => {
  const state = resolveRuntimeDiagnosticsState({
    ...healthyInput,
    apiBaseUrl: '',
  })
  assertEqual(state.mode, 'hidden', 'proxy healthy mode')
  assertEqual(isProxyDevBaseUrl(''), true, 'empty base is proxy mode')
  assertEqual(formatApiBaseLabel(''), 'same-origin proxy', 'proxy label')
})

test('same worktree + different SHA does not block', () => {
  const state = resolveRuntimeDiagnosticsState({
    ...healthyInput,
    apiIdentity: {
      ...healthyInput.apiIdentity,
      commit_sha: 'different-sha',
    },
  })
  assertEqual(state.mode, 'hidden', 'stale process mode')
})

test('same worktree + different SHA + empty API base stays healthy', () => {
  const state = resolveRuntimeDiagnosticsState({
    ...healthyInput,
    apiBaseUrl: '',
    apiIdentity: {
      ...healthyInput.apiIdentity,
      commit_sha: 'older-sha-before-commit',
    },
  })
  assertEqual(state.mode, 'hidden', 'stale proxy mode')
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

test('different worktrees banner', () => {
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

test('different branches banner', () => {
  const state = resolveRuntimeDiagnosticsState({
    ...healthyInput,
    apiIdentity: {
      ...healthyInput.apiIdentity,
      branch: 'feature/other-branch',
    },
  })
  assertEqual(state.mode, 'banner', 'banner mode')
  if (state.mode === 'banner') {
    assertEqual(state.reason, 'branch_mismatch', 'branch mismatch reason')
  }
})

test('different worktree still blocks even when SHAs match', () => {
  const state = resolveRuntimeDiagnosticsState({
    ...healthyInput,
    apiIdentity: {
      ...healthyInput.apiIdentity,
      worktree_id: 'other-worktree',
      commit_sha: healthyInput.dashboardSha,
    },
  })
  assertEqual(state.mode, 'banner', 'banner mode')
  if (state.mode === 'banner') {
    assertEqual(state.reason, 'wrong_worktree', 'wrong worktree reason')
  }
})

console.log(`\nResult: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)