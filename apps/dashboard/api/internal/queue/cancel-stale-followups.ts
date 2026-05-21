import { getSupabaseClient } from '../../../src/lib/supabaseClient'

type ApiRequest = {
  method?: string
  body?: any
}

type ApiResponse = {
  status: (code: number) => ApiResponse
  json: (body: any) => void
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (process.env.NEXUS_ALLOW_BACKEND_MUTATION !== 'true') {
    res.status(403).json({ error: 'BOUNDARY_VIOLATION', message: 'Backend mutation scripts must run from real-estate-automation, not nexus-dashboard.' })
    return
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const supabase = getSupabaseAdminClient()
  const now = new Date()
  const staleCutoffIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()

  try {
    const { data, error } = await supabase
      .from('send_queue')
      .update({
        queue_status: 'cancelled',
        failed_reason: 'stale_follow_up_cancelled',
        updated_at: now.toISOString(),
      })
      .eq('queue_status', 'scheduled')
      .lt('scheduled_for_utc', staleCutoffIso)
      .ilike('type', '%follow%')
      .select('id')

    if (error) throw error
    res.status(200).json({ ok: true, cancelled: data?.length || 0 })
  } catch (error) {
    console.error('[Cancel Stale Followups Error]:', error)
    res.status(500).json({ error: error instanceof Error ? error.message : 'Cancel stale follow-ups failed' })
  }
}
 error.message : 'Cancel stale follow-ups failed' })
  }
}
