const compactNumberFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

const percentFormatter = new Intl.NumberFormat('en-US', {
  style: 'percent',
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
})

export const formatCompactNumber = (value: number) => compactNumberFormatter.format(value)

export const formatCurrency = (value: number | string | null | undefined) => {
  if (value === null || value === undefined) return 'N/A'
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value))
  if (Number.isNaN(n)) return 'N/A'
  return currencyFormatter.format(n)
}

export const formatMoney = formatCurrency

export const formatPercent = (value: number | string | null | undefined) => {
  if (value === null || value === undefined) return '0%'
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value))
  if (Number.isNaN(n)) return '0%'
  const val = n > 1 ? n / 100 : n
  return percentFormatter.format(val)
}

export const formatDisplayValue = (value: unknown) => {
  if (value === null || value === undefined || value === '') return 'Not enriched'
  return String(value)
}

export const formatInteger = (value: number | string | null | undefined) => {
  if (value === null || value === undefined) return '0'
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value))
  if (Number.isNaN(n)) return '0'
  return Math.round(n).toLocaleString()
}

export const formatBoolean = (value: boolean | null | undefined) => (value === true ? 'Yes' : value === false ? 'No' : 'Unknown')

export const formatScore = (value: number | string | null | undefined) => {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value))
  if (Number.isNaN(n)) return 'N/A'
  return `${Math.round(n)}/100`
}

export const formatDate = (iso: string | null | undefined) => {
  if (!iso) return 'Unknown'
  try {
    return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(new Date(iso))
  } catch {
    return 'Invalid Date'
  }
}

export const formatPhone = (phone: string | null | undefined) => {
  if (!phone) return 'Unknown'
  const cleaned = String(phone).replace(/\D/g, '')
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    const match = cleaned.slice(1).match(/^(\d{3})(\d{3})(\d{4})$/)
    if (match) return `(${match[1]}) ${match[2]}-${match[3]}`
  }
  const match = cleaned.match(/^(\d{3})(\d{3})(\d{4})$/)
  if (match) return `(${match[1]}) ${match[2]}-${match[3]}`
  return phone
}

export const formatDisplayPhone = (raw: string): string => {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
  }
  return raw.startsWith('+') ? raw : `+${digits}`
}

export const formatRelativeTime = (iso: string | null | undefined) => {
  if (!iso) return ''
  const date = new Date(iso)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return date.toLocaleDateString()
}

export const formatCompactTime = (iso: string | null | undefined): string => {
  if (!iso) return ''
  const date = new Date(iso)
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export const formatInboxThreadTimestamp = (iso: string | null | undefined): {
  dayLabel: string
  timeLabel: string
  fullLabel: string
} => {
  if (!iso) {
    return {
      dayLabel: '—',
      timeLabel: '',
      fullLabel: 'Unknown time',
    }
  }

  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return {
      dayLabel: '—',
      timeLabel: '',
      fullLabel: 'Invalid time',
    }
  }

  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const diffDays = Math.round((startOfToday.getTime() - startOfDate.getTime()) / 86400000)

  let dayLabel = date.toLocaleDateString([], { month: 'short', day: 'numeric' })
  if (date.getFullYear() !== now.getFullYear()) {
    dayLabel = date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
  } else if (diffDays === 0) {
    dayLabel = 'Today'
  } else if (diffDays === 1) {
    dayLabel = 'Yesterday'
  }

  const timeLabel = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

  return {
    dayLabel,
    timeLabel,
    fullLabel: `${dayLabel} ${timeLabel}`.trim(),
  }
}

export const formatMessageTime = (iso: string | null | undefined): string => {
  if (!iso) return ''
  const date = new Date(iso)
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export const formatMessageDateTime = (iso: string | null | undefined): string => {
  if (!iso) return ''
  const date = new Date(iso)
  const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' })
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `${dateStr} · ${time}`
}

export const formatClockTime = (date: Date): string => {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

export const formatShortDateTime = (iso: string): string => {
  const date = new Date(iso)
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

export const formatStageLabel = (value: string): string => {
  return value.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
}

export const formatOwnerLabel = (value: string) =>
  value
    .split('-')
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
