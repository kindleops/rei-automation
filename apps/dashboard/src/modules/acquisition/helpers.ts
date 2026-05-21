// Utility functions shared across acquisition apps

export const currency = (value: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value)

export const parseNumber = (value: string) => {
  const normalized = Number(value.replace(/[^0-9.-]/g, ''))
  return Number.isFinite(normalized) ? normalized : 0
}

export const sparkline = (seed: string) => {
  const base = seed
    .split('')
    .reduce((sum, char) => sum + char.charCodeAt(0), 0)

  return Array.from({ length: 8 }, (_, index) => {
    const wave = ((base + index * 17) % 34) + 14
    return Math.min(100, Math.max(16, wave * 2))
  })
}

export const filterByMarket = <T extends { market?: string; marketName?: string }>(
  rows: T[],
  selectedMarket: string,
) => {
  if (selectedMarket === 'All Markets') return rows
  return rows.filter((row) => {
    const market = row.market ?? row.marketName ?? ''
    return market.toLowerCase() === selectedMarket.toLowerCase()
  })
}

export const chipTypeClass = (type: string) => {
  if (type === 'owner') return 'is-owner'
  if (type === 'property') return 'is-property'
  if (type === 'prospect') return 'is-prospect'
  if (type === 'phone' || type === 'email') return 'is-contact'
  if (type === 'offer' || type === 'contract') return 'is-offer'
  if (type === 'queue_item') return 'is-queue'
  return 'is-message'
}

export const kpiToneClass = (tone?: string) => {
  if (tone === 'good') return 'is-good'
  if (tone === 'warn') return 'is-warn'
  if (tone === 'critical') return 'is-critical'
  return 'is-neutral'
}

export const statusClass = (value: string) => {
  const normalized = value.toLowerCase()
  if (normalized.includes('critical') || normalized.includes('failed') || normalized.includes('blocked')) {
    return 'is-critical'
  }
  if (normalized.includes('watch') || normalized.includes('pending') || normalized.includes('review')) {
    return 'is-warn'
  }
  if (normalized.includes('healthy') || normalized.includes('ready') || normalized.includes('active')) {
    return 'is-good'
  }
  return 'is-neutral'
}

export const severityClass = (severity: 'info' | 'warning' | 'critical') => {
  if (severity === 'critical') return 'is-critical'
  if (severity === 'warning') return 'is-warning'
  return 'is-info'
}
