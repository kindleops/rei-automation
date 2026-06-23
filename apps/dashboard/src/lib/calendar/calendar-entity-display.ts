import type { CalendarEvent } from '../data/calendarData'

const PLACEHOLDER_SELLER = new Set(['unknown seller', 'unknown', ''])
const PLACEHOLDER_PROPERTY = new Set(['property unknown', 'unknown property', 'unknown address', ''])

export function formatSellerLabel(event: CalendarEvent): string {
  const name = String(event.sellerName || '').trim()
  if (!name || PLACEHOLDER_SELLER.has(name.toLowerCase())) {
    if (event.unresolvedReason) return 'Unresolved event'
    if (event.sellerId || event.deepLinkContext?.master_owner_id) return 'Owner pending resolution'
    return 'Unresolved event'
  }
  return name
}

export function formatPropertyLabel(event: CalendarEvent): string {
  const addr = String(event.propertyAddress || '').trim()
  if (!addr || PLACEHOLDER_PROPERTY.has(addr.toLowerCase())) {
    if (event.propertyId || event.deepLinkContext?.property_id) return 'Property pending resolution'
    return ''
  }
  return addr
}

export function formatEntitySubtitle(event: CalendarEvent): string {
  const seller = formatSellerLabel(event)
  const property = formatPropertyLabel(event)
  if (property) return `${seller} · ${property}`
  return seller
}

export function isFullyResolved(event: CalendarEvent): boolean {
  const seller = String(event.sellerName || '').trim()
  const property = String(event.propertyAddress || '').trim()
  const hasSeller = seller && !PLACEHOLDER_SELLER.has(seller.toLowerCase()) && !seller.startsWith('Unresolved')
  const hasProperty = property && !PLACEHOLDER_PROPERTY.has(property.toLowerCase())
  return Boolean(hasSeller && (hasProperty || event.propertyId))
}