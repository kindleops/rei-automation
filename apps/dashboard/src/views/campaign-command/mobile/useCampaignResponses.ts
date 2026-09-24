import { useCallback, useEffect, useState } from 'react'
import { getCampaignResponsesBackend, type CampaignResponsesResponse } from '../../../lib/api/backendClient'

/**
 * One fetch of a campaign's responses, shared by the hero, Overview and
 * Replies — they sit on one screen and must agree, so they read one answer.
 * Kept for a minute; `reload` asks again.
 */

const TTL_MS = 60_000
const cache = new Map<string, { at: number; data: CampaignResponsesResponse }>()
const inflight = new Map<string, Promise<CampaignResponsesResponse | null>>()

function request(campaignId: string): Promise<CampaignResponsesResponse | null> {
  const pending = inflight.get(campaignId)
  if (pending) return pending
  const p = getCampaignResponsesBackend(campaignId)
    .then((res) => {
      if (res.ok && res.data?.ok) {
        cache.set(campaignId, { at: Date.now(), data: res.data })
        return res.data
      }
      return null
    })
    .catch(() => null)
    .finally(() => { inflight.delete(campaignId) })
  inflight.set(campaignId, p)
  return p
}

export function useCampaignResponses(campaignId: string) {
  const cached = cache.get(campaignId)
  const fresh = cached && Date.now() - cached.at < TTL_MS ? cached.data : null
  const [data, setData] = useState<CampaignResponsesResponse | null>(fresh)
  const [loading, setLoading] = useState(!fresh)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async (force = false) => {
    if (force) cache.delete(campaignId)
    const hit = cache.get(campaignId)
    if (hit && Date.now() - hit.at < TTL_MS) {
      setData(hit.data)
      setLoading(false)
      return
    }
    setLoading(true)
    setFailed(false)
    const result = await request(campaignId)
    setData(result)
    setFailed(result === null)
    setLoading(false)
  }, [campaignId])

  useEffect(() => { void load() }, [load])

  return { data, loading, failed, reload: () => load(true) }
}
