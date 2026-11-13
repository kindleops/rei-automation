# Negotiation composer hook — `lc.negotiation-composer.v1` (rc-8.5.21 part B)

The call site of `composerView()` and `checkSellerFacingText()` (8.5.20-b,
`domain/negotiation/seller-facing-guard.js`). The rc-8.5.21 part A runtime calls it for the
`PREPARE_OFFER` and `NEGOTIATE_WITHIN_AUTHORITY` decision outcomes.

Module: `apps/api/src/lib/domain/negotiation/negotiation-composer.js`

## Function

```js
import { composeNegotiationReply } from '@/lib/domain/negotiation/negotiation-composer.js'

const r = await composeNegotiationReply({
  outcome,              // 'PREPARE_OFFER' | 'NEGOTIATE_WITHIN_AUTHORITY'
  context,              // handleDecisionOutcome context (lc.negotiation-interface.v1):
                        //   { thread_key, property_id, opportunity_id?, seller_request?, fact_ledger?,
                        //     economics?, offer_plan?, now? }
  deps,                 // handleDecisionOutcome deps: { store (negotiation store), assessEconomics?, planOffer? }
  sendAuthorizations,   // { latestFor(scope_key) → { authorization, revoked } }  (send-authorization.js stores)
  templates,            // APPROVED sms_templates rows for the move use cases (see below)
  thread,               // { language?: 'english'|'spanish', template_context?: { summary vars }, sends_used?: number }
  env,
})
```

### Result

| `action` | meaning | `rendered_text` |
|---|---|---|
| `ESCALATE_TO_OPERATOR` | no authority / no send authorization / no approved template / guard violation / composer disabled | `null` |
| `HOLD` | within authority, our number stands — no message | `null` |
| `DETERMINISTIC_REPLY` | an envelope-authorized move rendered from an approved template, validated | the draft |

`DETERMINISTIC_REPLY` also carries `template_id`, `template_use_case`, `amount` (= the authorized
move amount), `authority_ref { envelope_id, envelope_version, send_authorization_id }`,
`validation { ok, violations, amounts }`, `composer_view`, and `persist`:

- `persist.seller_offer_args` — `toSellerOfferArgs(...)` for `seller-offer-authority.persistActiveOffer`
- `persist.ledger_event` — `{ event_type, actor: 'engine', authority: 'within_envelope', envelope_id, amount }`
  for `recordNegotiationEvent`

The composer writes NOTHING and sends NOTHING. The part A send path, if and when it is
authorized to send, persists `seller_offer_args` and appends `ledger_event` BEFORE the send.

## Gates (in order; the first failure escalates with no draft)

1. `NEGOTIATION_COMPOSER_ENABLED=1` — default OFF ⇒ `negotiation_composer_disabled`.
2. `handleDecisionOutcome` → position + `composer_view`. Only `composer_view` is read for the move.
   `needs_envelope` / `escalate` ⇒ escalate (the proposed envelope goes to an operator). `hold` ⇒ `HOLD`.
3. **A separate live send authorization** (`domain/negotiation/send-authorization.js`,
   table `public.negotiation_send_authorizations`, PROPOSED_20261016161000): same scope
   (thread + property), same envelope id + version, the envelope itself live, not revoked, not expired,
   `amount ≤ send ceiling`, terms hash = the envelope's allowed terms, sends used < `max_sends`.
   Granted only through its own operator approval (capability `pipeline.prepare_negotiation_send_authorization`,
   never in the model tool list; its approval id must differ from the envelope's).
4. An approved template: a real `sms_templates` id (never `local-template:*`), active, the thread's
   language, the move's use case, exactly one `{{offer_price}}`, no other money in the template body:

   | move | use cases (first match) |
   |---|---|
   | `open` | `offer_reveal_cash` |
   | `counter` | `narrow_range` |
   | `final` | `narrow_range` |
   | `agree_at_seller_price` | `close_handoff`, `offer_reveal_cash` |

5. Render with `render-template.js` (`{{offer_price}}` = the authorized amount); any missing or
   use-case-invalid placeholder ⇒ escalate.
6. `checkSellerFacingText(draft, { position, plan, economics, envelope })` — any amount other than the
   authorized one, any internal number (ceiling / envelope max / target / value / margin), ceiling
   language, comparable-sales detail — plus the forbidden-claim scan (cash on hand, proof of funds,
   guaranteed close, binding contract) ⇒ escalate. A violation is a hold for a human, never a rewrite.

## Pipeline adapter

`createEnvelopeNegotiationAuthority({ resolveContext, deps, sendAuthorizations, templatesFor, env })`
returns a `NegotiationAuthority` (`conversation-ai/pipeline/negotiation-authority.js` interface:
`prepareOffer(ctx)`, `negotiateWithinAuthority(ctx)`). `resolveContext(pipelineCtx) → { context, thread }`
is injected by part A (the pipeline context carries refs only). The pipeline normalizes the answer to
`{ action, reason, template_use_case, authority_ref }`; a runtime that needs the rendered text calls
`composeNegotiationReply` directly.

## Related (internal only)

`domain/negotiation/negotiation-pathway.js` — `buildNegotiationPathway({ economics, offer_plan, ... })`:
class, MAO (ceiling), opening range strictly below it, justification, concession ladder, flexibility,
closing requirements, buyer liquidity, complexity, margin, friction, land zoning-first path and one
next action. Never seller-facing.
