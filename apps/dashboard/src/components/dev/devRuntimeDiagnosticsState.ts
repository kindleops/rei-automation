export type RuntimeIdentity = {
  app_name?: string
  branch?: string
  commit_sha?: string
  worktree_id?: string
  build_timestamp?: string
  environment?: string
  api_port?: number
}

export type RuntimeDiagnosticsInput = {
  isDev: boolean
  dashboardSha: string
  dashboardBranch: string
  dashboardWorktreeId: string
  apiBaseUrl: string | null
  apiIdentity: RuntimeIdentity | null
  fetchError: string | null
}

export type RuntimeDiagnosticsState =
  | { mode: 'hidden' }
  | { mode: 'banner'; reason: 'sha_mismatch' | 'api_unavailable' | 'missing_identity' | 'stale_api' | 'wrong_worktree' | 'unexpected_environment' }
  | { mode: 'indicator'; healthy: true }
  | { mode: 'panel'; healthy: true }

export function shouldShowDevRuntimeDiagnostics(isDev: boolean): boolean {
  return isDev
}

function isProxyDevBaseUrl(baseUrl: string | null | undefined): boolean {
  return !String(baseUrl ?? '').trim()
}

export function resolveRuntimeDiagnosticsState(input: RuntimeDiagnosticsInput): RuntimeDiagnosticsState {
  if (!input.isDev) {
    return { mode: 'hidden' }
  }

  if (input.fetchError) {
    return { mode: 'banner', reason: 'api_unavailable' }
  }

  if (!input.apiIdentity?.commit_sha) {
    return { mode: 'banner', reason: 'missing_identity' }
  }

  if (input.dashboardSha === 'unknown') {
    return { mode: 'banner', reason: 'missing_identity' }
  }

  if (input.apiIdentity.commit_sha !== input.dashboardSha) {
    return { mode: 'banner', reason: 'sha_mismatch' }
  }

  const expectedWorktree = input.dashboardWorktreeId
  const apiWorktree = input.apiIdentity.worktree_id
  if (
    expectedWorktree !== 'unknown' &&
    apiWorktree &&
    apiWorktree !== 'unknown' &&
    apiWorktree !== expectedWorktree
  ) {
    return { mode: 'banner', reason: 'wrong_worktree' }
  }

  const apiEnv = String(input.apiIdentity.environment ?? '').trim().toLowerCase()
  if (apiEnv && !['development', 'dev', 'test', 'local'].includes(apiEnv)) {
    return { mode: 'banner', reason: 'unexpected_environment' }
  }

  if (!isProxyDevBaseUrl(input.apiBaseUrl) && !input.apiBaseUrl) {
    return { mode: 'banner', reason: 'unexpected_environment' }
  }

  return { mode: 'indicator', healthy: true }
}

export function shouldAutoCollapseHealthy(state: RuntimeDiagnosticsState): boolean {
  return state.mode === 'indicator' && state.healthy === true
}