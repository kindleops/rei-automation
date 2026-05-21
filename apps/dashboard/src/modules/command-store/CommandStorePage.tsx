import { useMemo, useState } from 'react'
import type { CSSProperties, MouseEvent, ReactNode } from 'react'
import { pushRoutePath } from '../../app/router'
import {
  AI_AGENT_NAMES,
  APP_EXPOSURES,
  COMMAND_DOCK_ITEMS,
  COMMAND_SPACES,
  COMMAND_STORE_ITEMS,
  FEATURED_SYSTEM_IDS,
  HERO_ORBIT_TILES,
  INTEGRATION_NAMES,
  KPI_NAMES,
  POPULAR_APP_NAMES,
  RECOMMENDED_FOR_YOU,
  STORE_CATEGORY_FILTERS,
  STORE_SHORTCUTS,
  STORE_SIDEBAR_CATEGORIES,
  STORE_SORT_OPTIONS,
  STORE_VIEW_OPTIONS,
  SYSTEM_ALERTS,
  TOP_CATEGORIES,
  TRENDING,
  UTILITY_APP_NAMES,
  type CommandStoreItem,
} from '../../data/commandStore'

type StoreFilter = (typeof STORE_CATEGORY_FILTERS)[number]
type StoreSort = (typeof STORE_SORT_OPTIONS)[number]
type StoreView = (typeof STORE_VIEW_OPTIONS)[number]

type SpacePickerState = {
  itemId: string
  x: number
  y: number
}

const STORAGE_KEY = 'nexus:command-store:installed-v2'

const statusLabel = (value: CommandStoreItem['status']) => value.replace(/_/g, ' ')

const getInitialInstallSet = () => {
  try {
    const raw = globalThis.localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set(COMMAND_STORE_ITEMS.filter((item) => item.status === 'installed' || item.status === 'connected').map((item) => item.id))
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set<string>()
    return new Set(parsed.filter((value): value is string => typeof value === 'string'))
  } catch {
    return new Set(COMMAND_STORE_ITEMS.filter((item) => item.status === 'installed' || item.status === 'connected').map((item) => item.id))
  }
}

const persistInstallSet = (installSet: Set<string>) => {
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(installSet)))
  } catch {
    // Ignore storage failures in private browsing contexts.
  }
}

const itemTypeLabel = (item: CommandStoreItem) => item.type.replace('_', ' ')

const itemToRoute = (item: CommandStoreItem) => {
  const name = item.name.toLowerCase()
  if (name.includes('inbox') || name.includes('reply')) return '/inbox'
  if (name.includes('queue') || name.includes('send')) return '/queue'
  if (name.includes('dossier') || name.includes('owner')) return '/dossier'
  if (name.includes('map') || name.includes('street') || name.includes('market')) return '/dashboard/live'
  if (name.includes('buyer') || name.includes('dispo')) return '/buyer'
  if (name.includes('title') || name.includes('contract') || name.includes('closing')) return '/title'
  if (name.includes('revenue') || name.includes('forecast') || name.includes('executive')) return '/stats'
  return '/'
}

const accentStyle = (item: CommandStoreItem) => ({ '--store-accent': item.accent } as CSSProperties)

const StatusBadge = ({ status }: { status: CommandStoreItem['status'] }) => (
  <span className={`store-status store-status--${status}`}>{statusLabel(status)}</span>
)

const InstalledBadge = ({ installed }: { installed: boolean }) =>
  installed ? <span className="store-installed-badge">Installed</span> : null

const AppIcon = ({ item, large = false }: { item: CommandStoreItem; large?: boolean }) => (
  <span className={`store-app-icon ${large ? 'store-app-icon--large' : ''}`} style={accentStyle(item)}>
    {item.icon}
  </span>
)

const MotionGlowCard = ({ children, item, className = '' }: { children: ReactNode; item: CommandStoreItem; className?: string }) => (
  <article className={`store-glow-card ${className}`.trim()} style={accentStyle(item)}>
    <div className="store-glow-card__bloom" aria-hidden="true" />
    {children}
  </article>
)

const SpacePicker = ({
  visible,
  x,
  y,
  onSelect,
  onClose,
}: {
  visible: boolean
  x: number
  y: number
  onSelect: (space: string) => void
  onClose: () => void
}) => {
  if (!visible) return null
  return (
    <div className="store-space-picker" style={{ left: x, top: y }}>
      <header>
        <strong>Add To Space</strong>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>
      {COMMAND_SPACES.slice(0, 6).map((space) => (
        <button key={space} type="button" className="store-space-picker__item" onClick={() => onSelect(space)}>
          {space}
        </button>
      ))}
    </div>
  )
}

const AppCard = ({
  item,
  installed,
  onPreview,
  onInstall,
  onAddToSpace,
}: {
  item: CommandStoreItem
  installed: boolean
  onPreview: (item: CommandStoreItem) => void
  onInstall: (item: CommandStoreItem) => void
  onAddToSpace: (event: MouseEvent<HTMLButtonElement>, item: CommandStoreItem) => void
}) => (
  <MotionGlowCard item={item} className="store-app-card" key={item.id}>
    <header>
      <AppIcon item={item} />
      <div>
        <h4>{item.name}</h4>
        <p>{itemTypeLabel(item)}</p>
      </div>
      <StatusBadge status={installed ? 'installed' : item.status} />
    </header>
    <p className="store-app-card__description">{item.description}</p>
    <div className="store-app-card__meta">
      {(item.metrics ?? []).slice(0, 2).map((metric) => (
        <span key={metric.label}>{metric.label}: {metric.value}</span>
      ))}
      <InstalledBadge installed={installed} />
    </div>
    <div className="store-app-card__spaces">
      {item.recommendedSpaces.slice(0, 2).map((space) => (
        <span key={space}>{space}</span>
      ))}
    </div>
    <footer>
      <button type="button" onClick={() => onPreview(item)}>Preview</button>
      <button type="button" className="store-app-card__action" onClick={(event) => (installed ? onAddToSpace(event, item) : onInstall(item))}>
        {installed ? 'Add To Space' : 'Install'}
      </button>
    </footer>
  </MotionGlowCard>
)

const FeaturedAppCard = ({
  item,
  installed,
  onPreview,
  onInstall,
  onAddToSpace,
}: {
  item: CommandStoreItem
  installed: boolean
  onPreview: (item: CommandStoreItem) => void
  onInstall: (item: CommandStoreItem) => void
  onAddToSpace: (event: MouseEvent<HTMLButtonElement>, item: CommandStoreItem) => void
}) => (
  <MotionGlowCard item={item} className="store-featured-card">
    <header>
      <AppIcon item={item} />
      <div>
        <h3>{item.name}</h3>
        <p>{item.tags.join(' • ')}</p>
      </div>
      <StatusBadge status={installed ? 'installed' : item.status} />
    </header>
    <p>{item.description}</p>
    <div className="store-featured-card__chips">
      {item.tags.map((tag) => (
        <span key={tag}>{tag}</span>
      ))}
    </div>
    <footer>
      <button type="button" onClick={() => onPreview(item)}>Preview</button>
      <button type="button" className="store-featured-card__cta" onClick={(event) => (installed ? onAddToSpace(event, item) : onInstall(item))}>
        {installed ? 'Add To Space' : 'Install'}
      </button>
    </footer>
  </MotionGlowCard>
)

const CompactAppCard = ({
  item,
  installed,
  onPreview,
}: {
  item: CommandStoreItem
  installed: boolean
  onPreview: (item: CommandStoreItem) => void
}) => (
  <button type="button" className="store-compact-card" style={accentStyle(item)} onClick={() => onPreview(item)}>
    <AppIcon item={item} />
    <div>
      <strong>{item.name}</strong>
      <span>{item.description}</span>
    </div>
    <StatusBadge status={installed ? 'installed' : item.status} />
  </button>
)

const AgentCard = ({ item, installed, onPreview, onAddToSpace }: {
  item: CommandStoreItem
  installed: boolean
  onPreview: (item: CommandStoreItem) => void
  onAddToSpace: (event: MouseEvent<HTMLButtonElement>, item: CommandStoreItem) => void
}) => (
  <MotionGlowCard item={item} className="store-agent-card">
    <header>
      <AppIcon item={item} />
      <div>
        <h4>{item.name}</h4>
        <p>{item.lastAction ?? 'Agent is ready for activation'}</p>
      </div>
    </header>
    <div className="store-agent-card__stats">
      <span>Confidence {item.confidence ?? '90%'}</span>
      <span>Time Saved {item.timeSaved ?? '6h/week'}</span>
      <StatusBadge status={installed ? 'installed' : item.status} />
    </div>
    <footer>
      <button type="button" onClick={() => onPreview(item)}>Preview</button>
      <button type="button" onClick={(event) => onAddToSpace(event, item)}>Add To Space</button>
    </footer>
  </MotionGlowCard>
)

const IntegrationCard = ({ item, onPreview }: { item: CommandStoreItem; onPreview: (item: CommandStoreItem) => void }) => (
  <MotionGlowCard item={item} className="store-integration-card">
    <header>
      <AppIcon item={item} />
      <div>
        <h4>{item.name}</h4>
        <p>{item.lastSync ? `Last sync ${item.lastSync}` : 'No sync recorded'}</p>
      </div>
      <StatusBadge status={item.status} />
    </header>
    <div className="store-integration-card__meta">
      <span className={item.health === 'warning' ? 'is-warning' : 'is-healthy'}>
        {item.health === 'warning' ? 'Warning' : 'Healthy'}
      </span>
      <button type="button" onClick={() => onPreview(item)}>Manage</button>
      <button type="button" onClick={() => onPreview(item)}>Add Widget</button>
    </div>
  </MotionGlowCard>
)

const HeroOrbitGraphic = () => (
  <div className="store-hero-orbit" aria-hidden="true">
    <div className="store-hero-orbit__core">
      <span>NX</span>
    </div>
    <div className="store-hero-orbit__ring store-hero-orbit__ring--one" />
    <div className="store-hero-orbit__ring store-hero-orbit__ring--two" />
    <div className="store-hero-orbit__ring store-hero-orbit__ring--three" />
    {HERO_ORBIT_TILES.map((tile, index) => (
      <div
        key={tile}
        className="store-hero-orbit__tile"
        style={{ '--index': `${index}` } as CSSProperties}
      >
        {tile}
      </div>
    ))}
  </div>
)

const StoreHero = ({
  onExploreFeatured,
  onBrowseAgents,
  onViewInstalled,
}: {
  onExploreFeatured: () => void
  onBrowseAgents: () => void
  onViewInstalled: () => void
}) => (
  <section className="store-hero">
    <div className="store-hero__copy">
      <span className="store-kicker">NEXUS Marketplace</span>
      <h1>Install operating systems, agents, automations, and intelligence into Command Spaces.</h1>
      <p>
        Command Store turns LeadCommand into a modular AI operating layer for acquisitions, sales, messaging, operations, revenue, and execution.
        Browse premium systems, preview what they include, install locally, and add them to spaces that run your business.
      </p>
      <div className="store-hero__actions">
        <button type="button" onClick={onExploreFeatured}>Explore Featured</button>
        <button type="button" onClick={onBrowseAgents}>Browse Agents</button>
        <button type="button" onClick={onViewInstalled}>View Installed</button>
      </div>
    </div>
    <div className="store-hero__visual">
      <HeroOrbitGraphic />
    </div>
  </section>
)

const CategoryTabs = ({
  active,
  onChange,
  sort,
  onSortChange,
  view,
  onViewChange,
}: {
  active: StoreFilter
  onChange: (value: StoreFilter) => void
  sort: StoreSort
  onSortChange: (value: StoreSort) => void
  view: StoreView
  onViewChange: (value: StoreView) => void
}) => (
  <section className="store-tabs">
    <div className="store-tabs__row">
      {STORE_CATEGORY_FILTERS.map((filter) => (
        <button key={filter} type="button" className={active === filter ? 'is-active' : ''} onClick={() => onChange(filter)}>
          {filter}
        </button>
      ))}
    </div>
    <div className="store-tabs__controls">
      <label>
        <span>Sort by</span>
        <select value={sort} onChange={(event) => onSortChange(event.target.value as StoreSort)}>
          {STORE_SORT_OPTIONS.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      </label>
      <div className="store-tabs__view">
        {STORE_VIEW_OPTIONS.map((option) => (
          <button key={option} type="button" className={view === option ? 'is-active' : ''} onClick={() => onViewChange(option)}>
            {option}
          </button>
        ))}
      </div>
    </div>
  </section>
)

const StoreIntelligenceSidebar = () => (
  <aside className="store-intel-sidebar">
    <section className="store-intel-card">
      <h3>NEXUS Status</h3>
      <div className="store-radar">
        <div className="store-radar__ring" />
        <div className="store-radar__dot" />
      </div>
      <strong>Operational</strong>
      <p>All systems nominal</p>
      <ul>
        <li>AI stable</li>
        <li>Queue healthy</li>
        <li>Sync online</li>
      </ul>
    </section>

    <section className="store-intel-card">
      <h3>Top Categories</h3>
      {TOP_CATEGORIES.map((category) => (
        <div key={category.label} className="store-intel-row">
          <span>{category.label}</span>
          <strong>{category.count}</strong>
        </div>
      ))}
    </section>

    <section className="store-intel-card">
      <h3>Trending Now</h3>
      {TRENDING.map((item, index) => (
        <div key={item.name} className="store-trending-row">
          <span>{index + 1}</span>
          <div>
            <strong>{item.name}</strong>
            <small>{item.velocity}</small>
          </div>
        </div>
      ))}
    </section>

    <section className="store-intel-card">
      <h3>Recommended For You</h3>
      {RECOMMENDED_FOR_YOU.map((item) => (
        <button key={item} type="button">{item}</button>
      ))}
    </section>

    <section className="store-intel-card">
      <h3>System Alerts</h3>
      {SYSTEM_ALERTS.map((alert) => (
        <div key={alert.name} className={`store-alert store-alert--${alert.state}`}>
          {alert.name}
        </div>
      ))}
    </section>
  </aside>
)

const CommandDock = () => (
  <nav className="store-command-dock" aria-label="Command Dock">
    {COMMAND_DOCK_ITEMS.map((item) => (
      <button key={item.label} type="button" className={'active' in item && item.active ? 'is-active' : ''}>
        <span>{item.icon}</span>
        <small>{item.label}</small>
        {'badge' in item ? <em>{item.badge}</em> : null}
      </button>
    ))}
  </nav>
)

const AppPreviewDrawer = ({
  item,
  installed,
  onClose,
  onInstall,
  onAddToSpace,
}: {
  item: CommandStoreItem | null
  installed: boolean
  onClose: () => void
  onInstall: (item: CommandStoreItem) => void
  onAddToSpace: (event: MouseEvent<HTMLButtonElement>, item: CommandStoreItem) => void
}) => {
  if (!item) return null
  const exposure = APP_EXPOSURES[item.name] ?? ['Full App', 'Widget', 'Agent', 'Automation', 'Report', 'Map Layer', 'Alert', 'Integration']
  return (
    <div className="store-drawer-overlay" onClick={onClose}>
      <aside className="store-drawer" onClick={(event) => event.stopPropagation()}>
        <header style={accentStyle(item)}>
          <AppIcon item={item} large />
          <div>
            <small>{item.category}</small>
            <h2>{item.name}</h2>
            <StatusBadge status={installed ? 'installed' : item.status} />
          </div>
          <button type="button" onClick={onClose}>Close</button>
        </header>

        <section className="store-drawer__summary">
          <p>{item.longDescription ?? item.description}</p>
          <div className="store-drawer__shots">
            <div>Preview Screenshot A</div>
            <div>Preview Screenshot B</div>
            <div>Preview Screenshot C</div>
          </div>
        </section>

        <section className="store-drawer__details">
          <div>
            <h4>What It Does</h4>
            <p>{item.description}</p>
          </div>
          <div>
            <h4>Included Widgets</h4>
            {(item.includedWidgets ?? []).length ? (item.includedWidgets ?? []).map((widgetName) => <span key={widgetName}>{widgetName}</span>) : <span>None listed</span>}
          </div>
          <div>
            <h4>Included Automations</h4>
            {(item.includedAutomations ?? []).length ? (item.includedAutomations ?? []).map((automationName) => <span key={automationName}>{automationName}</span>) : <span>None listed</span>}
          </div>
          <div>
            <h4>Required Integrations</h4>
            {(item.requiredIntegrations ?? []).length ? (item.requiredIntegrations ?? []).map((integrationName) => <span key={integrationName}>{integrationName}</span>) : <span>None listed</span>}
          </div>
          <div>
            <h4>Data Sources</h4>
            {(item.dataSources ?? []).length ? (item.dataSources ?? []).map((source) => <span key={source}>{source}</span>) : <span>None listed</span>}
          </div>
          <div>
            <h4>Permissions</h4>
            <span>Read Module Events</span>
            <span>Write Space Layout Preferences</span>
            <span>Invoke Automation Actions</span>
          </div>
          <div>
            <h4>Recommended Spaces</h4>
            {item.recommendedSpaces.map((space) => <span key={space}>{space}</span>)}
          </div>
          <div>
            <h4>Activity Logs</h4>
            <span>Deployment validated</span>
            <span>Health checks passing</span>
            <span>No critical alerts</span>
          </div>
          <div>
            <h4>Recent Updates</h4>
            <span>Enhanced metrics rendering</span>
            <span>Improved add-to-space hooks</span>
            <span>Refined card interactions</span>
          </div>
          <div>
            <h4>Exposes</h4>
            {exposure.map((itemName) => <span key={itemName}>{itemName}</span>)}
          </div>
        </section>

        <footer>
          <button type="button" onClick={() => pushRoutePath(itemToRoute(item))}>Preview Full Module</button>
          <button type="button" onClick={(event) => onAddToSpace(event, item)}>Add To Space</button>
          <button type="button" className="store-drawer__install" onClick={() => onInstall(item)}>
            {installed ? 'Installed' : 'Install To Market Intelligence Space'}
          </button>
        </footer>
      </aside>
    </div>
  )
}

export const CommandStorePage = () => {
  const [activeNav, setActiveNav] = useState<'Store' | 'Installed' | 'Integrations' | 'My Spaces'>('Store')
  const [activeSidebarCategory, setActiveSidebarCategory] = useState('featured')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<StoreFilter>('All')
  const [sort, setSort] = useState<StoreSort>('Recommended')
  const [view, setView] = useState<StoreView>('Grid')
  const [installSet, setInstallSet] = useState<Set<string>>(getInitialInstallSet)
  const [selectedItem, setSelectedItem] = useState<CommandStoreItem | null>(null)
  const [spacePicker, setSpacePicker] = useState<SpacePickerState | null>(null)
  const [toast, setToast] = useState('Command Store online')

  const install = (item: CommandStoreItem) => {
    setInstallSet((current) => {
      const next = new Set(current)
      next.add(item.id)
      persistInstallSet(next)
      return next
    })
    setToast(`${item.name} installed`)
    // TODO: persist installed modules
  }

  const onAddToSpace = (event: MouseEvent<HTMLButtonElement>, item: CommandStoreItem) => {
    const rect = (event.currentTarget as HTMLButtonElement).getBoundingClientRect()
    setSpacePicker({ itemId: item.id, x: rect.left, y: rect.bottom + 10 })
  }

  const completeAddToSpace = (space: string) => {
    const item = COMMAND_STORE_ITEMS.find((candidate) => candidate.id === spacePicker?.itemId)
    if (!item) return
    setToast(`${item.name} added to ${space}`)
    setSpacePicker(null)
    // TODO: fetch workspace spaces
    // TODO: connect Add to Space action
    // TODO: persist homepage widgets
  }

  const withInstallStatus = useMemo(
    () => COMMAND_STORE_ITEMS.map((item) => ({ item, installed: installSet.has(item.id) || item.status === 'connected' })),
    [installSet],
  )

  const searched = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return withInstallStatus
    return withInstallStatus.filter(({ item }) => {
      return [item.name, item.description, item.category, item.tags.join(' ')].some((value) => value.toLowerCase().includes(normalized))
    })
  }, [query, withInstallStatus])

  const filtered = useMemo(() => {
    let list = searched
    if (filter === 'Installed') list = list.filter(({ installed }) => installed)
    if (filter === 'Featured') list = list.filter(({ item }) => item.category === 'Featured')
    if (filter === 'Apps') list = list.filter(({ item }) => item.type === 'app')
    if (filter === 'Agents') list = list.filter(({ item }) => item.type === 'agent')
    if (filter === 'Automations') list = list.filter(({ item }) => item.type === 'automation')
    if (filter === 'Widgets') list = list.filter(({ item }) => item.type === 'widget')
    if (filter === 'Dashboards') list = list.filter(({ item }) => item.category === 'Dashboards')
    if (filter === 'Integrations') list = list.filter(({ item }) => item.type === 'integration')
    if (filter === 'Map Layers') list = list.filter(({ item }) => item.type === 'map_layer')
    if (filter === 'Templates') list = list.filter(({ item }) => item.type === 'template')
    if (filter === 'Reports') list = list.filter(({ item }) => item.type === 'report')

    if (sort === 'Installed First') {
      list = [...list].sort((a, b) => Number(b.installed) - Number(a.installed))
    }
    if (sort === 'Recently Added') {
      list = [...list].sort((a, b) => b.item.id.localeCompare(a.item.id))
    }
    if (sort === 'Most Used') {
      list = [...list].sort((a, b) => (b.item.metrics?.[0]?.value ?? '').localeCompare(a.item.metrics?.[0]?.value ?? ''))
    }
    if (sort === 'Needs Setup') {
      list = [...list].sort((a, b) => Number(a.item.status === 'needs_auth') - Number(b.item.status === 'needs_auth'))
    }

    return list
  }, [filter, searched, sort])

  const getByName = (name: string) => withInstallStatus.find((entry) => entry.item.name === name)
  const getById = (id: string) => withInstallStatus.find((entry) => entry.item.id === id)

  const featured = FEATURED_SYSTEM_IDS.map((id) => getById(id)).filter((entry): entry is { item: CommandStoreItem; installed: boolean } => Boolean(entry))
  const popularApps = POPULAR_APP_NAMES.map((name) => getByName(name)).filter((entry): entry is { item: CommandStoreItem; installed: boolean } => Boolean(entry))
  const aiAgents = AI_AGENT_NAMES.map((name) => getByName(name)).filter((entry): entry is { item: CommandStoreItem; installed: boolean } => Boolean(entry))
  const utilityApps = UTILITY_APP_NAMES.map((name, index) => {
    const found = getByName(name)
    if (found) return found
    const accent = ['#68d4b8', '#7fb7ff', '#ffbf79', '#89c8ff'][index % 4]
    return { item: appStub(name, accent), installed: false }
  })
  const kpiApps = KPI_NAMES.map((name) => getByName(name)).filter((entry): entry is { item: CommandStoreItem; installed: boolean } => Boolean(entry))
  const integrations = INTEGRATION_NAMES.map((name) => getByName(name)).filter((entry): entry is { item: CommandStoreItem; installed: boolean } => Boolean(entry))

  const installedCount = withInstallStatus.filter((entry) => entry.installed).length

  return (
    <div className="store-page">
      <header className="store-top-bar">
        <div className="store-brand" role="button" tabIndex={0} onClick={() => pushRoutePath('/')} onKeyDown={(event) => {
          if (event.key === 'Enter') pushRoutePath('/')
        }}>
          <span>NX</span>
          <div>
            <small>LEADCOMMAND.AI / NEXUS</small>
            <strong>Command Store</strong>
          </div>
        </div>

        <label className="store-search">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search apps, agents, automations, widgets, layers..."
          />
          <kbd>Cmd K</kbd>
        </label>

        <nav className="store-top-nav">
          {(['Store', 'Installed', 'Integrations', 'My Spaces'] as const).map((name) => (
            <button key={name} type="button" className={activeNav === name ? 'is-active' : ''} onClick={() => setActiveNav(name)}>
              {name}
            </button>
          ))}
          <button type="button" onClick={() => pushRoutePath('/')}>Back Home</button>
          <button type="button" aria-label="Notifications">Alerts 7</button>
          <span className="store-operator">Operator Online</span>
        </nav>
      </header>

      <div className="store-layout">
        <aside className="store-sidebar">
          <span className="store-kicker">Browse</span>
          {STORE_SIDEBAR_CATEGORIES.map((category) => (
            <button
              key={category.id}
              type="button"
              className={activeSidebarCategory === category.id ? 'is-active' : ''}
              onClick={() => setActiveSidebarCategory(category.id)}
            >
              <span>{category.icon}</span>
              <strong>{category.label}</strong>
              <em>{category.count}</em>
            </button>
          ))}

          <div className="store-sidebar__shortcuts">
            <h4>Shortcuts</h4>
            {STORE_SHORTCUTS.map((shortcut) => (
              <button key={shortcut.label} type="button">
                <span>{shortcut.icon}</span>
                {shortcut.label}
              </button>
            ))}
          </div>

          <div className="store-sidebar__promo">
            <strong>Build Custom Systems</strong>
            <p>Create your own apps, agents, automations, and workflows with NEXUS Studio.</p>
            <button type="button">Open NEXUS Studio</button>
          </div>
        </aside>

        <main className="store-content">
          <StoreHero
            onExploreFeatured={() => setFilter('Featured')}
            onBrowseAgents={() => setFilter('Agents')}
            onViewInstalled={() => setFilter('Installed')}
          />

          <CategoryTabs
            active={filter}
            onChange={setFilter}
            sort={sort}
            onSortChange={setSort}
            view={view}
            onViewChange={setView}
          />

          <section className="store-section">
            <div className="store-section__head">
              <h2>Featured Systems</h2>
              <button type="button" onClick={() => setFilter('Featured')}>View All</button>
            </div>
            <div className="store-featured-rail">
              {featured.map(({ item, installed }) => (
                <FeaturedAppCard key={item.id} item={item} installed={installed} onPreview={setSelectedItem} onInstall={install} onAddToSpace={onAddToSpace} />
              ))}
            </div>
          </section>

          <section className="store-section">
            <div className="store-section__head">
              <h2>Popular Apps</h2>
              <button type="button" onClick={() => setFilter('Apps')}>View All</button>
            </div>
            <div className="store-compact-grid">
              {popularApps.map(({ item, installed }) => (
                <CompactAppCard key={item.id} item={item} installed={installed} onPreview={setSelectedItem} />
              ))}
            </div>
          </section>

          <section className="store-section">
            <div className="store-section__head">
              <h2>AI Agents</h2>
              <button type="button" onClick={() => setFilter('Agents')}>View All</button>
            </div>
            <div className="store-agent-grid">
              {aiAgents.map(({ item, installed }) => (
                <AgentCard key={item.id} item={item} installed={installed} onPreview={setSelectedItem} onAddToSpace={onAddToSpace} />
              ))}
            </div>
          </section>

          <section className="store-section">
            <div className="store-section__head">
              <h2>Utility And Productivity</h2>
              <button type="button">View All</button>
            </div>
            <div className="store-compact-grid">
              {utilityApps.map(({ item, installed }) => (
                <CompactAppCard key={item.id} item={item} installed={installed} onPreview={setSelectedItem} />
              ))}
            </div>
          </section>

          <section className="store-section">
            <div className="store-section__head">
              <h2>KPI Dashboards</h2>
              <button type="button" onClick={() => setFilter('Dashboards')}>View All</button>
            </div>
            <div className="store-compact-grid">
              {kpiApps.map(({ item, installed }) => (
                <CompactAppCard key={item.id} item={item} installed={installed} onPreview={setSelectedItem} />
              ))}
            </div>
          </section>

          <section className="store-section">
            <div className="store-section__head">
              <h2>Integrations</h2>
              <button type="button" onClick={() => setFilter('Integrations')}>View All</button>
            </div>
            <div className="store-integration-grid">
              {integrations.map(({ item }) => (
                <IntegrationCard key={item.id} item={item} onPreview={setSelectedItem} />
              ))}
            </div>
          </section>

          <section className="store-section">
            <div className="store-section__head">
              <h2>Installed In This Space</h2>
              <span>{installedCount} installed modules</span>
            </div>
            <div className={`store-app-grid store-app-grid--${view.toLowerCase()}`}>
              {filtered.map(({ item, installed }) => (
                <AppCard key={item.id} item={item} installed={installed} onPreview={setSelectedItem} onInstall={install} onAddToSpace={onAddToSpace} />
              ))}
            </div>
          </section>
        </main>

        <StoreIntelligenceSidebar />
      </div>

      <SpacePicker
        visible={Boolean(spacePicker)}
        x={spacePicker?.x ?? 0}
        y={spacePicker?.y ?? 0}
        onSelect={completeAddToSpace}
        onClose={() => setSpacePicker(null)}
      />

      <AppPreviewDrawer
        item={selectedItem}
        installed={selectedItem ? installSet.has(selectedItem.id) : false}
        onClose={() => setSelectedItem(null)}
        onInstall={install}
        onAddToSpace={onAddToSpace}
      />

      <CommandDock />
      <div className="store-toast">{toast}</div>

      <div className="store-hidden-todos" aria-hidden="true">
        {/* TODO: fetch installed apps from Supabase */}
        {/* TODO: fetch integration statuses */}
      </div>
    </div>
  )
}

const appStub = (name: string, accent: string): CommandStoreItem => ({
  id: `stub-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  name,
  type: 'app',
  category: 'Utility',
  description: `${name} utility module for operator workflow speed.`,
  status: 'available',
  accent,
  icon: name
    .split(' ')
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase(),
  recommendedSpaces: ['Homepage'],
  tags: ['utility'],
})
