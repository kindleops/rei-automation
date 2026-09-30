import { Icon } from '../../../shared/icons'
import {
  describeAutoReplyMode,
  describeHeldReason,
  describeNotSchedulable,
  describePace,
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
  /** The campaign's daily cap setting. */
  dailyCap?: number | null
  spacingSeconds: number
  maxTargets: number
}

type RoutingBlocks = Record<string, { targets: number; reason: string; senders: Array<{ phone_number: string | null; state: string }> }>

export function CampaignLaunchMobile({
  ready,
  schedulable,
  schedulableLoading,
  schedulableBlockers,
  routingBlocks = null,
  preflightError = null,
  buildHeld = null,
  eligibleInAudience = null,
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
  /** Per market: why no sender could carry these sellers, number by number. */
  routingBlocks?: RoutingBlocks | null
  /** The preflight's own failure message (build refused, request failed). */
  preflightError?: string | null
  /** Sellers the preflight build held back, by reason. */
  buildHeld?: Record<string, number> | null
  /** Queue-eligible sellers in the whole audience, before the send limit. */
  eligibleInAudience?: number | null
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
  const notSchedulable = plan.schedulableKnown ? describeNotSchedulable(schedulableBlockers, routingBlocks) : []
  const heldLines = Object.entries(buildHeld ?? {}).filter(([, n]) => Number(n) > 0).sort((a, b) => Number(b[1]) - Number(a[1]))
  const heldTotal = heldLines.reduce((sum, [, n]) => sum + Number(n), 0)
  const firstSend = plan.firstSendAt
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
      ? { tone: 'checking' as const, title: 'Checking every seller', sub: 'Choosing a sender and rendering a message for each seller to confirm it can send.' }
      : preflightError && !plan.schedulableKnown
        ? { tone: 'blocked' as const, title: 'This audience couldn’t be checked', sub: preflightError }
        : zeroSchedulable
          ? {
              tone: 'blocked' as const,
              title: notSchedulable.length ? 'No seller can be messaged yet' : 'No seller is ready to message',
              sub: notSchedulable[0] ? `${notSchedulable[0].label} (${nf(notSchedulable[0].count)}).` : 'Every seller in this audience is held back — see below.',
            }
          : plan.schedulableKnown
            ? {
                tone: 'ready' as const,
                title: 'Ready to launch',
                sub: `${nf(plan.willQueue)} ${plan.willQueue === 1 ? 'seller' : 'sellers'} will be messaged${plan.now ? ', starting now' : ` from ${formatLaunchWhen(scheduledAt)}`}${plan.days && plan.days > 1 ? `, over about ${plan.days} days` : ''}.`,
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
            {describePace(plan)}
            <small>one every {display.spacingSeconds}s{display.dailyCap && plan.paceBinding !== 'daily_cap' ? ` · daily cap ${nf(display.dailyCap)}` : ''}</small>
          </span>
          <Icon name="chevron-right" size={14} />
        </button>
        <button type="button" className={cls('clv-row', plan.capBinds && 'is-capped')} onClick={onEditLimit}>
          <span className="clv-row__label">Sellers</span>
          <span className="clv-row__value">
            {ready != null && plan.willQueue === ready && ready > 0 ? `All ${nf(plan.willQueue)}` : nf(plan.willQueue)}
            {ready != null && ready > 0 && plan.willQueue !== ready && <small>of {nf(ready)} ready</small>}
          </span>
          <Icon name="chevron-right" size={14} />
        </button>
        {plan.durationKnown && (
          <div className="clv-row is-static">
            <span className="clv-row__label">Takes</span>
            <span className="clv-row__value">{plan.durationLabel}</span>
          </div>
        )}
        {firstSend && plan.willQueue > 0 && (
          <div className="clv-row is-static">
            <span className="clv-row__label">First text</span>
            <span className="clv-row__value">{formatLaunchWhen(firstSend)}</span>
          </div>
        )}

        {plan.willQueue > 0 && (
          <p className="clv-card__note">
            Every seller above is messaged — the queue refills itself in small batches until the audience is done.
          </p>
        )}
        {plan.capBinds && eligibleInAudience != null && (
          <p className="clv-card__note is-warn">
            {`This campaign’s send limit is ${nf(display.maxTargets)}, so ${nf(Math.max(0, eligibleInAudience - display.maxTargets))} more eligible sellers in the audience aren’t included. Raise the limit to reach them.`}
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

      {/* ── why some ready sellers won't be messaged, with the fix named ── */}
      {notSchedulable.length > 0 && (
        <section className="clv-card" aria-label="Not scheduled">
          <h4 className="clv-card__h">Won’t be messaged</h4>
          {notSchedulable.slice(0, 6).map((line) => (
            <div key={line.reason}>
              <div className="clv-row is-static">
                <span className="clv-row__label is-wide">{line.label}</span>
                <span className="clv-row__value">{nf(line.count)}</span>
              </div>
              {line.details.map((detail) => (
                <p key={detail} className="clv-card__note">{detail}</p>
              ))}
            </div>
          ))}
        </section>
      )}

      {heldTotal > 0 && (
        <section className="clv-card" aria-label="Held back at build">
          <h4 className="clv-card__h">Held back at build<span className="clv-card__badge is-quiet">{nf(heldTotal)}</span></h4>
          {heldLines.slice(0, 5).map(([reason, n]) => (
            <div key={reason} className="clv-row is-static">
              <span className="clv-row__label is-wide">{describeHeldReason(reason)}</span>
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
