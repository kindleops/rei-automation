/** Verified production baseline — reconciles with public.properties. */
export const CANONICAL_PROPERTY_BASELINE = 124_046

/** Canonical quick-filter preset keys in display order. */
export const CANONICAL_QUICK_FILTER_KEYS = [
  'all_properties',
  'uncontacted',
  'contacted',
  'high_equity',
  'sms_eligible',
  'has_phone',
  'absentee_owner',
  'out_of_state',
  'tax_delinquent',
  'active_lien',
  'vacant',
  'multifamily_2_4',
  'multifamily_5_plus',
  'portfolio_owner',
] as const

export const DESKTOP_WORKSPACE_MIN_WIDTH = 1180
export const DESKTOP_WORKSPACE_MAX_WIDTH = 1440