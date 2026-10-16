import { useMemo, useSyncExternalStore } from 'react'
import { useAgentContextSnapshot } from '../../agent/context/agent-context'
import { PROPERTY_LOCATOR_EVENT, readPropertyLocator } from '../../../domain/locator/property-locator'
import { CAMPAIGN_SUBJECT_EVENT } from '../../../views/campaign-command/desktop/war-room-links'
import * as L from '../../desktop/workspace/layout'
import { selectionInSession, useWorkspace } from '../../desktop/workspace/workspace-store'
import type { PageContext } from '../model/context-model'

const CAMPAIGN_KEY = 'nexus:campaign-subject:v1'
const THREAD_APPS = new Set(['inbox', 'conversation', 'deal-intelligence'])

function readCampaign(): { id: string; name: string | null } | null {
  try {
    const v = JSON.parse(window.sessionStorage.getItem(CAMPAIGN_KEY) || 'null') as { campaignId?: string; name?: string | null } | null
    return v?.campaignId ? { id: v.campaignId, name: v.name ?? null } : null
  } catch { return null }
}

let campaignStamp = 0
if (typeof window !== 'undefined') window.addEventListener(CAMPAIGN_SUBJECT_EVENT, () => { campaignStamp += 1 })
let locStamp = 0
if (typeof window !== 'undefined') window.addEventListener(PROPERTY_LOCATOR_EVENT, () => { locStamp += 1 })

/**
 * What the current page is about, read from what the shell already
 * publishes (no app had to change): the focused pane, the property locator
 * (property · thread · deal), the Entity Graph selection and Campaign
 * Command's open campaign. A campaign attaches only while Campaign Command
 * is the focused app; a seller thread only from the conversation apps.
 */
export function usePageContext(): PageContext {
  const ctx = useAgentContextSnapshot()
  const ws = useWorkspace()
  const focused = L.focusedInstance(ws.layout)
  const cs = useSyncExternalStore((l) => { window.addEventListener(CAMPAIGN_SUBJECT_EVENT, l); return () => window.removeEventListener(CAMPAIGN_SUBJECT_EVENT, l) }, () => campaignStamp, () => 0)
  const ls = useSyncExternalStore((l) => { window.addEventListener(PROPERTY_LOCATOR_EVENT, l); return () => window.removeEventListener(PROPERTY_LOCATOR_EVENT, l) }, () => locStamp, () => 0)
  return useMemo<PageContext>(() => {
    void cs; void ls
    const loc = selectionInSession() ? readPropertyLocator() : null
    const app = ctx.app
    const campaign = app === 'campaign-command' ? readCampaign() : null
    return {
      app,
      appLabel: ctx.appLabel,
      instanceId: focused?.id ?? null,
      property: ctx.property?.id || ctx.property?.address ? { id: ctx.property.id, address: ctx.property.address } : null,
      thread: loc?.threadKey && app && THREAD_APPS.has(app) ? { key: loc.threadKey } : null,
      deal: loc?.opportunityId ? { opportunityId: loc.opportunityId } : null,
      campaign,
      selection: ctx.selection ? { property_ids: ctx.selection.property_ids, count: ctx.selection.count } : null,
    }
  }, [ctx.app, ctx.appLabel, ctx.property?.id, ctx.property?.address, ctx.selection, focused?.id, cs, ls])
}
