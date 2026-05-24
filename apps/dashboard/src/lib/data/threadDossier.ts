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
  diagnostics: Record<string, string | null>
  errors: string[]
  partial: boolean
  fetched_at: string
}

export async function fetchThreadDossier(thread_key: string): Promise<ThreadDossier> {
  const res = await fetch(`/api/cockpit/inbox/thread-dossier?thread_key=${encodeURIComponent(thread_key)}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as any)?.error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<ThreadDossier>
}
