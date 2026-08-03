# Production Activation Runbook — Internal Automation Proof (2026-08-02)

One deterministic sequence: **one production deployment, one migration
sequence, one complete internal automation proof.** Prepared on
`launch/backend-final-completion`; **nothing in this document has been
executed against production.** Every step is idempotent, fail-closed, and
independently verifiable; every step states its verification and its abort
condition. Execute strictly in order; stop at the first failed verification.

Operator machine prerequisites: repo checkout at the final merge SHA, `psql`,
`vercel` CLI authenticated to the prod project, `.env.local` with
`SUPABASE_DB_URL` (session pooler) available to the runbook script.

**Standing precondition (from the deferred-rotation record):** rotate
`QUEUE_ENGINE_SHARED_SECRET` in Vercel prod before any deploy — the old value
is in pushed git history. Rotation is an operator Vercel action; verify
afterward that the DB `system_control` row and the Vercel value were rotated
TOGETHER (the queue engine compares them for equality).

Notation: `$MERGE_SHA` = the merge commit of the final PR on `main` (fill in
after merge); `$DB` = the prod Postgres connection string (operator-held).

---

## Step 1 — Verify main/merge provenance

```bash
git fetch origin main
git log origin/main --oneline -3
git rev-parse origin/main          # → $MERGE_SHA
git merge-base --is-ancestor c83488d1ae36679d1adf58701a17e797dd28ec75 origin/main && echo PR62_ANCESTOR_OK
git status --short                  # must be empty on the operator checkout
git checkout "$MERGE_SHA"
```

Verify: `PR62_ANCESTOR_OK` prints; `origin/main` head is the reviewed final
PR merge; working tree clean. Abort if any command disagrees.
Idempotent: read-only.

## Step 2 — Apply migrations transactionally

Determine which of the five candidate migrations are missing, then apply the
missing ones **in one transaction**. All five are `IF NOT EXISTS` /
`CREATE OR REPLACE`-safe (re-application is a no-op), but the single
transaction guarantees all-or-nothing.

```bash
psql "$DB" -tA <<'SQL'
select 'seller_inbound_bursts:'        || coalesce(to_regclass('public.seller_inbound_bursts')::text,        'MISSING');
select 'inbound_processing_ledger:'    || coalesce(to_regclass('public.inbound_processing_ledger')::text,    'MISSING');
select 'webhook_request_receipts:'     || coalesce(to_regclass('public.webhook_request_receipts')::text,     'MISSING');
select 'claim_inbound_processing:'     || coalesce(to_regprocedure('public.claim_inbound_processing(text,text,text,text,text,text,integer,timestamptz,uuid,integer,integer)')::text, 'MISSING');
select 'internal_proof_stamp:'         || coalesce(to_regprocedure('public.internal_proof_stamp_queue_row(uuid,text,uuid,uuid,jsonb,text,text)')::text, 'MISSING');
SQL
```

Apply (from `apps/api/`), including only files whose objects reported
MISSING — in timestamp order:

```bash
psql "$DB" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
\i supabase/migrations/20260726120000_seller_inbound_bursts.sql
\i supabase/migrations/20260801060000_inbound_processing_ledger.sql
\i supabase/migrations/20260802090000_inbound_claim_contract.sql
\i supabase/migrations/20260802091000_webhook_request_receipts.sql
\i supabase/migrations/20260802092000_internal_proof_stamp_merge.sql
COMMIT;
SQL
```

NOTE (from the Phase-4A record): if any function errors on `gen_random_bytes`
/ `gen_random_uuid`, the session `search_path` must include `extensions`
(pgcrypto lives there on this project). Do not pin a narrower search_path.

Verify: re-run the probe block — zero `MISSING`. Abort on any error; the
transaction rolls back as a unit.
Idempotent: re-running the apply block is a no-op.

## Step 3 — Verify live database functions behaviorally

Read-only-effect probes against throwaway keys (rows are created only under
the `runbook:probe:` namespace and deleted immediately):

```bash
psql "$DB" -v ON_ERROR_STOP=1 -tA <<'SQL'
-- claim contract: fresh claim then duplicate-completed round trip
select (public.claim_inbound_processing('runbook:probe:claim'))->>'outcome';                     -- claimed_new
select (public.complete_inbound_processing('runbook:probe:claim',
        (select processing_run_id from public.inbound_processing_ledger
          where idempotency_key='runbook:probe:claim'), 'no_reply_required'))->>'ok';            -- true
select (public.claim_inbound_processing('runbook:probe:claim'))->>'outcome';                     -- duplicate_completed
delete from public.inbound_processing_ledger where idempotency_key = 'runbook:probe:claim';
-- stamp merge: zero-row targeting must fail closed
select (public.internal_proof_stamp_queue_row('00000000-0000-0000-0000-000000000000',
        'queued', null, 'b7c9a000-0000-0000-0000-000000000000'::uuid,
        '{"internal_canary": true}'::jsonb, 'probe', 'probe'))->>'ok';                           -- false
-- burst claim: no-op on an absent thread
select count(*) from public.claim_seller_inbound_burst('runbook:probe:none', null, now(), 'probe', gen_random_uuid()::text, 300000);  -- 0
SQL
```

Verify: outputs exactly as annotated. Abort otherwise.
Idempotent: probe rows deleted in-line; functions are pure claims.

## Step 4 — Deploy the exact clean merge SHA

```bash
cd apps/api
vercel deploy --prod --yes --build-env DEPLOY_GIT_SHA="$MERGE_SHA"
```

`--build-env DEPLOY_GIT_SHA` is REQUIRED — without it `/api/version` reports
provenance "unknown" (recorded deploy-protocol lesson). Queue remains paused
(`queue_execution_mode=paused` — containment unchanged by deploy).

Verify: deployment completes; note the deployment URL/id. Abort on build
failure (nothing has changed in prod behavior: same DB, queue paused).
Idempotent: redeploying the same SHA is safe.

## Step 5 — Verify /api/version

```bash
curl -s https://api-steel-three-96.vercel.app/api/version | jq .
```

Verify: reported SHA == `$MERGE_SHA`. Abort on mismatch (alias may point at
the previous deployment — do not proceed until the live host serves the
merge SHA).

## Step 6 — Configure required environment variables (explicit operator actions)

Names only — values are operator-held and never recorded:

| Variable | Value class | Purpose |
|---|---|---|
| `GROQ_API_KEY` **or** `OPENROUTER_API_KEY` | secret | natural-response provider credential (groq preferred when both) |
| `NATURAL_REPLY_ENGINE` | `internal_proof` | generation substitutes ONLY for internal test phones; all real threads behave as shadow |
| `NATURAL_REPLY_MODEL` | optional | allowlisted model; unset → provider default |
| `NATURAL_REPLY_TIMEOUT_MS` | optional | default 8000, clamped 1000–20000 |
| `SELLER_INBOUND_BURST_ENABLED` | `internal_proof` | burst engages ONLY for internal phones AND an active proof session |

```bash
vercel env add GROQ_API_KEY production          # or OPENROUTER_API_KEY
vercel env add NATURAL_REPLY_ENGINE production   # value: internal_proof
vercel env add SELLER_INBOUND_BURST_ENABLED production   # value: internal_proof
vercel redeploy <deployment-from-step-4> --prod  # env changes need a redeploy; same SHA
```

Then re-run Step 5.

Fail-closed properties (why partial configuration is safe): engine mode
without a key → deterministic template path, audited `no_model_configured`;
key without mode → nothing runs; `internal_proof` values without an open
proof session (burst) or a non-internal recipient (natural reply) behave as
disabled/shadow.

## Step 7 — Enable natural responses for internal proof only

Already accomplished by Step 6 (`NATURAL_REPLY_ENGINE=internal_proof`).
Verification is behavioral in Step 14. Explicitly NOT `enabled` — the
substitution path outside the internal phone registry must remain shadow.

## Step 8 — Enable burst only for the pinned internal thread

Already accomplished by Step 6 (`SELLER_INBOUND_BURST_ENABLED=internal_proof`).
The webhook additionally requires an ACTIVE internal-proof session (opened in
Step 9) and an internal test phone; each denial logs
`textgrid.inbound_burst_internal_proof_denied`. Real seller threads cannot
engage burst in this mode (tested: seller-burst-internal-proof-gate).

## Step 9 — Open the bounded proof session

```bash
cd apps/api
node --import ./scripts/register-aliases-ops.mjs scripts/ops/internal-proof-runbook.mjs status
node --import ./scripts/register-aliases-ops.mjs scripts/ops/internal-proof-runbook.mjs open-session
```

Verify: session row written with expiry ≤ 2 h (absolute cap 240 min from
first open — repeated open-session preserves the original window; it cannot
extend it). Abort if `status` shows queue mode ≠ `paused` before arming.

## Step 10 — Resume the exact canary row

```bash
node --import ./scripts/register-aliases-ops.mjs scripts/ops/internal-proof-runbook.mjs arm
node --import ./scripts/register-aliases-ops.mjs scripts/ops/internal-proof-runbook.mjs mint
node --import ./scripts/register-aliases-ops.mjs scripts/ops/internal-proof-runbook.mjs fire
```

The pinned row/campaign/recipient/sender are hardcoded in the runbook script
(row `4d211395-…`, campaign `b7c9a000-…`, recipient the internal handset,
sender the internal TextGrid number). `arm` refuses unless mode is `paused`
and then sets `scoped_canary_only`; `mint` issues a fresh 30-minute
authorization (the prior consumed authorization is unusable —
scoped-canary lesson: a resumed canary needs a NEW canary_run_id); `fire`
POSTs `/api/internal/queue/run` with the scoped-canary headers.

Verify: `fire` reports the single pinned row dispatched; zero excluded
reasons. Abort → run `close` (Step 17) which restores `paused`.

## Step 11 — Verify outbound send and receipt

```bash
node --import ./scripts/register-aliases-ops.mjs scripts/ops/internal-proof-runbook.mjs verify
```

Verify: queue row `sent`; `message_events` outbound row with provider SID;
delivery webhook received; contact-window bypass audit row present (the
bypass DENIES itself if its audit write fails — absence of the audit row
with a sent message is an abort-and-investigate condition). Physical check:
the internal handset received the SMS.

## Step 12 — Process the handset reply

Operator: reply from the internal handset with the scripted proof message
(multi-part: send two fragments within ~20 s to exercise burst).

Verify (SQL, bounded to the internal thread):

```bash
psql "$DB" -tA -c "select outcome, rejection_reason from public.webhook_request_receipts where from_phone_sha256 = encode(sha256('<internal-e164>'::bytea),'hex') order by received_at desc limit 3;"
psql "$DB" -tA -c "select status, terminal_disposition, attempt_count, duplicate_delivery_count from public.inbound_processing_ledger where thread_key = '<internal-e164>' order by received_at desc limit 3;"
```

Verify: receipts `accepted`; ledger rows `completed` with a canonical
terminal disposition; zero `processing` rows older than the SLA window.

## Step 13 — Verify burst / classification / state mutation

```bash
psql "$DB" -tA -c "select status, jsonb_array_length(constituents), version from public.seller_inbound_bursts where thread_key='<internal-e164>' order by created_at desc limit 1;"
psql "$DB" -tA -c "select lifecycle_stage, seller_stage, operational_status, lead_temperature, disposition, inbox_bucket, next_action from public.inbox_thread_state where thread_key='<internal-e164>';"
psql "$DB" -tA -c "select field_name, previous_value, new_value, change_source from public.universal_lead_state_events where thread_key='<internal-e164>' and created_at > now() - interval '1 hour' order by created_at;"
```

Verify: ONE completed burst containing both fragments; exactly one coherent
reply decision for the burst; thread state fields consistent with the
classified intent; before/after audit rows present for each changed field.

## Step 14 — Verify the automatic natural reply

```bash
node --import ./scripts/register-aliases-ops.mjs scripts/ops/internal-proof-runbook.mjs stamp-reply
psql "$DB" -tA -c "select event_type, payload->>'source', payload->>'model', payload->>'fallback_reason' from public.automation_events where event_type like 'NATURAL_REPLY_%' order by created_at desc limit 3;"
```

`stamp-reply` uses the atomic `internal_proof_stamp_queue_row` RPC (expected
status + campaign guard + allowlisted jsonb merge) — it aborts rather than
overwrite a concurrently-mutated row. Then:

```bash
node --import ./scripts/register-aliases-ops.mjs scripts/ops/internal-proof-runbook.mjs mint-reply
node --import ./scripts/register-aliases-ops.mjs scripts/ops/internal-proof-runbook.mjs fire-reply
```

Verify: reply SMS arrives on the handset; `NATURAL_REPLY_APPLIED` (or
`NATURAL_REPLY_FALLBACK` with the deterministic template — record which)
audit event persisted with model/latency/usage; the queued message passed
validation (no invented numerics, length within bounds).

## Step 15 — Verify follow-up planning

```bash
psql "$DB" -tA -c "select queue_status, message_type, scheduled_for from public.send_queue where to_phone_number='<internal-e164>' and message_type='followup' order by created_at desc limit 2;"
```

Verify: follow-up row exists per the stage's follow-up policy, scheduled in
the future, and (queue still `scoped_canary_only`) CANNOT dispatch — it is
outside the pinned manifest.

## Step 16 — Verify Inbox synchronization and alerting

```bash
psql "$DB" -tA -c "select inbox_bucket, latest_message_preview is not null from public.inbox_thread_state where thread_key='<internal-e164>';"
psql "$DB" -tA -c "select event_type, severity from public.notification_events where created_at > now() - interval '1 hour' order by created_at desc limit 5;"
```

Verify: bucket reflects the reply state; notification event(s) emitted for
the inbound; NO `inbound_no_disposition` P0 alerts fired during the session.

## Step 17 — Close the proof session

```bash
node --import ./scripts/register-aliases-ops.mjs scripts/ops/internal-proof-runbook.mjs close
```

Verify: `close` re-reads and reports session expired + mode restored; it
surfaces read errors rather than assuming success.

## Step 18 — Restore queue paused

`close` performs this; verify independently:

```bash
psql "$DB" -tA -c "select value from public.system_control where key='queue_execution_mode';"   -- paused
```

Also (operator decision): flip `SELLER_INBOUND_BURST_ENABLED` and
`NATURAL_REPLY_ENGINE` back to unset in Vercel if the proof window is over —
both are inert without an open session / for non-internal threads, but
removing them restores the pre-proof configuration exactly.

## Step 19 — Prove zero other recipients or rows were touched

All bounded to the session window `[T_open, T_close]`:

```bash
psql "$DB" -tA <<'SQL'
-- outbound sends to anyone other than the internal recipient: must be 0
select count(*) from public.message_events
 where direction='outbound' and created_at between :'T_OPEN' and :'T_CLOSE'
   and to_phone_number <> '<internal-e164>';
-- queue rows claimed outside the pinned manifest: must be 0
select count(*) from public.send_queue
 where updated_at between :'T_OPEN' and :'T_CLOSE'
   and to_phone_number <> '<internal-e164>'
   and queue_status in ('sending','sent');
-- thread-state mutations outside the internal thread (audited writers): must be 0
select count(*) from public.universal_lead_state_events
 where created_at between :'T_OPEN' and :'T_CLOSE'
   and thread_key <> '<internal-e164>';
-- inbound claims processed for non-internal threads during the window:
-- expected = organic inbound traffic; verify each has a terminal disposition
select count(*) filter (where status='processing') from public.inbound_processing_ledger
 where received_at between :'T_OPEN' and :'T_CLOSE';
SQL
```

Verify: first three counts are 0; the fourth is 0 once the SLA window has
passed. Record all outputs in the proof log.

---

## Abort/rollback at any step

`queue_execution_mode` is the single containment authority: run runbook
`close` (restores `paused`, expires the session). No step above changes any
seller-facing configuration outside the two `internal_proof`-scoped env
values, and no step is destructive; migrations are additive.

## Status honesty

Everything in this runbook is **prepared and tested at the code/replay
level only** (see `backend-final-completion-2026-08-02.md` for the
tested / replay-observed / production-proven split). Nothing here is
production-proven until this sequence has been executed and its
verifications recorded.
