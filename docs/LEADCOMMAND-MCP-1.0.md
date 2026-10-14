# LeadCommand MCP 1.0 — Intelligence Gateway

A first-party, provider-neutral, **read-only** MCP server over LeadCommand data, for any MCP host (Claude, Agntei, or another agent runtime).

| | |
|---|---|
| Status | Built and tested locally. **Not pushed, not merged, not deployed.** |
| Branch | `feat/leadcommand-mcp-1`, cut from production release `43650af3` (8.5.13) |
| Package | `mcp/leadcommand-mcp/` |
| Transport | stdio (enabled). Streamable HTTP is designed but disabled. |
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
MCP host (Claude / Agntei / any client)
   │  stdio (JSON-RPC 2.0, MCP 2025-11-25)
   ▼
protocol/server.mjs      SDK low-level Server: initialize · tools/list · tools/call (tools capability only)
   ▼
gateway.mjs              ONE enforcement path per call (below)
   ├─ auth/principal.mjs     principal from host config · agent.operator_membership (agent_api, fail-closed) · cross-org
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
| Org scoping | `agent.operator_membership` is read as `agent_api` (verify-full TLS, non-privileged role check, 5 s statement timeout), cached 60 s. A failure is `unavailable` (fail closed). Cross-org is `forbidden`. | cross-org ×2, membership failure, revocation after TTL |
| Multi-tenancy (honest) | Membership, scopes and the cross-org check are tenant-aware, but domain tables have no org column. One server serves exactly one data org (`LEADCOMMAND_MCP_DATA_ORG_ID`). Row-level tenancy is a 2.0 item. | cross-org |
| Scopes | One `.read` scope per tool. Unknown or write scopes refuse to boot. Contact status is not in the default grant. | scope denial ×3 |
| Read-only | (1) The catalog boot guard: only `leadcommand_(get\|search)_*` names and `.read` scopes, with write-shaped names refused. (2) A static import fence over the whole import graph: no write-capable LeadCommand module and no DB mutation call or SQL is reachable. (3) The transport refuses writes before the network. | readonly ×9 |
| PII | Projection first: no names, phones, emails, mailing data, message text, person keys or demographics. `safeFlags` drops protected-class labels. A second net masks phone and email shapes in every string. Contacts are handles. | safety: PII ×4, second net |
| Untrusted text | Imported or human-entered strings are sanitized (control and bidi characters stripped, length capped). They appear only as data, and their paths are listed in `untrusted_fields`. The result `trust.content` is `data_only`, and server instructions say the same. No action tools exist to hijack. | prompt injection ×2 |
| Secrets | Read from files, closure-held, environment scrubbed. A redactor (JWT, keys, `postgres://`, PEM, bearer, `password=`) runs on every audit line. A secret-shaped value in a result is refused (`SECRET_GUARD`). | secret redaction ×3 |
| Rate / concurrency | Sliding-window limits per principal (default 60/min, ceiling 120) and per tool. In-flight calls are bounded (default 4, ceiling 8); the excess is refused, never queued. | limits ×3 |
| Timeouts | Per-call hard deadline (default 10 s, ceiling 15 s, per tool 8–10 s). Each HTTP request aborts at 5 s. Each call has a budget of 40 requests. `Prefer: timeout=5` is sent on every request. | timeout |
| Size | Per-tool byte caps (16–96 KB, global ceiling 256 KB). Paged rows are dropped to fit; the page then says `truncated_for_size` and returns no cursor. A single oversized record fails. | size ×2 |
| Audit | One record per call: hashed principal and org, tool, scope, outcome, error class and code, correlation id, latency, rows, bytes, truncation, input hash, data mode, upstream timeout preference. No inputs, results or PII. | secret redaction, every suite |

**Known gap: the 5-second server-side statement timeout is not confirmed.**

- Every read aborts client-side at 5 s.
- PostgREST did not return `Preference-Applied` for `Prefer: timeout=5` in the live run (`upstream_timeout_pref: null`), so a server-side 5 s bound is **not confirmed**.
- The service role has no statement timeout of its own.
- Every query is index-served and bounded, and the maximum observed latency was 4.5 s. A server-side bound is a 1.1 gate: a dedicated read role with `statement_timeout = '5s'`, or STABLE RPCs with `SET statement_timeout`.

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
| `LEADCOMMAND_MCP_SUPABASE_URL` | Live only: the https origin of the app data service |
| `LEADCOMMAND_MCP_SERVICE_KEY_FILE` | Live only: **path** to a 0600 file holding the service key (never the key itself) |
| `LEADCOMMAND_MCP_AGENT_DB_URL_FILE` / `LEADCOMMAND_MCP_AGENT_DB_CA_FILE` | Live only: paths to the `agent_api` URL and the Supabase CA |
| `LEADCOMMAND_MCP_RATE_PER_MIN`, `_MAX_CONCURRENCY`, `_CALL_TIMEOUT_MS`, `_MAX_RESPONSE_BYTES` | Can only **lower** the budgets (hard ceilings in `config.mjs`) |
| `LEADCOMMAND_MCP_TRANSPORT` | `stdio` only. Anything else refuses to boot in 1.0. |

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
        "LEADCOMMAND_MCP_SERVICE_KEY_FILE": "<path, 0600>",
        "LEADCOMMAND_MCP_AGENT_DB_URL_FILE": "<path, 0600>",
        "LEADCOMMAND_MCP_AGENT_DB_CA_FILE": "<path>/prod-ca-2021.crt",
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

### 5.3 Streamable HTTP (designed, disabled)

`protocol/transports.mjs#startHttp` refuses unconditionally, and `LEADCOMMAND_MCP_TRANSPORT=http` refuses to boot. The design for 1.1:

- **Authorization.** The server is an OAuth 2.1 resource server.
  - It publishes RFC 9728 protected-resource metadata and accepts only audience-bound tokens issued for this server.
  - It does no token passthrough.
  - The principal comes from the verified token on every request, and membership is checked per session.
- **Network exposure.**
  - `Origin` allowlist and DNS-rebinding protection.
  - Loopback bind by default.
  - The `MCP-Protocol-Version` header is checked.
- **Sessions.** Session ids are random, bound to the principal, and never used as authentication.
- **Shared state.** Rate state moves to the durable store.

---

## 6. Agntei

| Step | Result |
|---|---|
| Local search | `ls ~/ ~/Projects ~/code \| grep -i agnt`, `find ~ -maxdepth 6 -iname '*agnt*'` and `mdfind -name agntei` all returned **nothing**. No Agntei memory entry exists. |
| MCP connection architecture read | **BLOCKED.** There is no checkout to read. |
| Connection profile | **Prepared, provider-neutral**: §5.2 (stdio `mcpServers` profile). It has not been validated against Agntei. |
| Tests A–E and G (owner's Agntei plan) | **BLOCKED.** There is no Agntei runtime on this machine. The equivalent generic MCP-host checks were run with the official SDK Client over real stdio (§7.3): initialize, discovery, read calls, typed errors, scope denial, concurrency, and disconnect / relaunch. |
| Multi-agent Mission | **NOT RUN.** No distinct agents were run. No mission success is claimed. |

---

## 7. Testing

### 7.1 MCP suite: 67 tests, 67 pass

The suite uses FIXTURE data, labelled synthetic. Run it with `cd mcp/leadcommand-mcp && npm test`.

| File | Tests | Covers |
|---|---|---|
| `protocol.test.mjs` | 5 | initialize (server info, tools-only capability, instructions), discovery (9 tools, annotations, closed input schemas, scopes, limits), every result validated against its advertised output schema (Ajv and the SDK Client), input bounds, unknown tool as a protocol error (audited) |
| `tools.test.mjs` | 15 | each tool's happy path, missing ≠ 0, current / stale / not-run scores, comps lane and buyer basis, exact campaign counts, empty results, not_found on every per-record tool |
| `security.test.mjs` | 15 | unauthenticated (no principal, non-member), cross-org ×2, forged-context keys, injection-shaped ids, scope denial ×3, role, membership fail-closed, TTL revocation, cursor forgery (tampered, cross-filter, cross-tool, cross-principal), unsupported filters, HTTP disabled |
| `limits.test.mjs` | 12 | full keyset traversal (no duplicates or gaps), max-result limits, size cap (truncation and oversize failure), timeout at the deadline, rate limit (principal and tool), DB failure (fault, missing relation), concurrency (bounded, refuse the excess), disconnect / recover in memory **and as a real stdio subprocess** (kill, the process exits, relaunch) |
| `safety.test.mjs` | 11 | provenance kinds and missing ≠ 0, no fixture phone, name, email or person key anywhere, protected flags dropped, contact handles only, second-net masking, redactor and audit hygiene, secret guard, environment scrub, prompt injection (seller preview never leaves; injected text only at declared untrusted paths; tool surface unchanged), control and bidi stripping, suppression (active, inactive and lookup-failure cases) |
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
- Data paths: membership as `agent_api` (verify-full TLS); domain reads through the guarded read-only transport.
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
| G05 | Streamable HTTP designed and **disabled** (refuses to boot) | PASS |
| G06 | Layered package (protocol, auth, authz, adapters, audit, errors / validation, config) | PASS |
| G07 | Principal from host config only; forged ids and context refused | PASS |
| G08 | Org scoping through `agent.operator_membership` as `agent_api`, fail-closed; cross-org refused | PASS |
| G09 | One read scope per tool; scope denial; sensitive scope not granted by default | PASS |
| G10 | 9 tools with input / output schemas, scope, limits, cursor (where supported), size cap, typed errors and provenance | PASS |
| G11 | Read-only: no write tool registered; static import fence (no write module or mutation reachable) | PASS |
| G12 | Transport refuses writes before the network (insert / update / delete / RPC) | PASS |
| G13 | PII minimization (no phones, names, emails, mailing data, message text, demographics; handles only for contacts) | PASS |
| G14 | Untrusted text confined to declared data fields; prompt-injection tests | PASS |
| G15 | Rate limit and concurrency limit | PASS |
| G16 | Per-call timeout and 5 s statement bound | **FAIL (partial)**. The client-side 5 s abort and the call deadline PASS. The server-side `statement_timeout ≤ 5 s` is NOT confirmed (`Preference-Applied` absent). Fix in 1.1. |
| G17 | Response size caps (truncation and oversize refusal) | PASS |
| G18 | Audit record per call (no PII) and secret redaction | PASS |
| G19 | Provenance on every value group; missing ≠ 0; stale and inferred labelled | PASS |
| G20 | Suppression correctness (inactive ≠ suppressed; lookup failure = unknown) | PASS |
| G21 | MCP test suite (fixtures): 67 / 67 | PASS |
| G22 | Existing chunked critical suite, no regressions (`CRITICAL_CHUNKS=8`): 834 files, 11,455 tests, 11,399 pass, **0 fail**, 56 skipped — SUITE PASSED; `npm run lint` (2,954 files) passed | PASS |
| G23 | Local protocol validation: fixture and bounded live (10 calls, ≤ 5 identifiers per call) | PASS |
| G24 | Agntei MCP connection architecture read, profile prepared, Tests A–E and G | **BLOCKED**. No Agntei checkout or runtime found. Generic profile prepared (§5.2). |
| G25 | No push / merge / deploy / production migration / remote mutation / credential rotation; no paid enrichment | PASS |

Summary: 23 PASS · 1 FAIL (G16, partial) · 1 BLOCKED (G24) · multi-agent Mission NOT RUN.

---

## 10. MCP 1.1 plan (hardening, still read-only)

1. Bound statements server-side. Options: a dedicated `mcp_read` login with `statement_timeout = '5s'`, SELECT on exactly the projected columns, and no service role in the path; or STABLE `SECURITY DEFINER` RPCs with `SET statement_timeout`. Either one closes G16 and removes the service key from the gateway.
2. Streamable HTTP behind OAuth 2.1 (§5.3), with a durable rate and session store, and per-request principal verification.
3. A pure campaign readiness core extracted from `campaign-launch-readiness.js`, exposed as `leadcommand_get_campaign_readiness`.
4. Truthful reply metrics: a STABLE, indexed RPC for `message_events` pairing.
5. Engine-qualified comps: extract `evaluateCompEligibility` / `normalizePropertyFeatures` into a pure module (the same pattern as `decisionFreshness`), so comps evidence carries the engine's eligibility verdicts.
6. Publish `resources` for the tool catalog and the provenance legend; add MCP `prompts` for common read workflows.
7. Agntei: run Tests A–E and G once a checkout or runtime exists.

## 11. MCP 2.0 plan (actions, behind approvals)

1. Row-level multi-tenancy: an org column or tenant schemas on the domain tables, with RLS keyed to the verified principal.
2. **Prepare-only** action tools that go through the existing capability plane (`agent/capabilities` → pending approval, never direct execution). Examples: `prepare_reply`, `prepare_campaign_draft`.
   - Gated by the capability tiers, the untrusted-content taint rule, fresh named-user identity and owner approval.
   - No tool that sends, unsuppresses or launches directly.
3. Elicitation for confirmations and URL-mode elicitation for fresh authentication.
4. Agent-to-agent missions (Agntei): signed delegation, per-mission scopes and budgets, and the audit chain linked across agents.
