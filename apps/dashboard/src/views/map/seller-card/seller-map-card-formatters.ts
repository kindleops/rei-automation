export const nullIfZeroish = (value: number | null | undefined): number | null => {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  return Math.abs(value) <= 0.000001 ? null : value
}

export const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const cleaned = String(value ?? '').trim().replace(/[^0-9.-]/g, '')
  if (!cleaned) return null
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

export const asBoolean = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') return value
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!normalized) return null
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true
  if (['false', '0', 'no', 'n'].includes(normalized)) return false
  return null
}

export const text = (value: unknown): string => String(value ?? '').trim()

export const titleize = (value: string): string =>
  value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())

export const formatInteger = (value: number | null | undefined): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)
}

export const formatMoney = (value: number | null | undefined): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}M`
  }
  if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1).replace(/\.0$/, '')}K`
  }
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value)
}

export const formatPercent = (value: number | null | undefined): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${Math.round(value)}%`
}

export const formatDecimal = (value: number | null | undefined, digits = 1): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(value)
}

export const formatDate = (value: string | null | undefined): string => {
  if (!value) return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(parsed)
}

export const formatRelativeTime = (value: string | null | undefined): string => {
  if (!value) return ''
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return ''
  const diffMinutes = Math.floor((Date.now() - parsed.getTime()) / 60000)
  if (diffMinutes < 1) return 'just now'
  if (diffMinutes < 60) return `${diffMinutes}m ago`
  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 30) return `${diffDays}d ago`
  return formatDate(value)
}

export const formatRelativeUpper = (value: string | null | undefined): string => {
  const relative = formatRelativeTime(value)
  if (!relative) return ''
  return relative.replace('ago', 'AGO').toUpperCase()
}

export const firstDefined = (record: Record<string, unknown>, keys: string[]): unknown => {
  for (const key of keys) {
    const value = record[key]
    if (value !== undefined && value !== null && text(value) !== '') return value
  }
  return undefined
}

export const parseTagValues = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap((entry) => parseTagValues(entry))
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((entry) => parseTagValues(entry))
  }
  const raw = text(value)
  if (!raw) return []
  if ((raw.startsWith('[') && raw.endsWith(']')) || (raw.startsWith('{') && raw.endsWith('}'))) {
    try {
      return parseTagValues(JSON.parse(raw))
    } catch {
      return raw.split(/[;,|]/).map((entry) => entry.trim()).filter(Boolean)
    }
  }
  return raw.split(/[;,|]/).map((entry) => entry.trim()).filter(Boolean)
}

export const classifyPriorityScore = (
  score: number | null,
  tier: string | null,
): { classification: string | null; barPercent: number } => {
  const normalizedTier = text(tier).toUpperCase()
  if (normalizedTier) {
    if (normalizedTier.includes('TIER_1') || normalizedTier.includes('URGENT')) {
      return { classification: 'Urgent Priority', barPercent: score ?? 92 }
    }
    if (normalizedTier.includes('TIER_2') || normalizedTier.includes('HIGH')) {
      return { classification: 'High Priority', barPercent: score ?? 78 }
    }
    if (normalizedTier.includes('TIER_3') || normalizedTier.includes('NORMAL') || normalizedTier.includes('MODERATE')) {
      return { classification: 'Moderate Priority', barPercent: score ?? 58 }
    }
    if (normalizedTier.includes('TIER_4') || normalizedTier.includes('LOW') || normalizedTier.includes('WATCH')) {
      return { classification: 'Watchlist', barPercent: score ?? 38 }
    }
    return { classification: titleize(normalizedTier.replace(/_/g, ' ')), barPercent: score ?? 50 }
  }
  if (score === null) return { classification: null, barPercent: 0 }
  if (score <= 30) return { classification: 'Low Priority', barPercent: score }
  if (score <= 55) return { classification: 'Watchlist', barPercent: score }
  if (score <= 75) return { classification: 'Moderate Priority', barPercent: score }
  if (score <= 90) return { classification: 'High Priority', barPercent: score }
  return { classification: 'Urgent Priority', barPercent: score }
}