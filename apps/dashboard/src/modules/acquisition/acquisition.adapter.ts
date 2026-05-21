import type { AcquisitionWorkspaceModel } from './acquisition.types'
import {
  getAcquisitionActivity,
  getAcquisitionAiBrain,
  getAcquisitionAutomations,
  getAcquisitionContacts,
  getAcquisitionKpis,
  getAcquisitionMapPoints,
  getAcquisitionOffers,
  getAcquisitionOwners,
  getAcquisitionProperties,
  getAcquisitionProspects,
  getAcquisitionUnderwriting,
} from '../../lib/data/acquisitionData'

export const loadAcquisitionWorkspace = async (): Promise<AcquisitionWorkspaceModel> => {
  const [
    kpis,
    owners,
    properties,
    prospects,
    contacts,
    offers,
    underwriting,
    aiBrain,
    activity,
    mapPoints,
    automations,
  ] = await Promise.all([
    getAcquisitionKpis(),
    getAcquisitionOwners(),
    getAcquisitionProperties(),
    getAcquisitionProspects(),
    getAcquisitionContacts(),
    getAcquisitionOffers(),
    getAcquisitionUnderwriting(),
    getAcquisitionAiBrain(),
    getAcquisitionActivity(),
    getAcquisitionMapPoints(),
    getAcquisitionAutomations(),
  ])

  const marketOptions = Array.from(
    new Set([
      'All Markets',
      ...owners.map((owner) => owner.market),
      ...properties.map((property) => property.market),
      ...mapPoints.map((point) => point.marketName),
    ]),
  )

  return {
    workspaceName: 'Acquisition Command',
    subtitle:
      'Seller outreach, owner intelligence, property review, messaging, offers, and contract handoff.',
    status: 'Live Sync',
    marketOptions,
    kpis,
    owners,
    properties,
    prospects,
    phones: contacts.phones,
    emails: contacts.emails,
    offers,
    underwriting,
    aiBrain,
    activity,
    mapPoints,
    automations,
  }
}
