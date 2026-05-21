import type { HomePreset, HomeWidgetDefinition, HomeWorkspace } from './home.types'
import { HOME_WIDGETS } from './home.widgets'

export const HOME_WORKSPACES: HomeWorkspace[] = [
  { id: 'acq', name: 'Acquisitions', description: 'Owner outreach and opportunity intake', activeCount: '42 active', accent: 'emerald' },
  { id: 'intel', name: 'Market Intelligence', description: 'Heat pressure and market pulse tracking', activeCount: '7 markets hot', accent: 'sky' },
  { id: 'exec', name: 'Deal Execution', description: 'Offers, contracts, and title progression', activeCount: '19 in flight', accent: 'amber' },
  { id: 'dispo', name: 'Dispo / Buyers', description: 'Buyer matching and package distribution', activeCount: '31 buyer matches', accent: 'violet' },
  { id: 'msg', name: 'Messaging / AI', description: 'Conversations, drafts, and operator guidance', activeCount: '63 pending', accent: 'rose' },
  { id: 'ops', name: 'Automation Health', description: 'Systems health and sync reliability', activeCount: '2 alerts', accent: 'slate' },
  { id: 'rev', name: 'Revenue / Executive', description: 'Pipeline, forecast, and closings control', activeCount: '$12.4M pipeline', accent: 'emerald' },
]

export const HOME_PRESETS: HomePreset[] = [
  {
    id: 'operator',
    label: 'Operator',
    description: 'Balanced command board for daily execution',
    widgetIds: [
      'inbox-hot-replies',
      'queue-ready-now',
      'queue-failed-sends',
      'dossier-hot-sellers',
      'market-heat',
      'deals-offers-ready',
      'deals-title-blockers',
      'automation-webhook-failures',
      'revenue-pipeline-value',
    ],
  },
  {
    id: 'acquisition',
    label: 'Acquisition',
    description: 'Lead response, motivation, and follow-up control',
    widgetIds: [
      'inbox-hot-replies',
      'inbox-needs-response',
      'queue-ready-now',
      'dossier-hot-sellers',
      'dossier-high-equity',
      'market-pressure-zones',
      'deals-offers-ready',
      'buyers-matches-ready',
      'automation-api-pressure',
    ],
  },
  {
    id: 'map-command',
    label: 'Map Command',
    description: 'Market pressure, zoning, and response velocity focus',
    widgetIds: [
      'market-heat',
      'market-top',
      'market-pressure-zones',
      'dossier-portfolio-owners',
      'queue-send-capacity',
      'deals-title-blockers',
      'buyers-interest',
      'automation-sync',
    ],
  },
  {
    id: 'ceo',
    label: 'CEO',
    description: 'Executive-level revenue and risk snapshot',
    widgetIds: [
      'revenue-pipeline-value',
      'revenue-projected-assignments',
      'revenue-closed',
      'deals-closings-week',
      'deals-contracts-waiting',
      'automation-webhook-failures',
      'market-top',
      'buyers-packages-sent',
    ],
  },
  {
    id: 'automation-health',
    label: 'Automation Health',
    description: 'System reliability and workflow continuity',
    widgetIds: [
      'automation-api-pressure',
      'automation-webhook-failures',
      'automation-textgrid-health',
      'automation-sync',
      'queue-failed-sends',
      'inbox-ai-drafts',
      'deals-title-blockers',
    ],
  },
  {
    id: 'dispo',
    label: 'Dispo',
    description: 'Buyer operations and deal packaging control',
    widgetIds: [
      'buyers-matches-ready',
      'buyers-interest',
      'buyers-packages-sent',
      'deals-offers-ready',
      'deals-contracts-waiting',
      'deals-closings-week',
      'revenue-projected-assignments',
    ],
  },
]

const findWidgets = (ids: string[]): HomeWidgetDefinition[] =>
  ids
    .map((id) => HOME_WIDGETS.find((widget) => widget.id === id))
    .filter((widget): widget is HomeWidgetDefinition => Boolean(widget))

export const resolvePresetWidgets = (presetId: string) => {
  const preset = HOME_PRESETS.find((candidate) => candidate.id === presetId) ?? HOME_PRESETS[0]
  return findWidgets(preset.widgetIds)
}
