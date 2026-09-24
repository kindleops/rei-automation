/**
 * CAMPAIGN BUILDER CHROME — mobile.
 *
 * The previous builder put its step navigation at the BOTTOM of the screen as a
 * row of 10px caps ("BUILD · REACH · LAUNCH") beside a counter that read
 * "— NOT COUNTED", and gave BUILD and REACH no primary action at all: the only
 * way forward was to notice that the tiny labels were tappable.
 *
 * Mobile convention puts these the other way round, for a reason. Where you
 * are belongs at the top, where the eye starts. What you do next belongs at the
 * bottom, where the thumb already is. So:
 *
 *   BuilderTop     title + a step indicator that says done / here / needs you
 *   BuilderFooter  one sticky primary action, and one supporting fact
 *
 * Neither owns any campaign logic. Step state and actions are computed by the
 * modal and passed in; these only present them.
 */
import { Icon } from '../../../../shared/icons'
import type { BuilderStep } from '../../campaign-launch-plan'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export type StepState = 'done' | 'current' | 'attention' | 'upcoming'

const STEPS: Array<{ key: BuilderStep; label: string }> = [
  { key: 'build', label: 'Build' },
  { key: 'reach', label: 'Reach' },
  { key: 'launch', label: 'Launch' },
]

export function BuilderTop({
  title,
  subtitle,
  step,
  states,
  onStep,
  onClose,
}: {
  title: string
  subtitle?: string | null
  step: BuilderStep
  states: Record<BuilderStep, StepState>
  onStep: (step: BuilderStep) => void
  onClose: () => void
}) {
  const currentIndex = STEPS.findIndex((s) => s.key === step)

  return (
    <header className="cbt">
      <div className="cbt__row">
        <div className="cbt__title">
          <h2 className="cbt__h">{title}</h2>
          {subtitle ? <p className="cbt__sub">{subtitle}</p> : null}
        </div>
        <button type="button" className="cbt__close" onClick={onClose} aria-label="Close builder">
          <Icon name="x" size={17} />
        </button>
      </div>

      <nav className="cbt__steps" aria-label="Campaign builder steps">
        {/* A track behind the steps fills to the current one, so progress reads
            at a glance before any label does. */}
        <span className="cbt__track" aria-hidden="true">
          <span
            className="cbt__track-fill"
            style={{ width: `${(currentIndex / (STEPS.length - 1)) * 100}%` }}
          />
        </span>
        {STEPS.map((s, i) => {
          const state = states[s.key]
          return (
            <button
              key={s.key}
              type="button"
              className={cls('cbt__step', `is-${state}`, s.key === step && 'is-here')}
              aria-current={s.key === step ? 'step' : undefined}
              aria-label={`${s.label}${state === 'done' ? ', complete' : state === 'attention' ? ', needs attention' : ''}`}
              onClick={() => onStep(s.key)}
            >
              <span className="cbt__node" aria-hidden="true">
                {state === 'done' && s.key !== step ? <Icon name="check" size={11} /> : i + 1}
              </span>
              <span className="cbt__label">{s.label}</span>
            </button>
          )
        })}
      </nav>
    </header>
  )
}

export type FooterAction = {
  label: string
  kind: 'go' | 'next' | 'blocked' | 'busy' | 'draft'
  onClick: () => void
  disabled?: boolean
}

export function BuilderFooter({
  meta,
  secondary,
  primary,
}: {
  /** One supporting fact, e.g. "12,480 · sellers match". Omitted when there isn't one. */
  meta?: { value: string; label: string; tone?: 'quiet' | 'stale' | 'live' } | null
  secondary?: { label: string; onClick: () => void; disabled?: boolean } | null
  primary: FooterAction
}) {
  return (
    <footer className="cbf">
      <div className="cbf__left">
        {secondary ? (
          <button type="button" className="cbf__secondary" onClick={secondary.onClick} disabled={secondary.disabled}>
            {secondary.label}
          </button>
        ) : meta ? (
          <div className={cls('cbf__meta', meta.tone && `is-${meta.tone}`)}>
            <strong>{meta.value}</strong>
            <span>{meta.label}</span>
          </div>
        ) : null}
      </div>

      <button
        type="button"
        className={cls('cbf__primary', `is-${primary.kind}`)}
        onClick={primary.onClick}
        disabled={primary.disabled || primary.kind === 'busy'}
        aria-busy={primary.kind === 'busy' || undefined}
      >
        {primary.kind === 'busy' && <span className="cbf__spinner" aria-hidden="true" />}
        {primary.kind === 'blocked' && <Icon name="alert-circle" size={15} />}
        <span className="cbf__primary-label">{primary.label}</span>
        {(primary.kind === 'next' || primary.kind === 'blocked') && <Icon name="chevron-right" size={15} />}
      </button>
    </footer>
  )
}
