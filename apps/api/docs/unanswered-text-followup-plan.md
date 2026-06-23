# Unanswered Text Follow-Up Plan

Status: design-ready, not enabled.

The repo has inbound-driven nurture scheduling in `apps/api/src/lib/domain/seller-flow/seller-followup-scheduler.js` and conversation state fields for follow-up trigger state, but there is not yet a complete scheduler that scans prior outbound SMS rows and creates a follow-up only when no inbound reply arrived after the prior outbound.

## Desired Scheduler

Proposed path:

- `apps/api/src/lib/domain/seller-flow/unanswered-text-followup-scheduler.js`
- `apps/api/src/app/api/internal/outbound/unanswered-followups/route.js`
- `scripts/proof/sms-unanswered-followup-proof.mjs`

## Rules

- After `ownership_check` outbound, if no inbound exists after the prior outbound for 24-48 hours, queue `ownership_check_follow_up`.
- After `consider_selling` outbound, if no inbound exists after the prior outbound for 48-72 hours, queue `consider_selling_follow_up`.
- Never schedule if any inbound reply exists after the last outbound for the owner/phone/property thread.
- Never schedule if suppression exists for opt-out, wrong-number, negative/legal, timing complaint, invalid/deactivated phone, or provider blacklist.
- Never schedule if a pending unanswered follow-up already exists for the same owner/phone/property/stage.
- Max 2 unanswered follow-ups per owner/phone/property thread.
- Respect contact window and local timezone from the queue row, market, or `DEFAULT_CONTACT_TIMEZONE`.
- Require exact market routing and pass `evaluateSmsHealthGuard` before writing the future queue row.

## Idempotency

Use this key:

```text
no_reply_followup:{thread_key}:{stage}:{prior_outbound_message_id}
```

The scheduler should upsert or skip by that key before inserting `send_queue`.

## Proof Expectations

The proof script should use fixtures and never send SMS. It should prove:

- prior outbound without later inbound creates a future queued row in dry-run output,
- later inbound suppresses follow-up,
- opt-out/wrong-number/provider blacklist suppresses follow-up,
- duplicate idempotency key suppresses follow-up,
- exact-market and SMS health guard checks are required.
