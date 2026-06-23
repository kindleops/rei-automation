import type { EntityGraphTab, EntitySearchResult } from '../../domain/entity-graph/entity-graph.types'

export type TableColumn = { key: string; label: string; sortable?: boolean }

export const TABLE_COLUMNS: Record<EntityGraphTab, TableColumn[]> = {
  properties: [
    { key: 'title', label: 'Address', sortable: true },
    { key: 'location', label: 'City / State' },
    { key: 'market', label: 'Canonical Market', sortable: true },
    { key: 'assetType', label: 'Asset Type' },
    { key: 'units', label: 'Units', sortable: true },
    { key: 'value', label: 'Value', sortable: true },
    { key: 'equity', label: 'Equity' },
    { key: 'score', label: 'Acquisition Score', sortable: true },
    { key: 'flags', label: 'Flags' },
    { key: 'contacts', label: 'Reachable Contacts' },
  ],
  master_owners: [
    { key: 'title', label: 'Owner Name', sortable: true },
    { key: 'ownerType', label: 'Owner Type' },
    { key: 'market', label: 'Primary Market' },
    { key: 'portfolio', label: 'Portfolio Count', sortable: true },
    { key: 'value', label: 'Portfolio Value', sortable: true },
    { key: 'tier', label: 'Priority Tier' },
    { key: 'coverage', label: 'Contact Coverage' },
    { key: 'contacts', label: 'Reachable Contacts' },
    { key: 'people', label: 'Linked People' },
  ],
  people: [
    { key: 'title', label: 'Person Name', sortable: true },
    { key: 'signals', label: 'Role / Signals' },
    { key: 'language', label: 'Language' },
    { key: 'occupation', label: 'Occupation' },
    { key: 'owner', label: 'Linked Owner' },
    { key: 'properties', label: 'Linked Properties' },
    { key: 'contacts', label: 'Contact Methods' },
    { key: 'reachable', label: 'Reachable Status' },
  ],
  organizations: [
    { key: 'title', label: 'Entity Name', sortable: true },
    { key: 'entityType', label: 'Entity Type' },
    { key: 'mailing', label: 'Mailing Address' },
    { key: 'properties', label: 'Properties Count' },
    { key: 'people', label: 'Linked People' },
    { key: 'coverage', label: 'Contact Coverage' },
    { key: 'contacts', label: 'Reachable Contacts' },
  ],
  contact_methods: [
    { key: 'title', label: 'Contact', sortable: true },
    { key: 'type', label: 'Type' },
    { key: 'owner', label: 'Linked Person / Owner' },
    { key: 'status', label: 'Status' },
    { key: 'reachable', label: 'Reachability' },
  ],
  markets: [
    { key: 'title', label: 'Canonical Market', sortable: true },
    { key: 'state', label: 'State / Region' },
    { key: 'properties', label: 'Properties', sortable: true },
    { key: 'owners', label: 'Master Owners' },
    { key: 'people', label: 'People' },
    { key: 'contacts', label: 'Reachable Contacts' },
    { key: 'score', label: 'Avg Acquisition Score' },
  ],
  zips: [
    { key: 'title', label: 'ZIP', sortable: true },
    { key: 'market', label: 'Canonical Market' },
    { key: 'properties', label: 'Properties', sortable: true },
    { key: 'owners', label: 'Master Owners' },
    { key: 'people', label: 'People' },
    { key: 'contacts', label: 'Reachable Contacts' },
    { key: 'coverage', label: 'Contact Coverage' },
    { key: 'score', label: 'Avg Acquisition Score' },
  ],
}

export function formatCell(value?: number | string | null): string {
  if (value === undefined || value === null || value === '') return '—'
  if (typeof value === 'number') {
    if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`
    if (value >= 10_000) return value.toLocaleString()
    return String(Math.round(value * 10) / 10)
  }
  return value
}

export function formatCurrency(value?: number | null): string {
  if (value === undefined || value === null) return '—'
  return `$${Math.round(value).toLocaleString()}`
}

export function contactCoverageLabel(result: EntitySearchResult): string {
  const coverage = result.linkedCounts.contactCoverage
  if (coverage === undefined || coverage === null) return '—'
  const clamped = Math.min(100, Math.round(Number(coverage)))
  if (!Number.isFinite(clamped)) return '—'
  return `${clamped}%`
}

export function formatMetricLabel(key: string): string {
  const labels: Record<string, string> = {
    acquisition: 'Acquisition Score',
    motivation: 'Motivation',
    equityPercent: 'Equity',
    equity: 'Equity',
    propertyCount: 'Portfolio',
    totalValue: 'Portfolio Value',
    totalEquity: 'Portfolio Equity',
  }
  return labels[key] || key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()).trim()
}

export function formatMetricValue(key: string, value: unknown): string {
  if (value === undefined || value === null || value === '') return '—'
  if (key === 'equityPercent' || key === 'equity') {
    const num = Number(value)
    return Number.isFinite(num) ? `${Math.round(num)}%` : String(value)
  }
  if (key === 'propertyCount') {
    const count = Number(value)
    if (!Number.isFinite(count)) return '—'
    return `${count} ${count === 1 ? 'property' : 'properties'}`
  }
  if (typeof value === 'number') {
    if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`
    if (value >= 10_000) return value.toLocaleString()
    return String(Math.round(value * 10) / 10)
  }
  return String(value)
}

export function pluralCount(count: number | undefined | null, singular: string, plural?: string): string {
  if (count === undefined || count === null) return '—'
  const label = count === 1 ? singular : (plural ?? `${singular}s`)
  return `${count.toLocaleString()} ${label}`
}

export function renderTableRowCells(tab: EntityGraphTab, result: EntitySearchResult): string[] {
  const d = result.details ?? {}
  switch (tab) {
    case 'properties':
      return [
        result.title,
        [d.city, d.state].filter(Boolean).join(', ') || result.subtitle || '—',
        d.marketLabel ?? result.badges[0] ?? '—',
        d.assetType ?? '—',
        formatCell(d.units),
        formatCurrency(d.value),
        d.equity !== undefined ? `${formatCell(d.equity)}%` : '—',
        formatCell(d.acquisitionScore ?? result.score),
        d.flagCount ? String(d.flagCount) : (d.flags ? '•' : '—'),
        formatCell(result.linkedCounts.reachableContacts ?? result.linkedCounts.contacts),
      ]
    case 'master_owners':
      return [
        result.title,
        d.ownerType ?? result.badges[0] ?? '—',
        d.marketLabel ?? '—',
        formatCell(result.linkedCounts.properties),
        formatCurrency(d.portfolioValue),
        d.priorityTier ?? result.badges[1] ?? '—',
        contactCoverageLabel(result),
        formatCell(result.linkedCounts.reachableContacts ?? result.linkedCounts.contacts),
        formatCell(result.linkedCounts.prospects),
      ]
    case 'people':
      return [
        result.title,
        result.badges.slice(0, 2).join(' · ') || '—',
        d.language ?? result.badges.find((b) => b.length <= 3) ?? '—',
        d.occupation ?? '—',
        d.ownerName ?? '—',
        formatCell(result.linkedCounts.properties),
        formatCell(result.linkedCounts.contacts),
        result.linkedCounts.contacts ? 'Reachable' : '—',
      ]
    case 'organizations':
      return [
        result.title,
        d.entityType ?? result.subtitle ?? '—',
        d.mailingAddress ?? '—',
        formatCell(result.linkedCounts.properties),
        formatCell(result.linkedCounts.prospects),
        contactCoverageLabel(result),
        formatCell(result.linkedCounts.reachableContacts ?? result.linkedCounts.contacts),
      ]
    case 'contact_methods':
      return [
        result.title,
        d.contactType ?? (result.entityType === 'phone' ? 'Phone' : 'Email'),
        result.subtitle ?? '—',
        [d.phoneType, d.eligibility].filter(Boolean).join(' · ') || '—',
        d.reachability ?? (d.wrongNumber ? 'Unreachable' : d.eligibility === 'Eligible' ? 'Reachable' : '—'),
      ]
    case 'markets':
      return [
        result.title,
        d.state ?? '—',
        formatCell(result.linkedCounts.properties),
        formatCell(result.linkedCounts.masterOwners),
        formatCell(result.linkedCounts.prospects),
        formatCell(result.linkedCounts.reachableContacts ?? result.linkedCounts.contacts),
        formatCell(result.linkedCounts.avgAcquisitionScore ?? result.score),
      ]
    case 'zips':
      return [
        result.title,
        d.marketLabel ?? result.subtitle?.replace(/^Market:\s*/, '') ?? '—',
        formatCell(result.linkedCounts.properties),
        formatCell(result.linkedCounts.masterOwners),
        formatCell(result.linkedCounts.prospects),
        formatCell(result.linkedCounts.reachableContacts ?? result.linkedCounts.contacts),
        contactCoverageLabel(result),
        formatCell(result.linkedCounts.avgAcquisitionScore ?? result.score),
      ]
    default:
      return [result.title, result.subtitle ?? '—', result.badges.join(', ') || '—']
  }
}

export const TAB_OPTIONS: Array<{ key: EntityGraphTab; label: string; countKey: string }> = [
  { key: 'properties', label: 'Properties', countKey: 'properties' },
  { key: 'master_owners', label: 'Master Owners', countKey: 'master_owners' },
  { key: 'people', label: 'People', countKey: 'people' },
  { key: 'organizations', label: 'Ownership Entities', countKey: 'organizations' },
  { key: 'contact_methods', label: 'Contact Methods', countKey: 'contact_methods' },
  { key: 'markets', label: 'Markets', countKey: 'markets' },
  { key: 'zips', label: 'Zips', countKey: 'zips' },
]