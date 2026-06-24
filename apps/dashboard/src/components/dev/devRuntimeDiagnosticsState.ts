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
  | { mode: 'banner'; reason: 'api_unavailable' | 'missing_identity' | 'wrong_worktree' | 'branch_mismatch' | 'unexpected_environment' }

export function shouldShowDevRuntimeDiagnostics(isDev: boolean): boolean {
  return isDev
}

export function isProxyDevBaseUrl(baseUrl: string | null | undefined): boolean {
  return !String(baseUrl ?? '').trim()
}

function worktreesMatch(dashboardWorktreeId: string, apiWorktree?: string): boolean {
  if (dashboardWorktreeId === 'unknown') return true
  if (!apiWorktree || apiWorktree === 'unknown') return true
  return apiWorktree === dashboardWorktreeId
}

function branchesMatch(dashboardBranch: string, apiBranch?: string): boolean {
  if (dashboardBranch === 'unknown') return true
  if (!apiBranch || apiBranch === 'unknown') return true
  return apiBranch === dashboardBranch
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

  if (!worktreesMatch(input.dashboardWorktreeId, input.apiIdentity.worktree_id)) {
    return { mode: 'banner', reason: 'wrong_worktree' }
  }

  if (!branchesMatch(input.dashboardBranch, input.apiIdentity.branch)) {
    return { mode: 'banner', reason: 'branch_mismatch' }
  }

  // Same worktree + same branch with different SHAs means one process started before the latest commit.
  // That is ordinary stale-process state in local dev, not a blocking mismatch.
  if (input.apiIdentity.commit_sha !== input.dashboardSha) {
    return { mode: 'hidden' }
  }

  const apiEnv = String(input.apiIdentity.environment ?? '').trim().toLowerCase()
  if (apiEnv && !['development', 'dev', 'test', 'local'].includes(apiEnv)) {
    return { mode: 'banner', reason: 'unexpected_environment' }
  }

  // Empty API base on localhost is healthy same-origin proxy mode.
  return { mode: 'hidden' }
}

export function shouldAutoCollapseHealthy(state: RuntimeDiagnosticsState): boolean {
  return state.mode === 'hidden'
}

export function formatApiBaseLabel(baseUrl: string | null | undefined): string {
  if (isProxyDevBaseUrl(baseUrl)) {
    return 'same-origin proxy'
  }
  return String(baseUrl ?? '').trim()
}