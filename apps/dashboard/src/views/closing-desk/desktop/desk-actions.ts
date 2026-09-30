import type { Closing } from '../mobile/closing-execution-api'
import { availableActions, type ActionSpec } from '../mobile/ClosingActions'
import { links } from './desk-model'

/**
 * What the operator can DO about a model action verb — either one
 * authoritative server write (closing-authority.js via the actions route, as
 * a form) or a hand-off to the app that owns the channel (Email Command,
 * Inbox, Buyer Match, Calendar). Closing Desk never composes email itself.
 */
export type Resolved =
  | { kind: 'form'; label: string; spec: ActionSpec }
  | { kind: 'link'; label: string; path: string; locate: boolean }
  | { kind: 'review'; label: string }

const FORM_FOR: Record<string, string> = {
  verify_emd: 'verify_emd',
  record_contract_emd: 'record_contract_emd_deposit',
  schedule_closing: 'set_closing_date',
  send_buyer_agreement: 'record_buyer_agreement',
  resend_buyer_agreement: 'record_buyer_agreement',
  resolve_emd: 'record_emd_receipt',
  resume_automation: 'set_automation_paused',
  finalize: 'finalize_closing',
}

export function formFor(c: Closing, action: string): ActionSpec | null {
  if (action === 'resolve_title_issue') return availableActions(c).find((a) => a.action === 'update_title_issue') ?? null
  const want = FORM_FOR[action] || action
  return availableActions(c).find((a) => a.action === want) ?? null
}

const titleThreadPath = (c: Closing) => (c.title.thread?.id ? links.emailThread(c.title.thread.id) : c.propertyId ? `/email-command?property_id=${encodeURIComponent(c.propertyId)}` : null)
const buyerThreadPath = (c: Closing) => (c.buyer?.thread?.id ? links.emailThread(c.buyer.thread.id) : c.propertyId ? `/email-command?property_id=${encodeURIComponent(c.propertyId)}` : null)

export function resolveAction(action: string | null | undefined, c: Closing): Resolved | null {
  if (!action) return null
  switch (action) {
    case 'email_title': { const p = titleThreadPath(c); return p ? { kind: 'link', label: c.title.thread?.id ? 'Open title thread' : 'Email title', path: p, locate: true } : null }
    case 'chase_emd':
    case 'nudge_buyer': { const p = buyerThreadPath(c); return p ? { kind: 'link', label: c.buyer?.thread?.id ? 'Open buyer thread' : 'Email buyer', path: p, locate: true } : null }
    case 'nudge_seller': return c.threadKey ? { kind: 'link', label: 'Message seller', path: `/inbox?thread=${encodeURIComponent(c.threadKey)}`, locate: false } : null
    case 'select_buyer':
    case 'replace_buyer': return c.propertyId ? { kind: 'link', label: 'Open Buyer Match', path: `/buyer-match?property_id=${encodeURIComponent(c.propertyId)}`, locate: true } : null
    case 'choose_title': return null
    case 'review': return { kind: 'review', label: 'Show open requirements' }
    default: {
      const spec = formFor(c, action)
      return spec ? { kind: 'form', label: spec.label, spec } : null
    }
  }
}
