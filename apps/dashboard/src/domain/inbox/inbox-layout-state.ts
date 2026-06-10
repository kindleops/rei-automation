import type { InboxSavedFilterPreset } from './inbox-ui-helpers'

export type NexusTheme = 'dark' | 'light'
export type PanelMode = 'default' | 'hidden' | 'half' | 'full'
export type InboxMode = 'default' | 'full_single' | 'full_double'
export type MapMode = 'off' | 'side' | 'half' | 'seventy_five' | 'full'
export type MapSourceMode = 'visible_threads' | 'loaded_threads' | 'all_active_coordinate_threads'
export type ActiveOverlay = null | 'notifications' | 'queue' | 'filters' | 'avatar' | 'ai' | 'templates' | 'dossier' | 'keys' | 'activity' | 'map'

export interface InboxLayoutState {
  theme: NexusTheme
  leftPanelMode: PanelMode
  rightPanelMode: PanelMode
  inboxMode: InboxMode
  mapMode: MapMode
  activeOverlay: ActiveOverlay
  selectedThreadId: string | null
  leftInboxFilter: InboxSavedFilterPreset
  rightInboxFilter: InboxSavedFilterPreset
}

export const defaultInboxLayoutState: InboxLayoutState = {
  theme: 'dark',
  leftPanelMode: 'default',
  rightPanelMode: 'default',
  inboxMode: 'default',
  mapMode: 'off',
  activeOverlay: null,
  selectedThreadId: null,
  leftInboxFilter: 'my_priority',
  rightInboxFilter: 'new_inbounds',
}

export const defaultMapSourceMode: MapSourceMode = 'loaded_threads'
// TODO: Upgrade to 'all_active_coordinate_threads' when backend query is ready

const panelCycle: PanelMode[] = ['default', 'hidden', 'half', 'full']
const inboxCycle: InboxMode[] = ['default', 'full_single', 'full_double']
const mapCycle: MapMode[] = ['side', 'half', 'seventy_five', 'full']
const mapSourceCycle: MapSourceMode[] = ['visible_threads', 'loaded_threads', 'all_active_coordinate_threads']

export const cycleMapSourceMode = (current: MapSourceMode): MapSourceMode =>
  nextValue(mapSourceCycle, current)

const nextValue = <T extends string>(cycle: T[], current: T): T => {
  const index = cycle.indexOf(current)
  return cycle[(index + 1) % cycle.length] ?? cycle[0]
}

export const cycleLeftPanelMode = (state: InboxLayoutState): InboxLayoutState => ({
  ...state,
  leftPanelMode: nextValue(panelCycle, state.leftPanelMode),
  inboxMode: state.leftPanelMode === 'half' ? 'default' : state.inboxMode,
})

export const cycleRightPanelMode = (state: InboxLayoutState): InboxLayoutState => ({
  ...state,
  rightPanelMode: nextValue(panelCycle, state.rightPanelMode),
  inboxMode: state.rightPanelMode === 'half' ? 'default' : state.inboxMode,
})

export const cycleInboxMode = (state: InboxLayoutState): InboxLayoutState => {
  if (state.mapMode !== 'off') {
    return { ...state, mapMode: nextValue(mapCycle, state.mapMode) }
  }
  return {
    ...state,
    inboxMode: nextValue(inboxCycle, state.inboxMode),
    leftPanelMode: 'default',
    rightPanelMode: 'default',
  }
}

export const cycleMapMode = (state: InboxLayoutState): InboxLayoutState => ({
  ...state,
  mapMode: nextValue(mapCycle, state.mapMode === 'off' ? 'side' : state.mapMode),
  inboxMode: 'default',
  rightPanelMode: 'hidden',
})

export const openMapMode = (state: InboxLayoutState): InboxLayoutState => ({
  ...state,
  mapMode: 'side',
  inboxMode: 'default',
  rightPanelMode: 'hidden',
})

export const closeMapMode = (state: InboxLayoutState): InboxLayoutState => ({
  ...state,
  mapMode: 'off',
  rightPanelMode: 'default',
})

export const resetLayoutMode = (state: InboxLayoutState): InboxLayoutState => ({
  ...state,
  leftPanelMode: 'default',
  rightPanelMode: 'default',
  inboxMode: 'default',
  mapMode: 'off',
  activeOverlay: null,
})

export const setDoubleSidedInboxFilters = (
  state: InboxLayoutState,
  leftInboxFilter: InboxSavedFilterPreset,
  rightInboxFilter: InboxSavedFilterPreset,
): InboxLayoutState => ({
  ...state,
  leftInboxFilter,
  rightInboxFilter,
})

export const getLayoutClassNames = (state: InboxLayoutState): string[] => [
  'is-operator-rebuild',
  `is-theme-${state.theme}`,
  state.theme === 'light' && 'is-light-mode',
  `is-left-${state.leftPanelMode}`,
  `is-right-${state.rightPanelMode}`,
  `is-inbox-${state.inboxMode}`,
  state.mapMode !== 'off' && 'is-map-mode',
  `is-map-${state.mapMode}`,
].filter(Boolean) as string[]

export const layoutToastForState = (state: InboxLayoutState, key: '[' | ']' | '/'): string => {
  if (key === '[') {
    if (state.leftPanelMode === 'hidden') return 'Left panel hidden'
    if (state.leftPanelMode === 'half') return 'Inbox split view'
    if (state.leftPanelMode === 'full') return 'Full-screen inbox'
    return 'Layout reset'
  }
  if (key === ']') {
    if (state.rightPanelMode === 'hidden') return 'Intelligence hidden'
    if (state.rightPanelMode === 'half') return 'Intelligence split view'
    if (state.rightPanelMode === 'full') return 'Full-screen deal intelligence'
    return 'Layout reset'
  }
  if (state.mapMode !== 'off') {
    if (state.mapMode === 'half' || state.mapMode === 'side') return 'Map split view'
    if (state.mapMode === 'seventy_five') return 'Map expanded'
    if (state.mapMode === 'full') return 'Full-screen map'
  }
  if (state.inboxMode === 'full_single') return 'Full inbox triage'
  if (state.inboxMode === 'full_double') return 'Double-sided inbox'
  return 'Layout reset'
}
