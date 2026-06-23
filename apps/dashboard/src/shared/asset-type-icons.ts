import type { IconName } from './icons'

export type CanonicalAssetType =
  | 'Single-Family Residential'
  | 'Multifamily 2–4'
  | 'Multifamily 5+'
  | 'Condominium/Townhome'
  | 'Mobile/Manufactured Home'
  | 'Residential Land'
  | 'Commercial Land'
  | 'Retail / Strip Mall'
  | 'Office'
  | 'Industrial'
  | 'Self-Storage'
  | 'Mixed Use'
  | 'Hospitality'
  | 'Other Commercial'
  | 'Unknown'

export interface AssetTypePresentation {
  canonical: CanonicalAssetType
  icon: IconName
  label: string
}

const CANONICAL_RULES: Array<{ canonical: CanonicalAssetType; icon: IconName; test: RegExp }> = [
  { canonical: 'Single-Family Residential', icon: 'home', test: /single.?family|sfr|residential(?!\s*land)|house|detached/i },
  { canonical: 'Multifamily 2–4', icon: 'layers', test: /multifamily\s*2|duplex|triplex|quadplex|2.?4|two.?four|2unit|3unit|4unit/i },
  { canonical: 'Multifamily 5+', icon: 'layers', test: /multifamily\s*5|5\+|apartment|apt\b|complex|tower/i },
  { canonical: 'Condominium/Townhome', icon: 'grid', test: /condo|townhome|townhouse|rowhouse/i },
  { canonical: 'Mobile/Manufactured Home', icon: 'home', test: /mobile|manufactured|mhp|trailer/i },
  { canonical: 'Residential Land', icon: 'map', test: /residential\s*land|vacant\s*residential|res\s*lot/i },
  { canonical: 'Commercial Land', icon: 'map', test: /commercial\s*land|vacant\s*commercial|comm\s*lot/i },
  { canonical: 'Retail / Strip Mall', icon: 'briefcase', test: /retail|strip\s*mall|shopping|plaza/i },
  { canonical: 'Office', icon: 'briefcase', test: /office/i },
  { canonical: 'Industrial', icon: 'cpu', test: /industrial|warehouse|flex\s*space/i },
  { canonical: 'Self-Storage', icon: 'database', test: /self.?storage|storage\s*unit/i },
  { canonical: 'Mixed Use', icon: 'layout-split', test: /mixed\s*use/i },
  { canonical: 'Hospitality', icon: 'star', test: /hospitality|hotel|motel|lodging/i },
  { canonical: 'Other Commercial', icon: 'briefcase', test: /commercial|comm\b|retail\s*office/i },
]

export function normalizeCanonicalAssetType(raw: string | null | undefined): CanonicalAssetType {
  const v = String(raw ?? '').trim()
  if (!v) return 'Unknown'
  for (const rule of CANONICAL_RULES) {
    if (rule.test.test(v)) return rule.canonical
  }
  if (/land|lot|parcel|vacant/i.test(v)) return 'Residential Land'
  if (/multi|duplex/i.test(v)) return 'Multifamily 2–4'
  return 'Unknown'
}

export function resolveAssetTypeIcon(propertyType: string | null | undefined): AssetTypePresentation {
  const canonical = normalizeCanonicalAssetType(propertyType)
  const rule = CANONICAL_RULES.find(r => r.canonical === canonical)
  return {
    canonical,
    icon: rule?.icon ?? 'home',
    label: canonical,
  }
}