/** Verified production baseline — reconciles with public.properties. */
export const CANONICAL_PROPERTY_BASELINE = 124_046

/** Verified quick-filter preset keys — must match backend VERIFIED_QUICK_PRESET_KEYS. */
export const CANONICAL_QUICK_FILTER_KEYS = [
  'all_properties',
  'multifamily_5_plus',
  'multifamily_2_4',
  'high_equity',
  'sms_eligible',
  'has_phone',
  'portfolio_owner',
] as const

export const DESKTOP_WORKSPACE_MIN_WIDTH = 1180
export const DESKTOP_WORKSPACE_MAX_WIDTH = 1440