/**
 * ONE compliance gate for every direct call action (`tel:`) in the product.
 *
 * The UI does not decide eligibility — it renders the verdict the server
 * already recorded (suppression list, thread suppression, contactability,
 * wrong-number flag). This module only refuses to hand out a dialler link
 * when any of those facts says "do not contact", or when the number itself
 * is not a dialable phone. Unknown contactability codes do not block on
 * their own; every known prohibitive code does.
 */

export interface CallGateInput {
  /** Raw phone (E.164, 10-digit, formatted…). */
  phone: string | null | undefined
  /** Any suppression on the number or the thread (list or thread flag). */
  suppressed?: boolean | null
  /** inbox_thread_state.contactability_status (or equivalent). */
  contactability?: string | null
  /** phones.wrong_number_at is set. */
  wrongNumber?: boolean | null
  /** The subject is still loading — never dial the previous seller. */
  pending?: boolean
}

export type CallVerdict =
  | { allowed: true; href: string; e164: string; reason: null }
  | { allowed: false; href: null; e164: string | null; reason: string }

/** Contactability codes that prohibit a call, with the plain-language reason. */
const PROHIBITED: Record<string, string> = {
  opted_out: 'Seller opted out — do not call',
  dnc: 'On the do-not-contact list',
  do_not_contact: 'Marked do not contact',
  do_not_text: 'Marked do not contact',
  provider_blacklisted: 'Number is suppressed',
  invalid_number: 'Number is not valid',
  wrong_number: 'Reported as a wrong number',
}

/** Normalises to E.164 (+1 NANP or +CC…); null when the value is not a dialable phone. */
export function normalizeDialable(phone: string | null | undefined): string | null {
  if (typeof phone !== 'string') return null
  const raw = phone.trim()
  if (!raw) return null
  // Letters mean this is not a phone (thread keys, ids, emails).
  if (/[a-z]/i.test(raw)) return null
  const digits = raw.replace(/\D/g, '')
  if (raw.startsWith('+')) {
    // Country code 1 is NANP: exactly ten digits must follow.
    if (digits.startsWith('1')) return digits.length === 11 ? nanp(digits.slice(1)) : null
    return digits.length >= 10 && digits.length <= 15 && !digits.startsWith('0') ? `+${digits}` : null
  }
  if (digits.length === 10) return nanp(digits)
  if (digits.length === 11 && digits.startsWith('1')) return nanp(digits.slice(1))
  return null
}

/** NANP: area code and exchange cannot start with 0 or 1. */
function nanp(ten: string): string | null {
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? `+1${ten}` : null
}

export function resolveCallAction(input: CallGateInput): CallVerdict {
  const e164 = normalizeDialable(input.phone)
  const deny = (reason: string): CallVerdict => ({ allowed: false, href: null, e164, reason })
  if (input.pending) return deny('Checking contact permissions…')
  const code = typeof input.contactability === 'string' ? input.contactability.trim().toLowerCase() : ''
  if (code && PROHIBITED[code]) return deny(PROHIBITED[code])
  if (input.suppressed) return deny('Contact is suppressed')
  if (input.wrongNumber) return deny(PROHIBITED.wrong_number)
  if (!input.phone || !String(input.phone).trim()) return deny('No phone on file')
  if (!e164) return deny('Number is not valid')
  return { allowed: true, href: `tel:${e164}`, e164, reason: null }
}

type Rec = Record<string, unknown> | null | undefined

/**
 * Builds the gate input from a Deal Intelligence dossier (mobile + Pipeline
 * sheet share this shape): compliance, phone and conversation blocks. A
 * missing dossier means compliance is not known yet, so the call is held.
 */
export function callGateFromDossier(dossier: unknown, phone: string | null | undefined): CallGateInput {
  const dz = (dossier && typeof dossier === 'object' ? dossier : null) as { compliance?: Rec; phone?: Rec; conversation_intelligence?: Rec } | null
  // No dossier yet = compliance unknown: hold the call until it arrives.
  if (!dz) return { phone, pending: true }
  const compliance = dz.compliance ?? null
  const ph = dz.phone ?? null
  const convo = dz.conversation_intelligence ?? null
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  return {
    phone,
    suppressed: compliance?.is_suppressed === true || ph?.suppressed === true || convo?.suppressed === true,
    contactability: str(compliance?.contactability_status) ?? str(convo?.contactability_status) ?? str(ph?.contactability_status),
    wrongNumber: compliance?.wrong_number === true || ph?.wrong_number === true,
  }
}
