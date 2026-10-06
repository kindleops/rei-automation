/**
 * Settings → Displays client (operator session; cockpit routes only).
 * Every call changes DISPLAY configuration or view — never an operational write.
 */
import { callBackend } from '../../../lib/api/backendClient'
import type { WallDisplayConfig, WallViewCommand } from '../wall-types'

export interface ManagedDisplay {
  id: string
  name: string
  status: 'awaiting_handoff' | 'active' | 'pairing_required' | 'revoked'
  connection: 'online' | 'degraded' | 'offline' | 'revoked' | 'awaiting_handoff' | 'pairing_required' | 'unknown'
  paired_at: string | null
  paired_by: string | null
  last_seen_at: string | null
  revoked_at: string | null
  token_expires_at: string | null
  config: WallDisplayConfig
  config_version: number
  view_command: WallViewCommand | null
  client: { build: string | null; browser: string | null; width: number | null; height: number | null; dpr: number | null; render_mode: string | null; connection: string | null; uptime_s: number | null; errors: number | null; reconnects: number | null }
}

export interface DisplaysResult { ok: true; displays: ManagedDisplay[]; store: string }
export type ApiFail = { ok: false; code: string; message: string }

const BASE = '/api/cockpit/wall/displays'

function failOf(r: { status: number; error: string; message: string; upstream?: unknown }): ApiFail {
  const up = (r.upstream && typeof r.upstream === 'object' ? r.upstream : {}) as { error?: string; message?: string }
  const code = up.error || r.error || `http_${r.status}`
  const known: Record<string, string> = {
    display_registry_unprovisioned: 'The display registry is not provisioned yet (the proposed migration has not been applied).',
    code_not_found: 'No display is showing that code. Check the TV and try again.',
    code_expired: 'That code expired. The TV shows a fresh one — enter the new code.',
    code_already_used: 'That code was already used.',
    bad_code: 'Codes look like ABCD-2345.',
    rate_limited: 'Too many attempts. Wait a few minutes and try again.',
    display_not_found: 'That display no longer exists.',
  }
  return { ok: false, code, message: known[code] || up.message || r.message || 'Request failed.' }
}

async function send<T>(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<T | ApiFail> {
  const r = await callBackend<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body), signal })
  return r.ok ? r.data : failOf(r)
}

export const listDisplays = (signal?: AbortSignal) => send<DisplaysResult>(BASE, 'GET', undefined, signal ?? new AbortController().signal)
export const claimDisplay = (input: { code: string; name: string; preset: string; theme: string; privacy_mode: string; display_id?: string }) => send<{ ok: true; display: ManagedDisplay }>(BASE, 'POST', input)
export const updateDisplay = (id: string, patch: Partial<WallDisplayConfig> & { name?: string }) => send<{ ok: true; display: ManagedDisplay }>(`${BASE}/${encodeURIComponent(id)}`, 'PATCH', patch)
export const revokeDisplay = (id: string) => send<{ ok: true; display: ManagedDisplay }>(`${BASE}/${encodeURIComponent(id)}`, 'DELETE')
export const regeneratePairing = (id: string) => send<{ ok: true; display: ManagedDisplay }>(`${BASE}/${encodeURIComponent(id)}/repair`, 'POST', {})
export const sendView = (id: string, cmd: { preset?: string | null; market?: string | null; hold_minutes?: number }) => send<{ ok: true; display: ManagedDisplay }>(`${BASE}/${encodeURIComponent(id)}/view`, 'POST', cmd)
