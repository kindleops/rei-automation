/**
 * Every application's own light. The command island, the launcher tile and
 * the app chip all glow in it, so the chrome says where you are before the
 * label does. One table, keyed by app registry id.
 */
export const APP_HUE: Record<string, string> = {
  home: '#f7c75b',
  inbox: '#38bdf8',
  conversation: '#22d3ee',
  'email-command': '#a78bfa',
  notifications: '#fb7185',
  'deal-intelligence': '#fb923c',
  properties: '#5eead4',
  'entity-graph': '#a98bff',
  'comp-intelligence': '#ff5a64',
  'buyer-match': '#34d399',
  map: '#2dd4bf',
  pipeline: '#60a5fa',
  queue: '#fbbf24',
  'campaign-command': '#22d3ee',
  'workflow-studio': '#c084fc',
  'closing-desk': '#4ade80',
  calendar: '#f472b6',
  analytics: '#818cf8',
  settings: '#94a3b8',
}

export const appHue = (id: string | null | undefined): string => APP_HUE[id ?? ''] ?? '#5ee7ff'
