import { CALENDAR_LAYER_OPTIONS, loadCalendarLayers, saveCalendarLayers, type CalendarLayerId } from '../../../lib/calendar/calendar-layers'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type CalendarLayersMenuProps = {
  layers: CalendarLayerId[]
  onChange: (layers: CalendarLayerId[]) => void
  selectedSellerActive?: boolean
  selectedSellerDisabledReason?: string | null
}

export function CalendarLayersMenu({
  layers,
  onChange,
  selectedSellerActive,
  selectedSellerDisabledReason,
}: CalendarLayersMenuProps) {
  const toggle = (id: CalendarLayerId) => {
    const next = layers.includes(id) ? layers.filter((layer) => layer !== id) : [...layers, id]
    onChange(next.length ? next : loadCalendarLayers())
    saveCalendarLayers(next.length ? next : CALENDAR_LAYER_OPTIONS.map((l) => l.id))
  }

  return (
    <div className="nx-cal__layers">
      <span className="nx-cal__eyebrow">Layers</span>
      <div className="nx-cal__layers-grid">
        {CALENDAR_LAYER_OPTIONS.map((layer) => (
          <button
            key={layer.id}
            type="button"
            className={cls('nx-cal__layer-chip', layers.includes(layer.id) && 'is-active')}
            onClick={() => toggle(layer.id)}
          >
            {layer.label}
          </button>
        ))}
      </div>
      {selectedSellerActive ? (
        <p className="nx-cal__layers-note">Selected Seller scope active from global entity context.</p>
      ) : selectedSellerDisabledReason ? (
        <p className="nx-cal__layers-note">{selectedSellerDisabledReason}</p>
      ) : null}
    </div>
  )
}