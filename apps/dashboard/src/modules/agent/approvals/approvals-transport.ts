/**
 * CAPABILITY APPROVALS — client half of apps/api/src/lib/agent/actions/routes.js:
 *
 *   GET  /api/cockpit/agent/actions/approvals?state=pending      pending approvals for the operator's org
 *   GET  /api/cockpit/agent/actions/approvals/:id                one approval + display-only preview
 *   POST /api/cockpit/agent/actions/approvals/:id/decide         { decision, payload_hash }
 *
 * The server verifies the operator's Supabase session, the agent allowlist and
 * org membership; approving re-reads the current state (drift refuses) and then
 * runs the existing service path (manual send-now, Composer launch, pipeline
 * transition). The client only shows what the server returns and echoes the
 * payload hash of exactly what was shown.
 */
import { callBackend } from '../../../lib/api/backendClient'

const BASE = '/api/cockpit/agent/actions/approvals'

export type ApprovalState = 'pending' | 'executing' | 'executed' | 'failed' | 'denied' | 'expired' | 'refused_drift' | 'cancelled'

export interface CapabilityApproval {
  approval_id: string
  capability_id: string
  capability_version: number
  tier: string
  state: ApprovalState
  provenance: 'operator' | 'model' | 'untrusted_content'
  target: Record<string, unknown>
  intended_change: Record<string, unknown>
  summary: string[]
  payload_hash: string
  snapshot_hash_prefix: string
  expires_at: string
  created_at: string
  decided_at: string | null
  execution_result: Record<string, unknown> | null
  preview?: { message_text?: string; recipient_mask?: string; sender_mask?: string; matches_approved?: boolean; unavailable?: string } | null
}

export type ApprovalsResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; message: string }

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

function failure(res: { status: number; error?: string; message?: string; upstream?: unknown }, fallback: string): ApprovalsResult<never> {
  const up = obj(res.upstream)
  const code = str(up.error) ?? str(up.code) ?? (res.status === 404 ? 'APPROVALS_NOT_MOUNTED' : res.error || fallback)
  return { ok: false, status: res.status, code, message: str(up.message) ?? res.message ?? code }
}

export async function listApprovals(state: 'pending' | 'all' = 'pending', signal?: AbortSignal): Promise<ApprovalsResult<CapabilityApproval[]>> {
  const res = await callBackend<unknown>(`${BASE}?state=${state}&limit=50`, { signal, timeoutMs: 10_000 })
  if (!res.ok) return failure(res, 'APPROVALS_LIST_FAILED')
  const b = obj(res.data)
  if (b.ok === false) return { ok: false, status: res.status, code: str(b.code) ?? 'APPROVALS_LIST_FAILED', message: str(b.code) ?? 'refused' }
  return { ok: true, data: (Array.isArray(b.approvals) ? b.approvals : []) as CapabilityApproval[] }
}

export async function getApproval(id: string, signal?: AbortSignal): Promise<ApprovalsResult<CapabilityApproval>> {
  const res = await callBackend<unknown>(`${BASE}/${encodeURIComponent(id)}`, { signal, timeoutMs: 15_000 })
  if (!res.ok) return failure(res, 'APPROVAL_READ_FAILED')
  const b = obj(res.data)
  return b.ok === false ? { ok: false, status: res.status, code: str(b.code) ?? 'APPROVAL_READ_FAILED', message: 'refused' } : { ok: true, data: b.approval as CapabilityApproval }
}

export interface DecideOutcome { ok: boolean; state: string | null; code: string | null; replayed: boolean; execution_result: Record<string, unknown> | null }

export async function decideApproval(a: Pick<CapabilityApproval, 'approval_id' | 'payload_hash'>, decision: 'approve' | 'deny'): Promise<ApprovalsResult<DecideOutcome>> {
  const res = await callBackend<unknown>(`${BASE}/${encodeURIComponent(a.approval_id)}/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision, payload_hash: a.payload_hash }),
    timeoutMs: 60_000,
  })
  const b = obj(res.ok ? res.data : res.upstream)
  if (!res.ok && !('state' in b) && !('code' in b)) return failure(res, 'APPROVAL_DECIDE_FAILED')
  return { ok: true, data: { ok: b.ok === true, state: str(b.state), code: str(b.code), replayed: b.replayed === true, execution_result: (b.execution_result as Record<string, unknown>) ?? null } }
}

/** Plain-language labels for refusal codes the decide endpoint returns. */
export const DECIDE_CODE_LABEL: Record<string, string> = {
  STATE_DRIFTED: 'The records changed since this was prepared. Ask the agent to prepare it again.',
  HASH_MISMATCH: 'This no longer matches what was shown. Reload and review again.',
  APPROVAL_EXPIRED: 'This approval expired. Ask the agent to prepare it again.',
  APPROVAL_EXECUTING: 'This approval is executing now.',
  NOT_A_MEMBER: 'Your account is not a member of this organization.',
  IDENTITY_REQUIRED: 'Sign in again: a verified operator session is required.',
  CAPABILITY_VERSION_CHANGED: 'The action changed since this was prepared. Ask the agent to prepare it again.',
}
