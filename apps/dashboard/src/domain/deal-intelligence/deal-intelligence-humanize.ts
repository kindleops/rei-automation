const ENUM_REPLACEMENTS: Record<string, string> = {
  CASH_ASSIGNMENT: 'Cash Assignment',
  SELLER_FINANCE: 'Seller Finance',
  SUBJECT_TO: 'Subject-To',
  LEASE_OPTION: 'Lease Option',
  NOVATION: 'Novation',
  LANDLORD_FATIGUE_AND_WEALTH_PRESERVATION: 'Landlord Fatigue + Wealth Preservation',
}

export function humanizeEnum(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = String(value).trim()
  if (!trimmed) return null
  if (ENUM_REPLACEMENTS[trimmed]) return ENUM_REPLACEMENTS[trimmed]
  if (ENUM_REPLACEMENTS[trimmed.toUpperCase()]) return ENUM_REPLACEMENTS[trimmed.toUpperCase()]

  return trimmed
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((word) => {
      const lower = word.toLowerCase()
      if (lower === 'to' && trimmed.includes('SUBJECT')) return 'To'
      if (lower === 'ai') return 'AI'
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join(' ')
    .replace(/Subject To/gi, 'Subject-To')
}

export function parseFlagBadges(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  return String(value)
    .split(/[;,|]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function priorityFlags(flags: string[]): string[] {
  const priority = [
    'pre-foreclosure',
    'probate',
    'tax delinquent',
    'active lien',
    'vacant',
    'tired landlord',
    'absentee owner',
    'out-of-state owner',
    'free and clear',
    'high equity',
    'heavily dated',
    'senior owner',
  ]
  const ranked = [...flags].sort((a, b) => {
    const ai = priority.findIndex((p) => a.toLowerCase().includes(p))
    const bi = priority.findIndex((p) => b.toLowerCase().includes(p))
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
  })
  return ranked.length ? ranked : flags
}