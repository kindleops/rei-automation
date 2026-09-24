/**
 * CAMPAIGN HEALTH — one coherent status object (§14).
 *
 * The detail screen used to state the campaign's condition in four places at
 * once: a posture strip ("NO SMS WILL TRANSMIT"), a readiness row ("TEST MODE
 * — NO MESSAGES WILL TRANSMIT"), a NEXT line ("Test mode — build targets to
 * stage sends"), and a state badge. Three of those said the same thing in
 * different words, all shouted, and none of them said what to do.
 *
 * This is the single place the screen answers "is it healthy, and does it need
 * me". It derives from existing canonical facts and invents no score.
 */
import {
  describeCampaignStatus,
  type OperatorState,
} from '../campaign-operator-language'
import type { CampaignSummary } from '../campaigns.types'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

type Props = {
  campaign: CampaignSummary
  /** Global send posture, only when it actually constrains THIS campaign. */
  containment?: string | null
}

/** Headline per state. Deliberately short — the sentence underneath does the work. */
const HEADLINE: Record<OperatorState, string> = {
  live: 'Healthy',
  attention: 'Needs attention',
  blocked: 'On hold',
  paused: 'Paused',
  scheduled: 'Scheduled',
  draft: 'Not started',
  completed: 'Completed',
  test: 'Test mode',
}

export function CampaignHealthMobile({ campaign, containment }: Props) {
  const status = describeCampaignStatus(campaign)

  /*
   * Containment is the operator's own global brake, so it outranks the
   * campaign's own condition: a "healthy" campaign that physically cannot
   * transmit is not healthy in any sense the operator cares about.
   */
  const detail = containment
    ? containment
    : status.detail

  return (
    <section
      className={cls('chm', `is-${status.state}`, (status.needsOperator || containment) && 'is-flagged')}
      aria-label="Campaign status"
    >
      <span className="chm__mark" aria-hidden="true">
        <span className={cls('chm__dot', status.isLive && !containment && 'is-pulsing')} />
      </span>
      <span className="chm__body">
        <strong className="chm__headline">{HEADLINE[status.state]}</strong>
        {detail ? <span className="chm__detail">{detail}</span> : null}
      </span>
    </section>
  )
}

export default CampaignHealthMobile
