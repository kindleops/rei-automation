/**
 * Sanitize buyer-match errors before displaying in the dashboard UI.
 */

const INTERNAL_PATTERNS = [
  /cannot find module/i,
  /vendor-chunks/i,
  /webpack/i,
  /node_modules/i,
  /\.next\//i,
  /\/Users\//i,
  /\/home\//i,
  /MODULE_NOT_FOUND/i,
  /@sentry/i,
  /at\s+[\w.]+\s+\(/i,
]

export interface StructuredBuyerMatchEvent {
  id: string
  timestamp: string
  event_type: string
  state: string
  duration_ms?: number | null
  counts?: Record<string, number | string | null>
  error_code?: string | null
  retryable?: boolean
  model_version?: string | null
  message: string
}

export function sanitizeBuyerMatchError(raw: unknown): string {
  const message = String(raw ?? '').trim()
  if (!message) return 'Buyer match could not complete.'
  if (INTERNAL_PATTERNS.some((p) => p.test(message))) {
    return 'Buyer match service is temporarily unavailable. Use diagnostics to retry.'
  }
  if (message.length > 160) {
    return 'Buyer match could not complete. Check subject property data.'
  }
  return message
}

export function classifyBuyerMatchErrorCode(raw: unknown): string {
  const message = String(raw ?? '')
  if (/cannot find module|vendor-chunks|MODULE_NOT_FOUND/i.test(message)) return 'api_runtime_build_error'
  if (/coordinate/i.test(message)) return 'coordinates_unavailable'
  if (/property_not_found/i.test(message)) return 'property_not_found'
  if (/rpc|buyer_source/i.test(message)) return 'buyer_source_unavailable'
  return 'buyer_match_failed'
}

export function makeStructuredEvent(
  event_type: string,
  message: string,
  extra: Partial<StructuredBuyerMatchEvent> = {},
): StructuredBuyerMatchEvent {
  return {
    id: `${event_type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    event_type,
    state: extra.state ?? event_type,
    message: sanitizeBuyerMatchError(message),
    ...extra,
  }
}

export function dedupeStructuredEvents(events: StructuredBuyerMatchEvent[]): StructuredBuyerMatchEvent[] {
  const seen = new Set<string>()
  const out: StructuredBuyerMatchEvent[] = []
  for (const ev of events) {
    const key = `${ev.event_type}:${ev.error_code ?? ''}:${ev.message}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ev)
  }
  return out
}