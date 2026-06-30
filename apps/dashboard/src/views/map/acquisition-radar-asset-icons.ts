/**
 * Canonical asset-type icon hues for Acquisition Radar markers.
 * Ring = operational state; icon = asset class; halo = priority/activity.
 */

import { PIN_ICON } from './pin-icons'

export type AcquisitionAssetFamily =
  | 'sfr'
  | 'mf24'
  | 'mf5plus'
  | 'retail'
  | 'office'
  | 'industrial'
  | 'storage'
  | 'land'
  | 'commercial'
  | 'unknown'

export const ASSET_TYPE_ICON_COLORS: Record<AcquisitionAssetFamily, string> = {
  sfr: '#66B8FF',
  mf24: '#8D82FF',
  mf5plus: '#D46CFF',
  retail: '#FFB84D',
  office: '#64D8FF',
  industrial: '#FF795B',
  storage: '#38D2B3',
  land: '#7EDB63',
  commercial: '#C2CAD7',
  unknown: '#9AA6B8',
}

export const resolveAcquisitionAssetFamily = (assetType: string | null | undefined): AcquisitionAssetFamily => {
  const raw = String(assetType ?? '').trim().toLowerCase()
  if (!raw) return 'unknown'
  if (['sfr', 'condo', 'townhome', 'single_family', 'single-family'].includes(raw)) return 'sfr'
  if (['multifamily_small', 'multifamily_2_4', 'duplex', 'triplex', 'quadplex', 'multi'].includes(raw)) return 'mf24'
  if (['multifamily_large', 'multifamily_5_plus', 'apt', 'apartment', 'mhp'].includes(raw)) return 'mf5plus'
  if (['retail', 'shopping_plaza'].includes(raw)) return 'retail'
  if (['office'].includes(raw)) return 'office'
  if (['industrial', 'warehouse'].includes(raw)) return 'industrial'
  if (['storage'].includes(raw)) return 'storage'
  if (['land'].includes(raw)) return 'land'
  if (['commercial', 'mixed_use', 'hotel', 'comm'].includes(raw)) return 'commercial'
  return 'unknown'
}

export const assetFamilyToPinIcon = (family: AcquisitionAssetFamily): string => {
  switch (family) {
    case 'sfr': return PIN_ICON.sfr
    case 'mf24': return PIN_ICON.multi
    case 'mf5plus': return PIN_ICON.apt
    case 'retail': return PIN_ICON.retail
    case 'office': return PIN_ICON.office
    case 'industrial': return PIN_ICON.industrial
    case 'storage': return PIN_ICON.storage
    case 'land': return PIN_ICON.land
    case 'commercial': return PIN_ICON.comm
    default: return PIN_ICON.default
  }
}

export const buildAssetIconImageExpr = (): unknown[] => [
  'match', ['get', 'asset_family'],
  'sfr', PIN_ICON.sfr,
  'mf24', PIN_ICON.multi,
  'mf5plus', PIN_ICON.apt,
  'retail', PIN_ICON.retail,
  'office', PIN_ICON.office,
  'industrial', PIN_ICON.industrial,
  'storage', PIN_ICON.storage,
  'land', PIN_ICON.land,
  'commercial', PIN_ICON.comm,
  PIN_ICON.default,
]

export const buildAssetIconColorExpr = (): unknown[] => [
  'match', ['get', 'asset_family'],
  'sfr', ASSET_TYPE_ICON_COLORS.sfr,
  'mf24', ASSET_TYPE_ICON_COLORS.mf24,
  'mf5plus', ASSET_TYPE_ICON_COLORS.mf5plus,
  'retail', ASSET_TYPE_ICON_COLORS.retail,
  'office', ASSET_TYPE_ICON_COLORS.office,
  'industrial', ASSET_TYPE_ICON_COLORS.industrial,
  'storage', ASSET_TYPE_ICON_COLORS.storage,
  'land', ASSET_TYPE_ICON_COLORS.land,
  'commercial', ASSET_TYPE_ICON_COLORS.commercial,
  ASSET_TYPE_ICON_COLORS.unknown,
]