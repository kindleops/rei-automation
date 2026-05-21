export type PropertyCategory = 'sfh' | 'multifamily' | 'hotel' | 'storage' | 'retail' | 'office' | 'industrial' | 'land' | 'other'

const get = (obj: any, path: string): any => {
  return path.split('.').reduce((acc, part) => acc && acc[part], obj)
}

const normalizeText = (text: any): string => {
  if (typeof text !== 'string') return ''
  return text.trim()
}

export const detectPropertyCategory = (thread: any): PropertyCategory => {
  const pt = normalizeText(get(thread, 'propertyType') || get(thread, 'property_type')).toLowerCase()
  const units = Number(get(thread, 'unitCount') || get(thread, 'unit_count') || get(thread, 'units')) || 0
  if (units >= 5 || pt.includes('multifamily') || pt.includes('apartment')) return 'multifamily'
  if (pt.includes('hotel') || pt.includes('motel') || pt.includes('lodging') || pt.includes('hospitality')) return 'hotel'
  if (pt.includes('storage') || pt.includes('self-storage') || pt.includes('warehouse') && !pt.includes('industrial')) return 'storage'
  if (pt.includes('retail') || pt.includes('plaza') || pt.includes('strip') || pt.includes('shopping')) return 'retail'
  if (pt.includes('office') || pt.includes('medical office') || pt.includes('professional')) return 'office'
  if (pt.includes('industrial') || pt.includes('warehouse') || pt.includes('manufacturing') || pt.includes('flex')) return 'industrial'
  if (pt.includes('land') || pt.includes('lot') || pt.includes('acre') || pt.includes('vacant')) return 'land'
  if (units <= 4 && (pt.includes('single') || pt.includes('sfh') || pt.includes('residential') || pt === '')) return 'sfh'
  return 'other'
}
