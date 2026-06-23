import type { EntityGraphAction, UniversalEntityContext } from './entity-graph.types'

export type EntityGraphActionItem = {
  key: EntityGraphAction
  label: string
  disabled?: boolean
  hint?: string
}

export function buildEntityGraphActions(context: UniversalEntityContext, dossierThreads = 0): EntityGraphActionItem[] {
  const type = context.entityType
  const actions: EntityGraphActionItem[] = []

  if (type === 'property') {
    actions.push({ key: 'view_properties', label: 'Open Property Intelligence' })
    actions.push({ key: 'open_deal_intelligence', label: 'Open Deal Intelligence' })
    actions.push({ key: 'open_comp_intelligence', label: 'Open Comp Intelligence' })
    actions.push({ key: 'open_buyer_match', label: 'Open Buyer Match' })
    actions.push({ key: 'open_in_map', label: 'Open in Map' })
    if (context.threadKey || dossierThreads > 0) actions.push({ key: 'open_thread', label: 'Open Conversation' })
    else actions.push({ key: 'create_manual_draft', label: 'Create Conversation Draft' })
    actions.push({ key: 'create_opportunity', label: 'Create/Open Opportunity', disabled: !context.propertyId, hint: context.propertyId ? undefined : 'Property required' })
    return actions
  }

  if (type === 'master_owner') {
    actions.push({ key: 'open_portfolio', label: 'View Portfolio' })
    actions.push({ key: 'contact_owner', label: 'Contact Best Eligible Person' })
    if (context.threadKey || dossierThreads > 0) actions.push({ key: 'view_threads', label: 'Open Threads' })
    actions.push({ key: 'open_in_map', label: 'Open Portfolio in Map' })
    return actions
  }

  if (type === 'prospect') {
    if (context.threadKey || dossierThreads > 0) actions.push({ key: 'open_thread', label: 'Open Conversation' })
    else actions.push({ key: 'create_manual_draft', label: 'Create Conversation Draft' })
    actions.push({ key: 'view_owner', label: 'View Master Owner', disabled: !context.masterOwnerId })
    actions.push({ key: 'view_linked_properties', label: 'View Linked Properties' })
    actions.push({ key: 'select_contact_method', label: 'Select Contact Method' })
    return actions
  }

  if (type === 'phone' || type === 'email') {
    if (context.threadKey || dossierThreads > 0) actions.push({ key: 'open_thread', label: 'Open Existing Thread' })
    else actions.push({ key: 'create_manual_draft', label: 'Create Manual Draft' })
    actions.push({ key: 'view_prospect', label: 'View Linked Person', disabled: !context.prospectId })
    actions.push({ key: 'view_owner', label: 'View Master Owner', disabled: !context.masterOwnerId })
    return actions
  }

  if (type === 'zip') {
    actions.push({ key: 'view_properties', label: 'View Properties' })
    actions.push({ key: 'open_in_map', label: 'Open in Map' })
    actions.push({ key: 'apply_zip_filter', label: 'Apply ZIP Filter' })
    actions.push({ key: 'view_zip_intelligence', label: 'View ZIP Intelligence' })
    return actions
  }

  if (type === 'market') {
    actions.push({ key: 'view_properties', label: 'View Properties' })
    actions.push({ key: 'open_in_map', label: 'Open in Map' })
    actions.push({ key: 'apply_market_filter', label: 'Apply Market Filter' })
    actions.push({ key: 'view_market_intelligence', label: 'View Market Intelligence' })
    return actions
  }

  if (type === 'organization') {
    actions.push({ key: 'open_portfolio', label: 'View Portfolio' })
    actions.push({ key: 'view_owner', label: 'View Master Owner', disabled: !context.masterOwnerId })
    actions.push({ key: 'open_in_map', label: 'Open in Map' })
    return actions
  }

  return actions
}