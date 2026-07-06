import * as backendClient from '../../lib/api/backendClient'

export interface FilterCatalogGroup {
  id: string
  label: string
  icon: string
}

export interface FilterCatalogField {
  key: string
  group: string
  label: string
  type: string
  column?: string
  optionsKey?: string
}

export interface FilterOption {
  value: string
  label: string
  count: number
}

export interface SavedInboxView {
  id: string
  name: string
  icon?: string | null
  color?: string | null
  sort_order: number
  filter_json: Record<string, unknown>
  is_system: boolean
  is_pinned: boolean
}

export async function fetchInboxFilterCatalog(signal?: AbortSignal) {
  const res = await backendClient.callBackend<{
    ok: boolean
    groups: FilterCatalogGroup[]
    fields: FilterCatalogField[]
    source: string
  }>('/api/cockpit/inbox/filter-catalog', { signal })
  if (!res.ok) throw new Error(res.message || 'filter_catalog_failed')
  const body = res.data
  if (!body?.fields?.length) throw new Error('filter_catalog_empty')
  return body
}

export async function fetchInboxFilterOptions(
  field: string,
  context: Record<string, unknown> = {},
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ field })
  if (context.advanced) params.set('advanced', JSON.stringify(context.advanced))
  if (context.filter) params.set('filter', String(context.filter))
  const res = await backendClient.callBackend<{
    ok: boolean
    options: FilterOption[]
    field: string
  }>(`/api/cockpit/inbox/filter-options?${params}`, { signal })
  if (!res.ok) throw new Error(res.message || 'filter_options_failed')
  return res.data?.options ?? []
}

export async function fetchInboxFilterPreview(
  filters: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ advanced: JSON.stringify(filters) })
  const res = await backendClient.callBackend<{ ok: boolean; count: number }>(
    `/api/cockpit/inbox/filter-preview?${params}`,
    { signal },
  )
  if (!res.ok) throw new Error(res.message || 'filter_preview_failed')
  return res.data?.count ?? 0
}

export async function fetchInboxSavedViews(signal?: AbortSignal) {
  const res = await backendClient.callBackend<{ ok: boolean; views: SavedInboxView[] }>(
    '/api/cockpit/inbox/saved-views',
    { signal },
  )
  if (!res.ok) throw new Error(res.message || 'saved_views_failed')
  return res.data?.views ?? []
}

export async function saveInboxView(payload: {
  name: string
  filter_json: Record<string, unknown>
  icon?: string
  is_pinned?: boolean
}) {
  const res = await backendClient.callBackend<{ ok: boolean; view: SavedInboxView }>(
    '/api/cockpit/inbox/saved-views',
    { method: 'POST', body: JSON.stringify(payload) },
  )
  if (!res.ok) throw new Error(res.message || 'save_view_failed')
  return res.data?.view
}