// PII minimisation for every conversation-ai payload that crosses to a model or a report.
//
//   * phones → "•••-••NN", emails → "[email withheld]" (the research agent's maskString,
//     reused, not copied), then the residual check: if anything phone- or email-shaped
//     survives, the payload is REFUSED (never sent to a model).
//   * names: the owner's / prospect's known full and last names are replaced by
//     "[name]" in free text; only the seller's FIRST name may appear, and only in the
//     dedicated `seller_first_name` slot when a reply needs it.
//   * logs and reports carry hashed thread keys only (threadRef).
import { maskString, residualContact, sha256 } from '../../agent/research/pii.js'

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Words of a name worth masking (≥ 2 letters, not a common stop word). */
function nameTokens(names = []) {
  const stop = new Set(['the', 'and', 'llc', 'inc', 'trust', 'estate', 'of', 'mr', 'mrs', 'ms', 'dr', 'jr', 'sr', 'ii', 'iii'])
  const out = new Set()
  for (const n of names) {
    for (const w of String(n || '').split(/[\s,.&/]+/)) {
      const t = w.trim()
      if (t.length >= 2 && /^[\p{L}'-]+$/u.test(t) && !stop.has(t.toLowerCase())) out.add(t)
    }
  }
  return [...out].sort((a, b) => b.length - a.length)
}

/**
 * Mask one free-text string.
 * @param {string} text
 * @param {{ maskNames?: string[], keepFirstName?: string|null }} [o]
 *   maskNames: full names known for this thread (owner, prospect, co-owners).
 *   keepFirstName: the one first name the reply may use (left visible).
 */
// Money-shaped tokens are protected before the phone pass: the phone pattern joins digit
// runs across separators, so "150,000 or 140,000" would otherwise read as one phone.
const MONEY_RE = /\$\s?[0-9][0-9,]*(?:\.[0-9]+)?\s?(?:k|m|mil|million|thousand|grand)?\b|\b[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?\b|\b[0-9]+(?:\.[0-9]+)?\s?(?:k|m|mil|million|thousand|grand)\b/gi

export function maskText(text, { maskNames = [], keepFirstName = null } = {}) {
  const kept = []
  const held = String(text ?? '').replace(MONEY_RE, (m) => { kept.push(m); return `\u0001${kept.length - 1}\u0001` })
  let s = maskString(held)[0].replace(/\u0001([0-9]+)\u0001/g, (_, i) => kept[Number(i)])
  const keep = keepFirstName ? String(keepFirstName).trim().toLowerCase() : null
  const toks = nameTokens(maskNames).filter((t) => t.toLowerCase() !== keep)
  if (toks.length) s = s.replace(new RegExp(`(?<![\\p{L}])(?:${toks.map(escapeRe).join('|')})(?![\\p{L}])`, 'giu'), '[name]')
  return s
}

/** Deep-mask every string in a payload; returns { ok, value, residual }. */
export function maskPayload(value, opts = {}) {
  const walk = (v) => {
    if (typeof v === 'string') return maskText(v, opts)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  const masked = walk(value)
  const residual = residualContact(JSON.stringify(masked))
  return { ok: !residual, value: masked, residual: Boolean(residual) }
}

/**
 * A stable, non-reversible thread reference for logs and reports. Letters only
 * (hex digits mapped to g–p) so no reference can ever look like a phone run.
 */
export function threadRef(threadKey) {
  return `thr_${sha256(String(threadKey ?? '')).slice(0, 12).replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)])}`
}

/** First name only (never a last name, never an entity name). */
export function firstNameOnly(name) {
  const s = String(name ?? '').trim()
  if (!s || /\b(llc|inc|trust|estate|corp|company|co\.|ltd|lp|bank|church)\b/i.test(s)) return null
  const first = s.split(/\s+/)[0]
  return /^[\p{L}'-]{2,20}$/u.test(first) ? first[0].toUpperCase() + first.slice(1).toLowerCase() : null
}
