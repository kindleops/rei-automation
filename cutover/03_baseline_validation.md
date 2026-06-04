# Baseline File Validation Report

_Static analysis of the draft `apps/api/supabase/migrations/00000000000001_baseline_schema.sql` (~970 KB, 25,690 lines), plus the earlier from-zero replay result. Read-only._

## Replay result (from prior phase, throwaway branch, branch deleted)
| Metric | Result |
|---|---|
| Tables created | **117** |
| Views | **70** |
| Functions | **79** |
| Required tables present | campaigns, properties, prospects, phones, master_owners, send_queue, message_events, campaign_target_graph → **all ✅** |
| Failed statements | **1** (environment-dependent, see below) |
| Replayable from zero | **Yes** |

## Static checks (task 7)
| Check | Result | Verdict |
|---|---|---|
| Duplicate index names | **0** (566 indexes) | ✅ clean |
| Duplicate constraint names | **0** (239 constraints) | ✅ clean |
| Invalid/ownership statements (`OWNER TO`) | **0** (dumped `--no-owner`) | ✅ clean |
| Dangerous grants (`GRANT`/`REVOKE`) | **0** (dumped `--no-privileges`) | ⚠️ see "GRANTs" below |
| `SECURITY DEFINER` functions | **13** | ⚠️ review; all 13 pin `SET search_path` (safe pattern) |
| Webhook/platform dependencies | **1** (`supabase_functions.http_request` trigger) | ⚠️ blocker, see below |
| `auth.*` references | 2 (RLS policies → `auth.uid()`/`auth.role()`) | ℹ️ resolves on Supabase envs |
| RLS — tables with RLS enabled | 96 | ℹ️ |
| RLS — policies | 98, on 71 tables | ℹ️ |
| RLS — enabled but NO policy | **25 tables** | ⚠️ service-role-only (matches prod) |
| RLS — policy on table without RLS | **0** | ✅ no ineffective policies |
| Trigger recursion risk | 60 triggers | ⚠️ manual review recommended |

## Findings detail

### 1. ⚠️ BLOCKER — platform webhook dependency (1 statement)
```sql
CREATE TRIGGER "message_events_to_podio_sync" AFTER INSERT ON "public"."message_events"
  FOR EACH ROW EXECUTE FUNCTION "supabase_functions"."http_request"(
    'https://real-estate-automation-three.vercel.app/api/internal/events/sync-podio', 'POST', …);
```
`supabase_functions` is a **platform-managed** schema provisioned only when **Database Webhooks** are enabled. It exists on prod; absent on a bare branch → this was the single replay failure.
**Remediation (pre-adoption):** either (a) enable Database Webhooks on every target environment before replay, or (b) move this trigger out of the schema baseline and re-establish it via Supabase's webhook config / a guarded forward migration (`DO $$ BEGIN IF to_regnamespace('supabase_functions') IS NOT NULL THEN … END IF; END $$;`). **Recommended: (b)** — keeps the baseline environment-independent.

### 2. ⚠️ GRANTs were stripped (`--no-privileges`)
The baseline contains **no GRANTs**. Prod grants table privileges to `anon`/`authenticated`/`service_role` for PostgREST access. A baseline without grants means:
- Backend that uses **`service_role`** → unaffected (bypasses grants + RLS).
- Any dashboard/PostgREST access via **`anon`/`authenticated`** → would lose table access until grants are re-applied.
**Remediation (pre-adoption):** regenerate the **adoption** baseline **with** privileges (`pg_dump` without `--no-privileges`, or `supabase db dump` which includes them), OR add a companion `00000000000002_grants.sql`. Decide based on whether the app relies on anon/authenticated roles. _The current draft used `--no-privileges` for portability during validation; the adoption baseline should re-include grants if the app needs them._

### 3. ⚠️ 13 SECURITY DEFINER functions
13 functions run with definer privileges. **All 13 pin `SET search_path`** (the count of search_path-setting functions equals the SECURITY DEFINER count), which is the safe pattern that prevents search-path hijacking. **Action:** confirm each pins to a trusted schema (e.g., `pg_catalog, public`) and review their bodies once before adoption — they're a privilege-escalation surface.

### 4. ⚠️ RLS posture — 25 tables RLS-on / no-policy
96 tables have RLS enabled; 25 of them have **no policy** (e.g., `phones`, `prospects`, `system_control`, `emails`, `sms_campaigns`, `wire_accounts`). With RLS on and no policy, **non-service roles get zero rows** — this is deliberate "service-role-only" hardening and **matches prod** (the baseline is faithful). Not a defect, but document it so post-baseline nobody is surprised that anon/authenticated can't read these.

### 5. ⚠️ Trigger recursion (60 triggers) — manual review
Static analysis can't fully prove the absence of recursion. **Action:** review `AFTER INSERT/UPDATE` triggers whose function writes back to the same table (e.g., `*_updated_at`, denormalization, `set_*` triggers). `updated_at` triggers are `BEFORE` and safe; the risk is any `AFTER` trigger issuing `UPDATE`/`INSERT` on its own table without a guard.

## Verdict
The baseline is **structurally clean and replayable from zero.** Two items must be resolved before prod adoption: **(1)** the `supabase_functions` webhook trigger, **(2)** the GRANTs decision. Items 3–5 are review/documentation, not blockers.
