import { callBackend } from '../../../lib/api/backendClient'
import type { SignalCenterModel } from './signals-model'

const BASE = '/api/cockpit/signals'

type Fail = { ok: false; message: string; status: number }

const json = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

export async function fetchSignalCenter(): Promise<SignalCenterModel | Fail> {
  // generous: the read fans out to the watchlist, rules, ledger and checkpoints
  const res = await callBackend<SignalCenterModel>(BASE, { timeoutMs: 60_000 })
  if (!res.ok) return { ok: false, message: res.status === 401 || res.status === 403 ? 'Your sign-in does not allow reading signals.' : 'Signals could not be read right now.', status: res.status }
  return res.data?.ok ? res.data : { ok: false, message: 'Signals could not be read right now.', status: 500 }
}

async function write(path: string, body: unknown): Promise<void> {
  const res = await callBackend<{ ok?: boolean; message?: string }>(path, json(body))
  if (!res.ok || !res.data?.ok) throw new Error(res.ok ? res.data?.message || 'That change was not saved.' : res.message || 'That change was not saved.')
}

export const acknowledgeSignal = (id: string) => write(`${BASE}/${encodeURIComponent(id)}`, { action: 'acknowledge' })
export const resolveSignal = (id: string) => write(`${BASE}/${encodeURIComponent(id)}`, { action: 'resolve' })
export const setRuleArmed = (rule_key: string, enabled: boolean) => write(`${BASE}/rules`, { rule_key, enabled })
