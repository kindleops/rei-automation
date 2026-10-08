import { callBackend } from '../../lib/api/backendClient'

/**
 * SELLER PORTAL (ops side) — client contract for /api/cockpit/seller-portal.
 * The server owns the conversation, the read marks and every shared
 * document; this file types them. Nothing here decides what a seller sees.
 */

export interface PortalConversation {
  opportunity_id: string
  last_at: string
  last_author: 'seller' | 'operator' | 'system'
  preview: string | null
  unread: number
  opportunity: {
    id: string
    property_address_full: string | null
    seller_display_name: string | null
    acquisition_stage: string | null
    opportunity_status: string | null
    assigned_operator: string | null
  } | null
}

export interface PortalMessage { id: string; author_kind: string; author_operator: string | null; body: string; created_at: string }
export interface PortalShareable { id: string; filename: string; content_type: string | null; size_bytes: number | null; doc_type: string | null; received_at: string | null }
export interface PortalShare {
  id: string; attachment_id: string; label: string; document_kind: string; seller_status: string
  shared_by: string | null; shared_at: string; revoked_at: string | null; revoked_by: string | null
}
export interface PortalCall { id: string; status: string; start_at: string; end_at: string; reason: string | null; resource_id: string | null; sync_status: string | null }

export interface PortalThread {
  opportunity: { id: string; address: string | null; seller: string | null; stage: string | null; status: string | null; assigned_operator: string | null }
  portal_accounts: Array<{ email: string; name: string | null }>
  messages: PortalMessage[]
  documents: { shareable: PortalShareable[]; shares: PortalShare[] }
  calls: PortalCall[]
}

export type ShareKind = 'offer' | 'purchase_agreement' | 'disclosure' | 'title' | 'closing_statement' | 'other'
export const SHARE_KINDS: Array<{ value: ShareKind; label: string }> = [
  { value: 'offer', label: 'Offer' }, { value: 'purchase_agreement', label: 'Purchase agreement' }, { value: 'disclosure', label: 'Disclosure' },
  { value: 'title', label: 'Title' }, { value: 'closing_statement', label: 'Closing statement' }, { value: 'other', label: 'Other' },
]

/** §30 — the envelope's ok flag is honoured; the server's code is the message. */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await callBackend<T & { ok?: boolean; error?: string }>(path, init)
  if (!res.ok) {
    const up = res.upstream as { error?: string } | undefined
    throw new Error(up?.error || res.error || 'seller_portal_failed')
  }
  if (res.data && res.data.ok === false) throw new Error(res.data.error || 'seller_portal_failed')
  return res.data
}

export const fetchPortalConversations = (unreadOnly: boolean, signal?: AbortSignal) =>
  call<{ ok: true; conversations: PortalConversation[] }>(`/api/cockpit/seller-portal/conversations${unreadOnly ? '?unread=1' : ''}`, { signal })

export const fetchPortalThread = (opportunityId: string, signal?: AbortSignal) =>
  call<{ ok: true } & PortalThread>(`/api/cockpit/seller-portal/${encodeURIComponent(opportunityId)}`, { signal })

type PortalAction =
  | { action: 'reply'; body: string }
  | { action: 'mark_read' }
  | { action: 'share'; attachment_id: string; label: string; kind: ShareKind; status: 'ready' | 'needs_signature' }
  | { action: 'revoke'; share_id: string }

export const postPortalAction = (opportunityId: string, body: PortalAction) =>
  call<{ ok: true }>(`/api/cockpit/seller-portal/${encodeURIComponent(opportunityId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

export const humanCode = (code: string | null | undefined) => {
  const w = String(code ?? '').replace(/_/g, ' ').trim()
  return w ? `${w.charAt(0).toUpperCase()}${w.slice(1)}` : ''
}
