import { callBackend } from '../../../../lib/api/backendClient'
import { migrateLayout, type HomeLayout } from './home-layout-model'

/**
 * Server persistence for Home layouts — /api/cockpit/home/layouts.
 *
 * Operator-private: the API scopes every read and write to the operator the
 * Worker verified (x-ops-user-id); the browser never names the operator.
 * Until the proposed migration is applied the API answers
 * `home_store_unavailable` and the board keeps saving locally (same keys),
 * moving those layouts to the server the first time it is available.
 */

export interface LayoutRow {
  layout_id: string
  name: string
  is_default: boolean
  profile: string
  schema_version: number
  revision: number
  preset: string | null
  primary_family: string | null
  widget_instances: unknown[]
  created_at: string | null
  updated_at: string | null
}

export type ListResult =
  | { ok: true; layouts: HomeLayout[] }
  | { ok: false; reason: 'store_unavailable' | 'operator_unknown' | 'unauthorized' | 'network'; message: string }

export type SaveResult =
  | { ok: true; revision: number }
  | { ok: false; reason: 'conflict'; current: HomeLayout | null }
  | { ok: false; reason: 'store_unavailable' | 'operator_unknown' | 'unauthorized' | 'network' | 'invalid'; message: string }

export interface HomeLayoutApi {
  list(): Promise<ListResult>
  save(layout: HomeLayout): Promise<SaveResult>
  remove(layoutId: string): Promise<{ ok: boolean; reason?: string }>
}

const PATH = '/api/cockpit/home/layouts'

export function toRow(l: HomeLayout): LayoutRow {
  return {
    layout_id: l.id,
    name: l.name,
    is_default: l.isDefault,
    profile: l.profile,
    schema_version: l.schemaVersion,
    revision: l.revision,
    preset: l.preset,
    primary_family: l.primaryFamily,
    widget_instances: l.widgets,
    created_at: l.createdAt,
    updated_at: l.updatedAt,
  }
}

export function fromRow(r: Partial<LayoutRow> | null | undefined): HomeLayout | null {
  if (!r) return null
  return migrateLayout({
    id: r.layout_id,
    name: r.name,
    isDefault: r.is_default,
    schemaVersion: r.schema_version,
    revision: r.revision,
    preset: r.preset,
    primaryFamily: r.primary_family,
    widgets: r.widget_instances,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  })
}

type Body = { ok?: boolean; error?: string; message?: string; layouts?: LayoutRow[]; layout?: LayoutRow; current?: LayoutRow | null }

function reasonOf(status: number, body: Body | undefined): 'store_unavailable' | 'operator_unknown' | 'unauthorized' | 'network' | 'invalid' {
  const e = body?.error
  if (e === 'home_store_unavailable') return 'store_unavailable'
  if (e === 'operator_unknown') return 'operator_unknown'
  if (e === 'invalid_layout') return 'invalid'
  if (status === 401 || status === 403) return 'unauthorized'
  return 'network'
}

const MESSAGE: Record<string, string> = {
  store_unavailable: 'Layouts are saved on this device until server storage is enabled.',
  operator_unknown: 'Layouts are saved on this device — the server could not identify the operator.',
  unauthorized: 'Layouts are saved on this device — the server refused the request.',
  network: 'Layouts are saved on this device — the server could not be reached.',
  invalid: 'The server rejected this layout.',
}

export const httpHomeLayoutApi: HomeLayoutApi = {
  async list() {
    const ctl = new AbortController()
    const res = await callBackend<Body>(PATH, { signal: ctl.signal, timeoutMs: 20_000 })
    if (!res.ok) {
      const reason = reasonOf(res.status, res.upstream as Body | undefined)
      return { ok: false, reason: reason === 'invalid' ? 'network' : reason, message: MESSAGE[reason] }
    }
    const rows = Array.isArray(res.data?.layouts) ? res.data.layouts : []
    return { ok: true, layouts: rows.map(fromRow).filter((l): l is HomeLayout => Boolean(l)) }
  },
  async save(layout) {
    const res = await callBackend<Body>(PATH, { method: 'PUT', body: JSON.stringify({ layout: toRow(layout) }), headers: { 'content-type': 'application/json' }, timeoutMs: 20_000 })
    if (!res.ok) {
      const body = res.upstream as Body | undefined
      if (res.status === 409) return { ok: false, reason: 'conflict', current: fromRow(body?.current ?? null) }
      const reason = reasonOf(res.status, body)
      return { ok: false, reason, message: MESSAGE[reason] }
    }
    return { ok: true, revision: res.data?.layout?.revision ?? layout.revision }
  },
  async remove(layoutId) {
    const res = await callBackend<Body>(`${PATH}?layout_id=${encodeURIComponent(layoutId)}`, { method: 'DELETE', timeoutMs: 20_000 })
    return res.ok ? { ok: true } : { ok: false, reason: reasonOf(res.status, res.upstream as Body | undefined) }
  },
}
