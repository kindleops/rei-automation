import { DEFAULT_SAFE_CAPS, runQueueBatch, type QueueRunCaps } from './runner'

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

  try {
    const requestedCaps = req.body?.caps || {}
    const caps: Partial<QueueRunCaps> = {
      sends_per_run: Math.min(Number(requestedCaps.sends_per_run || DEFAULT_SAFE_CAPS.sends_per_run), DEFAULT_SAFE_CAPS.sends_per_run),
      auto_replies_per_run: Math.min(Number(requestedCaps.auto_replies_per_run || DEFAULT_SAFE_CAPS.auto_replies_per_run), DEFAULT_SAFE_CAPS.auto_replies_per_run),
      followups_per_run: Math.min(Number(requestedCaps.followups_per_run || DEFAULT_SAFE_CAPS.followups_per_run), DEFAULT_SAFE_CAPS.followups_per_run),
      first_touches_per_run: Math.min(Number(requestedCaps.first_touches_per_run || DEFAULT_SAFE_CAPS.first_touches_per_run), DEFAULT_SAFE_CAPS.first_touches_per_run),
      max_per_number_per_day: Math.min(Number(requestedCaps.max_per_number_per_day || DEFAULT_SAFE_CAPS.max_per_number_per_day), DEFAULT_SAFE_CAPS.max_per_number_per_day),
      max_per_market_per_hour: Math.min(Number(requestedCaps.max_per_market_per_hour || DEFAULT_SAFE_CAPS.max_per_market_per_hour), DEFAULT_SAFE_CAPS.max_per_market_per_hour),
    }
    const result = await runQueueBatch(caps)
    res.status(200).json(result)
  } catch (error) {
    console.error('[Queue Safe Batch Error]:', error)
    res.status(500).json({ error: error instanceof Error ? error.message : 'Safe batch failed' })
  }
}
