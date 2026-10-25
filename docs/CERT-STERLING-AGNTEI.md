# Certification: Sterling → Agntei runtime → LeadCommand Action Gateway (isolated)

Status: **PASS 15/15** (run 7, 2026-10-25), on a disposable local stack. Nothing here touches production, and nothing is activated anywhere.

## What it proves

Sterling is a REAL Claude Code agent: the operator's existing subscription sign-in, with no API key and no metered spend. Agntei's REAL task runtime starts it from ONE queued task, with no chat open and nobody approving anything during the run.

Through Agntei's connection proxy and the REAL Action MCP + Action Gateway, Sterling performed these authorized internal (T1) Workforce writes, each under its own standing grant:

| # | Action | Gateway result |
|---|---|---|
| 1 | `workforce_link_self` | `LINKED`: one Agntei install + agent bound to one LeadCommand employee |
| 2 | `workforce_open_mission` | `MISSION_OPENED`: origin `agntei`, requested by the CEO user, owned by the COO |
| 3 | `workforce_claim_assignment` | `CLAIMED`: the research step the COO staffed to Sterling |
| 4 | `workforce_request_research` | `RESEARCH_REQUESTED`: a real `property.research` R2 job, which ran to completion |
| 5 | `workforce_claim_assignment` | `CLAIMED` again, after the job handed the assignment back |
| 6 | `workforce_complete_assignment` | `ASSIGNMENT_COMPLETED`, outcome **verified**, evidence = the job, **resolved** by the gateway |

The COO then completed the mission review.

### Attribution, from both sides and joined by `client_request_id`

- **Agntei:** `connection_calls` rows carry the task, the run and `actor = claude-code`.
- **LeadCommand:**
  - `action_gateway.action_intents`, `action_authorizations` (`grant_id`, tier 1, sponsor) and `action_outcomes`;
  - `action_audit_events`: 6 each of intent_opened, authorized, claimed and intent_succeeded;
  - the employee row (`external_install_id`, `external_agent_id`, `action_principal_id`).

### Negative assertions

- **The connection is granted to Sterling + the project only.** A control agent, Equity, has no grant.
- **No credential is exposed.** It is not in Agntei's database and not in the Action MCP audit file. The run sees only Agntei's per-run loopback proxy URL.
- **Nothing is seller-facing.** There are 0 send_queue, offer, follow-up or agent-hold rows. No `public.*` table was written (pg_stat deltas).

## How to run

```bash
cd apps/api
node --import ./scripts/workforce/e2e-agntei/register.mjs scripts/workforce/cert-sterling-agntei.mjs \
  --pg-bin=<PostgreSQL 17 bin dir> --agntei-dir=<agntau worktree> --out=<new dir> [--port=8766] [--keep-alive]
```

The run:

1. Starts its own PostgreSQL 17 cluster on a free loopback port.
2. Applies the REAL chain (… → Action Gateway #26–#28 → Workforce → workforce_agntei) and seeds the synthetic Dallas book.
3. Arms the runtime kinds and `action_gateway_enabled` / tier `T1` on THAT database only.
4. Registers Sterling through the real `register_agntei` route.
5. Mints with the real owner scripts, runs the registration's owner SQL (principal + standing T1 grants) and calls `employee_bind_principal`.
6. Starts the Action MCP on 127.0.0.1:8766 and Agntei headless (its own data dir).
7. Configures Agntei only through its existing API, queues one task and waits.
8. Collects evidence and checks C01–C15.
9. Cleans up. The Agntei connection (its keychain entry), every process and the cluster are removed, including on Ctrl-C.

The report is `<out>/cert-report.json`.

## Deliberate differences from production (labelled)

- **Data path.** `mcp/leadcommand-action-mcp/scripts/cert-pg-host.mjs` runs the real app (`buildApp` + `startHttp`, behind the credential-fencing loader).
  - It reaches the database as `authenticator` with `role=lc_action_gateway` + the `lc_org` claim, through `pg-supabase`. This is the e2e-pg test's substitution.
  - The PostgREST HTTP/JWT layer is NOT exercised here. The PostgREST v16.4 macOS binary is unsigned (Gatekeeper rejects it; SHA-256 matches GitHub's digest), so it was not run on this Mac.
- **Agntei sign-in.** Agntei is isolated (`AGNTEI_ISOLATED=1`) and uses the operator's real Claude sign-in by explicit opt-in (`AGNTEI_ISOLATED_ALLOW_SHARED_LOGINS=1`, profile kind `legacy`).
- **Install id.** Agntei has no install-id concept yet. The run derives a stable `agntei_inst_<sha256(data dir)>`.
- **Charter.** Sterling holds the **research_analyst** charter (see the gap below).

## Findings

1. **GAP — an Agntei agent in the `acquisition_agent` charter cannot work its charter's steps.**
   - Run 5 registered Sterling as `acquisition_agent` with `assign_to_self`. The COO gave it the first step, `opps` (`intel.active_opportunities`).
   - That step, and the `conv.*` / `dec.*` steps staffed to acquisition agents, are executed INLINE by the Workforce engine through the deal-context service. No Workforce gateway tool exposes that data to an external agent.
   - Sterling (correctly) refused to invent a property id, and the run blocked.
   - Options:
     - (a) a read tool returning the assignment's context projection;
     - (b) route only externally-executable capabilities (today: `research.property`) to external employees.

   This is an owner decision.
2. **CI does not run** `tests/critical/action-gateway-*` (`agent-s3-persistence.yml` globs `agent-*`).
3. **The Action MCP draft-shadow flag is dead.** `scrubEnv` deletes `LEADCOMMAND_ACTION_MCP_*` before `app.mjs` reads `LEADCOMMAND_ACTION_MCP_DRAFT_SHADOW_ENABLED`. The same applies to `_RECOVERY_INTERVAL_MS` in the bin.
4. **Local baseline.** The gateway tools, standing-grant, unit and workforce-agntei flow/identity PG suites pass 39/39 on PostgreSQL 17.10 (EDB, Developer ID–signed).
