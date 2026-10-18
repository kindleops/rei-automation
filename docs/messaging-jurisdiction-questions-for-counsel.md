# Messaging categories and jurisdictional restrictions: questions for counsel

Status: OPEN. Prepared for rc-8.5.21 (owner ruling 2026-10-18). Nothing in this document is legal advice.
No legal rule has been encoded in the product. The restriction table ships empty.

## What the product does today

Every outbound SMS is placed in exactly one messaging category by one function,
`classifyMessagingCategory` in `apps/api/src/lib/domain/queue/recipient-window-policy.js`.
The delay planner, the AI reply executor, the follow-up lifecycle and the queue dispatcher all call it.

| Category | What it covers | Sending window |
|---|---|---|
| 1. `active_seller_conversation` | A reply to a seller's own inbound text, inside the active conversation. The conversational session is 30 minutes by default (`conversational_reply_window_minutes`). The reply must be linked to that inbound message. | Any hour, sent after the existing 3 to 40 minute human-like delay. There is no universal after-hours block. |
| 2. `campaign_outreach` | First touches and cold campaign touches. | 08:00 to 21:00 recipient-local. If the recipient's zone is unknown, the window is the intersection of the continental US zones, which is 11:00 to 21:00 Eastern. |
| 3. `scheduled_followup` | Nurtures, follow-ups, historical reactivation, and any reply sent after the conversation is no longer active. | 08:00 to 21:00 recipient-local, plus the follow-up lifecycle's own eligibility rules. |

The session only decides whether a conversation is continuing. A nurture, a campaign touch or a new-topic
message is never category 1, even if the seller texted a minute ago.

Some protections apply to every category and stay absolute. They are separate gates, not part of the window:
STOP and opt-out handling, suppression lists, automation holds, duplicate-send prevention, send authorization,
and thread and persona continuity.

### How the recipient's time zone is determined

1. Zones already stamped on the message by this policy.
2. The recipient's phone area code.
3. The owner's mailing address.
4. The property's location and any stored zone. These can only narrow the window. They are never treated as
   the recipient's location on their own, because absentee owners live elsewhere.
5. With no recipient evidence, the zone counts as unknown and the conservative intersection above is used.
   If nothing at all places the recipient, the message is held.

When several zones are plausible, the message may only go when it is inside the window in every one of them.

## The restriction table (the hook for counsel's answers)

The table lives at `apps/api/src/lib/domain/queue/messaging-restrictions.js` (`MESSAGING_RESTRICTIONS`). It is
empty. Each entry binds one jurisdiction (a state or territory code) and one or more categories. An entry
either gives permitted recipient-local hours or blocks the categories outright. Every entry must carry a
`citation` and an `approved_by`. `validateMessagingRestrictions` rejects an entry that is missing either.

An entry can only narrow sending. It can never widen the 08:00 to 21:00 base window of categories 2 and 3.

The jurisdictions a message is in currently come from the owner's mailing state and the property's state.
Area codes are mapped to time zones, not to states. Question A3 below asks which location should count.

## Questions

### A. Which law applies, and where

- A1. For each state with a telephone-solicitation quiet-hours statute, does that statute cover text
  messages, or only voice calls? States raised internally as worth checking include Florida (the Florida
  Telephone Solicitation Act), Oklahoma, Maryland and Washington, and possibly others such as Texas,
  Louisiana, Mississippi, Alabama and Connecticut. This list is a starting point from engineering, not a
  legal conclusion. Counsel should confirm the statutes, their current text and the full set of states.
- A2. What are the permitted hours in each covered state? Are they measured in the recipient's local time?
- A3. Is a message "in" a state based on the recipient's area code, the recipient's actual location, the
  owner's mailing address, or the property's location? What should we do when these disagree?
- A4. Do federal rules (the TCPA and the FCC's calling-time rule) cover
  each of the three categories? Do any state rules go further than the federal rule?

### B. Replies to a consumer-initiated message (category 1)

- B1. Is a reply to a message the seller sent us a "telephone solicitation" or "commercial message" under each
  covered statute? Or is it exempt as a response to a consumer-initiated contact?
- B2. If replies are exempt, does the exemption have a time limit, for example the same conversation or the
  same day? Is our 30-minute session a defensible boundary?
- B3. Does the exemption still apply when the reply moves toward a purchase offer for the seller's property?
  Does it still apply when the reply asks a qualifying question, such as asking price or condition?
- B4. In states that restrict hours, does a seller texting at 23:30 count as consent to an immediate reply at
  that hour?
- B5. Does an automated reply (AI-drafted, sent after a 3 to 40 minute delay) change the analysis compared with
  a human typing the reply?

### C. Consent and the other categories

- C1. For campaign first touches (category 2), what prior consent or relationship, if any, does each covered
  state require for SMS to a number obtained from public property records?
- C2. For nurtures and follow-ups (category 3) to a seller who replied "not interested" without opting out,
  which consent rules apply, and for how long?
- C3. Historical reactivation: does an old conversation create an ongoing exemption or relationship, and when
  does it lapse?
- C4. Are any states' do-not-call registry rules relevant to text messages to property owners?

### D. Operational

- D1. When the recipient's zone cannot be determined, is the continental-intersection window (11:00 to 21:00
  Eastern, that is 08:00 to 18:00 Pacific) acceptable? Or should those messages be held?
- D2. Alaska, Hawaii and US territories fall outside the continental intersection. Do they need their own
  handling when the zone is unknown?
- D3. What records should we keep to show that a category 1 reply answered a consumer-initiated message, such
  as the inbound message id, the times, and the session verdict?

## How an answer becomes a rule

1. Counsel answers a question for a named jurisdiction and category.
2. An engineer adds one entry to `MESSAGING_RESTRICTIONS`, with the citation and the approver.
3. The tests in `apps/api/tests/critical/recipient-window-policy-8521.test.mjs` must still pass. The test that
   pins an empty table will need to be updated in the same reviewed change.
4. No other code changes are needed. Every scheduler and the dispatcher read the same table.
