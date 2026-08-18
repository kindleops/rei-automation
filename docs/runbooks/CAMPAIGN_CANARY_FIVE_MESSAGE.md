# Five-Message Campaign Canary — PREPARED, NOT EXECUTED

**Prepared:** 2026-08-17 · all figures measured read-only against production.
**Status:** awaiting authorization. Nothing here has been run. No queue control
has been changed.

---

## 0. The critical finding: DO NOT use auto-enqueue

`queue_hard_cap = 5` **does not mean "only five targets can ever be touched."**

`validateLiveLimitedRails` (lib/domain/queue/queue-control-safety.js:130-137)
computes:

```js
effective_limit = min(requested_limit, min(hard_cap, max_batch_size))
```

That bounds **one pass**, not a run. And the auto-enqueue route
(app/api/cockpit/queue/auto-enqueue/route.js) computes `validation` and then
**never uses `validation.effective_limit`**. It calls the feeder with the raw
`per_pass_limit`, inside:

```js
while (queued_total < target_count && passes < 20) { ... offset += scan_limit }
```

`target_count` defaults to 100 and accepts up to **1,000**. The feeder itself
(supabase-candidate-feeder.js:4497) clamps to 500 per call and contains no
reference to `hard_cap` or `max_batch_size` at all.

**Therefore: one POST to auto-enqueue with `queue_auto_enqueue_enabled=true`
can create up to 1,000 queue rows, and the caps do not stop it.** With the
processor running, those rows send.

Auto-enqueue is not a canary mechanism. It is not used below.

---

## 1. The mechanism: `enqueue_campaign_target_one` (NOT `queue_one`)

**`queue_one` cannot be used for this canary.** It takes a
`campaign_session_id` plus market/state and resolves its recipient through
`runSupabaseCandidateFeeder` against `v_feeder_candidates_fast` — a legacy
property/prospect view with **no campaign linkage at all**. Measured:
20,738 rows, **zero** of the frozen five present, and `market ilike '%Los
Angeles%'` matches **0** rows. Invoking it would text one of 3,456 unrelated
CA sellers.

The correct mechanism is the target-addressed primitive:

    POST /api/internal/campaigns/enqueue-target-one
    { "campaign_target_id": "<uuid>", "dry_run": false }

- `dry_run` defaults to **true**; writing requires explicitly passing `false`
- exactly one named target in, zero or one queue row out
- never invokes the feeder (asserted by test)
- verifies `created_row.campaign_target_id === requested id` and treats a
  mismatch as fatal
- duplicate-proof via the UNIQUE index on `send_queue.queue_key`, keyed
  `campaign_target_one:<target>:t<touch>`
- creates a `queued` row; it does **not** send. Dispatch stays with
  `send_one_queue_row`.

### Legacy `queue_one` preconditions (retained for reference)

`app/api/cockpit/queue/control/route.js` already implements a purpose-built
one-shot path. `oneRowQueueSafetyFailure` refuses to run unless **all** of:

| Precondition | Current value | Required |
|---|---|---|
| `queue_auto_send_enabled` | `true` | **`false`** |
| `queue_auto_enqueue_enabled` | `false` ✅ | `false` |
| `queue_processor_mode` | `on` | **`off`** |
| `auto_reply_mode` | `live_limited` | **`disabled` or `dry_run`** |
| `queue_emergency_stop_at` | `""` (inactive) | **active** |

and `validateOneRowRails` additionally requires **all six** of `limit`,
`hard_cap`, `max_batch_size`, `daily_cap`, `market_cap`, `per_number_cap` to
equal exactly `1`.

It creates **one row, for one explicitly named target**, and
`rearmEmergencyStopAfterOneSend` re-asserts the stop afterwards.

This is structurally incapable of spilling into 2,161 targets: it takes a
single target id and every cap is pinned to 1. Five messages = five deliberate
invocations, each individually authorized.

**Note the operational cost:** `auto_reply_mode` must leave `live_limited` for
the duration, which pauses the inbound auto-reply canary. That is a real
trade-off to accept knowingly, not a side effect to discover mid-run.

---

## 2. Frozen candidate set — five, fully resolved

Campaign **Los Angeles- Multifamily**. One campaign, one language (Spanish),
one reply path, all CA/Pacific, all touch 1, all templates `testing` with
cap 20 and 0 used.

| # | target id | recip | property | tmpl | persona |
|---|---|---|---|---|---|
| 1 | `0cc25ba6-353f-4fa8-beeb-d0471c324a79` | ••0295 | 618 Hoefner Ave, LA 90022 | 201362 | Carmen Rivera |
| 2 | `11959319-83ad-4327-b6c1-f41f1fa77814` | ••6598 | 1347 W 99th St, LA 90044 | 200002 | Carlos Mendez |
| 3 | `143e4c36-c66e-416a-87f2-5458e0554f0d` | ••2380 | 1928 Browning Blvd, LA 90062 | 200002 | Carmen Rivera |
| 4 | `19340c21-8618-4d66-9da7-6ce15431bc2c` | ••8722 | 1026 E 57th St, LA 90011 | 201362 | Carlos Mendez |
| 5 | `19acb69e-1a5b-4f42-89f5-694004d48b92` | ••6180 | 1051 Westside Dr, LA 90022 | 201362 | Carmen Rivera |

**Exact outbound text** (must match the queued body byte-for-byte):

1. `Hola Rodolfo, Carmen aqui. Pregunta rapida. Sigues siendo el dueno de 618 Hoefner Ave, Los Angeles, Ca 90022?`
2. `Hola Veronica, soy Carlos. Todavia eres el dueno de 1347 W 99th St, Los Angeles, Ca 90044?`
3. `Hola Elsie, soy Carmen. Todavia eres el dueno de 1928 Browning Blvd, Los Angeles, Ca 90062?`
4. `Hola Juan, Carlos aqui. Pregunta rapida. Sigues siendo el dueno de 1026 E 57th St, Los Angeles, Ca 90011?`
5. `Hola David, Carmen aqui. Pregunta rapida. Sigues siendo el dueno de 1051 Westside Dr, Los Angeles, Ca 90022?`

Sender pool (Los Angeles, CA): `••9881` (LOS ANGELES-#4), `••4544`
(LOS ANGELES-#1). Both active, health 1.0, 800/day. **Pin one sender for all
five** so attribution is unambiguous.

Contact window: **08:00–21:00 America/Los_Angeles**.

**Opt-out disclosure:** operator decision on 2026-08-17 — no STOP language in
outbound messages. Verified: none of the five bodies contains it. Inbound
STOP/opt-out handling remains fully active and is unaffected.

---

## 3. Preflight (read-only, run immediately before)

```sql
-- Must return exactly 5 rows, all columns true.
with frozen(id) as (values
  ('0cc25ba6-353f-4fa8-beeb-d0471c324a79'::uuid),
  ('11959319-83ad-4327-b6c1-f41f1fa77814'::uuid),
  ('143e4c36-c66e-416a-87f2-5458e0554f0d'::uuid),
  ('19340c21-8618-4d66-9da7-6ce15431bc2c'::uuid),
  ('19acb69e-1a5b-4f42-89f5-694004d48b92'::uuid))
select t.id,
  t.target_status='ready'                                      as st_ready,
  t.routing_status='ready'                                     as routing_ready,
  t.suppression_status='clear'                                 as not_suppressed,
  t.identity_status='verified'                                 as identity_ok,
  t.timezone='Pacific'                                         as tz_valid,
  nullif(t.metadata->>'template_id','') is not null            as has_template,
  rc.rotation_status in ('active','testing','promote')
    and rc.daily_cap > 0                                       as governed,
  not exists (select 1 from sms_suppression_list s
               where s.phone_e164=t.to_phone_number
                 and coalesce(s.is_active,true))               as not_dnc,
  not exists (select 1 from send_queue q
               where q.to_phone_number=t.to_phone_number
                 and q.queue_status in ('sent','delivered','queued','pending',
                                        'processing','scheduled','locked','retry'))
                                                               as no_prior_or_live
from frozen f
join campaign_targets t on t.id=f.id
left join ownership_template_rotation_control rc
       on rc.template_id = t.metadata->>'template_id';

-- Must be 0.
select count(*) as live_rows from send_queue
 where queue_status in ('queued','pending','processing','scheduled','locked','retry');
```

**Any false, or `live_rows <> 0`, aborts.**

---

## 4. Identity — RESOLVED

`{{agent_name}}` now resolves from **`master_owners.agent_persona`**, first name
only. That contract was derived from production, not chosen: across all 423
historical sends carrying both fields, `send_queue.agent_name` equals
`split_part(agent_persona, ' ', 1)` — 423/423.

It binds to the OWNER, so a seller contacted twice hears from the same person.
It is measurably not sender-bound (number ••9881 alone has introduced itself as
six different names). It is language-aligned via `agent_family`, so the Spanish
canary draws Spanish personas.

Coverage: 2,156 of 2,161 ready targets. No persona → no send, fail closed.

Preflight and send-time call the same `buildOutboundMergeValues()` over the same
rows, so the previewed body cannot differ from the queued body.

---

## 4b. Reply leg — Spanish opt-out defect FIXED

Measured before the fix, these all classified as `unclear` rather than
`opt_out`:

| input | before | after |
|---|---|---|
| `¡STOP!` `!STOP` | unclear | **opt_out** |
| `PARE` `¡PARE!` | unclear | **opt_out** |
| `déjame en paz` | unclear | **opt_out** |
| `no me moleste` | unclear | **opt_out** |

Root cause: `detectComplianceFlag` stripped only TRAILING non-letters, so a
message opening with `¡` never matched — and Spanish keyboards emit that mark
by default. Separately, `pare` (the word on Spanish stop signs) was absent while
`para` was present.

A Spanish seller asking to stop was not being opted out. Fixed, with
non-regression cover for `bus stop`, `don't stop` and the
"stop calling me, text me instead" channel-preference carve.

The known Spanish **monetary** defect ("mil" read as million) lives in S3
asking-price parsing and is unreachable from an S1 ownership question; a
tripwire test pins that boundary.

## 5. Execution — five separate authorizations

**One message at a time. No loop.** For each of the five:

1. Set controls (first message only):
   `queue_auto_send_enabled=false`, `queue_processor_mode=off`,
   `auto_reply_mode=dry_run`, emergency stop **active**,
   `limit=hard_cap=max_batch_size=daily_cap=market_cap=per_number_cap=1`,
   `campaign_mode=live_limited`, `queue_state_filter=CA`.
   Leave `queue_auto_enqueue_enabled=false`.
2. `queue_one` with the single frozen target id.
3. **Expect exactly 1 new `send_queue` row.** Verify count delta is 1.
4. Read the rendered `message_body` **before** release. Confirm no `{{`, no
   double space, correct language, correct property.
5. Release the single row. Observe: `sent` → provider id → `delivered`.
6. Confirm `rearmEmergencyStopAfterOneSend` re-armed the stop.
7. Watch for inbound reply on that thread.
8. Stop. Review. Only then consider message 2.

---

## 6. Success criteria

- exactly 5 rows created, 5 sent, 0 unintended
- every rendered body auditable in advance and free of unresolved tokens
- all sends inside 08:00–21:00 America/Los_Angeles
- provider outcome recorded per message
- replies land on the correct thread
- `send_queue` total grows by exactly 5 (17,319 → 17,324)

## 7. Abort / rollback

Abort on: any preflight false, any unexpected queue row, any unresolved token,
any send outside the window, any DNC hit.

Rollback: set emergency stop active, `queue_processor_mode=off`,
`queue_auto_send_enabled=false`, cancel any unsent rows. Delivered SMS cannot
be recalled — which is why this runbook stops at one message at a time.

## 8. Restore after canary

`auto_reply_mode` back to `live_limited`; caps back to
`hard_cap=5`, `max_batch_size=1`, `daily_cap=750`, `market_cap=400`,
`per_number_cap=150`; `queue_auto_enqueue_enabled` stays `false`.
