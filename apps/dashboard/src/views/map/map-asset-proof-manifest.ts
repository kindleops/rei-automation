import { MARKER_KEY_TO_PIN_ICON, type CanonicalMapMarkerKey } from './canonical-map-asset-marker'

/**
 * Production-backed sample properties for asset icon proof matrix.
 * Office: no mappable office-classified properties in canonical universe (0 count).
 */
export type MapAssetProofEntry = {
  markerKey: CanonicalMapMarkerKey
  propertyId: string
  propertyType: string
  sprite: string
  latitude: number
  longitude: number
  screenshotSlug: string
  productionBacked: boolean
  note?: string
}

export const MAP_ASSET_PROOF_MANIFEST: MapAssetProofEntry[] = [
  {
    markerKey: 'single_family',
    propertyId: '2100277008',
    propertyType: 'SFR',
    sprite: MARKER_KEY_TO_PIN_ICON.single_family,
    latitude: 35.645544,
    longitude: -77.966748,
    screenshotSlug: 'single-family',
    productionBacked: true,
  },
  {
    markerKey: 'multifamily_2_4',
    propertyId: '2100283703',
    propertyType: 'Multifamily 2-4',
    sprite: MARKER_KEY_TO_PIN_ICON.multifamily_2_4,
    latitude: 35.717843,
    longitude: -77.924486,
    screenshotSlug: 'multifamily-2-4',
    productionBacked: true,
  },
  {
    markerKey: 'multifamily_5_plus',
    propertyId: '2100293600',
    propertyType: 'Multifamily 5+',
    sprite: MARKER_KEY_TO_PIN_ICON.multifamily_5_plus,
    latitude: 35.72474465,
    longitude: -77.90966803,
    screenshotSlug: 'multifamily-5-plus',
    productionBacked: true,
  },
  {
    markerKey: 'retail_strip',
    propertyId: '2127683323',
    propertyType: 'Strip Malls',
    sprite: MARKER_KEY_TO_PIN_ICON.retail_strip,
    latitude: 32.847717,
    longitude: -96.59602,
    screenshotSlug: 'retail-strip',
    productionBacked: true,
  },
  {
    markerKey: 'storage',
    propertyId: '2112039405',
    propertyType: 'Storage Units',
    sprite: MARKER_KEY_TO_PIN_ICON.storage,
    latitude: 40.438196,
    longitude: -79.878089,
    screenshotSlug: 'storage',
    productionBacked: true,
  },
  {
    markerKey: 'office',
    propertyId: '',
    propertyType: 'Office',
    sprite: MARKER_KEY_TO_PIN_ICON.office,
    latitude: 40.758,
    longitude: -73.9855,
    screenshotSlug: 'office',
    productionBacked: false,
    note: 'Zero office-classified properties in canonical universe; sprite verified via registration matrix only',
  },
  {
    markerKey: 'industrial',
    propertyId: '2102064213',
    propertyType: 'Industrial',
    sprite: MARKER_KEY_TO_PIN_ICON.industrial,
    latitude: 41.496593789,
    longitude: -81.64661461,
    screenshotSlug: 'industrial',
    productionBacked: true,
  },
  {
    markerKey: 'land',
    propertyId: '2101975330',
    propertyType: 'Land',
    sprite: MARKER_KEY_TO_PIN_ICON.land,
    latitude: 41.467462,
    longitude: -81.686722,
    screenshotSlug: 'land',
    productionBacked: true,
  },
  {
    markerKey: 'commercial_other',
    propertyId: '2101958897',
    propertyType: 'Commercial',
    sprite: MARKER_KEY_TO_PIN_ICON.commercial_other,
    latitude: 41.479758282,
    longitude: -81.74933932,
    screenshotSlug: 'commercial-other',
    productionBacked: true,
  },
  {
    markerKey: 'unknown',
    propertyId: '2116845426',
    propertyType: 'Other',
    sprite: MARKER_KEY_TO_PIN_ICON.unknown,
    latitude: 39.99099289,
    longitude: -75.11380039,
    screenshotSlug: 'unknown',
    productionBacked: true,
  },
]

export const CANONICAL_BASELINE = {
  totalMappable: 124_046,
  markets: 494,
  marketCounts: {
    'Miami, FL': 11_756,
    'Dallas, TX': 5_682,
    'Los Angeles, CA': 4_848,
    'Memphis, TN': 3_360,
  },
} as const