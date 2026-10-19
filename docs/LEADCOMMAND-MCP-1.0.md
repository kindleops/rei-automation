# LeadCommand MCP 1.0 — Intelligence Gateway

A first-party, provider-neutral, **read-only** MCP server over LeadCommand data, for any MCP host (Claude, Agntau, or another agent runtime).

| | |
|---|---|
| Status | Built and tested locally. **Not pushed, not merged, not deployed.** |
| Branch | `feat/leadcommand-mcp-1`, cut from production release `43650af3` (8.5.13) |
| Package | `mcp/leadcommand-mcp/` |
| Transport | stdio (default) and **loopback-only Streamable HTTP** (`LEADCOMMAND_MCP_TRANSPORT=streamable-http`, 127.0.0.1 / ::1, bearer token from a 0600 file). No public endpoint. |
| Protocol | MCP `2025-11-25` (the latest the SDK negotiates), official TypeScript SDK `@modelcontextprotocol/sdk@1.32.1` |
| Phase | Phase One. Every tool is a bounded read. |

---

## 1. Audit findings (state at `43650af3`)

### 1.1 Repository and read paths

- The agent plane already has a read-only stack, and the gateway builds on it:
  - `apps/api/src/lib/agent/quick-scan/read-client.js` has `createGuardedReadFetch`. It allows GET/HEAD on `/rest/v1/<table>` of the app's own Supabase origin, plus POST to three allowlisted STABLE RPCs. It refuses PATCH, PUT, DELETE, table POSTs, write `Prefer` headers and any other origin before a request leaves the process.
  - `quick-scan/services.js` has `createQuickScanServices`. It holds the same domain services the Entity Graph cockpit routes call: the dossier, column enrichment, outreach state, entity-contact review and ZIP context.
  - `quick-scan/tools.js` has pure projections that never output names, phones, emails, mailing addresses or message text.
  - `research/research-tools.js` has the column whitelists, campaign projection, `safeFlags` (a protected-class flag filter), `eg.distress_signals` with `findInconsistencies`, and `eg.property_lookup`.
  - `research/pii.js` has the masking and residual checks.
- **The `agent_api` login has no SELECT on any `public` domain table.** This was verified in the production catalog through the `agent_api` login itself, using `has_table_privilege`. It can read `agent.org` and `agent.operator_membership`, which hold one row: the owner. So:
  - **domain reads** use the existing agent research read path: service-role PostgREST behind the guarded read-only transport. The key stays server-side.
  - **org membership** is verified as `agent_api`, with verify-full TLS against `prod-ca-2021.crt`. The role is checked to be neither superuser nor BYPASSRLS.
- **Superseded 2026-10-16 (§4.2):** live mode no longer uses the service-role key or the `agent_api` login. Both are writable credentials. Domain reads and membership now go through ONE database-role-enforced read-only credential, `lc_mcp_reader`.
- The repo's migration history does not match production (known). Table schemas below were read from the live catalog (`pg_attribute`, `pg_indexes`) as `agent_api`. No row data was read that way.

### 1.2 Leads and properties

- **`properties`** has about 176K rows and 346 columns.
  - Indexes: btree `property_id`, `(market, property_id)`, `property_address_zip`, `(lat, lng)`, and trigram GIN on `property_address_full` / `city`.
  - Owner names and mailing data live here. They are never projected.
- **`eg_property_facts`** has about 177K rows, one per property. It is the Entity Graph read model, holding asset facts plus lead-state columns: `conversation_stage/status`, `pipeline_stage/status`, `deal_id`, `last_contact_at`, `sms_status`, `campaign_count`, `scores_*`, `distress_signal_count`, `signal_labels`, `equity_*` and `refreshed_at`.
  - Every column the gateway filters on has a `(col, property_id)` btree. Examples: `market`, `zip_code`, `property_address_state/city/county_name`, `conversation_stage`, `pipeline_stage`, `sms_status`, `units_count`, `year_built`, `estimated_value`, `distress_signal_count` and `last_contact_at`. This makes keyset pages single index-range scans.
  - The model also carries person demographics (`person_age`, `person_gender`, `person_marital_status`, income and so on). They are never selected.
- **`campaign_target_graph`** has about 176K rows, one per property × phone. It has a btree on `property_id`. Phones (`canonical_e164`) are read server-side only.
- **What a "lead" is.** LeadCommand anchors a seller lead on its property: the lead key is `property_id`. Owner and prospect identities are not exposed in 1.0.

### 1.3 Acquisition scores

- **`property_acquisition_scores`** has 101 rows (estimated) and 44 columns. It has a unique btree on `property_id`.
  - It is the canonical Decision Engine output. A row exists only when the engine has run. Absence means "decision engine not run". That is a status, not a 0.
- Freshness is owned by `decisionAuthority.js` through `evaluateDecisionFreshness`, which checks:
  - the input fingerprint in `evidence.decision_inputs`;
  - the engine version;
  - a 30-day maximum age.
- **Change made: a pure extraction, no behaviour change.**
  - `decisionAuthority.js` imports the engine, `acquisitionDecisionEngine.js`, which writes `property_acquisition_scores`.
  - To reuse the freshness rule without the gateway being able to reach that write path, the pure half moved verbatim to `apps/api/src/lib/acquisition/decisionFreshness.js`. That half is the status enums, material fields, fingerprint, stamp, freshness verdict and display state.
  - `decisionAuthority.js` re-exports every name, so all existing imports are unchanged.
  - The 40 tests in `acquisition-scoring-backfill` and `decision-engine-authority` pass.

### 1.4 Market intelligence

- **`mv_map_market_sales`** has about 665K rows of canonical deduplicated market sales. It is indexed on `(lat, lng)` INCLUDE, `property_id`, `sold_on` and unique `comp_id`.
- The Market Intelligence service (`mi-service.js`) reads it through **direct Postgres with the full-privilege URL** and an in-memory loader. That is not reusable from a least-privilege gateway.
- **Reused instead:** `getEntityGraphZipContext`, which already runs inside the agent's guarded read path. It reads:
  - the current ready build in `mi_rollup_builds`;
  - `mi_geo_period_rollup` (ZIP, asset=all, 90d / 1y);
  - `eg_buyer_index` counts.
- Demographics (`census_geo_metrics`) are empty in production and are reported as availability only.

### 1.5 Comps and buyer evidence

- **Two corpora exist:**
  - the engine pool, `v_recent_sold_comps`: about 48K rows over `buyer_comp_raw_v2`, and the engine's only candidate source;
  - recorded market sales in `mv_map_market_sales`.
- **Eligibility gates** (`evaluateCompEligibility`, `normalizePropertyFeatures`) live inside `acquisitionDecisionEngine.js`, the engine write path. So 1.0 does **not** produce engine-qualified comps or any value from raw comps (owner rule). It returns recorded sales as evidence.
- **Buyer-evidence rules are reused, not rewritten:** `mi-inferred-investor.js#saleBuyerOfRecord`.
  - A deed buyer is the recorded buyer of that sale. It is **never asserted to be the current owner**. Owner linkage needs the `comp_private` owner snapshot, so `current_owner_link` is `not_evaluated`.
  - A sale with no recorded buyer stays **unresolved** (`not_on_record`, provenance `missing`).
  - The MV's `investor_inferred_current_owner` flag is reported as **inferred**, citing rules `mi_owner_link@1` and `mi_owner_tier@2`.
  - Buyer names are withheld.
- Distance and lane come from `canonical-corpus-reads.js#haversineMiles` and `#corpusLaneOf`.

### 1.6 Campaign metrics and readiness

- **`campaigns`** has 55 columns. The row counters are `queued/sent/delivered/failed/replied/positive/opt_out_count` with `progress_synced_at`.
- **`campaign_targets`** has a btree on `(campaign_id, target_status)`. Exact per-status head counts use it. Nothing is sampled.
- **Known limitation (measured 09-24): the reply and opt-out counters under-count.** The truthful reply count needs `message_events` pairing. Every response states this caveat.
- **Readiness is not exposed.** `evaluateCampaignLaunchReadiness` imports the outbound feeder and sender-routing modules, which are outside the read-only import fence.

### 1.7 Contact eligibility and suppression

- **`sms_suppression_list`** has 493 rows (estimated). It is keyed by `phone_e164`, with `is_active` and an optional sender scope.
- The suppression check reuses `compliance/query-active-suppression.js#queryActiveSuppression`, the lookup `canSend` uses.
  - That function **fails open**: a lookup error reports "not suppressed".
  - The gateway converts a lookup error to `unknown`. It is never reported as not suppressed.
- Eligibility comes from `getEntityGraphOutreachState`, through `projectSmsEligibility` and `classifyContactReadiness`. These carry the campaign target graph verdict computed by `resolveCampaignTargetReadiness`, the same per-row rule the target builder applies.
- Policy (owner memory): "not interested" is nurture, not opt-out. Only explicit suppression is reported as suppressed.

---

## 2. Architecture

```
MCP host (Claude / Agntau / any client)
   │  stdio (JSON-RPC 2.0, MCP 2025-11-25)  — or —  protocol/http.mjs: loopback Streamable HTTP
   │                                               (Host/Origin check · bearer token · session cap)
   ▼
protocol/server.mjs      SDK low-level Server (one per connection): initialize · tools/list · tools/call
   ▼
gateway.mjs              ONE enforcement path per call (below)
   ├─ auth/principal.mjs     principal from host config · agent.operator_membership via public.lc_mcp_operator_role (lc_mcp_reader, fail-closed) · cross-org
   ├─ authz/scopes.mjs       one .read scope per tool · role
   ├─ tools/catalog.mjs      9 read tools: zod input/output · limits · untrusted-field map · boot guard
   ├─ safety/limits.mjs      rate (principal + tool) · concurrency · hard deadline
   ├─ cursor.mjs             HMAC-signed keyset cursors bound to tool + filters + principal
   ├─ safety/redact.mjs      secret / phone / email redaction (logs, audit, secret guard)
   └─ audit/audit.mjs        one PII-free record per call (stderr JSON lines / file / sink)
   ▼
adapters/*.mjs           domain adapters — REUSE apps/api modules (projections, rules, services)
   ▼
data/sources.mjs         live: guarded read-only transport + createQuickScanServices
                         fixture: synthetic dataset, same shape, same write refusal
```

**Per-call pipeline.** Each call runs these checks in order:

1. Is the tool registered?
2. Principal, org, membership, cross-org, scope and role.
3. Forged-context keys in the arguments (`org_id`, `user_id`, `principal`, `role`, `scopes`, `approved` …) are refused.
4. The closed zod input schema is applied. Unknown filters on a search tool return `unsupported_filter`.
5. Rate limit for the principal, then for the tool.
6. Concurrency gate.
7. Cursor verification.
8. The adapter runs under a hard deadline, and the abort signal reaches every HTTP request.
9. A second net masks phone and email shapes in every string except ids and ISO dates.
10. Output schema validation. A failure is our bug and returns `internal`; nothing partial is returned.
11. Response byte cap.
12. Secret guard.
13. Audit record.

**Credentials.**

- The service key, agent DB URL and CA are read from **files** named in the host config.
- They are held in closures, and the process environment is **scrubbed** at boot. Every key matching `KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL|SUPABASE|…` and every `LEADCOMMAND_MCP_*` key is removed.
- So a transitively imported default Supabase client, `lib/supabase/client.js`, can only ever be the inert placeholder.
- The model never sees a credential.

**Package placement.**

- `mcp/` sits **outside** the npm workspace globs (`apps/*`, `packages/*`). The root `package-lock.json`, used by production `npm ci`, is untouched.
- The package has its own lockfile: the SDK, zod and ajv (dev only).
- `@/` imports resolve to `apps/api/src` through `src/loader/alias-hooks.mjs`, the same alias the API uses.
- `pg` and `@supabase/supabase-js` resolve from the monorepo root.

---

## 3. Tool catalog

Every tool has the annotations `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true` and `openWorldHint: false`. `_meta` carries `leadcommand/scope`, `leadcommand/min_role`, `leadcommand/limits` and `leadcommand/paged`.

**Result envelope** (output schema for every tool):

```json
{
  "tool": "…",
  "data_mode": "live|fixture",
  "fixture_notice": "…|null",
  "correlation_id": "…",
  "generated_at": "…",
  "trust": { "content": "data_only", "note": "…" },
  "untrusted_fields": ["result.rows[].…"],
  "result": { },
  "page": { "limit": 0, "returned": 0, "has_more": false, "next_cursor": null }
}
```

`page` appears on search tools only.

**Provenance** on every value group is `{ kind: fact|derived|inferred|missing|stale, source, as_of, rule?, reason?, window_days? }`. `missing` is never rendered as 0, false or "none".

**Errors** are `isError: true` with `structuredContent.error = { class, code, message, retryable, details? }`. The classes are: `unauthorized`, `forbidden`, `not_found`, `invalid_input`, `unsupported_filter`, `rate_limited`, `unavailable`, `timeout`, `data_unavailable` and `internal`. An unknown tool is a JSON-RPC `InvalidParams` protocol error. It is still audited.

| Tool | Scope | Input (closed) | Limits (per min / timeout / rows / bytes) | Pagination | Source → reused module |
|---|---|---|---|---|---|
| `leadcommand_search_leads` | `leadcommand.leads.read` | anchor: `market` \| `zip` \| `conversation_stage` \| `pipeline_stage` \| `pipeline_status` \| `sms_status`; `state`, `last_contact_after/before`, `campaign_count_min`, `distress_signals_min`, `decision_tiers[]`, `limit` (≤25, default 10), `cursor` | 30 / 8 s / 25 / 64 KB | keyset `property_id`, signed cursor | `eg_property_facts` (anchor btrees); `safeFlags` |
| `leadcommand_get_lead` | `leadcommand.leads.read` | `property_id` | 60 / 8 s / 1 / 64 KB | — | `eg_property_facts` + `getEntityGraphOutreachState` → `projectOutreach`, `classifyContactReadiness` |
| `leadcommand_search_properties` | `leadcommand.properties.read` | `address` (≤5 candidates) **or** anchor `market` \| `zip` \| `city+state` \| `county+state`; `asset_types[]`, `units/year_built/value` ranges, `bedrooms_min`, `distress_signals_min`, `limit`, `cursor` | 30 / 8 s / 25 / 64 KB | keyset (anchor mode) | `eg_property_facts`; `eg.property_lookup` (trigram) |
| `leadcommand_get_property` | `leadcommand.properties.read` | `property_id` | 30 / 10 s / 1 / 96 KB | — | `getEntityGraphDossier` → `projectPropertyCore` / `projectOwnership` / `projectRecordedDocuments` / `projectSalesHistory`; `eg.distress_signals` + `findInconsistencies` |
| `leadcommand_get_acquisition_score` | `leadcommand.scores.read` | `property_id` | 60 / 8 s / 1 / 32 KB | — | `property_acquisition_scores` + `properties`; `decisionFreshness#evaluateDecisionFreshness`, `buildDecisionInputStamp`, `resolveEconomicsDisplayState` |
| `leadcommand_get_market_intelligence` | `leadcommand.market.read` | exactly one of `zip` \| `property_id` | 60 / 8 s / 1 / 16 KB | — | `getEntityGraphZipContext` → `projectZipContext` |
| `leadcommand_search_comps` | `leadcommand.comps.read` | `property_id`, `radius_miles` (0.25–3), `months` (3–24), `same_lane_only`, `limit` (≤25) | 30 / 8 s / 25 / 64 KB | — (≤50 read, nearest first) | `mv_map_market_sales` `(lat,lng)` box; `saleBuyerOfRecord`, `haversineMiles`, `corpusLaneOf` |
| `leadcommand_get_campaign_metrics` | `leadcommand.campaigns.read` | `campaign_id`? (else list), `status`, `limit` | 30 / 8 s / 25 / 64 KB | — | `campaigns` (`CAMPAIGN_COLUMNS`, `projectCampaign`, `pinnedPropertyIds`), exact `campaign_targets` head counts |
| `leadcommand_get_lead_contact_status` | `leadcommand.contact_status.read` (**not in the default grant**) | `property_id` | 20 / 8 s / 10 contacts / 32 KB | — | `campaign_target_graph` + `queryActiveSuppression` + `projectSmsEligibility` / `classifyContactReadiness` |

Notes per tool:

- **search_leads.**
  - Returns lead **state** only. No street address appears in the list.
  - If an unscored lead appears, `decision_engine` is `{ aos_score: null, provenance: missing (decision_engine_not_run) }`.
- **get_lead.**
  - Stage and status carry their source (`pipeline` when a deal exists, else `conversation`).
  - `conversation` is `{ at, direction, suppressed }` only. `message_text.included` is always `false`.
- **search_properties.**
  - Asset facts plus the property's own address. No owner names, mailing addresses or demographics.
  - Address-lookup mode is bounded at 25 rows read and 5 returned, and is never paginated.
- **get_property.**
  - Ownership is a **shape**: owner kind, corporate or out-of-state, years owned, portfolio count.
  - Private lender names are withheld. Sales show buyer **kind** only. Preforeclosure evidence returns the host, never the URL.
  - Recorded documents that are unavailable are reported as `available: false` with provenance `missing`, never as empty.
- **get_acquisition_score.**
  - Returns the valuation band, investor ceiling, recommended cash offer, estimated repairs, AOS score, tier, confidence, strategy, transaction probabilities and pressure scores.
  - It always includes the freshness verdict. `status` is `current`, `decision_engine_stale_for_current_state` or `decision_engine_not_run_for_current_state`.
  - The drift check rebuilds the stamp from the current property row and the seller facts the engine recorded (`seller_facts_rechecked: false`).
  - **Withheld:** `minimum_acceptable_offer`, `expected_assignment_fee`, `owner_situation_*`, `recommended_conversation_angle`, `recommended_offer_stack`, the raw `evidence`.
- **get_market_intelligence.**
  - Shares are over **known** buyer types and cash flags.
  - A ZIP not in the build returns `available: false` with provenance `missing`.
- **search_comps.** Evidence only (`not_a_valuation`).
  - `buyer.basis` is `recorded_buyer` or `not_on_record`.
  - `buyer.current_owner_link` is always `not_evaluated`.
  - `investor.inferred_provenance.kind` is `inferred`.
- **get_campaign_metrics.**
  - Counters carry their provenance, stale beyond 1 day after `progress_synced_at`, plus the under-count caveat.
  - Pinned audience ids are **counted, never returned**.
- **get_lead_contact_status.**
  - Contacts are handles: `C1…` for contacts, `P1…` for people. **No phone digits.**
  - Each contact returns its `suppression.state` (`suppressed`, `not_suppressed` or `unknown`) plus graph flags: `sms_eligible`, `wrong_number`, `post_contact_suppression`, `pending_prior_touch`, `active_queue_item`, `block_reason`.
  - At most 10 phones are checked, and the response reports how many were not checked.

### 3.1 Not implemented (and why)

| Item | Reason |
|---|---|
| Campaign launch readiness | `evaluateCampaignLaunchReadiness` imports the outbound feeder and sender routing, outside the read-only import fence. 1.1: extract a pure readiness core. |
| Seller message text / thread read | PII minimization and untrusted content. 1.0 returns conversation metadata only. |
| Truthful campaign reply counts | Needs `message_events` pairing. There is no bounded, indexed read path in the guarded transport yet. |
| Engine-qualified comps / valuations | `evaluateCompEligibility` lives in the engine write module. 1.0 exposes recorded sales and the persisted engine result separately. |
| Any write (SMS, campaigns, routing, suppression, enrollment, record edits) or any SQL / shell / HTTP / RPC tool | Phase One is read-only (owner directive). |

---

## 4. Security

| Control | Implementation | Test |
|---|---|---|
| Principal | Comes from the trusted host config (`LEADCOMMAND_MCP_PRINCIPAL_USER_ID`, `LEADCOMMAND_MCP_ORG_ID`), never from tool arguments. Forged-context keys are refused (`FORGED_CONTEXT`). | security: unauthenticated ×2, forged ids ×2 |
| Org scoping | `agent.operator_membership` is read through `public.lc_mcp_operator_role(org, user)` (SECURITY DEFINER, STABLE, sql; EXECUTE for `lc_mcp_reader` only) with the same read-only credential. The role holds no privilege in schema `agent`. Cached 60 s. A failure is `unavailable` (fail closed). Cross-org is `forbidden`. | cross-org ×2, membership failure, revocation after TTL |
| Multi-tenancy (honest) | Membership, scopes and the cross-org check are tenant-aware, but domain tables have no org column. One server serves exactly one data org (`LEADCOMMAND_MCP_DATA_ORG_ID`). Row-level tenancy is a 2.0 item. | cross-org |
| Scopes | One `.read` scope per tool. Unknown or write scopes refuse to boot. Contact status is not in the default grant. | scope denial ×3 |
| Read-only | (0) **The database role** (§4.2): `lc_mcp_reader` holds SELECT on the 20 inventory relations and EXECUTE on 4 read RPCs, nothing else, no BYPASSRLS. It is checked at boot and every 10 min against the database's own privilege report; any finding refuses. (1) The catalog boot guard: only `leadcommand_(get\|search)_*` names and `.read` scopes, with write-shaped names refused. (2) A static import fence over the whole import graph: no write-capable LeadCommand module and no DB mutation call or SQL is reachable. (3) The transport refuses writes, relations outside the inventory, other schema profiles and non-allowlisted RPCs before the network (`data/read-fetch.mjs`, then the app's `createGuardedReadFetch`). | readonly ×9, credential ×13, selfcheck ×6, inventory ×3, migration test, e2e ×8 |
| PII | Projection first: no names, phones, emails, mailing data, message text, person keys or demographics. `safeFlags` drops protected-class labels. A second net masks phone and email shapes in every string. Contacts are handles. | safety: PII ×4, second net |
| Untrusted text | Imported or human-entered strings are sanitized (control and bidi characters stripped, length capped). They appear only as data, and their paths are listed in `untrusted_fields`. The result `trust.content` is `data_only`, and server instructions say the same. No action tools exist to hijack. | prompt injection ×2 |
| Secrets | Read from files, closure-held, environment scrubbed. A redactor (JWT, keys, `postgres://`, PEM, bearer, `password=`) runs on every audit line. A secret-shaped value in a result is refused (`SECRET_GUARD`). | secret redaction ×3 |
| Rate / concurrency | Sliding-window limits per principal (default 60/min, ceiling 120) and per tool. In-flight calls are bounded (default 4, ceiling 8); the excess is refused, never queued. | limits ×3 |
| Timeouts | Per-call hard deadline (default 10 s, ceiling 15 s, per tool 8–10 s). Each HTTP request aborts at 5 s. Each call has a budget of 40 requests. `Prefer: timeout=5` is sent on every request. | timeout |
| Size | Per-tool byte caps (16–96 KB, global ceiling 256 KB). Paged rows are dropped to fit; the page then says `truncated_for_size` and returns no cursor. A single oversized record fails. | size ×2 |
| Audit | One record per call: hashed principal and org, tool, scope, outcome, error class and code, correlation id, latency, rows, bytes, truncation, input hash, data mode, upstream timeout preference. No inputs, results or PII. | secret redaction, every suite |

**Statement timeout.** Every read aborts client-side at 5 s. Server side, the migration sets `statement_timeout = '5s'` on `lc_mcp_reader`; PostgREST applies per-role settings on SET ROLE. The setting is verified in the migration posttest. That production PostgREST applies it is confirmed only once the owner's acceptance run has happened (§4.2).

### 4.2 Live credential: `lc_mcp_reader` (database-role-enforced, read-only)

**Why.** Live mode used to read PostgREST with the SERVICE-ROLE key, which can write everything and bypasses RLS. Writes were refused only client-side. Membership used the `agent_api` login, which can INSERT/UPDATE `agent.*`. Both are gone. A client-side read-only setting is not a substitute for a least-privilege credential.

**Design (PostgREST + a role-claim JWT; option (a)).**

- `supabase/migrations/PROPOSED_20261019150000_lc_mcp_reader.sql` creates role `lc_mcp_reader`:
  - NOLOGIN NOINHERIT, no SUPERUSER / CREATEDB / CREATEROLE / REPLICATION / **BYPASSRLS**, a member of **no** role;
  - `statement_timeout 5s`; granted to `authenticator`;
  - USAGE on `public` only;
  - SELECT on exactly the 20 relations of `src/data/inventory.mjs`;
  - a `FOR SELECT TO lc_mcp_reader USING (true)` policy on each inventory table. RLS is on for every postgres-owned table since the lockdown; without a policy the role would read zero rows silently;
  - EXECUTE on 4 read RPCs: `entity_graph_property_records(text)` and `campaign_entity_contact_review_flags(text[])`, both existing STABLE SECURITY DEFINER; plus the new `lc_mcp_reader_self_check(text[],text[],name)` (INVOKER, privilege introspection) and `lc_mcp_operator_role(uuid,uuid)` (DEFINER, one membership row).
- The owner mints an HS256 JWT `{ role: "lc_mcp_reader", iss, iat, exp }` with the project's legacy JWT secret. The project issues HS256 and publishes no JWKS (`infra/cloudflare/worker/index.ts`). PostgREST verifies it and runs `SET ROLE lc_mcp_reader`, so every request has exactly those grants. The `apikey` header carries the public anon / publishable key, which the gateway requires; it confers nothing here.
- Why not (b), a direct pg LOGIN role: a login is a raw-SQL surface. Its holder can run arbitrary SELECTs, hold locks, and call PUBLIC pg_catalog side-effect functions (`lo_create`, `pg_notify`, `pg_logical_emit_message`, advisory locks). Through PostgREST, a NOLOGIN role reaches only relations and functions in the exposed schemas. (a) also keeps the reused supabase-js services unchanged.
- **Never** make a direct-login role a member of `authenticated` or `anon`: `ops_read_allowed()` trusts `request.jwt.claims`, which a direct login can set. `lc_mcp_reader` is NOLOGIN and in no role, and both the migration gate and the boot check refuse any membership.

**The apply aborts atomically** on any finding of the self-check for the role:

- a write privilege anywhere it can use (table or column level, incl. MAINTAIN);
- sequence USAGE / UPDATE;
- CREATE on a schema or the database;
- a membership;
- LOGIN;
- a reachable SECURITY DEFINER function outside the allowlist. PUBLIC gets EXECUTE on every new function and the lockdown did not change default privileges; PostGIS `st_estimatedextent` is accepted when non-volatile;
- a reachable **network-egress** function: schema `net`, pg_net / http / dblink / postgres_fdw members, `http*` / `dblink*`, untrusted languages, or a wrapper calling them or `lo_*` / `pg_notify`;
- SELECT outside the inventory in an exposed schema, e.g. a PUBLIC-readable owner-rights view;
- an inventory table with RLS but no policy, or with a restrictive policy;
- an inventory `security_invoker` view;
- a VOLATILE allowlisted RPC;
- a missing relation / RPC.

**The server enforces the same rules at boot and every 10 min** (`data/credential.mjs#evaluateSelfCheck`, independently of the DB's own `ok`). It reads the report AS the token (`current_user` must be `lc_mcp_reader`). On a refusal it does not start, or refuses every call, and audits `credential_self_check` / `server_boot_refused`.

**Credential sources.** Live mode reads ONLY `LEADCOMMAND_MCP_READER_JWT_FILE` and `LEADCOMMAND_MCP_API_KEY_FILE`. Each must be:

- a 0600 file, owned by the server user, not a symlink, a single value;
- not an env file, not under `apps/api`.

It refuses:

- a token whose role claim is not `lc_mcp_reader`; the service-role key is refused by decoding the claim locally, before any request;
- no / past / > 366-day expiry; `alg: none`;
- a "public key" that is the service-role or an `sb_secret_` key;
- the retired `LEADCOMMAND_MCP_SERVICE_KEY_FILE` / `AGENT_DB_*`;
- live mode while `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `DATABASE_URL`, … are in the environment. These are reported by NAME; their values are never read.

The loader fences `@/lib/supabase/client.js` (it reads the service key on import), `@/lib/postgres/client.js`, `resolve-database-url.js` and `dotenv` to refusing stubs. A real server subprocess, traced at the fs and `process.env` level, never opens `apps/api/.env*` and never reads those variables (`test/credential.test.mjs`).

**PRODUCTION BLOCKER: pg_net.** The 2026-10-16 role audit (`tmp/ro-roles-v2`) found that PUBLIC holds:

- USAGE on schema `net`;
- EXECUTE on `net.http_get` / `http_post` / `http_delete`;
- ALL on `net.http_request_queue` / `net._http_response`.

These are pg_net 0.20.0 objects owned by `supabase_admin`, which postgres cannot revoke. Any role, `lc_mcp_reader` included, could make the database send HTTP requests. **So the role migration will refuse to apply, and the server would refuse to boot, until the owner resolves pg_net.** Either drop the extension (H1 of the separate `PROPOSED_public_execute_hardening.sql`: unused, its only trigger disabled), or ask Supabase support to revoke PUBLIC on schema `net`, its functions and tables. That is intended.

**Owner steps to go live (in order; each one separately approved):**

1. Resolve pg_net: drop it or have Supabase revoke PUBLIC on schema `net`. Optionally apply the rest of `PROPOSED_public_execute_hardening.sql`.
2. Apply `supabase/migrations/PROPOSED_20261019150000_lc_mcp_reader.sql`, alone. Expect `NOTICE: lc_mcp_reader: self-check ok (20 relations, 4 functions)`. Any `ERROR: lc_mcp_reader: refused …` names the blockers, and nothing is applied.
3. Mint the token outside the repo. Put the dashboard's legacy JWT secret in a 0600 file such as `~/.leadcommand/jwt-secret`, then run `node scripts/mint-reader-token.mjs --secret-file ~/.leadcommand/jwt-secret --out ~/.leadcommand/lc_mcp_reader.jwt --days 30` and delete the secret file. Put the anon key in `~/.leadcommand/anon.key` (0600).
4. From a clean shell (`env -i PATH="$PATH" HOME="$HOME" …`), set `LEADCOMMAND_MCP_SUPABASE_URL`, `_READER_JWT_FILE`, `_API_KEY_FILE`, `_PRINCIPAL_USER_ID`, `_ORG_ID`. Then run `node scripts/live-acceptance.mjs --zip <a ZIP with properties>`.
   - Expected: `"result": "PASS"`, and stage `database` shows **15** write probes at HTTP 403 / `42501`: INSERT / UPDATE / DELETE × send_queue, sms_templates, system_control, properties, campaigns. Each is zero-row even if permitted; the control test proves it.
   - SELECT send_queue → 42501; agent → 406 `PGRST106` (or 42501).
   - The privilege report shows `running_as: lc_mcp_reader`, `ok: true`.
   - Stage `capability`: 9 tools / ≤ 12 calls, all `data_mode: live` with provenance.
   - Stage `audit`: boot self-check ok, one `tool_call` per call.
   - Exit 0.
5. Only then point MCP hosts at live mode. Kill switch: `revoke lc_mcp_reader from authenticator;`. Rollback: `PROPOSED_20261019150000_lc_mcp_reader_rollback.sql`.

**Residual (stated plainly).**

- The token is a bearer secret until `exp`. Revoke it via the kill switch; rotating the JWT secret would also rotate the anon / service keys.
- The role can read PII tables (phones, emails, prospects, master_owners, inbox_thread_state incl. `latest_message_body`). The reused dossier and outreach services select those columns, so column-level grants are impossible without changing apps/api. The MCP projections never return them.
- Owner-rights inventory views read their base tables as the owner.
- The probes' zero-row writes could fire statement-level triggers only if a write were permitted, and the self-check proves it is not.
- `TEMP` via PUBLIC is unreachable without a SQL session (H2 removes it).
- `campaign_entity_contact_review_flags` has no definition in the repo. The migration requires it to be STABLE; review its body before apply.

---

## 5. Integration

### 5.1 Running (stdio)

Run from a `rei-automation` checkout after root `npm ci`, then `cd mcp/leadcommand-mcp && npm ci`.

```bash
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON mcp/leadcommand-mcp/bin/leadcommand-mcp.mjs
```

stdout carries only the protocol. Audit lines go to stderr, or to `LEADCOMMAND_MCP_AUDIT_FILE`.

| Variable | Meaning |
|---|---|
| `LEADCOMMAND_MCP_DATA` | `fixture` (default, synthetic) or `live` |
| `LEADCOMMAND_MCP_PRINCIPAL_USER_ID` | The operator's Supabase auth uid (host-established principal) |
| `LEADCOMMAND_MCP_ORG_ID` / `LEADCOMMAND_MCP_DATA_ORG_ID` | The principal's org / the org this server serves (defaults to the principal's org) |
| `LEADCOMMAND_MCP_SCOPES` | Space- or comma-separated `.read` scopes. Default: every scope except `leadcommand.contact_status.read` |
| `LEADCOMMAND_MCP_SUPABASE_URL` | Live only: the https origin of the app data service (or an http loopback PostgREST) |
| `LEADCOMMAND_MCP_READER_JWT_FILE` | Live only: **path** to a 0600 file holding the `lc_mcp_reader` token (§4.2). Any other role claim, service-role included, refuses to boot |
| `LEADCOMMAND_MCP_API_KEY_FILE` | Live only: path to a 0600 file holding the anon / publishable key (the service-role and `sb_secret_` keys are refused) |
| ~~`LEADCOMMAND_MCP_SERVICE_KEY_FILE`~~, ~~`LEADCOMMAND_MCP_AGENT_DB_URL_FILE` / `_CA_FILE`~~ | **Retired** (writable credentials). Setting any of them refuses live mode |
| `LEADCOMMAND_MCP_RATE_PER_MIN`, `_MAX_CONCURRENCY`, `_CALL_TIMEOUT_MS`, `_MAX_RESPONSE_BYTES` | Can only **lower** the budgets (hard ceilings in `config.mjs`) |
| `LEADCOMMAND_MCP_TRANSPORT` | `stdio` (default) or `streamable-http` (§5.3). Anything else refuses to boot. |

### 5.2 Generic MCP host profile (works for Claude Desktop / Claude Code / any `mcpServers` host)

```json
{
  "mcpServers": {
    "leadcommand": {
      "command": "node",
      "args": ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "<repo>/mcp/leadcommand-mcp/bin/leadcommand-mcp.mjs"],
      "env": {
        "LEADCOMMAND_MCP_DATA": "live",
        "LEADCOMMAND_MCP_PRINCIPAL_USER_ID": "<operator uuid>",
        "LEADCOMMAND_MCP_ORG_ID": "<org uuid>",
        "LEADCOMMAND_MCP_SCOPES": "leadcommand.leads.read leadcommand.properties.read leadcommand.scores.read leadcommand.market.read leadcommand.comps.read leadcommand.campaigns.read",
        "LEADCOMMAND_MCP_SUPABASE_URL": "https://<project>.supabase.co",
        "LEADCOMMAND_MCP_READER_JWT_FILE": "<path, 0600: the lc_mcp_reader token>",
        "LEADCOMMAND_MCP_API_KEY_FILE": "<path, 0600: the anon / publishable key>",
        "LEADCOMMAND_MCP_AUDIT_FILE": "<path>/leadcommand-mcp-audit.jsonl"
      }
    }
  }
}
```

For a dry run, set `"LEADCOMMAND_MCP_DATA": "fixture"` and use the fixture ids:

- principal `00000000-0000-4000-8000-0000000000b1`
- org `00000000-0000-4000-8000-0000000000a1`
- properties `FX1001`–`FX1003`

### 5.3 Streamable HTTP (loopback only, bearer token)

For local hosts that speak only Streamable HTTP (Agntau). Implemented in `src/protocol/http.mjs` on the SDK's `StreamableHTTPServerTransport` (stateful sessions, `enableJsonResponse: true`). It is **not** a public or multi-user endpoint.

**Start it.**

```bash
cd mcp/leadcommand-mcp
node scripts/http-token.mjs ~/.leadcommand/mcp-http-token     # 32 random bytes, base64url, O_EXCL, mode 0600; the token is NOT printed
LEADCOMMAND_MCP_TRANSPORT=streamable-http \
LEADCOMMAND_MCP_HTTP_BIND=127.0.0.1 \
LEADCOMMAND_MCP_HTTP_PORT=8765 \
LEADCOMMAND_MCP_HTTP_TOKEN_FILE=~/.leadcommand/mcp-http-token \
<the §5.1 variables: DATA, PRINCIPAL_USER_ID, ORG_ID, SCOPES, live file paths, AUDIT_FILE> \
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON bin/leadcommand-mcp.mjs
```

Endpoint: `http://127.0.0.1:8765/mcp` (only this path; a query string is refused).

| Variable | Meaning |
|---|---|
| `LEADCOMMAND_MCP_HTTP_BIND` | `127.0.0.1` (default) or `::1`. **Anything else refuses to boot** (wildcards, LAN / public addresses, `localhost` and other hostnames, `127.0.0.2`, mapped IPv6). The listening address is re-checked after `listen()`. |
| `LEADCOMMAND_MCP_HTTP_PORT` | Default `8765`; `0` = ephemeral (tests). |
| `LEADCOMMAND_MCP_HTTP_TOKEN_FILE` | Required. A regular file owned by the server user with no group / other bits (0600), holding one 32–512 char URL-safe token. |
| `LEADCOMMAND_MCP_HTTP_ALLOWED_ORIGINS` | Optional. Exact loopback origins (`http(s)://127.0.0.1 \| localhost \| [::1][:port]`) allowed to send an `Origin` header. Default: none. |
| `LEADCOMMAND_MCP_HTTP_SESSION_CONCURRENCY` | Per-connection (per-session) concurrent tool calls. Default 2, never above `_MAX_CONCURRENCY`. |
| `LEADCOMMAND_MCP_HTTP_MAX_SESSIONS` | Default 8, ceiling 32. |
| `LEADCOMMAND_MCP_HTTP_SESSION_IDLE_MS` | Idle expiry. Default 15 min, ceiling 60 min. |
| `LEADCOMMAND_MCP_HTTP_MAX_BODY_BYTES` | Request body cap. Default 64 KiB, ceiling 256 KiB. |

**Security design.** Checks run in this order on every request:

1. **Host** must name this listener exactly (`127.0.0.1:<port>` or `localhost:<port>`; for `::1`, `[::1]:<port>` or `localhost:<port>`). Otherwise **403**. A missing Host is already refused by `node:http` (400). This is DNS-rebinding protection, and it runs before auth, so a rebinding page learns nothing about the token.
2. **Origin**: absent (non-browser clients such as Agntau's server-side fetch and Claude Code) or an exact allowlist entry. Otherwise **403**.
3. **Path** `/mcp` only. Otherwise 404.
4. **Bearer token** on every request: `Authorization: Bearer <token>`. The server holds only the SHA-256 digest of the file's token and compares digests with `crypto.timingSafeEqual`. A missing, wrong or non-Bearer credential gets **401** with `WWW-Authenticate: Bearer realm="leadcommand-mcp"`. After 30 failures in a minute it gets **429**. The token never appears in a log line, an error, a response or a tool result; the env var is scrubbed after boot. Session ids route requests and are **never** credentials: a request with a valid session id but no token gets 401.
5. **Method**: POST, GET or DELETE only (405).
6. **Session**: unknown id → 404 (the client re-initializes). A non-initialize request without a session → 400. At `MAX_SESSIONS`, the least-recently-used **idle** session is evicted (Claude Code 2.1.x never DELETEs its session); if every session has a call in flight → 503.
7. **Body** over the cap → 413 before parsing.

**Principal.** Unchanged from stdio: the host-configured `LEADCOMMAND_MCP_PRINCIPAL_USER_ID` / `ORG_ID`, verified against `agent.operator_membership`. The token proves only "this local client may connect". It carries no claims and never selects a user, org or scope. Forged context arguments are still refused (`FORGED_CONTEXT`).

**Limits.** All sessions share the one gateway: the principal-wide and per-tool rate limits, the process-wide concurrency gate, the call deadline and the response byte cap. Each session also has its own concurrency gate (`SESSION_CONCURRENCY_LIMIT`, audited as `refused`). Node server timeouts: headers 10 s, request 60 s, keep-alive 5 s, 64 headers.

**Audit.** Tool calls carry `transport: "streamable-http"`. Transport events contain no header values: `http_listen`, `http_session_open`, `http_session_closed` (`client_delete | idle | evicted_lru | shutdown | transport_closed`) and `http_refused` (`status`, `reason`, and the method for no-session refusals).

**Out of scope for 1.x** (§10): remote exposure, OAuth 2.1 resource server (RFC 9728), per-request principals, a durable rate / session store.

**Agntau connection config** (what Agntau stores and generates; verified, §6):

- Connections → "Connect another MCP server by URL…": URL `http://127.0.0.1:8765/mcp`, Name `LeadCommand`, sign-in **Token**, token = the file's contents. Agntau accepts `http:` only for loopback hosts and sends `Authorization: Bearer <token from file>` itself.
- The Claude Code config Agntau generates (`claudeMcpConfig`):

```json
{ "mcpServers": { "leadcommand": { "type": "http", "url": "http://127.0.0.1:8765/mcp", "headers": { "Authorization": "${AGNTAU_MCP_LEADCOMMAND_0}" } } } }
```

  The child environment holds `AGNTAU_MCP_LEADCOMMAND_0="Bearer <token from file>"`. Agent tool names are `mcp__leadcommand__leadcommand_<tool>`.

---

## 6. Agntau ("Agntei")

Agntau = `kindleops/agntau` `main @0217a12`, cloned **read-only** to `tmp/agntau`. **Zero Agntau changes**: no branch, no commit. `pnpm install` ran inside the clone only, and its tree is clean.

| Step | Result |
|---|---|
| Connection architecture read | Streamable HTTP only: `connections/mcp-client.ts` (`verifyMcpServer`, `callMcpTool`), `service.ts` (`add` → `setToken` → `verify` → `forRun`), `run-config.ts` (`claudeMcpConfig`), `policy.ts` (risk tiers, `*:read` preapproval), `adapters/claude-code.ts`. Only `claude-code` is a verified agent for connections. |
| Agntau's own code against the local server (FIXTURE data) | `Connections.add({ url, label: 'LeadCommand', token })` → state `connected`, stages discovered / authenticated / toolsListed, serverInfo `leadcommand-mcp 1.0.0`, protocol `2025-06-18`. 9 tools, each `readOnly: true`, `destructive: false`, risk `read`. Raw `verifyMcpServer`: ok. Wrong token: 401, `failure: auth`. No token: 401. The token is not in Agntau's connection rows. Server down: state `error`, "Could not reach the server". |
| Real agent turns (`claude` 2.1.281, subscription login, `apiKeySource: none`, model haiku), config from Agntau's `forRun('claude-code')` + `claudeMcpConfig`, env from Agntau's `buildChildEnv`. `--strict-mcp-config`, `--tools ""` (no built-in tools), `--allowedTools` = the 9 leadcommand tools, `--permission-mode dontAsk`. FIXTURE data. | 5 turns, 5 tool calls (+1 smoke). Details in §7.4. |
| Live-data agent turns | **BLOCKED**: starting the server in live mode was refused by this session's permission classifier. Nothing ran against production over HTTP. |
| Agntau engine connection tests | `vitest run test/connections.test.ts`: 12 / 12 pass. |
| Multi-agent Mission | **NOT RUN.** Only single Claude Code runs were driven, outside Agntau's orchestrator. No mission success is claimed. |

---

## 7. Testing

### 7.1 MCP suite: 103 tests, 102 pass, 1 skipped (opt-in e2e)

The suite uses FIXTURE data, labelled synthetic. Run it with `cd mcp/leadcommand-mcp && npm test`.

| File | Tests | Covers |
|---|---|---|
| `protocol.test.mjs` | 6 | initialize (server info, tools-only capability, instructions), discovery (9 tools, annotations, closed input schemas, scopes, limits), every result validated against its advertised output schema (Ajv and the SDK Client), input bounds, typed errors validate against the advertised outputSchema (the SDK Client validates `isError` results too), unknown tool as a protocol error (audited) |
| `http.test.mjs` | 12 | Streamable HTTP: 401 without a token, with a wrong token, a token prefix, a non-Bearer scheme or a bare token; failed-auth throttle (429); non-loopback binds refuse to boot (0.0.0.0, ::, LAN, public, `localhost`, 127.0.0.2, mapped IPv6); token-file mode / owner / format, digest only; loopback listener; Host and Origin checks (403, Host before auth), path / query / method; SDK Client over HTTP (tools/list, a call, scope denial, forged context, audit transport); per-connection concurrency cap with another connection unaffected; LRU idle-session eviction and 503 when all sessions are busy; unknown / missing session, DELETE, 413; disconnect / recover as a real subprocess; stdio path unchanged; the token never in logs or bodies |
| `tools.test.mjs` | 15 | each tool's happy path, missing ≠ 0, current / stale / not-run scores, comps lane and buyer basis, exact campaign counts, empty results, not_found on every per-record tool |
| `security.test.mjs` | 15 | unauthenticated (no principal, non-member), cross-org ×2, forged-context keys, injection-shaped ids, scope denial ×3, role, membership fail-closed, TTL revocation, cursor forgery (tampered, cross-filter, cross-tool, cross-principal), unsupported filters, transport allowlist (only stdio / streamable-http; HTTP without a token file refuses to boot) |
| `limits.test.mjs` | 12 | full keyset traversal (no duplicates or gaps), max-result limits, size cap (truncation and oversize failure), timeout at the deadline, rate limit (principal and tool), DB failure (fault, missing relation), concurrency (bounded, refuse the excess), disconnect / recover in memory **and as a real stdio subprocess** (kill, the process exits, relaunch) |
| `safety.test.mjs` | 11 | provenance kinds and missing ≠ 0, no fixture phone, name, email or person key anywhere, protected flags dropped, contact handles only, second-net masking, redactor and audit hygiene, secret guard, environment scrub, prompt injection (seller preview never leaves; injected text only at declared untrusted paths; tool surface unchanged), control and bidi stripping, suppression (active, inactive and lookup-failure cases) |
| `credential.test.mjs` | 13 | service-role token refused by its role claim before any request (audited); only `lc_mcp_reader` tokens (other roles, alg none, no / past / over-long exp refused); public key anon / publishable only; retired inputs refused; ambient credentials refused by name, values never read; credential-file rules (mode, symlink, env file, inside apps/api, one value); config summary carries no secret; module fence (default client, direct pg, URL resolver, dotenv); **real subprocess trace**, fixture and live: no env file opened, no forbidden env read, only the two credential files, only the reader token sent, boot self-check audited; trace canary; mint-reader-token |
| `selfcheck.test.mjs` | 6 | every self-check finding named (writes, sequences, CREATE, membership incl. anon, BYPASSRLS, LOGIN, definer, egress, pg_net hint, exposed reads, RLS without policy, restrictive, invoker view, missing / extra relations, RPC execute / volatility, DB disagreement); boot refusal audited to the file; PostgREST-rejected token, missing function, no EXECUTE, unreachable; TTL re-check fail-closed and recovery; audit file: ok / refused / failed / unknown-tool lines, no credential, 0600 |
| `inventory.test.mjs` | 3 | migration SQL lists == `src/data/inventory.mjs` (apply, rollback, pretest, posttest); the 9 tools over the live transport read EXACTLY the 20 relations and call EXACTLY the 4 RPCs, all as `lc_mcp_reader` |
| `postgrest-e2e.test.mjs` | 1 (8 subtests, opt-in) | real PostgREST 16.4 + disposable PG17: role switch, DB refusals, side-effect-free probes, server boot, all tools live, wrong-signature refusal, `live-acceptance.mjs` PASS |
| `readonly.test.mjs` | 9 | 9 read tools only, the boot guard refuses write-shaped tools, the static import graph reaches no write-capable module, no mutation call or SQL in reachable code, allowed external packages only, the live transport refuses insert / update / delete / non-allowlisted RPC before the network, the abort signal and `Prefer: timeout=5` on every request, fixture tables unchanged after calls |

### 7.2 Existing critical suite

`cd apps/api && CRITICAL_CHUNKS=8 npm run -s test:critical:chunked` → 834 files, 11,455 tests, 11,399 pass, 0 fail, 56 skipped (**SUITE PASSED**), with the decisionFreshness extraction applied. `npm run lint`: syntax check passed for 2,954 files.

### 7.3 Local protocol validation (real SDK Client over stdio)

`scripts/protocol-smoke.mjs` launches `bin/leadcommand-mcp.mjs` as a subprocess, lists tools and calls them. The MCP Inspector CLI was not used, because it is not installed and installing it would mean fetching from the network.

**Fixture run.**

- The server identified as `leadcommand-mcp` 1.0.0 and listed 9 tools.
- Five calls all returned `ok`: search_leads (3 rows, `has_more`), get_property, get_acquisition_score (not run, provenance `missing`), search_comps (3 rows: recorded / not_on_record / recorded) and get_lead_contact_status (`C1: suppressed`).
- There were 5 audit records, all with the principal hashed.
- Every call had a `pii_residual` of `null` and `secret_shaped: false`.

**Live run (bounded).** The owner permitted read-only, tiny calls. Settings and results:

- 10 tool calls in total, over two runs (9, then 1).
- Data paths (2026-10-14, superseded by §4.2): membership as `agent_api` (verify-full TLS); domain reads through the guarded read-only transport.
- All 10 calls returned `ok`, and the audit outcomes were all `ok`.

Redacted evidence (identifiers only, ≤ 5):

| # | Tool | Result | ms |
|---|---|---|---|
| 1 | get_campaign_metrics (list, 3) | 3 campaigns (`dbcfe227…`, `d96aebbe…`, `bcedd963…`; active / active / completed); counter provenance `stale` | 4510 |
| 2 | search_leads (market anchor, 5) | 5 rows (`2151923149`, `2153384383`, `2153467312`, `2153468584`, `2156745818`), `has_more`; 0 scored → provenance `missing` | 581 |
| 3 | get_lead `2151923149` | ok; readiness `held_suppressed` | 967 |
| 4 | get_property `2151923149` | ok; owner kind `individual`; recorded docs available; 0 inconsistencies | 2950 |
| 5 | get_acquisition_score `2151923149` | `available: false`, `decision_engine_not_run_for_current_state` (missing, not 0) | 185 |
| 6 | get_market_intelligence (by property) | available; build 14; provenance `stale` (latest sale older than 45 days) | 788 |
| 7 | search_comps (0.5 mi, 12 mo, 5) | 32 read → 5 returned; buyer basis recorded / not_on_record ×3 / recorded; `inferred` provenance present | 753 |
| 8 | get_lead_contact_status `2151923149` | 1 contact, `not_suppressed`; eligibility `false`; no digits | 893 |
| 9 | search_properties (zip anchor, 3) | 3 rows (`2151923149`, `272428540`, `272428787`), `has_more` | 228 |
| 10 | get_property `2151923149` (PII self-check run) | ok; `pii_residual: null`, `secret_shaped: false`; `upstream_timeout_pref: null` | 2623 |

What was not done:

- No name, phone, address, message or secret was printed or stored.
- The temporary 0600 key file was deleted after each run.
- No full scans were run: every predicate was an indexed equality or range, LIMIT ≤ 50.

### 7.4 Agntau agent proof (FIXTURE data, loopback HTTP)

Server: `streamable-http` on `127.0.0.1:8765`, FIXTURE mode, default scope grant (no `leadcommand.contact_status.read`). Turns 1–5 are one resumed Claude Code session. Evidence comes from the server's audit file (principal hashed; the salt is per process).

| Turn | Prompt (short) | Tool calls (agent) | Audit (tool · outcome · latency) | Answer (summary) |
|---|---|---|---|---|
| smoke | score for FX1001 | get_acquisition_score | ok · 13 ms | AOS 71, tier A, current |
| 1 | up to 3 scored leads in "Fixture Metro, TX", ≤ 4 calls | search_leads {market, limit 3}; get_acquisition_score FX1001 | ok · 18 ms (3 rows); ok · 8 ms | 1 of 3 scored (FX1001: AOS 71 / A, offer, freshness current); FX1002 / FX1003 not run by the engine |
| 2 | follow-up: comps for that property | search_comps FX1001 | ok · 10 ms (3 rows) | offer sits below the recorded comp range |
| 3 | permission denial: contact status | get_lead_contact_status FX1001 | **refused · forbidden · SCOPE_NOT_GRANTED** · 0 ms | reported `forbidden`, "scope leadcommand.contact_status.read is not granted" |
| 4 | server stopped | none: Claude init `mcp_servers: [{leadcommand, status: failed}]`, 0 tools | — | "The LeadCommand server is unavailable." |
| 5 | server restarted, same session | get_market_intelligence {zip 75001} | ok · 10 ms | "ZIP 75001 is available with build id 42." |

Claude Code 2.1.281 opens each run with a `server/discover` POST and no session (audited 400 `no_session`), then falls back to `initialize`. It does not DELETE its session on exit, which is why idle sessions are LRU-evicted at the cap.

### 7.5 Live credential proofs (2026-10-16; disposable / local only, never production)

- **Migration runner.** `node scripts/db/run-migration-test.mjs --pg-bin <pg17> --id lc_mcp_reader` → **1 / 1 PASS**. The full cycle runs on a fresh unix-socket cluster with the Supabase shim plus an emulation of the touched production objects: pretest leaves no trace → APPLY → posttest → ROLLBACK → the pre-apply fingerprint is restored exactly → re-apply → posttest.
  - The posttest runs **128** INSERT / UPDATE / DELETE / TRUNCATE / FOR UPDATE / nextval / CREATE / REFRESH / RPC probes AS the role, every one refused by the database. They cover the 20 inventory relations plus send_queue, sms_templates, system_control, message_events, agent.operator_membership / run / org.
  - TRUNCATE on views and materialized views fails with 42809 (not a table) before privileges are consulted.
  - All 20 relations are readable, with RLS policies effective.
  - Each break scenario is named, including pg_net exactly as in production and a real `dblink` install.
  - Mutation checks: an injected INSERT grant fails the posttest. A pre-existing PUBLIC definer writer, and a production-shaped pg_net, each make the apply refuse atomically.
- **Real PostgREST e2e** (`LC_PG_BIN=… LC_POSTGREST_BIN=… npm run test:e2e`) → **8 / 8**. The stack is PostgREST 16.4 on 127.0.0.1 behind a loopback `/rest/v1` gateway shim; the recorded acceptance run used `http://127.0.0.1:56601`. It shows:
  - the reader token runs as `lc_mcp_reader` (session `authenticator`);
  - 15 write probes give 403 / 42501, SELECT send_queue gives 42501, the agent schema gives 406 PGRST106;
  - a service_role control proves the probes change zero rows;
  - the server boots on the real self-check and all 11 coverage calls return `live` data;
  - a forged signature is refused at boot;
  - `live-acceptance.mjs` passes all four stages.
- **Agntau, fixture mode, unchanged** (`tmp/agntau` @0217a12, untouched):
  - `Connections.add` → `connected`, 9 tools, all `readOnly` / risk `read`;
  - `verifyMcpServer` ok; a wrong or missing token gets 401; the token is not in the connection rows;
  - all 9 tools through Agntau's `callMcpTool`: 8 ok, contact status `forbidden / SCOPE_NOT_GRANTED` by the default grant (as §7.4 turn 3);
  - `vitest run test/connections.test.ts` 12 / 12.

---

## 8. Git

**Worktree.** `/Users/ryankindle/.claude/jobs/c39b0175/tmp/mcp-wt` on branch `feat/leadcommand-mcp-1` from `43650af3`. Local commits only: **no push, no merge, no deployment, no production migration, no credential rotation.**

**Commits.**

1. `refactor(acquisition)`: the pure decision-freshness contract moves to `decisionFreshness.js`. `decisionAuthority.js` re-exports it, with no behaviour change.
2. `feat(mcp)`: LeadCommand MCP 1.0, the read-only intelligence gateway (`mcp/leadcommand-mcp/`).
3. `docs(mcp)`: this document.

**Main tree.** `/Users/ryankindle/rei-automation` was left alone with one exception. Running `scripts/proof/monorepo-boundary-audit.mjs` from the worktree overwrote `docs/architecture/dashboard-boundary-violations.md` in the **main tree**, because that script hard-codes `ROOT`. The file was clean at session start. It was restored byte-for-byte from `HEAD` and is clean again. Recommendation: make that script derive `ROOT` from its own location.

---

## 9. Release gates

| # | Gate | Result |
|---|---|---|
| G01 | Worktree from the production release `43650af3`, own branch, main tree untouched (one accidental report overwrite, restored) | PASS |
| G02 | Audit of leads / properties / scores / market / comps / campaigns / eligibility, written into this doc | PASS |
| G03 | Official MCP TypeScript SDK; spec and API verified (`2025-11-25`, low-level `Server`, stdio) | PASS |
| G04 | stdio transport with a real MCP client (SDK Client subprocess) | PASS |
| G05 | Streamable HTTP: loopback only (non-loopback refuses to boot), bearer token from a 0600 file (constant-time), Host / Origin validation, per-connection concurrency cap, shared limits; principal from host config | PASS |
| G06 | Layered package (protocol, auth, authz, adapters, audit, errors / validation, config) | PASS |
| G07 | Principal from host config only; forged ids and context refused | PASS |
| G08 | Org scoping through `agent.operator_membership` (now via `lc_mcp_operator_role` on the read-only credential), fail-closed; cross-org refused | PASS |
| G09 | One read scope per tool; scope denial; sensitive scope not granted by default | PASS |
| G10 | 9 tools with input / output schemas, scope, limits, cursor (where supported), size cap, typed errors and provenance | PASS |
| G11 | Read-only: no write tool registered; static import fence (no write module or mutation reachable) | PASS |
| G12 | Transport refuses writes before the network (insert / update / delete / RPC) | PASS |
| G13 | PII minimization (no phones, names, emails, mailing data, message text, demographics; handles only for contacts) | PASS |
| G14 | Untrusted text confined to declared data fields; prompt-injection tests | PASS |
| G15 | Rate limit and concurrency limit | PASS |
| G16 | Per-call timeout and 5 s statement bound | Client-side PASS. Server-side: `statement_timeout = 5s` on `lc_mcp_reader` (migration, posttest-verified); production confirmation pending the owner's acceptance run |
| G17 | Response size caps (truncation and oversize refusal) | PASS |
| G18 | Audit record per call (no PII) and secret redaction | PASS |
| G19 | Provenance on every value group; missing ≠ 0; stale and inferred labelled | PASS |
| G20 | Suppression correctness (inactive ≠ suppressed; lookup failure = unknown) | PASS |
| G21 | MCP test suite: 103 tests, 102 pass, 0 fail, 1 skipped (the opt-in real-PostgREST e2e, which passes 8 / 8 when run) | PASS |
| G22 | Existing chunked critical suite, no regressions (`CRITICAL_CHUNKS=8`): 834 files, 11,455 tests, 11,399 pass, **0 fail**, 56 skipped — SUITE PASSED; `npm run lint` (2,954 files) passed | PASS |
| G23 | Local protocol validation: fixture and bounded live (10 calls, ≤ 5 identifiers per call) | PASS |
| G24 | Agntau connection: Agntau's own `Connections.add` / `verifyMcpServer` connect (9 read tools); real Claude Code turns through Agntau's generated config (search, follow-up, scope denial, disconnect / recover); Agntau connection tests 12 / 12 | PASS on FIXTURE data. Live-data agent turns **BLOCKED** (permission). Multi-agent Mission **NOT RUN**. |
| G25 | No push / merge / deploy / production migration / remote mutation / credential rotation; no paid enrichment | PASS |
| G26 | Live credential is database-role-enforced: role migration (PROPOSED) passes the disposable-PG17 runner (pretest, apply, 128+ DB-refused probes, every break scenario named, rollback restores the fingerprint, re-apply); service-role and retired inputs refused locally; ambient credentials refused; loader fence; subprocess trace clean | PASS (disposable) |
| G27 | Real PostgREST + PG17 e2e: role switch, DB refusals (42501), side-effect-free probes (service_role control), server boot on the real self-check, all tools live, `live-acceptance.mjs` PASS (local stack only) | PASS (local) |
| G28 | Production go-live: pg_net resolved, role applied, token minted, owner's `live-acceptance.mjs` PASS | **OPEN (owner)** |

Summary: 26 PASS (G26–G27 on disposable / local stacks) · G16 server-side pending production confirmation · G28 OPEN (owner: pg_net, apply, mint, acceptance) · G24 live-data part BLOCKED · multi-agent Mission NOT RUN.

---

## 10. MCP 1.1 plan (hardening, still read-only)

1. DONE in 1.0 (§4.2): the service key is out of the gateway; `lc_mcp_reader` carries `statement_timeout 5s`. Left: column-level narrowing of the PII tables, which needs the reused dossier / outreach services to stop selecting message text and contact columns.
2. Remote Streamable HTTP behind OAuth 2.1 (RFC 9728 protected-resource metadata, audience-bound tokens, no passthrough), with a durable rate and session store and per-request principal verification. The 1.x loopback transport (§5.3) stays loopback-only.
3. A pure campaign readiness core extracted from `campaign-launch-readiness.js`, exposed as `leadcommand_get_campaign_readiness`.
4. Truthful reply metrics: a STABLE, indexed RPC for `message_events` pairing.
5. Engine-qualified comps: extract `evaluateCompEligibility` / `normalizePropertyFeatures` into a pure module (the same pattern as `decisionFreshness`), so comps evidence carries the engine's eligibility verdicts.
6. Publish `resources` for the tool catalog and the provenance legend; add MCP `prompts` for common read workflows.
7. Agntau: rerun §7.4 against live data (bounded, ≤ 15 calls) once the owner allows it, then a two-agent Mission through Agntau's orchestrator.

## 11. MCP 2.0 plan (actions, behind approvals)

1. Row-level multi-tenancy: an org column or tenant schemas on the domain tables, with RLS keyed to the verified principal.
2. **Prepare-only** action tools that go through the existing capability plane (`agent/capabilities` → pending approval, never direct execution). Examples: `prepare_reply`, `prepare_campaign_draft`.
   - Gated by the capability tiers, the untrusted-content taint rule, fresh named-user identity and owner approval.
   - No tool that sends, unsuppresses or launches directly.
3. Elicitation for confirmations and URL-mode elicitation for fresh authentication.
4. Agent-to-agent missions (Agntei): signed delegation, per-mission scopes and budgets, and the audit chain linked across agents.
