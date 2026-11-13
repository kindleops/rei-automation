# rc-8.5.21: phone-wide `bad_contact` audit (owner rule 2026-10-17: a property denial is never global)

Phone-wide `bad_contact` / `wrong_number` is allowed ONLY for:

- a wrong number;
- "not this person";
- an explicit stop.

A property-specific non-owner (or a tenant) is a contact × property fact. It lives in `contact_property_resolution`, written by the inbound contact-resolution phase, and the send-time recontact guard reads it there.

## Writers of `phones.phone_contact_status`

| Writer | Value | Scope after rc-8.5.21 |
|---|---|---|
| `domain/automation/automation-actions.js` `markBadContact` | `wrong_number` or `bad_contact` | Refuses any reason outside `PHONE_WIDE_BAD_CONTACT_REASONS` (wrong number / not this person / stop): `property_scoped_reason_never_phone_wide`. |
| Rule `suppression.wrong_number` (`rules/suppression-rules.js`) | `wrong_number` via `markBadContact` | Unchanged (wrong number). |
| Rule `suppression.not_owner_bad_contact` | was `bad_contact` + cancel pending + thread stage `wrong_number` | **RETIRED.** `rules/retired-rules.js` makes both the matcher and the action executor refuse it, whatever a stored `automation_rules` row says. The default is `is_active: false`. Its keyword matcher also no longer fires on an owner who mentions a tenant (SCONV-09). |
| `domain/seller-flow/apply-inbound-automation-decision.js` (around line 2839) | `wrong_number` | Unchanged (wrong number). |
| `domain/acquisition/compliance-handler.js` `updatePhoneSuppression` | `wrong_number` / `suppressed` | Unchanged (wrong number / compliance stop). |
| `lib/discord/discord-action-handlers/handle-sms-reply.js` | `wrong_number` | Unchanged (an operator wrong-number action). |

## Readers

No reader infers "not the owner of THIS property" from `bad_contact`:

- **Treat only `wrong_number` / `wrong_number_at` as a phone block:**
  - `send-time-contact-guard.js`
  - `lookup-canonical-phone-row.js`
  - `supabase-candidate-feeder.js`
  - the campaign graph SQL (`PROPOSED_20261016155000`)
  - `entity-network-service.js`
- **Blocks only opt-out / DNC / suppressed:** `apply-inbound-automation-decision.js` `contextHasActiveSuppression`.
- **Operator-chosen filter field only:** `campaign-automation-service.js` / `campaign-field-catalog.js`.
- **Read for ranking only:** `canary-audience-source.js` and `resolve-contact-outcome-phase.js`.
- **Display only:** `cockpit/inbox/property-participants`.

## Historical rows (PROVISIONAL, needs a production read)

Rows the retired rule already wrote stay `bad_contact` until a person reviews them. To count them (read-only):

```sql
-- PROVISIONAL: run read-only (BEGIN READ ONLY; statement_timeout 15s)
select count(*) as phones_bad_contact, min(updated_at), max(updated_at)
  from public.phones where phone_contact_status = 'bad_contact';
```
