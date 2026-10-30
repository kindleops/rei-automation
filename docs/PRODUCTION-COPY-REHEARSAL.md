# Production-copy rehearsal — runbook

Status: **built and proven on a synthetic dump only** (`docs/prod-copy-rehearsal/synthetic-2026-10-30/`). No production
database, backup, bucket or API has been read. Nothing here runs until the owner authorizes it in writing (§1).

The rehearsal answers three questions on a faithful copy of production, without touching production:

1. Do the five links (#29 OHG, #30 acquisition reads, #31 standing reply, A ledger kinds, B agent texts) apply, pass
   their tests, roll back to an identical schema and re-apply, on production's real schema and data volume — and how long
   does each take, including the CHECK re-validation on large tables (`docs/AGENT-TEXTS-DIFF-AUDIT.md`, "Before any of
   this reaches production" item 3)?
2. What does the lead corpus hold, as counts only (the census, Phase 2 of `docs/AGENT-TEXTS-CHANGE-RISK-REPORT.md`)?
3. Which historical seller conversations are the best opportunities, keyed by opaque ids, and which of them may be
   contacted — with unknown eligibility never counted as contactable (Operation Hidden Gold)?

Tool: `scripts/db/prod-copy-rehearsal.mjs` (one file, one subcommand per step). Tests:
`apps/api/tests/critical/prod-copy-rehearsal.test.mjs`. Synthetic source builder: `scripts/db/prod-copy-synthetic-build.mjs`.

## 1. What the owner must authorize (each item separately)

| # | Decision | Default until decided |
|---|---|---|
| A1 | That a backup of production may be **produced** (by the owner, with the owner's own credential) | No backup exists for this purpose |
| A2 | Which schemas the backup contains (recommended: everything except the Supabase platform schemas — see §2) | — |
| A3 | Which machine holds the copy, and that it may hold production data (disk encrypted, single operator, no sync to cloud folders) | No machine is approved |
| A4 | Who may run the rehearsal and read the evidence | Nobody |
| A5 | Whether `hidden-gold --include-text` (seller words, owner-only file) may be used at all | Off; never by an agent |
| A6 | How long the copy and the backup file may exist (recommended: deleted the same day, §6) | — |
| A7 | Whether any of the evidence may be committed to a repository (recommended: no; it is production-derived even when aggregate) | Not committed |

The owner's authorization covers **reading a copy**. It never covers: writing to production, sending or queuing any
message, changing a switch or a grant anywhere, or giving an agent a production credential.

## 2. How the backup is produced and delivered

**Produced by the owner, not by an agent.** On the owner's machine, with the owner's own read credential, a custom-format
dump made by `pg_dump` 17 (the rehearsal reads `-Fc`, `-Fd` or `-Ft`; plain SQL is accepted only without cluster-level
statements, and is restored with fewer safeguards):

```sh
# run by the OWNER. The connection string is typed by the owner and never shared.
pg_dump -Fc --file prod-$(date +%Y%m%d).dump \
  --exclude-schema=auth --exclude-schema=storage --exclude-schema=vault --exclude-schema=pgsodium \
  --exclude-schema=pgsodium_masks --exclude-schema=realtime --exclude-schema=_realtime \
  --exclude-schema=supabase_functions --exclude-schema=supabase_migrations --exclude-schema=net \
  --exclude-schema=graphql --exclude-schema=_analytics \
  "<the owner's own production connection string>"
sha256sum prod-*.dump      # the owner writes this hash down; validate-backup must print the same
```

Leaving the platform schemas out keeps login records, auth phone numbers / emails and vault secrets out of the file;
no rehearsal step reads them. The restore excludes the same schemas again even if they are present.

The Supabase dashboard's downloadable backup (`pg_dumpall` style, with `CREATE ROLE`) is refused by `validate-backup`:
it carries cluster-level statements. Produce a `pg_dump -Fc` instead.

**Delivered as a file on the rehearsal machine.** Accepted channels:
- the owner copies the file onto the rehearsal machine themselves (scp from their machine, an encrypted drive);
- or the owner creates a short-lived signed URL and **downloads it themselves** on the rehearsal machine.

Never: pasting the backup, a connection string, a password, a signed URL or a key into a chat or a ticket; giving the
URL or the file to an agent to fetch; storing it in the repository, a shared drive or a synced folder. The file is
`chmod 600`, in a directory only the operator can read, outside every repository.

## 3. The isolated database server

The copy lives on a **local, disposable PostgreSQL 17** that listens on loopback or a unix socket only. Prefer a cluster
created for this rehearsal alone (a shared development server is acceptable for the synthetic proof, not for production
data):

```sh
# as the postgres OS user, on the approved machine (A3)
/usr/lib/postgresql/17/bin/initdb -D /secure/lc-prodcopy/data -U postgres -A peer --auth-host=reject
/usr/lib/postgresql/17/bin/pg_ctl -D /secure/lc-prodcopy/data -l /secure/lc-prodcopy/server.log \
  -o "-c listen_addresses='' -c unix_socket_directories=/secure/lc-prodcopy" start
```

With peer authentication the rehearsal runs as the `postgres` OS user (or create a superuser role named after the
operator's OS user). The directory `/secure/lc-prodcopy` is mode 0700 and lives on the encrypted disk approved in A3.

The tool refuses, before connecting: any non-loopback host (the migration runner's `LC_DISPOSABLE_DB_HOST` escape hatch
is ignored), anything that looks hosted (Supabase, a pooler, RDS, Neon, Azure, Cloud SQL, …), the production project
ref, keyword conninfo, a URL without an explicit host, and a database not named `lc_prodcopy_<tag>`. After connecting it
refuses a server address that is not loopback and a server that carries a Supabase platform role (`supabase_admin`, …).

## 4. Commands, in order

```sh
cd <the repository at the reviewed commit>
export LC_PG_BIN=/usr/lib/postgresql/17/bin              # pg_restore must be >= the dump's pg_dump version
ADMIN='postgresql://postgres@/postgres?host=/secure/lc-prodcopy&port=5432'   # or postgres://postgres@127.0.0.1:<port>/postgres
DB=lc_prodcopy_20261031                                   # lc_prodcopy_<tag>
OUT=/secure/lc-prodcopy/evidence-20261031                 # outside the repository, mode 0700
R="node scripts/db/prod-copy-rehearsal.mjs"
A="--admin-url $ADMIN --db $DB --out $OUT"

$R guard           $A
$R validate-backup $A --file /secure/lc-prodcopy/prod-20261031.dump
$R restore         $A --file /secure/lc-prodcopy/prod-20261031.dump [--jobs 4]
$R prereqs         $A
$R migrate         $A
$R census          $A
$R hidden-gold     $A [--window-days 365] [--top 200]
$R destroy         $A
$R report          $A --title "Production-copy rehearsal 2026-10-31"
```

Each step runs the guard first, writes `$OUT/<step>.json`, appends `$OUT/<step>.log`, and exits 0 (pass), 4 (stopped by a
condition in §5), 3 (refused by the guard) or 1 (failed). The order is enforced: `restore` needs a passed
`validate-backup`, `prereqs` a passed `restore`, `migrate` a passed `prereqs`, `census` and `hidden-gold` a passed
`migrate`; `guard`, `destroy` and `report` need nothing. Re-running is safe:

| Step | On re-run |
|---|---|
| `validate-backup`, `prereqs`, `census`, `report` | re-reads and rewrites its evidence (read-only) |
| `restore` | no-op when this backup (same sha256) is already restored; `--replace` drops and re-creates the copy and supersedes the later steps' evidence |
| `migrate` | no-op once passed; if a run stopped part-way the copy is in an intermediate state and `migrate` refuses — `restore --replace`, `prereqs`, `migrate` |
| `hidden-gold` | resumes from its checkpoint (`hidden-gold.state.json`, rows fsync'd before the checkpoint advances; already-analysed threads are skipped); `--fresh` starts over; other parameters refuse to resume |

## 5. What each step proves, and when it stops

| Step | Proves | Stops (nothing later runs) when |
|---|---|---|
| `guard` | the target is a loopback / unix-socket server without Supabase roles, and the database is `lc_prodcopy_<tag>` | any refusal in §3 |
| `validate-backup` | the file's sha256 (compare with the owner's), its format, the archive header (pg_dump and server versions) and TOC counts by type and schema; whether the key tables carry data. Never row data | unsupported format; `pg_restore --list` fails (version); plain SQL with meta-commands, `CREATE/ALTER/DROP DATABASE / ROLE`, `ALTER SYSTEM` or `COPY … PROGRAM` |
| `restore` | the copy exists: `pg_restore --no-owner --no-privileges` (platform schemas excluded), then the archive's GRANT / REVOKE entries alone (`--no-acl-pass` skips this), so privilege self-checks are judged on production's ACLs; duration; errors by class (never statement text or data); exact row counts of 25 key tables; database size. Roles the archive's grants and policies name are created NOLOGIN NOINHERIT on the local server when missing (never a `supabase*` / `pg_*` role); `auth.uid()` / `role()` / `jwt()` stubs replace the excluded `auth` schema | the database exists without a passed restore of this backup (use `--replace`); the backup changed since `validate-backup`; any table failed to load its rows (`COPY failed`) |
| `prereqs` | the **verbatim** §1 query of `docs/AGENT-MESSAGES-MIGRATION-PLAN.md` (its sha256 recorded), plus a guarded evaluation of the same checks that cannot error; reader 1.0 (required by #30's pretest); the three switches | `ledger`, `link_26`, `link_27`, `link_28`, `link_28_send_authority`, `gateway_self_check` or `relations` false; `link_29`, `link_31`, `link_31_check` or #30 already applied (the five-link plan does not fit: owner decision); reader 1.0 absent; a switch not OFF |
| `migrate` | for each link: SHA-256 equal to `docs/AGENT-TEXTS-DIFF-AUDIT.md`; fixtures lint clean; pretest leaves schema and row counts untouched; apply timed; every CHECK the apply (re)creates on an existing table is timed again as a read-only scan (rows, bytes, ms — the re-validation cost); posttest timed and leaves no trace. After #31 the verbatim §1 query must be all true (the plan's precondition for A and B). After all five: V-A, V-B, V-OFF of the plan §3 and the switches. Then every rollback in reverse with its rollback posttest; the schema fingerprint (run-migration-test's) equals the pre-apply one and row counts match; re-apply of all five with pretests and posttests; the re-applied fingerprint equals the first apply; V-A / V-B / V-OFF and switches again | any of those checks fails. **#30's posttest is advisory** (recorded, not a stop): it creates schema `action_gateway` inside its transaction (impossible wherever #26 is applied) and asserts the runner's synthetic seeds; `--strict-posttests` makes it a stop |
| `census` | `lc_mcp_corpus_census(null)` plus aggregate counts: leads, unique contacts (distinct numbers, never listed), properties, SMS threads and messages, unanswered seller messages (verified on the message log), interest, asking prices / counteroffers, callbacks, stalled negotiations, warm / hot, missing next actions, duplicates / conflicts, suppression, eligibility (eligible / blocked / **UNKNOWN** apart), market and ZIP concentration (ZIP groups under `--min-cell` 5 are folded). Every definition is written next to its number | the reader links cannot be applied inside the copy; the read-only proof fails; an output carries a phone- / email- / address-shaped value or a forbidden key |
| `hidden-gold` | the reader worklist (`recent_inbound`, ≤ 365 days, keyset-paged) ranked by the existing `lc_opportunity_rank_v1` (`mcp/leadcommand-mcp/src/adapters/conversations.mjs`, reused, not copied); opted-out / possible opt-out / not-owner / declined threads excluded and counted; each ranked thread: thread id, property id, category, score, factor names and points, evidence **message ids**, eligibility verdict, next step for a human | as `census`; or a record claims contact for a verdict other than eligible |
| `destroy` | the copy is dropped (`drop database … with (force)`) | it still exists |
| `report` | `report.md`: every step's status and key numbers | an output fails the privacy check |

**Read-only.** Every `census` and `hidden-gold` query runs in a session started with
`PGOPTIONS=-c default_transaction_read_only=on` and `SET default_transaction_read_only = on`; each step records a write
probe refused with SQLSTATE 25006. The only writes after `migrate` are the census's reader links, applied **inside the
copy** only if absent, in a separate session (below).

**The reader-order finding.** Reader 1.1 (`lc_mcp_conversation_intel`) and 1.2 (`lc_mcp_corpus_census`) refuse to apply
once #30 is applied: their apply self-check lists #30's five functions as unexpected reachable definers. The documented
order is 1.0 → 1.1 → 1.2 → #30. If production lacks 1.1 / 1.2 and #30 is applied first, 1.1 / 1.2 cannot follow without
rolling #30 back. On the copy, `census` therefore rolls #30 back (its rollback posttest passes), applies 1.1 and 1.2
(pretest + apply; their posttests assert the runner's seeds and are not run) and re-applies #30 (pretest + apply). The
owner should decide the production order before applying #30.

**Eligibility rule (fails closed).** A thread is **eligible** only when the reader's own eligibility read
(`lc_mcp_thread_contact_eligibility`, link #30) says `eligible_for_outreach` with no blocking reason **and** every input
that read can lack is present: the hold registry, a contact/property resolution with `confirmed_owner`, a phone row with
a known line type and activity, a recorded contactability status; and the worklist's own reading of the seller's words
raises nothing. Any blocker → **blocked**. Anything missing → **unknown**. `contactable = (verdict == eligible)`;
unknown is never contactable, in the census, in the ranking or in the report (asserted in code and in the tests). An
eligible verdict is a read of the send-time guard's inputs, never an authorization to send.

## 6. Evidence, and destroying the copy

- Evidence stays in `$OUT` (mode 0700, files 0600), outside the repository. It holds counts, hashes, timings, catalog
  names, and — from `hidden-gold` — opaque production ids (thread / property / message ids). No names, phone numbers,
  addresses or message text: every JSON and the report pass a privacy check before they are written.
- `hidden-gold --include-text` is **owner-only** (A5): it writes `hidden-gold.owner-only.jsonl` (seller words and factor
  evidence, mode 0600) next to the evidence. It is never part of `report.md`, never committed, never shared, and is
  deleted with the copy. Agents never run it.
- `destroy` drops the database. Then the operator deletes, in this order: the owner-only file (if any), the backup
  file (`shred -u` where the filesystem allows it), and — if the cluster was created for the rehearsal — the cluster:
  `pg_ctl -D /secure/lc-prodcopy/data stop` and `rm -rf /secure/lc-prodcopy/data`. Record the time in the evidence log.
- Retention of `$OUT` itself follows A6 / A7.

## 7. What stays forbidden, whatever the rehearsal shows

- No connection, query or write to production, its backups, buckets or APIs by an agent; the backup is produced and
  delivered by the owner (§2).
- No message is sent, queued, drafted or scheduled; nothing here talks to a carrier, a provider or a model.
- No switch (`ai_agent_text_enabled`, `ai_agent_message_enabled`, `ai_conversation_send_enabled`, …) and no grant is
  changed, on production or on the copy; `migrate` stops if one is ON.
- Unknown eligibility never grants contact. An eligible verdict is not permission to contact: the send path's own guard
  decides at dispatch, after the owner's activation decisions.
- No production evidence enters a repository, a chat or a shared drive without A7.
- A passed rehearsal is not an approval: applying any link to production remains the owner's decision, through the
  deployment sequence of `docs/AGENT-TEXTS-CHANGE-RISK-REPORT.md`.

## 8. The synthetic proof (2026-10-30)

`docs/prod-copy-rehearsal/synthetic-2026-10-30/` holds every step's evidence for a synthetic dump, run on the local
disposable PostgreSQL 17 (`127.0.0.1:54341`). The source database was built by `scripts/db/prod-copy-synthetic-build.mjs`:
the repository's release chain (manifest entry `rc_8_5_21_release_chain`: its baselines and every chain migration up to
#28, i.e. production's expected state before #29), link #32's campaign baseline, and
`scripts/db/fixtures/prod_copy_synthetic_corpus.sql` (twelve invented leads, nine invented threads with known answers;
reserved 555-01xx numbers). It was dumped with `pg_dump -Fc` and the source database was dropped; the dump file itself is
not committed (its sha256 and build steps are in `synthetic-build.json`; a rebuild has a different hash because the rows
carry build-time timestamps). Reproduce:

```sh
node scripts/db/prod-copy-synthetic-build.mjs --admin-url postgres://postgres@127.0.0.1:54341/postgres \
  --db lc_prodcopy_synth_src_<tag> --dump /tmp/synthetic.dump --pg-bin /usr/lib/postgresql/17/bin
# then §4 with --db lc_prodcopy_synth_<tag> --file /tmp/synthetic.dump
```

What the synthetic proof does **not** show: production's volume (every table has a handful of rows, so the CHECK
re-validation timings are a floor, not an estimate), production's extensions and platform roles (the restore's error
classes on a real Supabase dump will include unavailable extensions and missing platform roles), or whether production
actually carries #26–#28, the ledger and reader 1.0 (the §1 query on the copy answers that).
