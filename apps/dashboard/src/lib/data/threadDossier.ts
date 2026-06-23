import { fetchInboxThreadDossier } from '../api/backendClient'

export interface ThreadDossier {
  thread_key: string
  resolvedIds: {
    master_owner_id: string | null
    property_id: string | null
    prospect_id: string | null
    queue_id: string | null
  }
  message_events: Record<string, unknown>[]
  send_queue: Record<string, unknown>[]
  inbox_thread_state: Record<string, unknown> | null
  thread_ai_state: Record<string, unknown> | null
  master_owner: Record<string, unknown> | null
  property: Record<string, unknown> | null
  prospect: Record<string, unknown> | null
  phones: Record<string, unknown>[]
  emails: Record<string, unknown>[]
  buyer_entities?: Record<string, unknown>[]
  buyer_purchase_events?: Record<string, unknown>[]
  buyer_matches?: Record<string, unknown>[]
  recently_sold?: Record<string, unknown>[]
  diagnostics: Record<string, string | null>
  errors: any[]
  partial: boolean
  fetched_at: string
}

export async function fetchThreadDossier(thread_key: string): Promise<ThreadDossier> {
  const qs = new URLSearchParams({ thread_key }).toString()
  const result = await fetchInboxThreadDossier(qs)
  if (!result.ok) throw new Error(result.message || result.error || `HTTP ${result.status}`)
  return result.data as ThreadDossier
}
