export function isUnavailableValue(value: number | null | undefined): boolean {
  return value === null || value === undefined || !Number.isFinite(value) || value === 0
}

export function fmtCurrency(value: number | null | undefined): string {
  if (isUnavailableValue(value)) return '—'
  const v = value as number
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
  if (v >= 10_000) return `$${Math.round(v / 1000)}K`
  return `$${Math.round(v).toLocaleString()}`
}

export function fmtCurrencyLabel(
  value: number | null | undefined,
  unavailable = 'Unavailable',
): string {
  if (isUnavailableValue(value)) return unavailable
  return fmtCurrency(value)
}

export function fmtRange(low: number | null, high: number | null, unavailable = 'Unavailable'): string {
  if (isUnavailableValue(low) && isUnavailableValue(high)) return unavailable
  if (low != null && high != null && !isUnavailableValue(low) && !isUnavailableValue(high)) {
    return `${fmtCurrency(low)}–${fmtCurrency(high)}`
  }
  const single = !isUnavailableValue(low) ? low : high
  return fmtCurrency(single)
}

export function fmtPercentScore(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return String(Math.round(value))
}

export function fmtStrategy(value: string | null | undefined): string {
  if (!value?.trim()) return 'No authorized strategy'
  return value
}

export function fmtExecutionState(value: string | null | undefined): string {
  if (!value?.trim()) return 'Research only'
  return value.replace(/_/g, ' ')
}

export function fmtMarketValue(value: number | null | undefined, source?: string): string {
  if (!isUnavailableValue(value)) return fmtCurrency(value)
  if (source === 'UNAVAILABLE') return 'Canonical V3 value unavailable'
  return 'No canonical value'
}

export function fmtBuyerExit(
  low: number | null | undefined,
  base: number | null | undefined,
  high: number | null | undefined,
): string {
  if (isUnavailableValue(low) && isUnavailableValue(base) && isUnavailableValue(high)) {
    return 'Not yet underwritten'
  }
  return fmtRange(low ?? null, high ?? null, 'Not yet underwritten')
}

export function humanFallback(level: string): string {
  const map: Record<string, string> = {
    EXACT_ZIP: 'Exact ZIP',
    RADIUS: 'Radius',
    MARKET: 'Market-level buyer evidence',
    COUNTY: 'County',
    STATE: 'State-level buyer evidence',
    NONE: 'No local evidence',
  }
  return map[level] ?? level
}

export function humanDataState(state: string): string {
  const map: Record<string, string> = {
    READY: 'Verified local buyer evidence',
    PARTIAL: 'Partial buyer evidence — refresh in progress',
    NO_LOCAL_DATA: 'Local buyer evidence is unavailable',
    SUBJECT_COORDINATES_REQUIRED: 'Subject coordinates required for map evidence',
    REFRESHING: 'Refreshing buyer market',
    ERROR: 'Buyer market unavailable',
  }
  return map[state] ?? state
}

export function humanContactReadiness(state: string): string {
  const map: Record<string, string> = {
    READY: 'Contact Ready',
    PARTIAL: 'Partial Contact',
    ENRICHMENT_REQUIRED: 'Enrichment Required',
    RESTRICTED: 'Restricted',
    UNKNOWN: 'Unknown',
  }
  return map[state] ?? state
}

export function fmtDate(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function fmtMiles(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return `${value.toFixed(1)} mi`
}