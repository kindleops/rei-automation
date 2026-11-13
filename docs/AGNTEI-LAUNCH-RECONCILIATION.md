# agntei launch: branch reconciliation, migrations, credentials and permissions (2026-11-05)

> Superseded in part (2026-11-05, later the same day): section 2 below is replaced by the reconciliation itself, `docs/AGNTEI-PRODUCTION-RECONCILIATION.md` (branch `review/agntei-production-reconciliation`). The migration plan is `docs/AGNTEI-MIGRATION-DOSSIER.md`.

Status: reviewed in a cloud session that cannot reach production, the Supabase project or the Mac.
Nothing here is applied, merged into a production branch, or deployed.

## 1. The branches as they stand

| Branch | Head | What it is |
|---|---|---|
| `release/cloudflare-production` | `c5a7104f` (2026-11-02) | What production runs: `main` plus 30 commits, the last of which is the P0 send-authority hotfix |
| `main` | `fa12ff7b` (2026-09-27) | 1 commit that production lacks (a home page change) |
| `feat/agntei-bidirectional-sync` | `29e5e57d` (2026-11-01) | 350 commits beyond `main`, unmerged: record sync and the Action Gateway chain |
| `feat/agntei-service-gateway` | `b36e9552` (2026-11-05) | `feat/agntei-bidirectional-sync` plus 3 commits: service principals, signed acting assertions, campaign audiences |

`feat/agntei-service-gateway` and production share a base at `6ecbae6b` (2026-10-14).
- Production has 9 commits that the gateway branch does not.
- The gateway branch has 332 commits that production does not.

## 2. What a trial merge showed

Merging `release/cloudflare-production` into a copy of `feat/agntei-service-gateway` stops with 33 conflicts. Both sides changed the same files in parallel; production carries back-ports such as the Package A research runtime.

The 21 conflicting source files include:
- the send path: `send-now-service.js` (255 changed lines on our side, 57 on production's) and `send-now/route.js`;
- classification: `classify.js` (457 against 58 lines);
- the conversation fact ledger: `fact-ledger.js` (586 against 473 lines);
- the automation hold core and gate;
- the runtime tick;
- research usage;
- operations;
- the Cloudflare worker.

The other 12 conflicts are tests and migration scripts.

**This merge was not made.** Resolving it means choosing, file by file, between two independently reviewed versions of send-authority code. That is LeadCommand's owner's change to make, as its own reviewed pull request, with the critical suite and the PostgreSQL chain re-run on the result. An automatic or blind resolution here could silently drop the production hotfix, or a guard from the other side.

## 3. What the launch actually needs from LeadCommand

The agntei service talks to LeadCommand only through the **Action Gateway**. That is a separate local process (`mcp/leadcommand-action-mcp`):
- it runs on the operator's Mac, loopback only, from a checkout of `feat/agntei-service-gateway`;
- it reaches the database through the scoped role `lc_action_gateway`.

The launch therefore does not redeploy LeadCommand's web application. Production's web code stays on `release/cloudflare-production`.

What the launch does need is the database chain that the gateway runs on.

### The chain

The chain is listed, in order, in `scripts/agntei-launch/chain.mjs`. The order was traced from the real disposable-PostgreSQL proof (`action-gateway-service-principal-pg`) on PostgreSQL 17.

| | Count | Migrations |
|---|---|---|
| Byte-identical on the production branch | 11 | durable run locks, S3 persistence, opaque ids, research RO, intel runtime, the two event budgets, agent capabilities, conversation AI shadow, persistent missions, operations action center |
| Only on the gateway branch | 17 | conversation turn operator items, automation holds registry, conversation reply turns, AI-generated messages, the reply-turn dispatch lease, negotiation authority, negotiation send authorization, the follow-up intent lifecycle, the Action Gateway (and its T2, T3/T4, OHG, standing reply, AI-generated outbound and agent message links), record sync, service principals |

Being on the production *branch* does not mean being applied in the production *database*. Every one of these is a `PROPOSED_` file that the owner applies by hand. Only a read of production's catalog can tell which of them are applied, and that read happens on the Mac (section 4).

### Shared objects the chain changes

Some of the 17 change objects that production's web code also uses:
- triggers and a unique backstop on `send_queue`: the dispatch lease and the follow-up lifecycle;
- hold triggers: the holds registry;
- record-change events on lead tables: record sync.

Each of them was built **born OFF** and passed the chain on a disposable database. However, production's web code at `c5a7104f` has not been run against a database that carries them.

That compatibility is owner review item R1 below. A migration that the review shows is already applied in production (for example, the holds registry is documented as applied through the hotfix) needs no new apply.

## 4. The read-only migration review (built here, run on the Mac)

There are three pieces:
- `scripts/agntei-launch/gateway-chain.manifest.json` is the chain's catalog fingerprint. It was produced by `build-chain-manifest.mjs`, which applies the chain one file at a time on a disposable database and records exactly what each migration adds: tables, columns, functions with body hashes, policies, triggers, indexes and schemas, plus the roles it creates. It records 28 migrations and 257 function bodies.
- `scripts/agntei-launch/review-chain.mjs` reads production's catalog inside `BEGIN TRANSACTION READ ONLY` (so PostgreSQL itself refuses any write). It prints, per migration in order:
  - applied, partial or absent;
  - which reviewed version of each function body is live;
  - **DRIFT**, meaning a body that no reviewed migration produced, so production carries a change this branch has not seen;
  - whether the order is broken.

  The connection string is read from a 0600 file and never printed.
- `apps/api/tests/critical/agntei-launch-chain-pg.test.mjs` proves the reviewer on disposable PostgreSQL 17 in four states:
  - production-like: the 11 shared migrations are applied, and the next one is reported correctly;
  - the full chain: everything reads as applied;
  - a hand-edited function: reported as DRIFT;
  - a skipped middle migration: the gap is reported.

  It also proves that the manifest still matches the files byte for byte.

The agntei launch workflow (`apps/desktop/scripts/agntei-launch.mjs` in agntei) runs this review in its "Backup and migration review" stage.

## 5. Credentials and signing

- **One service credential.** `svc_agntei` gets a `lcsvc_…` token minted by `mint-service-credential.mjs`.
  - Only its peppered digest is stored.
  - It is valid for the days given (`--days`; 7 in the proof).
  - The owner mints it on the Mac and hands it to agntei's secret store, never through chat or a file in a repository.
- **One signing key per acting agent.** These are Ed25519 keys.
  - agntei generates them (`service keys --create`) and keeps the private keys in its secret store.
  - Only the 43-character public keys go to LeadCommand, as `--delegate agent=<public key>`.
  - Every call carries `X-LC-Acting-Assertion`: a signature over the agent, the tool, the SHA-256 of the canonical arguments, and a timestamp with a 120-second window.
  - A header without a valid signature from that agent's key is refused (`ACTING_ASSERTION_*`).
- **Rotation.** Re-adding a delegate with a new key rotates it and records `key_rotated_by`. Only an owner may rotate, and the database guard enforces that.
- **The pepper.** A 0600 file of at least 32 random bytes, kept on the Mac.

## 6. Service permissions: the grant set to start with

These are role-scoped grants, written by the org owner (`action_gateway.capability_grants`).

| Agent | Tier ceiling | Grants |
|---|---|---|
| Rowan (head of acquisitions) | 2 | `records.read`, `records.apply_change` (T2), `campaigns.create_draft`, `campaigns.read`, `acquisitions.update_lead_status` (T2) |
| Acquisition representatives | 2 | `records.read`, `records.apply_change` (T2), `acquisitions.update_lead_status` (T2) |
| Research | 1 | `records.read` |

- No agent gets a sending capability at launch.
- The service ceiling is tier 2.
- Campaign launch stays human-only in LeadCommand until a standing sending policy is authorized separately (agntei `docs/AGNTEI-CAMPAIGN-AUTONOMY.md`).

## 7. Owner review items before any production apply

| # | Item |
|---|---|
| R1 | Decide whether production's web code at `c5a7104f` may run against the pending chain links that touch `send_queue`, the holds and the lead tables. Either run production's critical suite against a database carrying them, or merge the branches first (section 2). |
| R2 | Run the read-only review on the Mac. Act on DRIFT or a broken order before applying anything. |
| R3 | Back up production before the first apply: a Supabase point-in-time restore marker, or `pg_dump` of the affected schemas. |
| R4 | Apply each pending migration in order: pretest read-only, then `psql --single-transaction -v ON_ERROR_STOP=1 -f <file>`, then review again. Each one is its own approval, as `docs/ACTION-MCP.md` §7 already requires. |
| R5 | Mint the service credential with the agents' public keys, then write the grants in section 6. |
| R6 | Start the Action Gateway on the Mac, loopback only. The boot self-check must report `ok`. |
