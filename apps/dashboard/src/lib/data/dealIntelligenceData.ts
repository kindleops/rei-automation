import { getBackendBaseUrl, getBackendSecret } from '../api/backendClient'

export interface DealDossier {
  identity: {
    thread_key: string
    property_id?: string
    prospect_id?: string
    master_owner_id?: string
    canonical_e164?: string
  }
  property: any
  prospect: any
  master_owner: any
  phones: any[]
  primary_phone: any
  emails: any[]
  primary_email: any
  conversation: any
  deal_status: any
  valuation: any
  buyer_match: any
  census: any
  acquisition_decision: any
  compliance: any
  freshness: any
  raw_sources_debug?: any
}

export type DealIntelligenceData = DealDossier

export async function loadDealIntelligence(thread: {
  threadKey?: string
  propertyId?: string
  canonicalE164?: string
  prospectId?: string
  masterOwnerId?: string
}): Promise<DealIntelligenceData | null> {
  const base = getBackendBaseUrl()
  const secret = getBackendSecret()

  const threadKey = thread.threadKey || 'unknown'
  const qs = new URLSearchParams()
  if (thread.propertyId) qs.set('property_id', thread.propertyId)
  if (thread.canonicalE164) qs.set('canonical_e164', thread.canonicalE164)
  if (thread.prospectId) qs.set('prospect_id', thread.prospectId)
  if (thread.masterOwnerId) qs.set('master_owner_id', thread.masterOwnerId)
  
  const path = `/api/cockpit/deal-intelligence/thread/${encodeURIComponent(threadKey)}`
  const urlString = qs.toString() ? `${base}${path}?${qs.toString()}` : `${base}${path}`

  try {
    const res = await fetch(urlString, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-ops-dashboard-secret': secret,
      },
    })
    
    if (!res.ok) {
      console.warn('[LOAD_DEAL_DOSSIER_HTTP_ERROR]', res.status, await res.text())
      return null
    }

    const result = await res.json()
    if (result.ok && result.data) {
      return result.data
    } else {
      console.warn('[LOAD_DEAL_DOSSIER_FAILED]', result.error)
      return null
    }
  } catch (error) {
    console.error('[LOAD_DEAL_DOSSIER_EXCEPTION]', error)
    return null
  }
}