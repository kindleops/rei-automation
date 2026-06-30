/**
 * Shared MapLibre expressions for property-type pin icons and asset-class colors.
 */

import type { ExpressionSpecification } from 'maplibre-gl'
import { ASSET_TYPE_ICON_COLORS } from './acquisition-radar-asset-icons'
import { PIN_ICON } from './pin-icons'

export const PIN_ICON_IMAGE_BY_SLUG_EXPR: ExpressionSpecification = [
  'match', ['get', 'propTypeSlug'],
  'sfr', PIN_ICON.sfr,
  'multi', PIN_ICON.multi,
  'apt', PIN_ICON.apt,
  'land', PIN_ICON.land,
  'comm', PIN_ICON.comm,
  'storage', PIN_ICON.storage,
  'retail', PIN_ICON.retail,
  'office', PIN_ICON.office,
  'industrial', PIN_ICON.industrial,
  'hotel', PIN_ICON.hotel,
  'mhp', PIN_ICON.mhp,
  PIN_ICON.default,
]

export const PIN_ICON_COLOR_BY_SLUG_EXPR: ExpressionSpecification = [
  'match', ['get', 'propTypeSlug'],
  'sfr', ASSET_TYPE_ICON_COLORS.sfr,
  'multi', ASSET_TYPE_ICON_COLORS.mf24,
  'apt', ASSET_TYPE_ICON_COLORS.mf5plus,
  'land', ASSET_TYPE_ICON_COLORS.land,
  'comm', ASSET_TYPE_ICON_COLORS.commercial,
  'storage', ASSET_TYPE_ICON_COLORS.storage,
  'retail', ASSET_TYPE_ICON_COLORS.retail,
  'office', ASSET_TYPE_ICON_COLORS.office,
  'industrial', ASSET_TYPE_ICON_COLORS.industrial,
  'hotel', ASSET_TYPE_ICON_COLORS.commercial,
  'mhp', ASSET_TYPE_ICON_COLORS.mf5plus,
  ASSET_TYPE_ICON_COLORS.unknown,
]

export const PIN_ICON_COLOR_COALESCED_EXPR: ExpressionSpecification = [
  'coalesce',
  ['get', 'icon_color'],
  PIN_ICON_COLOR_BY_SLUG_EXPR,
]

export const PIN_ICON_SCALE_TOUCH_EXPR: ExpressionSpecification = [
  'interpolate', ['linear'], ['zoom'],
  8, 0.34,
  11, 0.44,
  13, 0.52,
  16, 0.62,
]