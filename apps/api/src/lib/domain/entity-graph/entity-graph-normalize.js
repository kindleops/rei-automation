export function clean(value) {
  return String(value ?? '').trim()
}

export function lower(value) {
  return clean(value).toLowerCase()
}

export function int(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, 0), max)
}

export function normalizePhoneE164(value) {
  const raw = clean(value)
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (raw.startsWith('+') && digits.length >= 10) return `+${digits}`
  return digits.length >= 10 ? `+${digits}` : null
}

export function normalizeEmail(value) {
  const email = lower(value)
  return email || null
}

export function normalizeAddressSearch(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeSearchQuery(value) {
  return clean(value).replace(/[,%()]/g, ' ')
}

export function phoneTail(value) {
  const e164 = normalizePhoneE164(value)
  if (!e164) return null
  return e164.slice(-4)
}

export function parseJsonArray(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean)
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.map(clean).filter(Boolean) : []
    } catch {
      return []
    }
  }
  return []
}

export function relationshipLabel(prospect, owner) {
  if (prospect?.likely_owner) return 'Likely Owner'
  if (prospect?.likely_renting) return 'Linked Person'
  if (owner?.owner_type_guess) {
    const type = lower(owner.owner_type_guess)
    if (type.includes('trust')) return 'Trust Contact'
    if (type.includes('llc') || type.includes('corp')) return 'Entity Contact'
  }
  return 'Associated Contact'
}