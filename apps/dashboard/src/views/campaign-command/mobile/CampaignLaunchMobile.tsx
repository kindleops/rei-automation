import { Icon } from '../../../shared/icons'
import {
  describeAutoReplyMode,
  describeQueueHold,
  formatLaunchWhen,
  friendlyTimezone,
  type BuilderStep,
  type LaunchIssue,
  type LaunchPlan,
} from '../campaign-launch-plan'

/**
 * Campaign Creator — LAUNCH, mobile.
 *
 * One question: if I press the button, what happens?
 *
 * What it replaced, from the rendered screen: a headline reading "SCHEDULABLE"
 * over a campaign with 0 ready contacts; five blockers under "5 must clear"
 * that were two causes stated five ways; the developer string "Campaign not
 * persisted yet" printed twice — once as a blocker and once AS THE PRIMARY
 * BUTTON; raw enums ("live limited", "America/Chicago"); and a "Save draft"
 * control sheared off behind the footer.
 *
 * The numbers are not re-derived here. `plan` and `issues` come from
 * campaign-launch-plan, computed once by the modal, so this screen and the
 * builder footer's button can never describe two different launches. The
 * canonical gate (canActivate / canSchedule) stays in the modal and decides.
 */

const nf = (n: number) => n.toLocaleString()
const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export interface LaunchPlanDisplay {
  dailyVolume: number
  spacingSeconds: number
  maxTargets: number
  runLimit: number | null
}

const NOT_SCHEDULABLE_COPY: Record<string, string> = {
  TEMPLATE_RENDER_LINT_FAILURE: 'Message personalization incomplete',
  NO_TEMPLATE: 'No approved message for this audience',
  MISSING_FIRST_NAME: 'Seller first name missing',
}

export function CampaignLaunchMobile({
  ready,
  schedulable,
  schedulableLoading,
  schedulableBlockers,
  plan,
  display,
  scheduledAt,
  routing,
  campaignTimezone,
  insideContactWindow,
  issues,
  warnings,
  queueMode,
  autoMode,
  onEditSchedule,
  onEditPacing,
  onEditLimit,
  onGoToStep,
}: {
  ready: number | null
  /** Exact audience Schedule can hand off, after template render + lint. */
  schedulable: number | null
  schedulableLoading: boolean
  schedulableBlockers: Record<string, number> | null
  plan: LaunchPlan
  display: LaunchPlanDisplay
  scheduledAt: string
  routing: { covered: number; crossState: number; unrouted: number } | null
  campaignTimezone: string
  insideContactWindow: boolean
  issues: LaunchIssue[]
  warnings: string[]
  queueMode: string | null
  autoMode: string | null
  onEditSchedule: () => void
  onEditPacing: () => void
  onEditLimit: () => void
  onGoToStep: (step: BuilderStep) => void
}) {
  const blocked = issues.length > 0
  const zeroSchedulable = plan.schedulableKnown && schedulable === 0
  const personalizationGap = plan.schedulableKnown && ready != null && (schedulable ?? 0) < ready
  const queueHold = describeQueueHold(queueMode)
  const autoReply = describeAutoReplyMode(autoMode)
  const tz = friendlyTimezone(campaignTimezone)

  /*
   * THE HEADLINE IS THE STATE, NOT A NOUN.
   *
   * "SCHEDULABLE" was printed regardless of whether anything was — above a
   * campaign with 0 ready contacts. Each branch below states something the
   * operator can act on, and none of them promises a number Schedule cannot
   * honour: until the preflight answers, READY is labelled as READY.
   */
  const hero = blocked
    ? {
        tone: 'blocked' as const,
        title: issues.length === 1 ? '1 thing to finish' : `${issues.length} things to finish`,
        sub: issues.length === 1 ? 'Sort this out and the campaign is ready to launch.' : 'Sort these out and the campaign is ready to launch.',
      }
    : schedulableLoading && !plan.schedulableKnown
      ? { tone: 'checking' as const, title: 'Checking your messages', sub: 'Rendering a message for every seller to confirm it can send.' }
      : zeroSchedulable
        ? { tone: 'blocked' as const, title: 'Messages need attention', sub: 'None of the audience has a message that renders cleanly.' }
        : plan.schedulableKnown
          ? {
              tone: 'ready' as const,
              title: 'Ready to launch',
              sub: plan.now
                ? `${nf(plan.willQueue)} ${plan.willQueue === 1 ? 'seller' : 'sellers'} will be messaged, starting now.`
                : `${nf(plan.willQueue)} ${plan.willQueue === 1 ? 'seller' : 'sellers'} will be messaged from ${formatLaunchWhen(scheduledAt)}.`,
            }
          : ready != null
            ? { tone: 'checking' as const, title: `${nf(ready)} ready`, sub: 'Messages are verified when the draft saves.' }
            : { tone: 'checking' as const, title: 'Counting your audience', sub: 'This takes a few seconds.' }

  return (
    <div className="clv">
      {/* ── readiness ───────────────────────────────────────────────── */}
      <section className={cls('clv-hero', `is-${hero.tone}`)} aria-live="polite">
        <span className="clv-hero__mark" aria-hidden="true">
          {hero.tone === 'ready' ? <Icon name="check" size={16} />
            : hero.tone === 'blocked' ? <Icon name="alert-circle" size={16} />
              : <span className="clv-hero__spin" />}
        </span>
        <div className="clv-hero__text">
          <h3>{hero.title}</h3>
          <p>{hero.sub}</p>
        </div>
      </section>

      {/* The checklist is part of the readiness answer, so it lives in the same
          card rather than as a second box beneath it. */}
      {blocked && (
        <ol className="clv-todo is-attached" aria-label="To finish before launch">
          {issues.map((issue) => {
            const Tag = issue.step ? 'button' : 'div'
            return (
              <li key={issue.key}>
                <Tag
                  {...(issue.step ? { type: 'button' as const, onClick: () => onGoToStep(issue.step as BuilderStep) } : {})}
                  className={cls('clv-todo__item', issue.step && 'is-actionable')}
                >
                  <span className="clv-todo__dot" aria-hidden="true" />
                  <span className="clv-todo__text">
                    <strong>{issue.title}</strong>
                    {issue.detail ? <em>{issue.detail}</em> : null}
                  </span>
                  {issue.step && (
                    <span className="clv-todo__go">
                      {issue.step === 'build' ? 'Build' : issue.step === 'reach' ? 'Reach' : 'Launch'}
                      <Icon name="chevron-right" size={13} />
                    </span>
                  )}
                </Tag>
              </li>
            )
          })}
        </ol>
      )}

      {/* ── the plan ────────────────────────────────────────────────── */}
      <section className="clv-card" aria-label="Launch plan">
        <h4 className="clv-card__h">Plan</h4>
        <button type="button" className="clv-row" onClick={onEditSchedule}>
          <span className="clv-row__label">Starts</span>
          <span className="clv-row__value">{plan.now ? 'Right away' : formatLaunchWhen(scheduledAt)}</span>
          <Icon name="chevron-right" size={14} />
        </button>
        <button type="button" className="clv-row" onClick={onEditPacing}>
          <span className="clv-row__label">Pace</span>
          <span className="clv-row__value">
            {nf(display.dailyVolume)} a day
            <small>one every {display.spacingSeconds}s</small>
          </span>
          <Icon name="chevron-right" size={14} />
        </button>
        <button type="button" className={cls('clv-row', plan.capBinds && 'is-capped')} onClick={onEditLimit}>
          <span className="clv-row__label">Sending to</span>
          <span className="clv-row__value">
            {nf(plan.willQueue)} {plan.willQueue === 1 ? 'seller' : 'sellers'}
            {ready != null && ready > 0 && <small>of {nf(ready)} ready</small>}
          </span>
          <Icon name="chevron-right" size={14} />
        </button>
        {plan.durationKnown && (
          <div className="clv-row is-static">
            <span className="clv-row__label">Takes</span>
            <span className="clv-row__value">{plan.durationLabel}</span>
          </div>
        )}

        {plan.capBinds && (
          <p className="clv-card__note is-warn">
            {plan.systemBound
              ? `A system limit of ${nf(display.runLimit ?? 0)} per run applies, so this launch sends to ${nf(plan.willQueue)} of the ${nf(ready ?? 0)} ready. The rest can go in a later launch.`
              : `This campaign is capped at ${nf(display.maxTargets)}, so ${nf((ready ?? 0) - plan.willQueue)} ready sellers won’t be included. Raise the limit to reach them.`}
          </p>
        )}
        {/* Only relevant to a launch that starts now: a campaign scheduled for
            9 AM tomorrow is not delayed by it being 11 PM today. */}
        {plan.now && !insideContactWindow && (
          <p className="clv-card__note">
            It’s outside {tz} texting hours right now, so sending begins when the window next opens.
          </p>
        )}
      </section>

      {/* ── sender coverage, as confirmation rather than a second funnel ── */}
      {routing && (routing.covered + routing.crossState + routing.unrouted) > 0 && (
        <section className="clv-card" aria-label="Sender coverage">
          <h4 className="clv-card__h">
            Sender coverage
            <span className={cls('clv-card__badge', routing.unrouted === 0 ? 'is-good' : 'is-warn')}>
              {routing.unrouted === 0 ? 'All covered' : `${nf(routing.unrouted)} without a number`}
            </span>
          </h4>
          <div className="clv-cover">
            <div className="clv-cover__cell">
              <strong>{nf(routing.covered)}</strong>
              <span>Local number</span>
            </div>
            <div className={cls('clv-cover__cell', routing.crossState === 0 && 'is-nil')}>
              <strong>{nf(routing.crossState)}</strong>
              <span>Out of state</span>
            </div>
            <div className={cls('clv-cover__cell', routing.unrouted === 0 ? 'is-nil' : 'is-bad')}>
              <strong>{nf(routing.unrouted)}</strong>
              <span>No number</span>
            </div>
          </div>
        </section>
      )}

      {/* ── why some ready sellers won't be scheduled ──────────────────── */}
      {personalizationGap && schedulableBlockers && (
        <section className="clv-card" aria-label="Not scheduled">
          <h4 className="clv-card__h">Won’t be scheduled</h4>
          {Object.entries(schedulableBlockers)
            .filter(([, n]) => Number(n) > 0)
            .sort((a, b) => Number(b[1]) - Number(a[1]))
            .slice(0, 5)
            .map(([reason, n]) => (
              <div key={reason} className="clv-row is-static">
                <span className="clv-row__label is-wide">
                  {NOT_SCHEDULABLE_COPY[reason] ?? reason.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())}
                </span>
                <span className="clv-row__value">{nf(Number(n))}</span>
              </div>
            ))}
        </section>
      )}

      {/* ── automation: only what constrains or accompanies this launch ── */}
      {(queueHold || autoReply) && (
        <section className="clv-card" aria-label="Automation">
          <h4 className="clv-card__h">Automation</h4>
          {autoReply && (
            <div className="clv-row is-static">
              <span className="clv-row__label">Auto-replies</span>
              <span className="clv-row__value">{autoReply}</span>
            </div>
          )}
          {queueHold && (
            <p className="clv-card__note is-warn">
              {queueHold}. The campaign will be set up, but nothing sends until it’s lifted.
            </p>
          )}
        </section>
      )}

      {/* ── warnings: launch is allowed, the operator should know ───────── */}
      {warnings.length > 0 && (
        <section className="clv-card is-warn" aria-label="Before you launch">
          <h4 className="clv-card__h">
            Worth knowing
            <span className="clv-card__badge is-quiet">You can still launch</span>
          </h4>
          {warnings.map((w) => (
            <p key={w} className="clv-card__note">{w}</p>
          ))}
        </section>
      )}
    </div>
  )
}
