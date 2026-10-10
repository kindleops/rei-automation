/**
 * CAMPAIGN → ENTITY GRAPH door (owner 2026-10-10: "from a campaign, pull up that
 * exact list of campaign targets in the entity graph and see every column").
 * Same mechanism as every other Campaign Command door (pushRoutePath): the
 * path is the desk's own URL state with the campaign scope chip, Overview first.
 */
import { pushRoutePath } from '../../app/router'
import { entityGraphCampaignPath, isCampaignId } from '../../domain/entity-graph/entity-graph-campaign-link'

export const ENTITY_GRAPH_DOOR_LABEL = 'View targets in Entity Graph'
export const ENTITY_GRAPH_DOOR_HINT = 'Opens Entity Graph on exactly this campaign’s targets — every column, Overview first'
export const ENTITY_GRAPH_DOOR_NO_ID = 'This campaign has no id yet — save it first'

/** The Entity Graph path for this campaign, or null when it has no campaign id. */
export function campaignEntityGraphPath(campaignId: string | null | undefined): string | null {
  return isCampaignId(campaignId) ? entityGraphCampaignPath(campaignId) : null
}

export function openCampaignInEntityGraph(campaignId: string | null | undefined, navigate: (path: string) => void = pushRoutePath): boolean {
  const path = campaignEntityGraphPath(campaignId)
  if (!path) return false
  navigate(path)
  return true
}
