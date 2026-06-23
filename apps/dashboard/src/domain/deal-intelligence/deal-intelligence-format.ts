import { formatCurrency, formatDate, formatInteger, formatPhone } from '../../shared/formatters'
import { humanizeEnum } from './deal-intelligence-humanize'

export const fmtDiMoney = (v: number | null | undefined) => {
  if (v == null || !Number.isFinite(v)) return null
  if (v === 0) return '$0'
  return formatCurrency(v)
}

export const fmtDiPct = (v: number | null | undefined) => {
  if (v == null || !Number.isFinite(v)) return null
  const normalized = Math.abs(v) <= 1 ? v * 100 : v
  return `${Math.round(normalized)}%`
}

export const fmtDiScore = (v: number | null | undefined) => {
  if (v == null || !Number.isFinite(v)) return null
  return String(Math.round(v * 10) / 10)
}

export const fmtDiSqft = (v: number | null | undefined) => {
  if (v == null || !Number.isFinite(v) || v <= 0) return null
  return `${formatInteger(v)} sq ft`
}

export const fmtDiUnits = (v: number | null | undefined, isSfr = false) => {
  if (isSfr || v == null || v <= 1) return null
  return `${v} units`
}

export const fmtDiDate = (v: string | null | undefined) => {
  if (!v) return null
  const text = String(v).trim()
  if (!text) return null
  return formatDate(text.includes('T') ? text : `${text}T12:00:00`)
}

export const fmtDiPhone = (v: string | null | undefined) => {
  if (!v) return null
  const formatted = formatPhone(v)
  return formatted === 'Unknown' ? null : formatted
}

export const fmtDiBool = (v: boolean | null | undefined) => {
  if (v === true) return 'Yes'
  if (v === false) return 'No'
  return null
}

export const fmtDiText = (v: unknown) => {
  if (v == null || v === '') return null
  const text = String(v).trim()
  if (!text || /^unknown$/i.test(text) || /^n\/a$/i.test(text)) return null
  return humanizeEnum(text) || text
}

export const fmtDiFieldValue = (key: string, val: unknown, isSfr = false) => {
  if (val == null || val === '') return null
  if (Array.isArray(val)) {
    const items = val.map(String).filter(Boolean)
    return items.length ? items.join(', ') : null
  }
  if (typeof val === 'boolean') return fmtDiBool(val)
  if (typeof val === 'number') {
    if (key === 'units' || key.includes('unit')) return fmtDiUnits(val, isSfr)
    if (key.includes('square_feet') || key.includes('sqft') || key.includes('garage')) return fmtDiSqft(val)
    if (key.includes('percent') || key.includes('percentage') || key.includes('equity_percentage')) return fmtDiPct(val)
    if (key.includes('value') || key.includes('price') || key.includes('balance') || key.includes('payment') || key.includes('repair') || key.includes('tax') || key.includes('fee') || key.includes('offer')) {
      return fmtDiMoney(val)
    }
    return formatInteger(val)
  }
  return fmtDiText(val)
}

const PHONE_TYPE_LABELS: Record<string, string> = {
  W: 'Wireless',
  L: 'Landline',
  V: 'VoIP',
  M: 'Mobile',
  P: 'Pager',
}

export const fmtPhoneType = (code: string | null | undefined) => {
  if (!code) return null
  const key = String(code).trim().toUpperCase()
  return PHONE_TYPE_LABELS[key] || humanizeEnum(key)
}

export const scoreTone = (score: number | null | undefined) => {
  const n = Number(score) || 0
  if (n >= 80) return 'strong'
  if (n >= 65) return 'active'
  if (n >= 45) return 'balanced'
  if (n >= 25) return 'thin'
  return 'muted'
}