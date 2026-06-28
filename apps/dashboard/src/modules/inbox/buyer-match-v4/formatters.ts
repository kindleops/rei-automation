export function fmtCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`
  if (value >= 10_000) return `$${Math.round(value / 1000)}K`
  return `$${Math.round(value).toLocaleString()}`
}

export function fmtRange(low: number | null, high: number | null): string {
  if (low == null && high == null) return '—'
  if (low != null && high != null) return `${fmtCurrency(low)}–${fmtCurrency(high)}`
  return fmtCurrency(low ?? high)
}

export function fmtPercentScore(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return String(Math.round(value))
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