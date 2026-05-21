import { useMemo, useState } from 'react'
import { Icon } from '../../shared/icons'
import {
  PROPERTY_RAW_FIELD_GROUPS,
  rawFieldLabel,
  rawFieldValue,
} from '../../lib/data/propertyData'
import type { PropertyRecord } from './property.types'

interface RawRecordDrawerProps {
  property: PropertyRecord
  open: boolean
  onClose: () => void
}

export const RawRecordDrawer = ({ property, open, onClose }: RawRecordDrawerProps) => {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()

  const groups = useMemo(
    () =>
      PROPERTY_RAW_FIELD_GROUPS.map((group) => ({
        ...group,
        fields: group.fields.filter((field) => {
          const value = property.raw[field]
          if (!normalizedQuery) return true
          return field.toLowerCase().includes(normalizedQuery) || rawFieldValue(value).toLowerCase().includes(normalizedQuery)
        }),
      })).filter((group) => group.fields.length > 0),
    [normalizedQuery, property.raw],
  )

  if (!open) return null

  const copyValue = (value: unknown) => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return
    navigator.clipboard.writeText(rawFieldValue(value)).catch(() => undefined)
  }

  return (
    <aside className="pi-raw-drawer" aria-label="Raw property record">
      <header>
        <div>
          <span>Supabase Payload</span>
          <h3>Raw Record</h3>
        </div>
        <button type="button" className="pi-icon-button" onClick={onClose} title="Close raw record">
          <Icon name="close" />
        </button>
      </header>
      <label className="pi-raw-search">
        <Icon name="search" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search raw fields" />
      </label>
      <div className="pi-raw-groups">
        {groups.map((group) => (
          <section key={group.id}>
            <h4>{group.title}</h4>
            {group.fields.map((field) => (
              field === 'raw_payload_json' ? (
                <details key={field} className="pi-raw-json">
                  <summary>{rawFieldLabel(field)}</summary>
                  <pre>{JSON.stringify(property.system.rawPayloadJson ?? property.raw.raw_payload_json ?? null, null, 2)}</pre>
                </details>
              ) : (
                <div key={field}>
                  <span>{rawFieldLabel(field)}</span>
                  <strong>{rawFieldValue(property.raw[field])}</strong>
                  {['string', 'number', 'boolean'].includes(typeof property.raw[field]) && (
                    <button type="button" onClick={() => copyValue(property.raw[field])} title={`Copy ${rawFieldLabel(field)}`}>
                      <Icon name="file-text" />
                    </button>
                  )}
                </div>
              )
            ))}
          </section>
        ))}
        {groups.length === 0 && (
          <div className="pi-empty-state">
            <Icon name="filter" />
            <p>No raw fields match that search.</p>
          </div>
        )}
      </div>
    </aside>
  )
}
