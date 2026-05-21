/**
 * Runtime guard for architecture boundary enforcement.
 *
 * nexus-dashboard is a read-only cockpit. Direct Supabase mutations for queue,
 * message_events, and inbox_thread_state must live in real-estate-automation.
 *
 * Use assertDashboardMutationBlocked() anywhere a legacy code path would
 * otherwise mutate Supabase directly from the dashboard.
 */

export class DashboardMutationBoundaryError extends Error {
  readonly operationName: string
  readonly boundaryViolation = true

  constructor(operationName: string) {
    super(
      `[BOUNDARY VIOLATION] Direct Supabase mutation "${operationName}" is not allowed from nexus-dashboard. ` +
      `This mutation must live in real-estate-automation. Dashboard is cockpit-only. ` +
      `Route this operation through src/lib/api/backendClient.ts.`
    )
    this.name = 'DashboardMutationBoundaryError'
    this.operationName = operationName
  }
}

/**
 * Call this instead of executing a legacy Supabase mutation in the dashboard.
 * Always throws — used to mark code paths that must never reach production execution.
 */
export function assertDashboardMutationBlocked(operationName: string): never {
  throw new DashboardMutationBoundaryError(operationName)
}

/**
 * Returns a mutation-blocked result object suitable for functions that return
 * { ok: false, errorMessage: string } rather than throwing.
 */
export function dashboardMutationBlockedResult(operationName: string): {
  ok: false
  errorMessage: string
  boundaryViolation: true
} {
  return {
    ok: false,
    errorMessage:
      `Backend endpoint required: "${operationName}" must run from real-estate-automation. ` +
      `Set VITE_BACKEND_API_URL to route this action through the backend.`,
    boundaryViolation: true,
  }
}
