import type { ReactNode } from 'react'
import { pushRoutePath } from '../../../app/router'
import { Icon } from '../../../shared/icons'

export interface AcquisitionAppShellProps {
  breadcrumb: string
  appName: string
  appDescription: string
  shellClassName?: string
  appStatus?: string
  marketOptions?: string[]
  selectedMarket?: string
  onMarketChange?: (market: string) => void
  search?: string
  onSearchChange?: (query: string) => void
  viewMode?: 'table' | 'grid' | 'cards'
  onViewModeChange?: (mode: 'table' | 'grid' | 'cards') => void
  actions?: Array<{ label: string; onClick: () => void; icon?: string }>
  children: ReactNode
}

export const AcquisitionAppShell = ({
  breadcrumb,
  appName,
  appDescription,
  shellClassName,
  appStatus,
  marketOptions,
  selectedMarket,
  onMarketChange,
  search,
  onSearchChange,
  viewMode = 'table',
  onViewModeChange,
  actions,
  children,
}: AcquisitionAppShellProps) => {
  return (
    <section className={['acq-app-shell', shellClassName].filter(Boolean).join(' ')}>
      <header className="acq-app-header">
        <div className="acq-app-header__title">
          <nav className="acq-breadcrumb">
            <button type="button" onClick={() => pushRoutePath('/acquisition')}>
              LeadCommand
            </button>
            <span>/</span>
            <button type="button" onClick={() => pushRoutePath('/acquisition')}>
              Acquisition
            </button>
            <span>/</span>
            <span>{breadcrumb}</span>
          </nav>
          <h1>{appName}</h1>
          <p>{appDescription}</p>
          {appStatus && <span className="acq-app-status">{appStatus}</span>}
        </div>

        <div className="acq-app-toolbar">
          {marketOptions && onMarketChange && (
            <label>
              <span>Market</span>
              <select value={selectedMarket ?? 'All Markets'} onChange={(e) => onMarketChange(e.target.value)}>
                {marketOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          )}

          {onSearchChange && (
            <label className="acq-app-search">
              <Icon name="search" />
              <input
                value={search ?? ''}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="Search..."
              />
            </label>
          )}

          {onViewModeChange && (
            <div className="acq-view-switcher">
              <button
                type="button"
                className={viewMode === 'table' ? 'is-active' : ''}
                onClick={() => onViewModeChange('table')}
                title="Table view"
              >
                <Icon name="grid" />
              </button>
              <button
                type="button"
                className={viewMode === 'cards' ? 'is-active' : ''}
                onClick={() => onViewModeChange('cards')}
                title="Cards view"
              >
                <Icon name="grid" />
              </button>
            </div>
          )}

          {actions && actions.length > 0 && (
            <div className="acq-app-actions">
              {actions.map((action) => (
                <button key={action.label} type="button" onClick={action.onClick}>
                  {action.icon && <Icon name={action.icon as any} />}
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      <div className="acq-app-content">{children}</div>
    </section>
  )
}
