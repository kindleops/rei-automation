import { registerHomeWidget } from '../widget-registry'
import { GoalsWidget, IntelligenceBriefWidget } from './goals-brief-widgets'

let done = false
/**
 * Register after the first-party set: `home.brief` keeps its id (saved layouts
 * keep working) and gains the brief; `analytics.goals` is new.
 */
export function registerGoalsAndBriefWidgets() {
  if (done) return
  done = true
  registerHomeWidget({
    id: 'home.brief', ownerApp: 'home', name: 'Home Brief', icon: 'briefing', domain: 'Command',
    description: 'The greeting, the system state and the Intelligence Brief: what needs you, ranked, every line citing its source.',
    sizes: ['small', 'medium', 'wide', 'large', 'feature'], defaultSize: 'wide',
    component: IntelligenceBriefWidget, defaultConfig: {},
    data: 'Signal Center, Notification Center stories, pipeline events, Campaign Command, Inbox, Closing Desk and Goals',
    openAction: () => ({ label: 'Open Analytics', path: '/analytics' }),
    refresh: { everyMs: 60_000, events: ['/queue', '/inbox', '/pipeline', '/campaign-command', '/closing-desk'] },
    emptyState: 'Nothing to report yet.',
    loadingState: 'lines',
  })
  registerHomeWidget({
    id: 'analytics.goals', ownerApp: 'analytics', name: 'Goals', icon: 'flag', domain: 'Intelligence',
    description: 'Your targets on Analytics metrics — period-to-date against target and pace, behind first.',
    sizes: ['compact', 'small', 'medium', 'tall', 'wide', 'large'], defaultSize: 'medium',
    component: GoalsWidget, defaultConfig: {},
    data: 'Analytics Goals (targets) · progress from the Analytics engine',
    openAction: () => ({ label: 'Open Goals', path: '/analytics?lens=goals' }),
    openBesideAction: () => ({ label: 'Open Goals beside', path: '/analytics?lens=goals' }),
    refresh: { everyMs: 300_000 },
    emptyState: 'No goals set.',
    loadingState: 'metric',
  })
}
