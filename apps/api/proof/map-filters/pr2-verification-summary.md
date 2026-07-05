# PR2 Verification Summary

Generated: 2026-07-05T04:58:00Z

## Recovery vs Rebuild

**Rebuild** from Grok session transcript (`updates.jsonl`). No recoverable git commits, stashes, or filesystem copies were found.

## Branch & Commits

| Phase | SHA | Message |
|-------|-----|---------|
| PR1 | `16fcb2f` | feat(map-filters): restore audited registry foundation |
| PR2 | `6409f94` | feat(map-filters): restore compiler tokens and canonical counts |

- **Remote branch:** `claude/restore-map-filters-pr1-pr2`
- **Worktree:** `/Users/ryankindle/real-estate-automation-map-filters`
- **Base:** `origin/main` @ `68d543b`

## Unit Tests

48/48 passing (`map-filter-registry`, `map-filter-compiler`, `map-filter-predicate-sql`, `map-filter-token-scope`).

## Live Gate (checkpointed)

| Suite | Status | Notes |
|-------|--------|-------|
| A. field-audit | **BLOCKED** | Supabase REST per-field sweep slow; gate run aborted early on empty error object |
| B. simple-property-accounting | **PASS** | 10/10 cases; property counts reconcile (698ms no_filter) |
| C. prospect-accounting | **FAIL** | `prospect_sms_eligible` prospect COUNT exceeds 120s statement timeout |
| D. owner-accounting | **NOT RUN** | Blocked by prospect suite timeout pattern |
| E. mixed-expression-accounting | **NOT RUN** | Blocked |
| F. relationship-semantics | **NOT RUN** | Blocked |
| G. token-security | **PASS** | RLS enabled, scope/expiry/revocation/cross-org checks |
| H. route-smoke | **BLOCKED** | Hangs after route import (Next.js ESM resolution / system flag) |
| I. query-plans | **NOT RUN** | Blocked |

## Live Row Counts (confirmed)

| Table | Count |
|-------|------:|
| properties | 124,046 |
| prospects | 149,798 |
| master_owners | 102,157 |
| map_filter_tokens | 0 |

## Accounting Highlights (property-only suite)

- **No filter:** 124,046 mappable properties — direct/compiler match
- **SFR:** 89,222 — match
- **Multifamily 5+:** reconciled
- **Equity ≥50%, tax delinquent, active lien, out-of-state owner:** reconciled

## Slowest Query

Cross-entity `COUNT(DISTINCT pr.prospect_id)` with `EXISTS` over `linked_property_ids_json` — **>120s** (statement timeout `57014`) on filtered prospect cases.

## Token Security

- `map_filter_tokens` exists with RLS enabled
- Full SHA-256 digest internal; 128-bit exposed token
- Expired, revoked (delete), cross-org, and unsupported version rejection proven
- Token route no longer leaks `filterTokenDigest` or `permissionScope`

## Remaining Blockers (PR3 not started)

1. Prospect/owner cross-entity count SQL performance — needs index/plan work before live reconciliation
2. Live field-audit completion (174-field REST sweep)
3. Route smoke tests (Next.js import + `dashboard_live_enabled` flag path)
4. Mixed-expression and relationship accounting suites
5. Query plan artifacts

## Post-PR2 fix commits pending push

Pooler URL resolution in postgres client, checkpointed gate suites, entity-scoped accounting, `revoked_at` reconciliation migration.