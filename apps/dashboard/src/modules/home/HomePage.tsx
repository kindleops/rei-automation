import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, DragEvent } from 'react'
import { pushRoutePath } from '../../app/router'
import { Icon } from '../../shared/icons'
import type { HomeModel, HomeWidgetDefinition } from './home.types'
import { resolvePresetWidgets } from './home.presets'
import {
  COMMAND_SPACES as STORE_COMMAND_SPACES,
  COMMAND_STORE_ITEMS,
  addStoreItemToSpace,
  getInstallSet,
  getResolvedStatus,
  isInstalledStatus,
  saveInstallSet,
} from '../command-store/command-store.data'
import type { CommandSpaceId, CommandStoreItem, CommandStoreItemType } from '../command-store/command-store.types'

const MapLibreMiniMap = lazy(() => import('./MapLibreMiniMap').then((mod) => ({ default: mod.MapLibreMiniMap })))

interface HomePageProps {
  data: HomeModel
}

type HomeCommand = {
  label: string
  category: string
  action: () => void
}

type DrawerTab = 'widgets' | 'apps' | 'agents' | 'automations' | 'integrations' | 'packs'

type MarketSnapshot = {
  name: string
  lng: number
  lat: number
  activeLeads: number
  hotReplies: number
  queueDepth: number
  pressure: number
}

const MARKET_COORDS: Record<string, { lng: number; lat: number }> = {
  Dallas: { lng: -96.797, lat: 32.7767 },
  Houston: { lng: -95.3698, lat: 29.7604 },
  Phoenix: { lng: -112.074, lat: 33.4484 },
  Atlanta: { lng: -84.388, lat: 33.749 },
  Charlotte: { lng: -80.8431, lat: 35.2271 },
  Minneapolis: { lng: -93.265, lat: 44.9778 },
}

const BASE_MARKETS: MarketSnapshot[] = [
  { name: 'Dallas', lng: -96.797, lat: 32.7767, activeLeads: 42, hotReplies: 5, queueDepth: 19, pressure: 82 },
  { name: 'Houston', lng: -95.3698, lat: 29.7604, activeLeads: 38, hotReplies: 4, queueDepth: 22, pressure: 91 },
  { name: 'Phoenix', lng: -112.074, lat: 33.4484, activeLeads: 27, hotReplies: 2, queueDepth: 11, pressure: 74 },
  { name: 'Atlanta', lng: -84.388, lat: 33.749, activeLeads: 31, hotReplies: 3, queueDepth: 14, pressure: 78 },
  { name: 'Charlotte', lng: -80.8431, lat: 35.2271, activeLeads: 22, hotReplies: 1, queueDepth: 9, pressure: 65 },
  { name: 'Minneapolis', lng: -93.265, lat: 44.9778, activeLeads: 36, hotReplies: 4, queueDepth: 16, pressure: 88 },
]

const MARKET_NODE_POSITIONS: Record<string, { left: string; top: string }> = {
  Dallas: { left: '39%', top: '62%' },
  Houston: { left: '43%', top: '75%' },
  Phoenix: { left: '22%', top: '59%' },
  Atlanta: { left: '64%', top: '64%' },
  Charlotte: { left: '62%', top: '50%' },
  Minneapolis: { left: '48%', top: '31%' },
}

type CommandSpace = {
  id: string
  name: string
  count: string
  accent: 'emerald' | 'sky' | 'amber' | 'violet' | 'rose' | 'slate' | 'red'
  presetId?: string
}

const COMMAND_SPACES: CommandSpace[] = [
  { id: 'executive', name: 'Executive', count: '$12.4M', accent: 'emerald', presetId: 'ceo' },
  { id: 'acquisition', name: 'Acquisition', count: '42 active', accent: 'emerald', presetId: 'acquisition' },
  { id: 'market-intel', name: 'Market Intel', count: '7 hot', accent: 'sky', presetId: 'map-command' },
  { id: 'messaging', name: 'Messaging', count: '14 hot', accent: 'rose', presetId: 'operator' },
  { id: 'queue', name: 'Queue', count: '62 ready', accent: 'amber', presetId: 'operator' },
  { id: 'deals', name: 'Deals', count: '19 live', accent: 'amber', presetId: 'operator' },
  { id: 'dispo', name: 'Dispo', count: '31 buyers', accent: 'violet', presetId: 'dispo' },
  { id: 'automation', name: 'Automation', count: '2 alerts', accent: 'red', presetId: 'automation-health' },
  { id: 'revenue', name: 'Revenue', count: '$1.94M', accent: 'emerald', presetId: 'ceo' },
]

const SYSTEM_HEALTH_ITEMS = [
  { name: 'Supabase', value: '99.1%', tone: 'healthy' },
  { name: 'TextGrid', value: '98.7%', tone: 'healthy' },
  { name: 'Podio Sync', value: '2 lagging', tone: 'watch' },
  { name: 'Queue Runner', value: 'Guarded', tone: 'watch' },
  { name: 'Webhooks', value: '4 replay', tone: 'alert' },
] as const

const nowString = () =>
  new Date().toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })

const isTypingTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement && Boolean(target.closest('input, textarea, [contenteditable="true"]'))

const getBentoWidgetClass = (widget: HomeWidgetDefinition) => {
  const map: Record<string, string> = {
    'revenue-pipeline-value': 'lc-widget--wide',
    'inbox-hot-replies': 'lc-widget--medium',
    'queue-ready-now': 'lc-widget--medium',
    'queue-failed-sends': 'lc-widget--small',
    'market-heat': 'lc-widget--medium',
    'deals-offers-ready': 'lc-widget--small',
    'dossier-hot-sellers': 'lc-widget--medium',
    'automation-webhook-failures': 'lc-widget--small',
    'deals-title-blockers': 'lc-widget--small',
  }
  return map[widget.id] ?? (widget.size === 'medium' ? 'lc-widget--medium' : 'lc-widget--small')
}

const getSparklineBars = (seed: string) => {
  const base = seed
    .split('')
    .reduce((sum, char, index) => sum + char.charCodeAt(0) + index, 0)
  return Array.from({ length: 14 }, (_, index) => 24 + ((base + index * 17) % 58))
}

const toSourceClass = (source: string) => `lc-source--${source.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`

const SAVED_LAYOUT_KEY = 'leadcommand:nexus-home-layout'

const resolveWidgetIds = (widgets: HomeWidgetDefinition[], ids: string[]) =>
  ids
    .map((id) => widgets.find((widget) => widget.id === id))
    .filter((widget): widget is HomeWidgetDefinition => Boolean(widget))

const loadSavedWidgetLayout = (widgets: HomeWidgetDefinition[]) => {
  try {
    const saved = window.localStorage.getItem(SAVED_LAYOUT_KEY)
    if (!saved) return null
    const ids = JSON.parse(saved) as unknown
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) return null
    const resolved = resolveWidgetIds(widgets, ids)
    return resolved.length > 0 ? resolved : null
  } catch {
    return null
  }
}

const formatKindLabel = (kind: string) =>
  kind
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')

const normalizeStoreName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')

const statusLabel = (value: string) => value.replace(/_/g, ' ')
const statusClass = (value: string) => value.replace(/_/g, '-')

const STORE_TAB_TYPES: Record<DrawerTab, CommandStoreItemType[]> = {
  widgets: ['widget'],
  apps: ['app', 'report', 'map-layer'],
  agents: ['agent'],
  automations: ['automation'],
  integrations: ['integration'],
  packs: ['pack', 'template'],
}

const STORE_TAB_LABELS: Record<DrawerTab, string> = {
  widgets: 'Widgets',
  apps: 'Apps',
  agents: 'Agents',
  automations: 'Automations',
  integrations: 'Integrations',
  packs: 'Packs',
}

const toStoreSpaceId = (spaceId: string): CommandSpaceId => {
  const map: Record<string, CommandSpaceId> = {
    executive: 'executive',
    acquisition: 'acquisition',
    'market-intel': 'market-intelligence',
    messaging: 'messaging',
    queue: 'queue',
    deals: 'deal-execution',
    dispo: 'dispo',
    automation: 'automation',
    revenue: 'revenue',
  }
  return map[spaceId] ?? 'acquisition'
}

export const HomePage = ({ data }: HomePageProps) => {
  const [editMode, setEditMode] = useState(false)
  const [mapFocus, setMapFocus] = useState(false)
  const [heatMode, setHeatMode] = useState(true)
  const [leadPulseMode, setLeadPulseMode] = useState(true)
  const [activeMarketName, setActiveMarketName] = useState('Houston')
  const [showAddWidget, setShowAddWidget] = useState(false)
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('widgets')
  const [quickAddQuery, setQuickAddQuery] = useState('')
  const [quickAddStatus, setQuickAddStatus] = useState<'All' | 'Installed' | 'Available'>('All')
  const [storeInstalledIds, setStoreInstalledIds] = useState(() => getInstallSet())
  const [quickAddNotice, setQuickAddNotice] = useState('Ready to install into the current Command Space.')
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  const [commandQuery, setCommandQuery] = useState('')
  const [activePresetId, setActivePresetId] = useState<string>('operator')
  const [activeSpaceId, setActiveSpaceId] = useState('executive')
  const [visibleWidgets, setVisibleWidgets] = useState<HomeWidgetDefinition[]>(
    () => loadSavedWidgetLayout(data.widgets) ?? resolvePresetWidgets('operator')
  )
  const [dateTime, setDateTime] = useState(nowString)
  const [draggingWidgetId, setDraggingWidgetId] = useState<string | null>(null)
  const [layoutSavedAt, setLayoutSavedAt] = useState<string | null>(null)

  const hiddenWidgets = useMemo(
    () => data.widgets.filter((widget) => !visibleWidgets.some((visible) => visible.id === widget.id)),
    [data.widgets, visibleWidgets]
  )

  const widgetLookup = useMemo(
    () => new Map(data.widgets.map((widget) => [widget.id, widget])),
    [data.widgets]
  )

  const mapMarkets = useMemo<MarketSnapshot[]>(() => {
    const byName = new Map(BASE_MARKETS.map((market) => [market.name, market]))
    data.topMarkets.forEach((marketName, index) => {
      if (byName.has(marketName)) return
      const coords = MARKET_COORDS[marketName]
      if (!coords) return
      byName.set(marketName, {
        name: marketName,
        lng: coords.lng,
        lat: coords.lat,
        activeLeads: Math.max(14, Math.round(data.leadPulses / Math.max(1, data.topMarkets.length)) + (index % 4) * 3),
        hotReplies: 1 + (index % 5),
        queueDepth: 6 + (index % 6) * 2,
        pressure: 62 + (index % 5) * 7,
      })
    })
    return Array.from(byName.values())
  }, [data.topMarkets, data.leadPulses])

  const activeMarket = useMemo(
    () => mapMarkets.find((market) => market.name === activeMarketName) ?? mapMarkets[0],
    [activeMarketName, mapMarkets]
  )

  const quickAddDestination = toStoreSpaceId(activeSpaceId)

  const quickAddItems = useMemo(() => {
    const normalizedQuery = quickAddQuery.trim().toLowerCase()
    const allowedTypes = STORE_TAB_TYPES[drawerTab]

    return COMMAND_STORE_ITEMS.filter((item) => {
      if (!allowedTypes.includes(item.type)) return false

      const status = getResolvedStatus(item, storeInstalledIds)
      if (quickAddStatus === 'Installed' && !isInstalledStatus(status)) return false
      if (quickAddStatus === 'Available' && isInstalledStatus(status)) return false

      if (!normalizedQuery) return true
      return [
        item.name,
        item.category,
        item.type,
        item.description,
        item.tags.join(' '),
        item.recommendedSpaces.map((space) => STORE_COMMAND_SPACES.find((candidate) => candidate.id === space)?.label ?? space).join(' '),
      ].some((value) => value.toLowerCase().includes(normalizedQuery))
    }).slice(0, 36)
  }, [drawerTab, quickAddQuery, quickAddStatus, storeInstalledIds])

  const findHomeWidgetForStoreItem = useCallback(
    (item: CommandStoreItem) => {
      if (item.type !== 'widget') return null
      const itemName = normalizeStoreName(item.name)
      return hiddenWidgets.find((widget) => normalizeStoreName(widget.title) === itemName) ?? null
    },
    [hiddenWidgets],
  )

  const applyPreset = useCallback((presetId: string) => {
    setActivePresetId(presetId)
    setVisibleWidgets(resolvePresetWidgets(presetId))
    setLayoutSavedAt(null)
  }, [])

  const activateSpace = (space: CommandSpace) => {
    setActiveSpaceId(space.id)
    if (space.presetId) {
      applyPreset(space.presetId)
    }
  }

  const removeWidget = (widgetId: string) => {
    setVisibleWidgets((current) => current.filter((widget) => widget.id !== widgetId))
  }

  const addWidget = (widget: HomeWidgetDefinition) => {
    setVisibleWidgets((current) => {
      if (current.some((existing) => existing.id === widget.id)) return current
      return [...current, widget]
    })
  }

  const installStoreItem = (item: CommandStoreItem) => {
    setStoreInstalledIds((current) => {
      const next = new Set(current)
      next.add(item.id)
      saveInstallSet(next)
      return next
    })
    addStoreItemToSpace(item.id, quickAddDestination)
    setQuickAddNotice(`${item.name} installed into ${STORE_COMMAND_SPACES.find((space) => space.id === quickAddDestination)?.label ?? 'Command Space'}.`)
  }

  const addStoreItem = (item: CommandStoreItem) => {
    const homeWidget = findHomeWidgetForStoreItem(item)
    if (homeWidget) {
      addWidget(homeWidget)
      setQuickAddNotice(`${homeWidget.title} added to the home canvas.`)
      return
    }

    addStoreItemToSpace(item.id, quickAddDestination)
    setQuickAddNotice(`${item.name} added to ${STORE_COMMAND_SPACES.find((space) => space.id === quickAddDestination)?.label ?? 'Command Space'}.`)
  }

  const resetLayout = () => {
    setVisibleWidgets(resolvePresetWidgets(activePresetId))
    setLayoutSavedAt(null)
  }

  const saveLayout = () => {
    try {
      window.localStorage.setItem(SAVED_LAYOUT_KEY, JSON.stringify(visibleWidgets.map((widget) => widget.id)))
      setLayoutSavedAt(`Saved ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`)
    } catch {
      setLayoutSavedAt('Save unavailable')
    }
  }

  const handleDragStart = (event: DragEvent<HTMLElement>, widgetId: string) => {
    if (!editMode) return
    setDraggingWidgetId(widgetId)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', widgetId)
  }

  const handleDragOver = (event: DragEvent<HTMLElement>, targetWidgetId: string) => {
    if (!editMode || !draggingWidgetId || draggingWidgetId === targetWidgetId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }

  const handleDrop = (event: DragEvent<HTMLElement>, targetWidgetId: string) => {
    event.preventDefault()
    const sourceWidgetId = draggingWidgetId ?? event.dataTransfer.getData('text/plain')
    if (!sourceWidgetId || sourceWidgetId === targetWidgetId) return

    setVisibleWidgets((current) => {
      const sourceIndex = current.findIndex((widget) => widget.id === sourceWidgetId)
      const targetIndex = current.findIndex((widget) => widget.id === targetWidgetId)
      if (sourceIndex < 0 || targetIndex < 0) return current

      const next = [...current]
      const [moved] = next.splice(sourceIndex, 1)
      next.splice(targetIndex, 0, moved)
      return next
    })
    setDraggingWidgetId(null)
  }

  const commands = useMemo<HomeCommand[]>(
    () => [
      { label: 'Open Inbox', category: 'Navigation', action: () => pushRoutePath('/inbox') },
      { label: 'Open Queue', category: 'Navigation', action: () => pushRoutePath('/queue') },
      { label: 'Open Seller Dossier', category: 'Navigation', action: () => pushRoutePath('/dossier') },
      { label: 'Open Live Map', category: 'Navigation', action: () => pushRoutePath('/dashboard/live') },
      { label: 'Open Command Store', category: 'Command Store', action: () => pushRoutePath('/command-store') },
      { label: 'Search Store', category: 'Command Store', action: () => setShowAddWidget(true) },
      { label: 'Show Installed Apps', category: 'Command Store', action: () => {
        setQuickAddStatus('Installed')
        setShowAddWidget(true)
      } },
      { label: 'Open Integrations', category: 'Command Store', action: () => {
        setDrawerTab('integrations')
        setShowAddWidget(true)
      } },
      { label: 'Install Seller Inbox', category: 'Command Store', action: () => installStoreItem(COMMAND_STORE_ITEMS.find((item) => item.id === 'app-seller-inbox') ?? COMMAND_STORE_ITEMS[0]) },
      { label: 'Install Queue Recovery Agent', category: 'Command Store', action: () => installStoreItem(COMMAND_STORE_ITEMS.find((item) => item.id === 'queue-recovery-agent') ?? COMMAND_STORE_ITEMS[0]) },
      { label: 'Add Hot Replies Widget', category: 'Command Store', action: () => addStoreItem(COMMAND_STORE_ITEMS.find((item) => item.id === 'widget-hot-replies') ?? COMMAND_STORE_ITEMS[0]) },
      { label: 'Add Market Heat Widget', category: 'Command Store', action: () => addStoreItem(COMMAND_STORE_ITEMS.find((item) => item.id === 'widget-market-heat') ?? COMMAND_STORE_ITEMS[0]) },
      { label: 'Add Revenue Forecast Dashboard', category: 'Command Store', action: () => addStoreItem(COMMAND_STORE_ITEMS.find((item) => item.id === 'report-revenue-forecast') ?? COMMAND_STORE_ITEMS[0]) },
      { label: 'Add App to Acquisition Command', category: 'Command Store', action: () => addStoreItem(COMMAND_STORE_ITEMS.find((item) => item.id === 'real-estate-acquisitions-pack') ?? COMMAND_STORE_ITEMS[0]) },
      { label: 'Add Map Layer', category: 'Command Store', action: () => addStoreItem(COMMAND_STORE_ITEMS.find((item) => item.id === 'layer-heat-map-layer') ?? COMMAND_STORE_ITEMS[0]) },
      { label: 'Show hot replies', category: 'Views', action: () => console.log('Show hot replies') },
      { label: 'Show failed sends', category: 'Views', action: () => console.log('Show failed sends') },
      { label: 'Show approval queue', category: 'Views', action: () => console.log('Show approval queue') },
      { label: 'Show title blockers', category: 'Views', action: () => console.log('Show title blockers') },
      { label: 'Show closings this week', category: 'Views', action: () => console.log('Show closings this week') },
      { label: 'Add widget', category: 'Layout', action: () => setShowAddWidget(true) },
      { label: 'Toggle edit mode', category: 'Layout', action: () => setEditMode((state) => !state) },
      { label: 'Switch to CEO preset', category: 'Presets', action: () => applyPreset('ceo') },
      { label: 'Switch to Map Command preset', category: 'Presets', action: () => applyPreset('map-command') },
    ],
    [addStoreItem, applyPreset, installStoreItem]
  )

  const filteredCommands = commandQuery
    ? commands.filter(
        (command) =>
          command.label.toLowerCase().includes(commandQuery.toLowerCase()) ||
          command.category.toLowerCase().includes(commandQuery.toLowerCase())
      )
    : commands

  const groupedCommands = filteredCommands.reduce((acc, command) => {
    if (!acc[command.category]) {
      acc[command.category] = []
    }
    acc[command.category].push(command)
    return acc
  }, {} as Record<string, HomeCommand[]>)

  useEffect(() => {
    const timer = window.setInterval(() => setDateTime(nowString), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return
      const isCmd = event.metaKey || event.ctrlKey

      if (isCmd && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setShowCommandPalette((state) => !state)
        return
      }

      if (event.key === 'Escape') {
        setShowAddWidget(false)
        setShowCommandPalette(false)
        setMapFocus(false)
        return
      }

      if (event.key.toLowerCase() === 'e') {
        setEditMode((state) => !state)
      } else if (event.key.toLowerCase() === 'm') {
        setMapFocus((state) => !state)
      } else if (event.key.toLowerCase() === 'w') {
        setShowAddWidget(true)
      } else if (event.key === '1') {
        applyPreset('operator')
      } else if (event.key === '2') {
        applyPreset('acquisition')
      } else if (event.key === '3') {
        applyPreset('map-command')
      } else if (event.key === '4') {
        applyPreset('ceo')
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [applyPreset])

  const activePresetLabel = data.presets.find((preset) => preset.id === activePresetId)?.label ?? 'Operator'
  const priorityActions = data.activities.slice(0, 4)
  const briefingActions = data.briefingInsights.slice(0, 3)
  const statusStack = [
    { label: 'Active Markets', value: String(data.activeMarkets) },
    { label: 'Hot Replies', value: widgetLookup.get('inbox-hot-replies')?.primaryMetric ?? '14' },
    { label: 'Queue Pressure', value: widgetLookup.get('queue-ready-now')?.primaryMetric ?? '62' },
    { label: 'Automation Health', value: widgetLookup.get('automation-textgrid-health')?.primaryMetric ?? '98.7%' },
  ]

  return (
    <div className={`home-page nx-home lc-home ${editMode ? 'lc-home--edit' : ''}`}>
      <header className="lc-topbar">
        <div className="lc-brand">
          <span className="lc-brand__mark">
            <Icon name="radar" />
          </span>
          <div>
            <span>LeadCommand.ai</span>
            <strong>Nexus Command Spaces</strong>
          </div>
        </div>

        <button className="lc-command-search" onClick={() => setShowCommandPalette(true)}>
          <Icon name="search" />
          <span>Search sellers, properties, markets, commands...</span>
          <kbd>Cmd K</kbd>
        </button>

        <div className="lc-topbar__meta">
          <span className="lc-live-pill"><i /> AI Stable</span>
          <span className="lc-top-pill">{dateTime}</span>
          <button className="lc-icon-pill" onClick={() => pushRoutePath('/notifications')} aria-label="Open notifications">
            <Icon name="bell" />
            <span>7</span>
          </button>
          <button className="lc-top-pill lc-top-pill--button" onClick={() => setEditMode((state) => !state)}>
            <Icon name="grid" />
            <span>{editMode ? 'Editing' : 'Edit Layout'}</span>
          </button>
        </div>
      </header>

      <div className="lc-home-shell">
        <aside className="lc-space-rail" aria-label="Command Spaces">
          <header>
            <span>Command Spaces</span>
            <strong>{activePresetLabel}</strong>
          </header>
          <nav className="lc-space-list">
            {COMMAND_SPACES.map((space) => (
              <button
                key={space.id}
                className={`lc-space-item lc-space-item--${space.accent} ${activeSpaceId === space.id ? 'is-active' : ''}`}
                onClick={() => activateSpace(space)}
              >
                <span className="lc-space-item__mark">{space.name.slice(0, 2).toUpperCase()}</span>
                <span className="lc-space-item__body">
                  <strong>{space.name}</strong>
                  <small>{space.count}</small>
                </span>
              </button>
            ))}
          </nav>
        </aside>

        <main className="lc-command-canvas">
          <section className="lc-hero-composition">
            <article className={`lc-live-tile ${mapFocus ? 'is-expanded' : ''}`}>
              <div className="lc-live-tile__chrome">
                <div>
                  <span className="lc-kicker">Live Intelligence</span>
                  <h1>Market Command Canvas</h1>
                  <p>{activeMarket?.name ?? 'Houston'} is carrying the highest pressure score across the active acquisition network.</p>
                </div>
                <div className="lc-map-actions">
                  <button className={heatMode ? 'is-active' : ''} onClick={() => setHeatMode((state) => !state)}>
                    <Icon name="layers" />
                    Heat
                  </button>
                  <button className={leadPulseMode ? 'is-active' : ''} onClick={() => setLeadPulseMode((state) => !state)}>
                    <Icon name="activity" />
                    Pulses
                  </button>
                  <button onClick={() => pushRoutePath('/dashboard/live')}>
                    <Icon name="maximize" />
                    Open Live Map
                  </button>
                </div>
              </div>

              <div className="lc-map-stage">
                <div className="lc-map-atmosphere" aria-hidden="true" />
                <div className="lc-map-grid" aria-hidden="true" />
                <div className="lc-map-scan" aria-hidden="true" />

                <Suspense fallback={<div className="lc-map-loading">Loading market intelligence...</div>}>
                  <MapLibreMiniMap
                    markets={mapMarkets}
                    heatMode={heatMode}
                    leadPulses={leadPulseMode}
                    expanded={mapFocus}
                    activeMarketName={activeMarket?.name}
                    onMarketSelect={setActiveMarketName}
                  />
                </Suspense>

                <div className="lc-market-node-layer" aria-label="Market pressure nodes">
                  {mapMarkets.map((market, index) => {
                    const position = MARKET_NODE_POSITIONS[market.name] ?? {
                      left: `${24 + index * 9}%`,
                      top: `${34 + (index % 3) * 12}%`,
                    }

                    return (
                      <button
                        key={`${market.name}-node`}
                        className={`lc-market-node ${activeMarket?.name === market.name ? 'is-active' : ''}`}
                        style={{ left: position.left, top: position.top }}
                        onClick={() => setActiveMarketName(market.name)}
                      >
                        <span>{market.name}</span>
                        <strong>{market.pressure}</strong>
                      </button>
                    )
                  })}
                </div>

                <div className="lc-map-status-stack">
                  {statusStack.map((item) => (
                    <div key={item.label}>
                      <span>{item.label}</span>
                      <strong>{item.value}</strong>
                    </div>
                  ))}
                </div>
              </div>

              <footer className="lc-market-strip">
                {mapMarkets.map((market) => (
                  <button
                    key={market.name}
                    className={activeMarket?.name === market.name ? 'is-active' : ''}
                    onClick={() => setActiveMarketName(market.name)}
                  >
                    <span>{market.name}</span>
                    <strong>{market.pressure}</strong>
                  </button>
                ))}
              </footer>
            </article>

            <aside className="lc-priority-stack">
              <header>
                <span className="lc-kicker">Action Layer</span>
                <h2>Priority Actions</h2>
              </header>
              {priorityActions.map((item) => (
                <article key={item.id} className={`lc-priority-card lc-priority-card--${item.severity}`}>
                  <div className="lc-priority-card__meta">
                    <span>{item.source}</span>
                    <small>{item.time}</small>
                  </div>
                  <h3>{item.title}</h3>
                  <p>{item.detail}</p>
                  <footer>
                    <span>{formatKindLabel(item.kind)}</span>
                    <button onClick={() => console.log(`Open activity: ${item.id}`)}>
                      Review
                      <Icon name="chevron-right" />
                    </button>
                  </footer>
                </article>
              ))}
            </aside>
          </section>

          <section className="lc-bento-section">
            <header className="lc-section-head">
              <div>
                <span className="lc-kicker">Command Widgets</span>
                <h2>Operator Bento</h2>
              </div>
              {editMode && <strong>{layoutSavedAt ?? 'Unsaved layout'}</strong>}
            </header>

            <div className="lc-widget-bento">
              {visibleWidgets.map((widget) => (
                <article
                  key={widget.id}
                  className={`lc-widget ${getBentoWidgetClass(widget)} lc-widget--${widget.status} ${draggingWidgetId === widget.id ? 'is-dragging' : ''}`}
                  draggable={editMode}
                  onDragStart={(event) => handleDragStart(event, widget.id)}
                  onDragOver={(event) => handleDragOver(event, widget.id)}
                  onDrop={(event) => handleDrop(event, widget.id)}
                  onDragEnd={() => setDraggingWidgetId(null)}
                >
                  <header>
                    <div>
                      <span>{widget.source}</span>
                      <h3>{widget.title}</h3>
                    </div>
                    <strong>{widget.status}</strong>
                  </header>
                  {editMode && (
                    <div className="lc-widget__tools">
                      <button aria-label={`Drag ${widget.title}`}>
                        <Icon name="drag" />
                      </button>
                      <button onClick={() => removeWidget(widget.id)} aria-label={`Remove ${widget.title}`}>
                        <Icon name="close" />
                      </button>
                    </div>
                  )}
                  <div className="lc-widget__metric">{widget.primaryMetric}</div>
                  <div className="lc-sparkline" aria-hidden="true">
                    {getSparklineBars(widget.id).map((height, index) => (
                      <span key={`${widget.id}-spark-${index}`} style={{ height: `${height}%` }} />
                    ))}
                  </div>
                  <p>{widget.secondaryText}</p>
                  <footer>
                    <span>{widget.category}</span>
                    <button onClick={() => pushRoutePath(widget.appPath)}>
                      {widget.actionLabel}
                    </button>
                  </footer>
                </article>
              ))}
            </div>
          </section>
        </main>

        <aside className="lc-intelligence-drawer">
          <section className="lc-ai-panel">
            <span className="lc-kicker">AI Briefing</span>
            <h2>Good afternoon, Ryan.</h2>
            <p>Nexus recommends clearing the response and delivery backlog before expanding market pressure.</p>
            <div className="lc-confidence">
              <span>Confidence</span>
              <strong>96%</strong>
            </div>
            <div className="lc-ai-actions">
              {briefingActions.map((insight) => (
                <div key={insight.id} className={`lc-ai-action lc-ai-action--${insight.tone}`}>
                  <span>{insight.label}</span>
                  <strong>{insight.value}</strong>
                </div>
              ))}
            </div>
            <footer>
              <button>Start Review</button>
              <button>Ask Nexus</button>
            </footer>
          </section>

          <section className="lc-activity-stream">
            <header>
              <span className="lc-kicker">Live Activity</span>
              <strong>Streaming</strong>
            </header>
            {data.activities.map((item) => (
              <article key={item.id} className={`lc-stream-item lc-stream-item--${item.severity} ${toSourceClass(item.source)}`}>
                <span>{item.source}</span>
                <div>
                  <strong>{item.title}</strong>
                  <small>{item.time}</small>
                </div>
              </article>
            ))}
          </section>

          <section className="lc-health-panel">
            <header>
              <span className="lc-kicker">System Health</span>
              <strong>{data.aiScanStatus}</strong>
            </header>
            {SYSTEM_HEALTH_ITEMS.map((item) => (
              <div key={item.name} className={`lc-health-row lc-health-row--${item.tone}`}>
                <span>{item.name}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </section>
        </aside>
      </div>

      <footer className="lc-bottom-strip">
        <div>
          <span>Current Preset</span>
          <strong>{activePresetLabel}</strong>
        </div>
        <button onClick={() => setShowAddWidget(true)}>
          <Icon name="grid" />
          Add Widget
        </button>
        <button onClick={saveLayout}>Save Layout</button>
        <button onClick={resetLayout}>Reset Layout</button>
        <button onClick={() => {
          setDrawerTab('apps')
          setShowAddWidget(true)
        }}>
          Open App Library
        </button>
        <button className="lc-bottom-strip__primary" onClick={() => pushRoutePath('/dashboard/live')}>
          Open Live Map
        </button>
      </footer>

      {showAddWidget && (
        <div className="lc-overlay" onClick={() => setShowAddWidget(false)}>
          <aside className="lc-library-drawer" onClick={(event) => event.stopPropagation()}>
            <header className="lc-library-drawer__head">
              <div>
                <span className="lc-kicker">Quick Add</span>
                <h3>Command Store</h3>
                <p>Install execution systems into {STORE_COMMAND_SPACES.find((space) => space.id === quickAddDestination)?.name}.</p>
              </div>
              <button onClick={() => setShowAddWidget(false)} aria-label="Close widget library">
                <Icon name="close" />
              </button>
            </header>

            <div className="lc-library-tabs">
              {(Object.keys(STORE_TAB_LABELS) as DrawerTab[]).map((tab) => (
                <button key={tab} className={drawerTab === tab ? 'is-active' : ''} onClick={() => setDrawerTab(tab)}>
                  {STORE_TAB_LABELS[tab]}
                </button>
              ))}
            </div>

            <div className="lc-quick-store-tools">
              <label>
                <Icon name="search" />
                <input
                  value={quickAddQuery}
                  onChange={(event) => setQuickAddQuery(event.target.value)}
                  placeholder="Search widgets, apps, agents, integrations..."
                />
              </label>
              <div>
                {(['All', 'Installed', 'Available'] as const).map((status) => (
                  <button
                    key={status}
                    className={quickAddStatus === status ? 'is-active' : ''}
                    onClick={() => setQuickAddStatus(status)}
                  >
                    {status}
                  </button>
                ))}
              </div>
            </div>

            <div className="lc-quick-store-status">
              <span>{quickAddNotice}</span>
              <button onClick={() => pushRoutePath('/command-store')}>Open Full Store</button>
            </div>

            <div className="lc-quick-store-grid">
              {quickAddItems.map((item) => {
                const status = getResolvedStatus(item, storeInstalledIds)
                const matchingHomeWidget = findHomeWidgetForStoreItem(item)
                const alreadyOnCanvas = matchingHomeWidget ? visibleWidgets.some((widget) => widget.id === matchingHomeWidget.id) : false
                const canAddWidget = item.type !== 'widget' || Boolean(matchingHomeWidget)
                const primaryAction = isInstalledStatus(status) ? (canAddWidget ? 'Add' : 'Manage') : (item.type === 'integration' ? 'Connect' : 'Install')

                return (
                  <article key={item.id} className="lc-quick-store-card" style={{ '--store-accent': item.accent } as CSSProperties}>
                    <header>
                      <span className="lc-library-icon">{item.icon}</span>
                      <div>
                        <strong>{item.name}</strong>
                        <small>{item.category}</small>
                      </div>
                      <em className={`lc-store-status lc-store-status--${statusClass(status)}`}>{statusLabel(status)}</em>
                    </header>
                    <p>{item.description}</p>
                    <div className="lc-quick-store-card__meta">
                      <span>{item.type}</span>
                      <span>{item.setupTime}</span>
                      <span>{item.recommendedSpaces.slice(0, 2).map((space) => STORE_COMMAND_SPACES.find((candidate) => candidate.id === space)?.label ?? space).join(' + ')}</span>
                    </div>
                    <footer>
                      <button onClick={() => pushRoutePath('/command-store')}>Preview</button>
                      <button
                        className="is-primary"
                        disabled={alreadyOnCanvas}
                        onClick={() => {
                          if (isInstalledStatus(status)) {
                            addStoreItem(item)
                          } else {
                            installStoreItem(item)
                          }
                        }}
                      >
                        {alreadyOnCanvas ? 'Added' : primaryAction}
                      </button>
                    </footer>
                  </article>
                )
              })}
              {quickAddItems.length === 0 ? (
                <div className="lc-library-empty">
                  <strong>No modules found.</strong>
                  <span>Try another tab or search term.</span>
                </div>
              ) : null}
            </div>

            <section className="lc-quick-store-destination">
              <span className="lc-kicker">Current Destination</span>
              <div>
                {STORE_COMMAND_SPACES.slice(0, 9).map((space) => (
                  <span key={space.id} className={space.id === quickAddDestination ? 'is-active' : ''}>
                    {space.label}
                  </span>
                ))}
              </div>
            </section>
          </aside>
        </div>
      )}

      {showCommandPalette && (
        <div className="lc-overlay lc-overlay--command" onClick={() => setShowCommandPalette(false)}>
          <div className="lc-command-palette" onClick={(event) => event.stopPropagation()}>
            <input
              autoFocus
              value={commandQuery}
              onChange={(event) => setCommandQuery(event.target.value)}
              placeholder="Search commands..."
            />
            <div className="lc-command-results">
              {Object.entries(groupedCommands).map(([category, list]) => (
                <div key={category} className="lc-command-group">
                  <div>{category}</div>
                  {list.map((command) => (
                    <button
                      key={command.label}
                      onClick={() => {
                        command.action()
                        setShowCommandPalette(false)
                        setCommandQuery('')
                      }}
                    >
                      {command.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
