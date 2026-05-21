import type { PropertyFilterClause } from '../../lib/data/propertyData'

export const QUICK_FILTERS = [
  'High Equity',
  'Free & Clear',
  'Tax Delinquent',
  'Active Lien',
  'Absentee Owner',
  'Corporate Owner',
  'Out of State Owner',
  'Multifamily',
  'Off Market',
  'Structural Rehab',
  'Long Term Owner',
  'Senior Owner',
  'Tired Landlord',
  'Heavily Dated',
  'Cash Offer Candidate',
  'Highlighted',
] as const

export type QuickFilterKey = (typeof QUICK_FILTERS)[number]

export type PropertyWorkspaceView =
  | 'command'
  | 'grid'
  | 'table'
  | 'map'
  | 'distress'
  | 'equity'
  | 'rehab'
  | 'multifamily'
  | 'raw'

export interface SavedPropertyView {
  id: string
  label: string
  filters: PropertyFilterClause[]
  quickFilters: string[]
}

export const VIEW_LABELS: Record<PropertyWorkspaceView, string> = {
  command: 'Command View',
  grid: 'Grid View',
  table: 'Table View',
  map: 'Map View',
  distress: 'Distress View',
  equity: 'Equity View',
  rehab: 'Rehab View',
  multifamily: 'Multifamily View',
  raw: 'Raw View',
}

export const defaultSavedViews = (): SavedPropertyView[] => [
  {
    id: 'sv-distress',
    label: 'Distress Sweep',
    quickFilters: ['Tax Delinquent', 'Active Lien'],
    filters: [],
  },
  {
    id: 'sv-equity',
    label: 'Equity Harvest',
    quickFilters: ['High Equity', 'Free & Clear'],
    filters: [],
  },
]
