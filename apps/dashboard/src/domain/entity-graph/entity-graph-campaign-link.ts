/**
 * CAMPAIGN → ENTITY GRAPH (owner, 2026-10-10: "from a campaign, pull up that
 * exact list of campaign targets in the entity graph and see every column").
 *
 * The campaign scope is ONE chip in the Entity Graph filter AST:
 *   { field_key: 'campaign.membership', operator: 'is_any_of', value: [<campaign uuid>] }
 * executed server-side and exactly (apps/api … entity-graph-campaign-scope.js):
 * a built campaign = its campaign_targets ∪ whatever was queued or sent; a
 * draft = its pinned ids / saved property filters.
 *
 * The link is the desk's own URL state (desk-state.ts): egs = scope, ff = the
 * filter list, egv = the view (overview | grid | graph).
 */
import type { EntityGraphFieldFilter } from './entity-graph-field-filters'

export const CAMPAIGN_MEMBERSHIP_KEY = 'campaign.membership'
export type CampaignScopeTab = 'properties' | 'master_owners' | 'people'
export type EntityGraphLinkView = 'overview' | 'grid' | 'graph'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isCampaignId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v.trim())

export function campaignScopeFilter(campaignId: string): EntityGraphFieldFilter {
  return { field_key: CAMPAIGN_MEMBERSHIP_KEY, operator: 'is_any_of', value: [campaignId.trim().toLowerCase()] }
}

export const isCampaignScopeFilter = (f: EntityGraphFieldFilter | null | undefined): boolean => f?.field_key === CAMPAIGN_MEMBERSHIP_KEY

/** The campaign ids a filter list is scoped to (in order, de-duplicated). */
export function campaignIdsInFilters(filters: readonly EntityGraphFieldFilter[] | null | undefined): string[] {
  const out: string[] = []
  for (const f of filters ?? []) {
    if (!isCampaignScopeFilter(f)) continue
    const values = Array.isArray(f.value) ? f.value : [f.value]
    for (const v of values) {
      if (!isCampaignId(v)) continue
      const id = v.trim().toLowerCase()
      if (!out.includes(id)) out.push(id)
    }
  }
  return out
}

/**
 * `/entity-graph?egs=…&ff=…&egv=…` — Entity Graph opened on exactly this
 * campaign's targets (Overview by default; Grid shows every column).
 */
export function entityGraphCampaignPath(campaignId: string, opts: { scope?: CampaignScopeTab; view?: EntityGraphLinkView } = {}): string {
  if (!isCampaignId(campaignId)) throw new Error('entityGraphCampaignPath: not a campaign id')
  const params = new URLSearchParams()
  const scope = opts.scope ?? 'properties'
  if (scope !== 'properties') params.set('egs', scope)
  else params.set('egs', 'properties')
  params.set('ff', JSON.stringify([campaignScopeFilter(campaignId)]))
  params.set('egv', opts.view ?? 'overview')
  return `/entity-graph?${params.toString()}`
}
