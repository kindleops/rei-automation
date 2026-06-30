import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PipelineGroupByMode } from '../../../domain/pipeline/pipeline-opportunity.types'
import { PIPELINE_VIEW_OPTIONS } from '../../../domain/pipeline/pipeline-display-helpers'
import { Icon } from '../../../shared/icons'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

interface PipelineFilterMenuProps {
  groupBy: PipelineGroupByMode
  onGroupByChange: (mode: PipelineGroupByMode) => void
  hotOnly: boolean
  followUpOnly: boolean
  showSuppressed: boolean
  onHotOnly: (value: boolean) => void
  onFollowUpOnly: (value: boolean) => void
  onShowSuppressed: (value: boolean) => void
  layout?: 'mobile' | 'desktop'
}

function activeFilterCount(props: PipelineFilterMenuProps): number {
  let n = 0
  if (props.hotOnly) n++
  if (props.followUpOnly) n++
  if (props.showSuppressed) n++
  return n
}

export function PipelineFilterMenu(props: PipelineFilterMenuProps) {
  const {
    groupBy,
    onGroupByChange,
    hotOnly,
    followUpOnly,
    showSuppressed,
    onHotOnly,
    onFollowUpOnly,
    onShowSuppressed,
    layout = 'mobile',
  } = props

  const [open, setOpen] = useState(false)
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({})
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const extras = activeFilterCount(props)
  const isMobile = layout === 'mobile'

  const groupLabel = useMemo(
    () => PIPELINE_VIEW_OPTIONS.find((o) => o.value === groupBy)?.label ?? 'Stage',
    [groupBy],
  )

  const summary = useMemo(() => {
    const parts = [groupLabel]
    if (hotOnly) parts.push('Hot')
    if (followUpOnly) parts.push('Due')
    if (showSuppressed) parts.push('Suppressed')
    return parts.join(' · ')
  }, [groupLabel, hotOnly, followUpOnly, showSuppressed])

  const close = useCallback(() => setOpen(false), [])

  const updatePanelPosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const margin = 10
    const top = rect.bottom + 6
    const maxHeight = Math.max(180, Math.min(window.innerHeight - top - margin, 420))

    if (isMobile) {
      setPanelStyle({
        position: 'fixed',
        top,
        left: margin,
        right: margin,
        maxHeight,
        zIndex: 1200,
      })
      return
    }

    const panelWidth = 320
    const left = Math.min(
      Math.max(margin, rect.right - panelWidth),
      window.innerWidth - panelWidth - margin,
    )
    setPanelStyle({
      position: 'fixed',
      top,
      left,
      width: panelWidth,
      maxHeight,
      zIndex: 1200,
    })
  }, [isMobile])

  useLayoutEffect(() => {
    if (!open) return
    updatePanelPosition()
    const onLayout = () => updatePanelPosition()
    window.addEventListener('resize', onLayout)
    window.addEventListener('scroll', onLayout, true)
    return () => {
      window.removeEventListener('resize', onLayout)
      window.removeEventListener('scroll', onLayout, true)
    }
  }, [open, updatePanelPosition])

  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    if (isMobile) document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', onKey)
    }
  }, [open, close, isMobile])

  const panel = open && typeof document !== 'undefined' ? createPortal(
    <>
      <button type="button" className="occ-liquid-filter__backdrop" aria-label="Close filters" onClick={close} />
      <div
        id={panelId}
        className="occ-liquid-filter__panel is-portaled plv-liquid-filter__panel"
        role="dialog"
        aria-label="Pipeline filters"
        aria-modal="true"
        style={panelStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="occ-liquid-filter__panel-head">
          <strong>Pipeline filters</strong>
          <button type="button" className="occ-liquid-filter__close" onClick={close} aria-label="Close">
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className="occ-liquid-filter__body">
          <section className="occ-liquid-filter__section">
            <h3>Group by</h3>
            <div className="occ-liquid-filter__pills occ-liquid-filter__pills--wrap">
              {PIPELINE_VIEW_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={cls('occ-mpill', groupBy === opt.value && 'is-active')}
                  onClick={() => onGroupByChange(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </section>

          <section className="occ-liquid-filter__section">
            <h3>Quick filters</h3>
            <div className="occ-liquid-filter__pills occ-liquid-filter__pills--wrap">
              <button
                type="button"
                className={cls('occ-mpill', hotOnly && 'is-active')}
                onClick={() => onHotOnly(!hotOnly)}
              >
                Hot only
              </button>
              <button
                type="button"
                className={cls('occ-mpill', followUpOnly && 'is-active')}
                onClick={() => onFollowUpOnly(!followUpOnly)}
              >
                Follow-up due
              </button>
              <button
                type="button"
                className={cls('occ-mpill', showSuppressed && 'is-active')}
                onClick={() => onShowSuppressed(!showSuppressed)}
              >
                Show suppressed
              </button>
            </div>
          </section>
        </div>
      </div>
    </>,
    document.body,
  ) : null

  return (
    <>
      <div className={cls('occ-liquid-filter', 'plv-liquid-filter', isMobile && 'plv-liquid-filter--mobile', open && 'is-open')}>
        <button
          ref={triggerRef}
          type="button"
          className="occ-liquid-filter__trigger"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="occ-liquid-filter__trigger-icon" aria-hidden>
            <Icon name="filter" size={14} />
          </span>
          <span className="occ-liquid-filter__trigger-copy">
            <span className="occ-liquid-filter__trigger-title">Filters</span>
            <span className="occ-liquid-filter__trigger-sub">{summary}</span>
          </span>
          {extras > 0 && <span className="occ-liquid-filter__badge">{extras}</span>}
          <span className={cls('occ-liquid-filter__chev', open && 'is-open')} aria-hidden>
            <Icon name="chevron-down" size={14} />
          </span>
        </button>
      </div>
      {panel}
    </>
  )
}