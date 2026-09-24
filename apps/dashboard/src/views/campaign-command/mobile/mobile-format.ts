/**
 * Small formatters shared by the mobile Campaign detail sections.
 */

/** +13057429240 → (305) 742-9240. Anything that isn't a US number is returned as-is. */
export function formatPhone(e164: string | null | undefined): string | null {
  const raw = String(e164 ?? '').trim()
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits.length === 10 ? digits : null
  if (!national) return raw
  return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`
}

/** A seller's name, or their number when the name is unknown — never "Unknown". */
export function sellerLabel(name: string | null | undefined, phone: string | null | undefined): string {
  const n = String(name ?? '').trim()
  if (n) return n
  return formatPhone(phone) ?? 'Seller'
}
