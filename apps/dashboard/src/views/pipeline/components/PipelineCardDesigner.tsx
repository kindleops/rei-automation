import { useMemo, useState } from 'react'
import type { PipelineCardDesign, CardSlotKey } from '../../../domain/pipeline/pipeline-card-design.types'
import type { PipelineGroupByMode, PipelineOpportunity } from '../../../domain/pipeline/pipeline-opportunity.types'
import { CARD_SLOT_KEYS } from '../../../domain/pipeline/pipeline-card-design.types'
import { getCardCompatibleFields, PIPELINE_FIELD_GROUP_LABELS } from '../../../domain/pipeline/pipeline-display-field-registry'
import { getRecommendedCardDesign, cloneCardDesign } from '../../../domain/pipeline/pipeline-card-presets'
import { PipelineConfigurableCard } from './PipelineConfigurableCard'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const SLOT_LABELS: Record<CardSlotKey, string> = {
  accent: 'Accent',
  eyebrow: 'Eyebrow',
  title: 'Primary Title',
  subtitle: 'Secondary Line',
  badge_1: 'Badge 1',
  badge_2: 'Badge 2',
  badge_3: 'Badge 3',
  preview: 'Preview',
  metric_1: 'Metric 1',
  metric_2: 'Metric 2',
  metric_3: 'Metric 3',
  footer: 'Footer',
}

interface PipelineCardDesignerProps {
  open: boolean
  onClose: () => void
  design: PipelineCardDesign
  groupBy: PipelineGroupByMode
  previewOpp: PipelineOpportunity | null
  onChange: (design: PipelineCardDesign) => void
  onSave: () => void
}

export function PipelineCardDesigner({
  open,
  onClose,
  design,
  groupBy,
  previewOpp,
  onChange,
  onSave,
}: PipelineCardDesignerProps) {
  const [activeSlot, setActiveSlot] = useState<CardSlotKey>('title')
  const cardFields = useMemo(() => getCardCompatibleFields(), [])
  const grouped = useMemo(() => {
    const map = new Map<string, typeof cardFields>()
    for (const f of cardFields) {
      const g = f.group
      if (!map.has(g)) map.set(g, [])
      map.get(g)!.push(f)
    }
    return map
  }, [cardFields])

  if (!open) return null

  const cycleField = (slot: CardSlotKey) => {
    const current = design.slots[slot]?.fieldKey
    const idx = cardFields.findIndex((f) => f.key === current)
    const next = cardFields[(idx + 1) % cardFields.length]
    onChange({
      ...design,
      slots: {
        ...design.slots,
        [slot]: { fieldKey: next.key, disabled: false },
      },
    })
  }

  const toggleSlot = (slot: CardSlotKey) => {
    const current = design.slots[slot]
    onChange({
      ...design,
      slots: {
        ...design.slots,
        [slot]: { ...current, disabled: !current.disabled },
      },
    })
  }

  const setDensity = (density: PipelineCardDesign['density']) => onChange({ ...design, density })
  const setPreviewLines = (previewLines: PipelineCardDesign['previewLines']) => onChange({ ...design, previewLines })

  return (
    <div className="plv-card-designer-overlay" role="presentation" onClick={onClose}>
      <div className="plv-card-designer nx-glass-menu" role="dialog" aria-label="Card designer" onClick={(e) => e.stopPropagation()}>
        <header className="plv-card-designer__header">
          <div>
            <strong>Card Designer</strong>
            <span className="plv-card-designer__subtitle">{groupBy.replace(/_/g, ' ')} view</span>
          </div>
          <button type="button" className="plv-card-designer__close" onClick={onClose}>×</button>
        </header>

        <div className="plv-card-designer__body">
          <section className="plv-card-designer__preview">
            <h4>Live Preview</h4>
            {previewOpp ? (
              <PipelineConfigurableCard
                opp={previewOpp}
                design={design}
                layoutMode="full"
              />
            ) : (
              <div className="plv-card-designer__preview-empty">Select an opportunity for preview</div>
            )}
          </section>

          <section className="plv-card-designer__slots">
            <h4>Card Slots</h4>
            <div className="plv-card-designer__slot-list">
              {CARD_SLOT_KEYS.map((slot) => {
                const cfg = design.slots[slot]
                const field = cardFields.find((f) => f.key === cfg.fieldKey)
                return (
                  <div
                    key={slot}
                    className={cls('plv-card-designer__slot', activeSlot === slot && 'is-active', cfg.disabled && 'is-disabled')}
                    onClick={() => setActiveSlot(slot)}
                  >
                    <span className="plv-card-designer__slot-label">{SLOT_LABELS[slot]}</span>
                    <button type="button" className="plv-glass-select" onClick={(e) => { e.stopPropagation(); cycleField(slot) }}>
                      {cfg.disabled ? 'Disabled' : field?.label ?? 'None'}
                    </button>
                    <button type="button" className="plv-glass-toggle" onClick={(e) => { e.stopPropagation(); toggleSlot(slot) }}>
                      {cfg.disabled ? 'Off' : 'On'}
                    </button>
                  </div>
                )
              })}
            </div>
          </section>

          <section className="plv-card-designer__picker">
            <h4>Field Picker</h4>
            {Array.from(grouped.entries()).map(([group, fields]) => (
              <div key={group} className="plv-card-designer__field-group">
                <span className="plv-card-designer__group-label">
                  {PIPELINE_FIELD_GROUP_LABELS[group as keyof typeof PIPELINE_FIELD_GROUP_LABELS] ?? group}
                </span>
                <div className="plv-card-designer__field-grid">
                  {fields.map((f) => (
                    <button
                      key={f.key}
                      type="button"
                      className={cls(
                        'plv-card-designer__field-btn',
                        design.slots[activeSlot]?.fieldKey === f.key && 'is-selected',
                      )}
                      title={f.description}
                      onClick={() => onChange({
                        ...design,
                        slots: {
                          ...design.slots,
                          [activeSlot]: { fieldKey: f.key, disabled: false },
                        },
                      })}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </section>

          <section className="plv-card-designer__options">
            <h4>Display Options</h4>
            <div className="plv-card-designer__option-row">
              <span>Density</span>
              {(['compact', 'standard', 'expanded'] as const).map((d) => (
                <button key={d} type="button" className={cls('plv-glass-toggle', design.density === d && 'is-active')} onClick={() => setDensity(d)}>
                  {d}
                </button>
              ))}
            </div>
            <div className="plv-card-designer__option-row">
              <span>Preview lines</span>
              <button type="button" className={cls('plv-glass-toggle', design.previewLines === 1 && 'is-active')} onClick={() => setPreviewLines(1)}>1 line</button>
              <button type="button" className={cls('plv-glass-toggle', design.previewLines === 2 && 'is-active')} onClick={() => setPreviewLines(2)}>2 lines</button>
            </div>
            <div className="plv-card-designer__option-row">
              <span>Empty values</span>
              <button type="button" className={cls('plv-glass-toggle', design.emptyBehavior === 'hide' && 'is-active')} onClick={() => onChange({ ...design, emptyBehavior: 'hide' })}>Hide</button>
              <button type="button" className={cls('plv-glass-toggle', design.emptyBehavior === 'placeholder' && 'is-active')} onClick={() => onChange({ ...design, emptyBehavior: 'placeholder' })}>Placeholder</button>
            </div>
          </section>
        </div>

        <footer className="plv-card-designer__footer">
          <button
            type="button"
            className="plv-glass-btn plv-glass-btn--ghost"
            onClick={() => onChange(cloneCardDesign(getRecommendedCardDesign(groupBy)))}
          >
            Reset to recommended
          </button>
          <button type="button" className="plv-glass-btn plv-glass-btn--primary" onClick={() => { onSave(); onClose() }}>
            Save card design
          </button>
        </footer>
      </div>
    </div>
  )
}