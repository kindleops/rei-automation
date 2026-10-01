import { memo } from 'react'
import { LCButton, LCIconButton, LCMenu, LCTooltip, cx, type LCMenuEntry } from '../../../shared/lc'
import { SECOND_CLOCK, useNow } from './war-room-hooks'
import { OWNER_LABEL, relative, type Mission, type Next } from './war-room-model'

/**
 * CAMPAIGN HERO — name, status in the product's own words, channel · market ·
 * zone · source, WHY it is in that state, and NEXT. The control bar holds the
 * one action the state calls for, Schedule, and More; nothing else.
 */

export type HeroAction = { id: string; label: string; variant: 'primary' | 'secondary' | 'danger'; disabled?: boolean; reason?: string }

function NextLine({ next }: { next: Next }) {
  // a countdown ticks by the second only while it is under an hour away
  const now = useNow(SECOND_CLOCK)
  const live = next.at ? relative(next.at, now) : next.rel
  return (
    <p className="cc3-next" data-tone={next.tone}>
      <span className="cc3-next__eyebrow">Next</span>
      <span className="cc3-next__label">{next.label}</span>
      {next.when ? <span className="cc3-next__when">{next.when}</span> : null}
      {live ? <span className="cc3-next__rel lc-num">{live}</span> : null}
      {next.expected ? <span className="cc3-next__basis">expected · every 5 min</span> : null}
    </p>
  )
}

export const WarHero = memo(function WarHero({
  title, eyebrow, mission, specs, next, primary, secondary, more, busy, onAction, inspectorOpen, onToggleInspector, onOpenRail, showRailToggle,
}: {
  title: string
  eyebrow: string
  mission: Mission
  specs: Array<{ key: string; text: string; hint?: string }>
  next: Next
  primary: HeroAction | null
  secondary: HeroAction | null
  more: LCMenuEntry[]
  busy: string | null
  onAction: (id: string) => void
  inspectorOpen: boolean
  onToggleInspector: () => void
  onOpenRail: () => void
  showRailToggle: boolean
}) {
  return (
    <header className="cc3-hero" data-tone={mission.tone} data-mission={mission.key}>
      <div className="cc3-hero__field" aria-hidden="true" />
      <div className="cc3-hero__top">
        {showRailToggle ? <LCIconButton icon="list" label="Campaigns" variant="glass" onClick={onOpenRail} /> : null}
        <div className="cc3-hero__id">
          <span className="cc3-hero__eyebrow">{eyebrow}</span>
          <h2 className="cc3-hero__title" title={title}>{title}</h2>
        </div>
        <div className="cc3-hero__bar" role="toolbar" aria-label="Campaign controls">
          {primary ? (
            <LCTooltip content={primary.disabled ? primary.reason : undefined} disabled={!primary.disabled}>
              <span className="cc3-hero__btnwrap">
                <LCButton variant={primary.variant} size="md" loading={busy === primary.id} disabled={busy !== null || primary.disabled} onClick={() => onAction(primary.id)}>{primary.label}</LCButton>
              </span>
            </LCTooltip>
          ) : null}
          {secondary ? (
            <LCButton variant="secondary" size="md" disabled={busy !== null || secondary.disabled} loading={busy === secondary.id} onClick={() => onAction(secondary.id)}>{secondary.label}</LCButton>
          ) : null}
          {more.length ? (
            <LCMenu label="More campaign actions" title={title} items={more} trigger={<LCIconButton icon="more" label="More" variant="glass" disabled={busy !== null} />} />
          ) : null}
          <LCIconButton icon="layout-split" label={inspectorOpen ? 'Hide inspector' : 'Show inspector'} selected={inspectorOpen} variant="glass" onClick={onToggleInspector} />
        </div>
      </div>
      <div className="cc3-hero__status">
        <span className={cx('cc3-state', mission.live && 'is-live')} data-tone={mission.tone}>
          <span className="cc3-state__dot" aria-hidden="true" />
          {mission.label}
        </span>
        {mission.owner && mission.group === 'attention' ? <span className="cc3-owner">{OWNER_LABEL[mission.owner]} action</span> : null}
        <span className="cc3-specs">
          {specs.map((s) => <span key={s.key} title={s.hint}>{s.text}</span>)}
        </span>
      </div>
      {mission.why ? <p className="cc3-hero__why">{mission.why}</p> : null}
      <NextLine next={next} />
    </header>
  )
})
