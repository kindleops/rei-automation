import type { ReactNode } from 'react'

export interface DossierFactItem {
  label: string
  value: ReactNode
  /** Raw stored value — surfaced in title/tooltip for diagnostics disclosure. */
  raw?: string | null
  kind?: 'fact' | 'derived' | 'missing'
  emptyLabel?: string
}

export interface DossierFactGridProps {
  items: DossierFactItem[]
  columns?: 1 | 2 | 3
  className?: string
}

function renderValue(item: DossierFactItem) {
  if (item.value === null || item.value === undefined || item.value === '') {
    return <span className="cd-absent">{item.emptyLabel ?? 'Not projected'}</span>
  }
  return item.value
}

export function DossierFactGrid({ items, columns = 2, className }: DossierFactGridProps) {
  return (
    <dl
      className={`cd-fact-grid cd-fact-grid--cols-${columns}${className ? ` ${className}` : ''}`}
      data-testid="cd-fact-grid"
    >
      {items.map((item) => (
        <div
          key={item.label}
          className={`cd-fact-row cd-fact-row--${item.kind ?? 'fact'}`}
          data-testid="cd-fact-row"
        >
          <dt className="cd-fact-row__label">{item.label}</dt>
          <dd className="cd-fact-row__value" title={item.raw ?? undefined}>
            {renderValue(item)}
          </dd>
        </div>
      ))}
    </dl>
  )
}