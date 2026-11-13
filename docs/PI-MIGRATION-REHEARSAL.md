# LeadCommand: the nine links, rehearsal and production plan

**Status: rehearsed on disposable PostgreSQL 17 only. Nothing here has touched production.**

> **This is a disposable-schema rehearsal. It is not a rehearsal on a production copy.**
>
> Every database here was disposable: private PostgreSQL 17 clusters on unix sockets, created and destroyed for the run. The schemas came from three sources:
> - emulation fixtures plus the real prerequisite migrations (`scripts/db/migration-tests.manifest.mjs`);
> - one **synthetic** production-shaped dump (`scripts/db/prod-copy-synthetic-build.mjs`). It holds the release chain up to #28, reader 1.0, and twelve invented leads.
>
> This proves:
> - each link applies, alone and cumulatively;
> - its posttest holds;
> - its rollback restores the catalog fingerprint exactly;
> - it re-applies.
>
> It does **not** prove behaviour against production's real relations, row volumes, extensions, platform roles, grants or drift. That needs the owner's production copy (docs/PRODUCTION-COPY-REHEARSAL.md, authorizations A1 to A7).

**Applying any link to production is an owner decision.** No production SMS activation is part of this plan. Every switch these links add is born OFF (§6).

**Owner boundary (2026-10-15, enforced by `run-migration-test.mjs`).** Pretest, posttest and rollback-posttest files are disposable-only fixtures: they insert synthetic rows inside their own transactions. **They never run against production**, not even inside `BEGIN … ROLLBACK`. On production, only these run:
- the read-only checks in §4 and §7;
- the apply files;
- the rollback files, if needed.

All of them are run by the owner.

**Evidence:** `docs/prod-copy-rehearsal/pi-2026-10-30/`
- `rehearsal.json` is the machine-readable report: every step, timing and fingerprint.
- `per-link/` holds the runner logs.
- `reader_family_chain.log` is the reader family on one database.
- `prodshape/` holds the production-shaped run's JSON evidence and the link-5 log.
- `scripts/` holds the scripts and validation SQL used.

## 1. The nine links, in production order

| # | Runner id | Apply file (`supabase/migrations/`) | Also called | What it adds |
|---|---|---|---|---|
| 1 | `lc_mcp_reader` | `PROPOSED_20261019150000_lc_mcp_reader.sql` | reader 1.0 | Role `lc_mcp_reader` (NOLOGIN, no BYPASSRLS), its SELECT policies, the self-check, 9 definer reads |
| 2 | `lc_mcp_conversation_intel` | `PROPOSED_20261026120000_lc_mcp_conversation_intel.sql` | reader 1.1 | `lc_mcp_lead_conversation`, `lc_mcp_conversation_worklist`, `lc_mcp_pipeline_counts`, `lc_mcp_conversation_signals` |
| 3 | `lc_mcp_corpus_census` | `PROPOSED_20261026150000_lc_mcp_corpus_census.sql` | reader 1.2 | `lc_mcp_corpus_census`, `lc_mcp_lead_screen` |
| 4 | `lc_mcp_acquisition_reads` | `PROPOSED_20261027130000_lc_mcp_acquisition_reads.sql` | reader 1.3, **#30** | Five per-thread reads: followups, execution log, offers, contact eligibility, operator tasks |
| 5 | `lc_mcp_full_history` | `PROPOSED_20261030120000_lc_mcp_full_history.sql` | reader, A8 | Redefines #2's worklist and conversation read: `window 0` = all history, still keyset-paged. The bound is 0..36500. It replaces the withdrawn `…_worklist_window_1095`. |
| 6 | `action_gateway_ohg` | `PROPOSED_20261027120000_action_gateway_ohg.sql` | **#29** | The Hidden Gold actions, `action_gateway.lead_annotations`, the restore table, the registry rows |
| 7 | `action_gateway_standing_reply` | `PROPOSED_20261028100000_action_gateway_standing_reply.sql` | **#31** | Standing seller-facing authority: grant columns, a CHECK, an authorization flag |
| 8 | `ai_generated_outbound` | `PROPOSED_20261029090000_ai_generated_outbound.sql` | **A** | `record_kind` and author columns on `public.ai_generated_messages`; widened CHECKs |
| 9 | `action_gateway_agent_message` | `PROPOSED_20261029100000_action_gateway_agent_message.sql` | **B**, #32 | `queue_agent_text`, submissions, lead ownership, the event feed, `ai_agent_text_enabled` (born OFF), the composer retirement |

Each link has its rollback beside it, `<file>_rollback.sql`, and its disposable-only fixtures. All nine set `lock_timeout = '5s'`, so a busy table makes a link fail fast instead of queueing behind traffic.

### Why this order

- **1 → 2 → 3 → 4 is forced.** Reader 1.1 and 1.2 **refuse to apply once #30 is applied**: their apply self-check sees #30's five definer functions as unexpected. This is found in docs/PRODUCTION-COPY-REHEARSAL.md §5 and reproduced here.
- **5 after 2.** It redefines 2's functions. It was proven after 4, and after the whole gateway family.
- **6 → 7 → 8 → 9** follows AGENT-MESSAGES-MIGRATION-PLAN §1. 8 may also come before 6 or 7, but not after 9.
- **Readers first.** They are read-only, A8 needs them, and they carry no send path. The gateway family may follow on another day.

The production-copy tool applies #29 before #30, and that works too, as long as 2 and 3 precede #30.

## 2. Dependency analysis

| Link | Needs (already applied) | Needed by | Notes |
|---|---|---|---|
| 1 reader 1.0 | Production base tables (its inventory relations) | 2, 3, 4, 5 | Creates the **cluster-global** role `lc_mcp_reader`. The synthetic dump already contained it. |
| 2 reader 1.1 | 1; the `messages` and inbox columns | 3, 5 | Must precede 4 (self-check, above) |
| 3 reader 1.2 | 1, 2; screening columns | none | Must precede 4. Its self-check list names 2's two functions by signature. |
| 4 #30 | 1. It also reads the `send_queue`, `followup_intents`, `seller_offers`, `acquisition_opportunities`, `automation_events`, suppressions and `agent.ops_work_item` columns. | none | Joins `action_gateway.seller_action_receipts` **when it exists** (#28): a soft cross-family edge. Its posttest cannot run where #26 is applied, because it creates schema `action_gateway`. It is advisory on a gateway database. |
| 5 full history | 1, 2 | none | `create or replace` with **identical signatures**, so the self-check lists of 3 and 4 still match. Owner, SECURITY DEFINER, STABLE, `search_path` and EXECUTE grants are unchanged. |
| 6 #29 | #26 (and its chain: runtime, capabilities, missions, operations action center, holds registry, S3, durability), #27, and #28 (with negotiation authority and send authorization) | 7 | Widens #28's receipts action CHECK; the original is kept in `action_gateway.ohg_restore` |
| 7 #31 | #26, #27, #28, 6 | 9 | Changes `capability_grants` and `action_authorizations`. Redefines `grant_refusal`, `action_gateway_principal`, `dw_handoff` and `lc_seller_action_load`. |
| 8 A | `PROPOSED_20261015130000_message_origin_ai_generated_messages` (the ledger) | 9 | ALTERs `public.ai_generated_messages` |
| 9 B | #26, #27, #28, 6, 7, 8 | none | Widens #28's receipts CHECK again; the originals go in `action_gateway.agent_message_restore`. Redefines #31's standing bodies. |

**Not among the nine, but required:**
- **#26, #27 and #28 before 6.** Check them with the §1 query of AGENT-MESSAGES-MIGRATION-PLAN. If any value is `false`, stop.
- **The ledger before 8.**

## 3. Rehearsal results

### 3.1 Each link alone (runner, fresh cluster per link)

`scripts/db/run-migration-test.mjs --pg-bin /usr/lib/postgresql/17/bin --data-root <dir> --id <id>`

**Each cycle:**
1. Setup.
2. Pretest. The fingerprint must show it left no trace.
3. Apply.
4. Posttest.
5. Rollback.
6. Rollback posttest.
7. The fingerprint must equal the pre-apply fingerprint.
8. Pretest, re-apply, posttest.

The setups are cumulative: link 9's 32 setup steps apply #26 → #28, 6, 7, the ledger and 8 for real. **All nine PASS.**

| # | Link | Setup | Pretest | **Apply** | Posttest | Rollback | Rollback posttest | Fingerprint restored | Re-apply | Re-apply posttest |
|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|
| 1 | lc_mcp_reader | 3 | 42 ms | **94 ms** | 431 ms | 44 ms | 38 ms | `1d6cbbc448ed5945` ✓ | 109 ms | 476 ms |
| 2 | lc_mcp_conversation_intel | 5 | 41 ms | **92 ms** | 142 ms | 41 ms | 85 ms | `a2d1f48c85c990a8` ✓ | 86 ms | 138 ms |
| 3 | lc_mcp_corpus_census | 7 | 48 ms | **82 ms** | 104 ms | 38 ms | 78 ms | `448adbf47d5a1fa0` ✓ | 89 ms | 125 ms |
| 4 | lc_mcp_acquisition_reads | 6 | 50 ms | **99 ms** | 133 ms | 41 ms | 77 ms | `829cf85a39f269ff` ✓ | 88 ms | 135 ms |
| 5 | lc_mcp_full_history | 6 | 63 ms | **49 ms** | 66 ms | 66 ms | 68 ms | `42f87ed536e2380c` ✓ | 71 ms | 77 ms |
| 6 | action_gateway_ohg | 27 | 69 ms | **61 ms** | 110 ms | 103 ms | 94 ms | `f051cdf5ee8be705` ✓ | 56 ms | 99 ms |
| 7 | action_gateway_standing_reply | 28 | 44 ms | **50 ms** | 101 ms | 47 ms | 99 ms | `85289131b97d3d32` ✓ | 64 ms | 87 ms |
| 8 | ai_generated_outbound | 3 | 41 ms | **47 ms** | 52 ms | 44 ms | 46 ms | `553fad6fd457acfa` ✓ | 49 ms | 52 ms |
| 9 | action_gateway_agent_message | 32 | 45 ms | **146 ms** | 108 ms | 121 ms | 93 ms | `2d8e3f10f2e0d57a` ✓ | 148 ms | 104 ms |

### 3.2 Reader family on one database (links 1 → 5)

The links were applied in order, each preceded by its own emulation, with pretest, apply and posttest each time. Then the §7 reader validation ran (all `true`), and the all-history worklist page as `lc_mcp_reader` returned 5 of 5 threads. Rollbacks then ran 5 → 1, each with its rollback posttest.

The catalog was then compared with a twin database holding the same emulations and no link. **Identical (`4dfbe988d80e32ff`). 0 failures. PASS.**

| Link | Apply | Posttest | Rollback | Rollback posttest |
|---|---:|---:|---:|---:|
| 1 | 82 ms | 518 ms | 35 ms | 25 ms |
| 2 | 69 ms | 130 ms | 17 ms | 74 ms |
| 3 | 70 ms | 89 ms | 16 ms | 55 ms |
| 4 | 72 ms | 122 ms | 18 ms | 55 ms |
| 5 | 22 ms | 39 ms | 18 ms | 64 ms |

### 3.3 All nine on one production-shaped database (synthetic dump, production-copy tool)

`scripts/db/prod-copy-rehearsal.mjs` ran on a private cluster against a **synthetic** dump: the release chain up to #28, reader 1.0 and twelve invented leads. Steps:
1. `guard`, `validate-backup` and `restore` passed. The restore had one expected error class (the stub schema already exists); its ACL pass reported 0 errors.
2. `prereqs` passed: #26, #27, #28, the ledger, the gateway self-check and reader 1.0 were present, and every switch was OFF.
3. `migrate` passed:
   - #29 → #30 → #31 → A → B, with pretests that left no trace and timed CHECK re-validation;
   - V-A, V-B and V-OFF all held, and the switches stayed OFF;
   - rollback B → #29, each with its rollback posttest; **fingerprint `34ec5ac68b13452d` restored, row counts restored**;
   - re-apply, with the fingerprint equal to the first apply.
4. `census` passed. It rolled back #30, applied 1.1 and 1.2 (pretest, apply), and re-applied #30.
5. **Link 5 by hand on the same database:**
   - pretest left no trace;
   - apply took 19 ms;
   - the §7 reader **and** gateway validation queries were all `true`, with all nine links present at once;
   - the all-history worklist returned 9 of 9 threads;
   - rollback, rollback posttest, then **fingerprint `4024e79a28f1ca86` restored**;
   - re-apply.

**Advisory posttests.** The posttests of #30 and link 5 are advisory on this copy, as the tool already treats #30's. They assert the runner emulation's seed threads (P5 and 101/102/107), which the synthetic corpus does not have.

| Cycle 1 | Pretest | Apply | Posttest |
|---|---:|---:|---:|
| #29 | 37 ms | 53 ms | 95 ms pass |
| #30 | 17 ms | 169 ms | advisory |
| #31 | 14 ms | 49 ms | 90 ms pass |
| A | 16 ms | 99 ms | 86 ms pass |
| B | 26 ms | 171 ms | 102 ms pass |

Rollbacks, B → #29: 120, 45, 51, 44 and 105 ms.

**Link 1 in this run.** It was part of the dump, so this run did not apply it. Its apply, rollback and re-apply are proven in §3.1 and §3.2.

### 3.4 What the timings mean

Every database had tens of rows, so these timings are a floor. On production:
- **Link 8** re-validates its CHECKs against every row of `public.ai_generated_messages`: one scan per CHECK. The `migrate` step times these scans on the copy.
- **Links 6, 7 and 9** re-validate CHECKs on `action_gateway.seller_action_receipts`, `capability_grants` and `action_authorizations`.
- **Links 1 to 5** create functions, policies and grants only: no table scan or rewrite.

## 4. Backup checks on production, before starting

These are read-only. Record their output beside the apply log.

### 4.1 pg_dump scope

Take these before link 1. Take them again before link 6 if the families are applied on different days.

```bash
# Schema of everything the nine links touch: the catalog diff after each link and after any rollback
pg_dump --schema-only --no-owner --schema=public --schema=action_gateway --schema=agent \
  "$PROD_ADMIN_URL" > pre-nine-schema.sql

# Data of every table a link ALTERs, or whose rows a rollback would drop
pg_dump --data-only --format=custom \
  --table=public.ai_generated_messages \
  --table='action_gateway.*' \
  --table=public.system_control \
  --table=public.idempotency_ledger \
  "$PROD_ADMIN_URL" > pre-nine-data.dump

# Roles: link 1 creates a cluster-global role
pg_dumpall --roles-only --no-role-passwords "$PROD_ADMIN_URL" > pre-nine-roles.sql
```

**If `pg_dumpall` is refused** (managed Supabase), record the role list instead:

```sql
select rolname, rolcanlogin, rolbypassrls from pg_roles order by 1;
```

**Also confirm** that the platform's point-in-time recovery or daily backup is current, and record its timestamp.

### 4.2 Row counts of touched tables

```sql
select 'public.ai_generated_messages' as rel, count(*) from public.ai_generated_messages
union all select 'action_gateway.capability_grants', count(*) from action_gateway.capability_grants
union all select 'action_gateway.action_authorizations', count(*) from action_gateway.action_authorizations
union all select 'action_gateway.seller_action_receipts', count(*) from action_gateway.seller_action_receipts
union all select 'action_gateway.extensions', count(*) from action_gateway.extensions
union all select 'public.idempotency_ledger', count(*) from public.idempotency_ledger
union all select 'public.system_control', count(*) from public.system_control
union all select 'public.messages', count(*) from public.messages
union all select 'public.message_events', count(*) from public.message_events
union all select 'public.inbox_thread_state', count(*) from public.inbox_thread_state
union all select 'public.send_queue', count(*) from public.send_queue;
```

The reader links write no rows. `ai_generated_messages`, `seller_action_receipts`, `capability_grants` and `action_authorizations` set the CHECK re-validation cost of links 6 to 9. `messages` and `inbox_thread_state` give the scale of a full-history traversal.

After all nine links, the counts must be **unchanged**, except that:
- `action_gateway.extensions` gains this chain's registry rows (B adds 17);
- the new `action_gateway.lead_events` starts empty.

### 4.3 Preconditions, all read-only

- **Link 1:**
  ```sql
  select count(*) = 0 from pg_roles where rolname = 'lc_mcp_reader';
  ```
- **Link 4:** links 2 and 3 are present:
  ```sql
  to_regprocedure('public.lc_mcp_corpus_census(text)') is not null
  ```
  Otherwise 2 and 3 can no longer be applied after it.
- **Link 6:** the AGENT-MESSAGES-MIGRATION-PLAN §1 query is all `true`.
- **Link 8:**
  ```sql
  to_regclass('public.ai_generated_messages') is not null
  ```
- **Every link:** its file's SHA-256 equals the reviewed commit's. The production-copy tool pins the gateway links' hashes from docs/AGENT-TEXTS-DIFF-AUDIT.md.

## 5. Rollback procedure, per link

Roll back in **reverse order**: 9 → 8 → 7 → 6, and 5 → 4 → 3 → 2 → 1. For each link:
1. Run `<file>_rollback.sql`. It is one transaction, with a 5 s lock timeout.
2. Diff `pg_dump --schema-only` of the three schemas against the dump taken before that link. It must be identical; the rehearsal fingerprints were.
3. Re-run the §4.2 counts.

| # | It refuses (nothing is dropped) while | What it restores or drops | Data impact |
|---|---|---|---|
| 9 | A live grant carries `standing_seller_facing` for `queue_agent_message` or `queue_agent_text`; an agent-message, text, assignment or transfer intent is pending; any agent-message or agent-text receipt exists (export it first) | Restores #31's standing bodies and #28's helpers, writer and receipts CHECK, verbatim from `agent_message_restore`. Drops lead assignments, the event feed **with its rows**, the reads, the reservation functions and the registry rows. | `lead_events` and the unsent `agent_text_submissions` are dropped: export them first. `idempotency_ledger` reservations stay and expire with retention. |
| 8 | Any `agent_outbound` or `agent_text` record exists (append-only evidence) | Restores the four original CHECKs and `inbound_message_id NOT NULL`. Drops `record_kind`, `author_employee` and `author_attribution`. | None while it can run: only `reply` rows exist |
| 7 | Any grant carries `standing_seller_facing` (the owner revokes it first) | Restores #26's and #28's bodies. Drops the standing trigger, the function and the two grant columns. The authorization flag is kept if standing authorizations exist as history. | None |
| 6 | An OHG intent is pending; an OHG receipt is open; any receipt of the two handed-off actions exists | Deletes its registry rows, drops what it created, and restores #28's receipts CHECK from `ohg_restore` | `lead_annotations` is dropped: export it first |
| 5 | The link is not applied | Restores 2's definitions of the two functions, byte for byte | None. But the bounds go back to reader 1.1's: the worklist accepts 1..365 days and the conversation read 1..1095. `window_days: 'all'` gets `22023`, **and so does a 1095-day ranking**. A caller's fallback for the ranking must be 365 days, not 1095. |
| 4 | The link is not applied | Drops its five functions and grants | None |
| 3 | The link is not applied | Drops its two functions and grants | None. **Roll back 4 first.** |
| 2 | The link is not applied | Drops its four functions and grants | None. **Roll back 5, 4 and 3 first.** |
| 1 | The link is not applied | Drops exactly what it created: policies, grants, functions and the role. It fails if another database depends on the role. | None. **Revoke the reader token first.** |

**Brakes that need no rollback:**
- the R2 emergency stop;
- the queue stop;
- `ai_agent_text_enabled` absent or `false`;
- revoking the reader token or a grant.

Use these first. A rollback is for a defective link, not for stopping traffic.

## 6. Born OFF, verified

| Link | Switch or grant | Born as | Evidence |
|---|---|---|---|
| 1 to 5 | None | No send path, no switch | Read-only definer functions. The posttests assert no write privilege and no BYPASSRLS; §7 shows `reader_role_safe`. |
| 6 #29 | The four Hidden Gold actions | Not callable: no grant exists, the owner mints them | Posttest; registry rows only |
| 7 #31 | `capability_grants.standing_seller_facing` | No grant carries it | Posttest "no grant carries the standing flag (born OFF)"; §7 `no_standing_grants` |
| 8 A | None | No new record; existing rows become `reply` | V-A `no_agent_records_yet` (production-shaped run) |
| 9 B | `system_control.ai_agent_text_enabled` | Absent = OFF; `agent_text_refusal()` returns `AGENT_TEXT_KILL_SWITCH_OFF`. No grant for the eight new capabilities; no standing grant. | Posttest "F: born OFF". V-OFF in the production-shaped run: `{refusal: AGENT_TEXT_KILL_SWITCH_OFF, at_switch: null, new_grants: 0, standing_at: 0}` after apply and after re-apply. |

The production-shaped run also confirmed that `ai_agent_text_enabled`, `ai_agent_message_enabled` and `ai_conversation_send_enabled` were OFF before, during and after.

## 7. Post-migration validation queries

These are read-only. Every boolean must be `true`. Both queries ran green on the production-shaped copy with all nine links applied (§3.3); the files are in `scripts/`.

**After links 1 to 5** (`scripts/validate_reader.sql`):

```sql
select r.rolcanlogin = false and r.rolbypassrls = false                                                                                                  as reader_role_safe,
       has_function_privilege('lc_mcp_reader', 'public.lc_mcp_conversation_worklist(text,integer,text,timestamp with time zone,uuid,integer)', 'EXECUTE') as worklist,
       has_function_privilege('lc_mcp_reader', 'public.lc_mcp_lead_conversation(text,uuid,integer,timestamp with time zone,text,integer)', 'EXECUTE')    as conversation,
       has_function_privilege('lc_mcp_reader', 'public.lc_mcp_corpus_census(text)', 'EXECUTE')                                                          as census,
       has_function_privilege('lc_mcp_reader', 'public.lc_mcp_thread_contact_eligibility(uuid)', 'EXECUTE')                                             as acquisition_reads,
       not has_function_privilege('anon', 'public.lc_mcp_conversation_worklist(text,integer,text,timestamp with time zone,uuid,integer)', 'EXECUTE')     as no_anon,
       pg_get_functiondef('public.lc_mcp_conversation_worklist(text,integer,text,timestamp with time zone,uuid,integer)'::regprocedure) ~ '36500'        as full_history
from pg_roles r where r.rolname = 'lc_mcp_reader';

-- one all-history page, as the reader (a definer read: nothing is written)
begin;
set local role lc_mcp_reader;
select (w ->> 'total')::int as all_history_total, jsonb_array_length(w -> 'rows') as page_rows
  from public.lc_mcp_conversation_worklist('recent_inbound', 0, null, null, null, 25) w;
rollback;
```

**Then run the reader's own self-check.** It runs at boot with the reader's full inventory, and every 10 minutes after. It must report `ok`.

**After links 6 to 9:**
1. Run V-A (after 8), then V-B and V-OFF (after 9), from AGENT-MESSAGES-MIGRATION-PLAN §3.
2. Run `scripts/validate_gateway.sql`:

```sql
select coalesce((action_gateway.self_check('lc_action_gateway') ->> 'ok')::boolean, false)                     as gateway_self_check,
       to_regclass('action_gateway.lead_annotations') is not null                                                 as link_29,
       to_regprocedure('action_gateway.standing_reply_refusal(uuid,uuid)') is not null                             as link_31,
       (select count(*) from action_gateway.capability_grants where standing_seller_facing and revoked_at is null) = 0 as no_standing_grants,
       action_gateway.agent_text_refusal() = 'AGENT_TEXT_KILL_SWITCH_OFF'                                        as agent_text_off;
```

**Then** re-run the §4.2 counts and compare them with the pre-apply counts.

## 8. What remains, and whose it is

- **A rehearsal on a copy of production** is the owner's:
  1. A backup, under authorizations A1 to A7.
  2. `scripts/db/prod-copy-rehearsal.mjs` (§3.3 is that tool on a synthetic dump).
  3. Link 5 by hand, as in `scripts/prodshape_full_history.sh`. The tool does not yet know link 5.
- **The A8 plan in agntei** (`docs/AGNTEI-A8-DATA-PROCESSING-PLAN.md` §2 and §5) still names `…_lc_mcp_worklist_window_1095` and "1095 days". The link is now `PROPOSED_20261030120000_lc_mcp_full_history`, with no time cutoff.
