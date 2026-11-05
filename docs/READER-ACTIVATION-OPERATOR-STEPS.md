# Read-only reader activation: the operator's sequence

**For the owner's authorization of 2026-10-30.** It covers:
- reader links 2–5 (link 1 is already in production exactly as reviewed);
- the reader's deployment;
- authentication through agntei's vault;
- verification of real access;
- the start of Sterling's Operation Hidden Gold analysis.

**Not included:** live SMS, links 6–9, seller contact and any other production write.

Run every step on the operator machine, from a LeadCommand checkout of `preserve/agntei-agent-texts-unreviewed`. No secret is ever typed into a chat, a log or a file in a repository.

## Status at 2026-10-31 (after the first apply)

The first apply committed **link 2** and then stopped: `date +%s%3N` is not portable to macOS, so the timer failed. The script's own guard stopped it before link 3.

**Read-only checks afterwards found:**
- links 1 and 2 identical to the reviewed files;
- links 3–5 absent;
- no row count changed;
- no role, grant or SMS setting changed.

The new production inventory fingerprint is **`2945b105f819b988`**, and it replaces `4bcff231005cc26e` once the owner approves it.

**The script is fixed** (portable millisecond timer, `shasum` fallback, empty-array safety under macOS bash 3.2, and a guard that every outstanding link was applied before validation). It was re-tested on a Supabase-shaped replica in the same intermediate state, under a macOS `date`. Steps 1–2 below then apply links **3–5** only. The script derives the outstanding links from the reconciliation.

**Second apply (2026-10-31, as reported by the operator session):**
- Evidence: `~/reader-activation-20261031T073948Z-apply2` on the operator machine.
- Links 3, 4 and 5 were applied; links 1 and 2 were already in place; links 6–9 were not touched.
- Validation was all true, and the reader's self-check was true (20 relations, 20 functions).
- The reader has no write privilege on any `public` relation and no CREATE on `public`.
- All 26 counted tables are unchanged.
- The catalog changed only by the 9 function entries of these links.
- The post-apply reconciliation found all five links identical (31 of 31 objects).
- The all-history worklist shows 2,135 threads with a seller message.

The production inventory fingerprint is now **`9db15fb47a5e4d64`**. Steps 0–2 are complete; continue at step 3.

**Provenance note:** that run used checkout `f362bc85` with the operator session's own local portability edits, equivalent to `d6115504`. Its diff is preserved in the evidence directory as `script-as-run.diff`.

## 0. Before anything

| Check | How | Stop if |
|---|---|---|
| Backup / recovery | Supabase dashboard → Database → Backups: the latest daily backup or point-in-time-recovery window for `real-estate-automation`; record its time | No backup in the last 24 h, or PITR unavailable and no fresh backup |
| The reviewed inventory | **`4bcff231005cc26e`**: the owner's v2 inventory of 2026-10-31 (link 1 IDENTICAL, links 2–5 ABSENT). It must have been computed with `reader-reconcile.mjs` at `26cd6ddf` or later (the key-order-independent fingerprint). An older comparator gives another value, and the preflight then stops as "production changed", which is a safe false stop: recompute it. | No fingerprint |
| Tools | `psql` and `node` ≥ 22 | Missing |
| Admin connection | `export PROD_ADMIN_URL=…` typed in this shell only; `export EXPECTED_DB_HOST=<the production host>` | — |

## 1. Fresh preflight (read-only)

```bash
MODE=preflight EXPECTED_INVENTORY=<reviewed fingerprint> scripts/db/reader-activation.sh
```

**It must report:**
- the five files are the reviewed ones;
- the reconciliation shows link 1 identical (both pinned memberships) and links 2–5 absent;
- `inventory unchanged since the owner's review (<fingerprint>)`;
- a recorded baseline (catalog snapshot and row counts);
- `preflight passed`, with outstanding links 2–5.

**Anything else stops here.** The evidence directory (mode 0700) holds `reconciliation.md`, `inventory.json`, `catalog-before.txt` and `counts-before.tsv`.

## 2. Apply links 2–5 only

```bash
MODE=apply EXPECTED_INVENTORY=<reviewed fingerprint> BACKUP_CONFIRMED="<backup / PITR time from step 0>" scripts/db/reader-activation.sh
```

**It first repeats every preflight check.** Then it applies links 2, 3, 4 and 5 in order, one transaction each, and skips link 1.

**Then it verifies, read-only:**
- the §7 validation is all true;
- the reader's own self-check is `true` (20 relations, 20 functions);
- the reader has no write privilege on any `public` relation, directly or through PUBLIC, and no CREATE on `public`;
- every counted row count is unchanged;
- the catalog changed only by the four links' own functions;
- a second reconciliation finds all five links identical;
- no role other than `lc_mcp_reader` changed (none should).

**Any failure stops.** The rollbacks of the links already applied are printed in reverse order; each restores the prior definitions exactly.

## 3. Mint the reader token (the owner)

```bash
mkdir -p ~/.leadcommand && chmod 700 ~/.leadcommand
# the project's legacy JWT secret, pasted into a 0600 file by the owner (never into a chat)
node mcp/leadcommand-mcp/scripts/mint-reader-token.mjs --secret-file ~/.leadcommand/jwt-secret --out ~/.leadcommand/lc_mcp_reader.jwt --days 30
rm ~/.leadcommand/jwt-secret
# the anon / publishable key into ~/.leadcommand/anon.key (0600)
```

The token carries `role: lc_mcp_reader` only. The reader refuses any service-role token.

## 4. Live acceptance against production (read-only; no data changes)

From a clean shell:

```bash
env -i PATH="$PATH" HOME="$HOME" \
  LEADCOMMAND_MCP_SUPABASE_URL=https://<project-ref>.supabase.co \
  LEADCOMMAND_MCP_READER_JWT_FILE=~/.leadcommand/lc_mcp_reader.jwt \
  LEADCOMMAND_MCP_API_KEY_FILE=~/.leadcommand/anon.key \
  LEADCOMMAND_MCP_PRINCIPAL_USER_ID=<owner user id> LEADCOMMAND_MCP_ORG_ID=<org id> \
  node mcp/leadcommand-mcp/scripts/live-acceptance.mjs --zip <an Indianapolis ZIP with properties>
```

**It must end `"result": "PASS"`:**
- **Stage `database`:**
  - 18 write and forbidden-read probes refused **by the database** (403 / 42501);
  - the privilege report shows `running_as: lc_mcp_reader`, `ok: true`.
- **Stage `capability`:** all 13 tools live, with provenance.
- **Stage `audit`:**
  - the boot self-check is ok;
  - one `tool_call` audit entry per call.

## 5. Start the reader for agntei (loopback, bearer token)

```bash
cd mcp/leadcommand-mcp
node scripts/http-token.mjs ~/.leadcommand/mcp-http-token          # 0600, never printed
LEADCOMMAND_MCP_DATA=live LEADCOMMAND_MCP_TRANSPORT=streamable-http \
LEADCOMMAND_MCP_HTTP_BIND=127.0.0.1 LEADCOMMAND_MCP_HTTP_PORT=8765 \
LEADCOMMAND_MCP_HTTP_TOKEN_FILE=~/.leadcommand/mcp-http-token \
LEADCOMMAND_MCP_SUPABASE_URL=https://<project-ref>.supabase.co \
LEADCOMMAND_MCP_READER_JWT_FILE=~/.leadcommand/lc_mcp_reader.jwt LEADCOMMAND_MCP_API_KEY_FILE=~/.leadcommand/anon.key \
LEADCOMMAND_MCP_PRINCIPAL_USER_ID=<owner user id> LEADCOMMAND_MCP_ORG_ID=<org id> \
LEADCOMMAND_MCP_SCOPES=<every .read scope> LEADCOMMAND_MCP_AUDIT_FILE=~/.leadcommand/reader-audit.jsonl \
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON bin/leadcommand-mcp.mjs
```

It binds 127.0.0.1 only and refuses anything else.

## 6. Vault authentication in agntei (the owner)

1. In agntei, go to Connections → "Connect another MCP server by URL…" → `http://127.0.0.1:8765/mcp`, sign-in **Token**.
2. Paste the content of `~/.leadcommand/mcp-http-token` into the secret field on the owner's own screen. It is stored in agntei's vault and never shown again.
3. Name the connection "LeadCommand reader".
4. In Acquisitions → settings, set it as the **reader connection**.

**Verify:**
- the connection test passes;
- `leadcommand_get_corpus_census` returns production counts;
- `~/.leadcommand/reader-audit.jsonl` shows the call.

## 7. Census reconciliation against the authoritative database (read-only)

Compare the reader's census (step 6, through the reader's own token) with direct counts in a read-only admin session:

```bash
PGOPTIONS='-c default_transaction_read_only=on' psql "$PROD_ADMIN_URL" -X -A -c "
select 'properties', count(*) from public.properties union all
select 'inbox_thread_state', count(*) from public.inbox_thread_state union all
select 'threads with a seller message', count(*) from public.inbox_thread_state where last_inbound_at is not null union all
select 'message_events', count(*) from public.message_events union all
select 'phones', count(*) from public.phones union all
select 'master_owners', count(*) from public.master_owners union all
select 'campaigns', count(*) from public.campaigns union all
select 'sms_suppression_list', count(*) from public.sms_suppression_list"
```

**Every pair must be equal.** The census counts exact rows, so a difference means the reader is not seeing all of production. Investigate it before Hidden Gold starts.

Record:
- the census `as_of`;
- the latency of the census call;
- the latency of one all-history ranking page.

## 8. Operation Hidden Gold: analysis only

In agntei, Acquisitions → Recovery → **Scan history** (or `POST /api/acquisitions/recovery`).

**Default scope:** every market, the whole history (`window_days: "all"`), paged with a durable cursor.

**What it does:**
- counts the corpus;
- traverses every conversation with a seller message;
- checks eligibility;
- builds a dossier per opportunity;
- gives Sterling the company-wide summary by market and category.

`GET /api/acquisitions/recovery/:id/reads` lists every page it read (ids and counts, never text).

**No seller is contacted:**
- Communications stays Disabled;
- historical leads are queued only by a person;
- links 6–9 are not applied, so no agent text path exists in LeadCommand.

## Stop switches

- **The credential, at once:** `revoke lc_mcp_reader from authenticator;` (a production write: the owner's).
- **The local endpoint:** stop the reader process, or remove the agntei connection (its stored token is deleted).
- **The mission:** pause it in agntei.
