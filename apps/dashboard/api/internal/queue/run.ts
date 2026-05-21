import { DEFAULT_LIVE_CAPS, runQueueBatch, type QueueRunCaps } from './runner'

type ApiRequest = {
  method?: string
  body?: any
}

type ApiResponse = {
  status: (code: number) => ApiResponse
  json: (body: any) => void
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const isLive = req.body?.dry_run === false

    // If it's a live run, check if we should proxy to real-estate-automation
    if (isLive) {
      const proxyUrl = process.env.REAL_ESTATE_AUTOMATION_BASE_URL
      const sharedSecret = process.env.QUEUE_ENGINE_SHARED_SECRET

      if (proxyUrl) {
        console.log(`[QueueProxy] Proxying live run to ${proxyUrl}`)
        try {
          const response = await fetch(`${proxyUrl.replace(/\/$/, '')}/api/internal/queue/run`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-queue-engine-secret': sharedSecret || '',
            },
            body: JSON.stringify(req.body),
          })

          if (!response.ok) {
            const errorText = await response.text()
            let errorJson: any = {}
            try {
              errorJson = JSON.parse(errorText)
            } catch {
              // Not JSON
            }

            return res.status(response.status).json({
              ok: false,
              error: 'PROXY_FAILED',
              message: `Upstream error (${response.status}): ${errorJson.message || errorText}`,
              status: response.status,
              upstream_error: errorJson
            })
          }

          const result = await response.json()
          return res.status(200).json(result)
        } catch (fetchErr) {
          console.error('[QueueProxy] Network error proxying request:', fetchErr)
          return res.status(502).json({
            ok: false,
            error: 'PROXY_NETWORK_ERROR',
            message: `Failed to connect to real-estate-automation: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`
          })
        }
      } else {
        // No proxy URL, fall through to local runner which will be caught by the hard guard
        console.warn('[QueueProxy] Live run requested but REAL_ESTATE_AUTOMATION_BASE_URL not set.')
      }
    }

    const caps: Partial<QueueRunCaps> = {
      ...DEFAULT_LIVE_CAPS,
      ...(req.body?.caps || {}),
    }

    if (typeof req.body?.dry_run === 'boolean') {
      caps.dry_run = req.body.dry_run;
    }
    if (typeof req.body?.limit === 'number') {
      caps.sends_per_run = req.body.limit;
    }

    const result = await runQueueBatch(caps)
    res.status(200).json(result)
  } catch (error) {
    console.error('[Queue Run Error]:', error)
    res.status(500).json({ error: error instanceof Error ? error.message : 'Queue run failed' })
  }
}
