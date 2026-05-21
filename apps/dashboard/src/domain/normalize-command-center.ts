import { referenceCommandCenterData } from './command-center-data'
import type {
  ActivityRecord,
  AgentRecord,
  AlertRecord,
  AutopilotEventRecord,
  BuyerProfileRecord,
  CommandCenterReferenceDataset,
  CommandCenterStore,
  InboxThreadRecord,
  MarketRecord,
  NotificationRecord,
  PropertyLeadRecord,
  TitleRecord,
  WatchlistRecord,
} from './types'

const mapById = <T extends { id: string }>(records: T[]) =>
  Object.fromEntries(records.map((record) => [record.id, record])) as Record<string, T>

const groupIdsByMarket = <T extends { id: string; marketId: string }>(records: T[]) =>
  records.reduce<Record<string, string[]>>((groups, record) => {
    const bucket = groups[record.marketId]
    if (bucket) {
      bucket.push(record.id)
      return groups
    }

    groups[record.marketId] = [record.id]
    return groups
  }, {})

export const normalizeCommandCenterData = (
  dataset: CommandCenterReferenceDataset,
): CommandCenterStore => ({
  marketsById: mapById<MarketRecord>(dataset.markets),
  marketIds: dataset.markets.map((market) => market.id),
  propertiesById: mapById<PropertyLeadRecord>(dataset.properties),
  propertyIds: dataset.properties.map((property) => property.id),
  propertyIdsByMarketId: groupIdsByMarket<PropertyLeadRecord>(dataset.properties),
  agentsById: mapById<AgentRecord>(dataset.agents),
  agentIds: dataset.agents.map((agent) => agent.id),
  alertsById: mapById<AlertRecord>(dataset.alerts),
  alertIds: dataset.alerts.map((alert) => alert.id),
  alertIdsByMarketId: groupIdsByMarket<AlertRecord>(dataset.alerts),
  activitiesById: mapById<ActivityRecord>(dataset.activities),
  activityIds: dataset.activities.map((activity) => activity.id),
  activityIdsByMarketId: groupIdsByMarket<ActivityRecord>(dataset.activities),
  mapLinks: dataset.mapLinks,
  systemHealth: dataset.systemHealth,
  inboxThreadsById: mapById<InboxThreadRecord>(dataset.inboxThreads),
  inboxThreadIds: dataset.inboxThreads.map((t) => t.id),
  buyerProfilesById: mapById<BuyerProfileRecord>(dataset.buyerProfiles),
  buyerProfileIds: dataset.buyerProfiles.map((b) => b.id),
  titleRecordsById: mapById<TitleRecord>(dataset.titleRecords),
  titleRecordIds: dataset.titleRecords.map((t) => t.id),
  autopilotEventsById: mapById<AutopilotEventRecord>(dataset.autopilotEvents),
  autopilotEventIds: dataset.autopilotEvents.map((e) => e.id),
  notificationsById: mapById<NotificationRecord>(dataset.notifications),
  notificationIds: dataset.notifications.map((n) => n.id),
  watchlistsById: mapById<WatchlistRecord>(dataset.watchlists),
  watchlistIds: dataset.watchlists.map((w) => w.id),
})

let commandCenterStore: CommandCenterStore | null = null

export const loadCommandCenterStore = async () => {
  if (commandCenterStore) {
    return commandCenterStore
  }

  commandCenterStore = normalizeCommandCenterData(referenceCommandCenterData)
  return commandCenterStore
}
