import { getSupabaseAdminClient } from '../../internal/_lib/supabaseAdmin'

type ApiRequest = {
  method?: string
  url?: string
  query?: Record<string, string | string[]>
}

type ApiResponse = {
  status: (code: number) => ApiResponse
  json: (body: unknown) => void
}

function getThreadKey(req: ApiRequest): string | null {
  // Try req.query first (Vercel serverless)
  if (req.query?.thread_key) {
    const v = req.query.thread_key
    return typeof v === 'string' ? v : v[0]
  }
  // Fallback: parse from URL
  if (req.url) {
    try {
      const url = new URL(req.url, 'http://localhost')
      return url.searchParams.get('thread_key')
    } catch {
      const match = req.url.match(/[?&]thread_key=([^&]+)/)
      return match ? decodeURIComponent(match[1]) : null
    }
  }
  return null
}

async function safeSelect(supabase: any, table: string, query: any): Promise<{ data: any[] | null; error: string | null }> {
  try {
    const { data, error } = await query
    if (error) return { data: null, error: error.message }
    return { data: data ?? [], error: null }
  } catch (err: any) {
    return { data: null, error: err?.message ?? `${table} fetch failed` }
  }
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const thread_key = getThreadKey(req)
  if (!thread_key) {
    res.status(400).json({ error: 'thread_key query param is required' })
    return
  }

  const supabase = getSupabaseAdminClient()
  const diagnostics: Record<string, string | null> = {}

  // ── 1. message_events ────────────────────────────────────────────────────
  const eventsR = await safeSelect(supabase, 'message_events',
    supabase.from('message_events').select('*').eq('thread_key', thread_key).order('created_at', { ascending: false }).limit(100)
  )
  diagnostics.message_events = eventsR.error
  const events: any[] = eventsR.data ?? []

  // ── 2. Recover canonical IDs ─────────────────────────────────────────────
  let master_owner_id: string | null = null
  let property_id: string | null = null
  let prospect_id: string | null = null
  let queue_id: string | null = null

  for (const ev of events) {
    master_owner_id = master_owner_id ?? ev.master_owner_id ?? null
    property_id     = property_id     ?? ev.property_id     ?? null
    prospect_id     = prospect_id     ?? ev.prospect_id     ?? null
    queue_id        = queue_id        ?? ev.queue_id        ?? null
  }

  // ── 3. send_queue ────────────────────────────────────────────────────────
  let sendQueue: any[] = []
  if (queue_id) {
    const sqR = await safeSelect(supabase, 'send_queue',
      supabase.from('send_queue').select('*').eq('id', queue_id)
    )
    diagnostics.send_queue = sqR.error
    sendQueue = sqR.data ?? []
  } else {
    // Try by thread_key if no direct queue_id
    const sqR = await safeSelect(supabase, 'send_queue',
      supabase.from('send_queue').select('*').eq('thread_key', thread_key).order('created_at', { ascending: false }).limit(10)
    )
    diagnostics.send_queue = sqR.error
    sendQueue = sqR.data ?? []
  }

  // Recover IDs from queue if still missing
  for (const q of sendQueue) {
    master_owner_id = master_owner_id ?? q.master_owner_id ?? null
    property_id     = property_id     ?? q.property_id     ?? null
    prospect_id     = prospect_id     ?? q.prospect_id     ?? null
  }

  // ── 4. inbox_thread_state ────────────────────────────────────────────────
  const itsR = await safeSelect(supabase, 'inbox_thread_state',
    supabase.from('inbox_thread_state').select('*').eq('thread_key', thread_key).limit(1)
  )
  diagnostics.inbox_thread_state = itsR.error
  const inboxThreadState = itsR.data?.[0] ?? null

  // Also recover IDs from inbox_thread_state
  if (inboxThreadState) {
    master_owner_id = master_owner_id ?? inboxThreadState.master_owner_id ?? null
    property_id     = property_id     ?? inboxThreadState.property_id     ?? null
    prospect_id     = prospect_id     ?? inboxThreadState.prospect_id     ?? null
  }

  // ── 5. thread_ai_state ───────────────────────────────────────────────────
  const tasR = await safeSelect(supabase, 'thread_ai_state',
    supabase.from('thread_ai_state').select('*').eq('thread_key', thread_key).limit(1)
  )
  diagnostics.thread_ai_state = tasR.error
  const threadAiState = tasR.data?.[0] ?? null

  // ── 6. master_owner ──────────────────────────────────────────────────────
  let masterOwner: any = null
  if (master_owner_id) {
    const ownerR = await safeSelect(supabase, 'master_owners',
      supabase.from('master_owners').select('*').eq('id', master_owner_id).limit(1)
    )
    diagnostics.master_owners = ownerR.error
    masterOwner = ownerR.data?.[0] ?? null
  } else {
    diagnostics.master_owners = 'no master_owner_id resolved'
  }

  // ── 7. property ──────────────────────────────────────────────────────────
  let property: any = null
  if (property_id) {
    const propR = await safeSelect(supabase, 'properties',
      supabase.from('properties').select('*').eq('property_id', property_id).limit(1)
    )
    diagnostics.properties = propR.error
    property = propR.data?.[0] ?? null
  } else {
    diagnostics.properties = 'no property_id resolved'
  }

  // ── 8. prospect ──────────────────────────────────────────────────────────
  let prospect: any = null
  if (prospect_id) {
    const prospR = await safeSelect(supabase, 'prospects',
      supabase.from('prospects').select('*').eq('id', prospect_id).limit(1)
    )
    diagnostics.prospects = prospR.error
    prospect = prospR.data?.[0] ?? null
  } else {
    diagnostics.prospects = 'no prospect_id resolved'
  }

  // ── 9. phones ────────────────────────────────────────────────────────────
  let phones: any[] = []
  if (master_owner_id) {
    const phonesR = await safeSelect(supabase, 'phones',
      supabase.from('phones').select('*').eq('master_owner_id', master_owner_id)
    )
    diagnostics.phones = phonesR.error
    phones = phonesR.data ?? []
  } else {
    diagnostics.phones = 'no master_owner_id resolved'
  }

  // ── 10. emails ───────────────────────────────────────────────────────────
  let emails: any[] = []
  if (master_owner_id) {
    const emailsR = await safeSelect(supabase, 'emails',
      supabase.from('emails').select('*').eq('master_owner_id', master_owner_id)
    )
    diagnostics.emails = emailsR.error
    emails = emailsR.data ?? []
  } else {
    diagnostics.emails = 'no master_owner_id resolved'
  }

  const resolvedIds = { master_owner_id, property_id, prospect_id, queue_id }
  const errors = Object.entries(diagnostics).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`)

  res.status(200).json({
    thread_key,
    resolvedIds,
    message_events: events,
    send_queue: sendQueue,
    inbox_thread_state: inboxThreadState,
    thread_ai_state: threadAiState,
    master_owner: masterOwner,
    property,
    prospect,
    phones,
    emails,
    diagnostics,
    errors,
    partial: errors.length > 0,
    fetched_at: new Date().toISOString(),
  })
}
