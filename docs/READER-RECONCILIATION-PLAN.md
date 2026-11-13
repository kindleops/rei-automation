# Reader links 1–5: reconciling production before any apply

**Status: plan and tooling, tested on disposable PostgreSQL 17 only. Nothing has been applied to production.** It answers the owner's finding of 2026-10-30 and the owner's conditions: no dropped role, no bypassed guard, no blind re-run, no existing production grant altered to force an apply, existing integrations preserved. The read-only reader activation stays authorized once the preconditions, backup readiness and security verification pass. Links 6–9, live SMS and seller contact are not part of this.

## 1. The finding, and what this repository knows

An independent read-only inspection of the production project `real-estate-automation` found:

| Object | Production |
|---|---|
| PostgreSQL | 17.6 |
| Role `lc_mcp_reader` | **exists**: NOLOGIN, no superuser, no BYPASSRLS, granted to `authenticator` |
| `lc_mcp_reader_self_check` | **exists** |
| The worklist, conversation, census, lead-screen and contact-eligibility reads (links 2–5) | absent under their reviewed signatures |
| `supabase_migrations.schema_migrations` rows for the reader links | none |

**This repository has no record of any production apply of the reader.** Its docs say "not deployed", and the recorded production history (`rc-8.5.21-migration-chain.md`) lists two unrelated migrations. So the objects above came from outside this migration path: a manual or tool-driven apply of some version of link 1, or a partial one.

Link 1 has had **six committed versions** (`4de6c6b3` 2026-10-16 to `53a09f86` 2026-10-23, the reviewed one), and `lc_mcp_reader_self_check` has **four distinct definitions** among them. Which one production holds dates and identifies what was applied.

## 2. The reconciliation (read-only), then a verdict per link

**Step 1: the inventory.** Run `scripts/db/reader-reconcile.sql` against production in a **read-only** session, for example the owner's read-only Supabase SQL integration or `psql` with `PGOPTIONS='-c default_transaction_read_only=on'`. It returns one JSON value containing **catalog metadata only**:
- the role's attributes, memberships and settings;
- for every function the five links create or grant: signature, a hash of its definition, SECURITY DEFINER, volatility, owner, ACL;
- `lc_mcp_reader`'s table privileges and policies;
- objects it owns;
- the migration-history rows naming the reader.

No table row, no secret. Save it as a `.json` file. It is safe to share.

**Step 2: the comparison.** `node scripts/db/reader-reconcile.mjs <inventory.json>` compares it with three inventories of disposable databases where the reviewed files were applied (after link 1, after links 1–4, after links 1–5: `scripts/db/reader-reconcile-expected/`). It also compares with the definition hashes of every historical version of link 1 (`link1-history.json`, produced by `reader-reconcile-history.py`).

For each object it reports one of:
- `identical`;
- `absent`;
- `partial`;
- `divergent`, naming the commit whose definition production holds, when it matches one.

It then gives one verdict per link and, for link 1, **exactly what applying the reviewed file would change on the objects that already exist**. It also prints an **inventory fingerprint** that identifies this exact production state.

**Proof of method.** The history hashing reproduces the reviewed `lc_mcp_reader_self_check` hash exactly (`3101fd82` = commit `53a09f86`). The comparator classifies the three reviewed states correctly:
- after link 1: links 2–5 outstanding;
- after links 1–4: only link 5 outstanding;
- after links 1–5: nothing outstanding.

## 3. The decision table

| Reconciliation verdict | What happens |
|---|---|
| **Link 1 identical** (role, settings, membership, the nine functions with their ACLs, grants and policies all as reviewed) | Link 1 is **not re-applied**. Only the links reported `absent` are applied, in order. This needs no further approval: it is the authorized activation. |
| Links 2–5 each `identical` or `absent`, in order | Identical ones are skipped; absent ones are applied. An identical link after an absent one is out of order and **stops**. |
| **Link 1 partial or divergent**, with every existing object either absent or an earlier reviewed version, and the role's attributes and memberships as reviewed | **Stops for the owner's review.** The report lists every effect of completing link 1. If the owner accepts them, the owner approves **that exact inventory** by setting `LINK1_COMPLETION_APPROVED=<fingerprint>`. A changed production state no longer matches, so the approval cannot be reused. |
| Any definition matching **no** reviewed version; a role with LOGIN, BYPASSRLS, extra members or a non-SELECT grant; an object owned by the role; CREATE on `public` | **Stops. Nothing is applied.** The object's origin is investigated first. Any change to it is a separate owner decision. |
| Link 2, 3, 4 or 5 partial or divergent | **Stops.** Same as above. |

## 4. What completing link 1 does, and never does

Link 1 is written to tolerate an existing unprivileged role. It refuses a privileged one (LOGIN, INHERIT, superuser, CREATEDB, CREATEROLE, REPLICATION, BYPASSRLS).

**On objects that already exist, it:**
- replaces its own nine functions (`CREATE OR REPLACE`). For an earlier version of `lc_mcp_reader_self_check`, that is an upgrade to the reviewed definition;
- sets the role's `statement_timeout = 5s` and `search_path = public` (only those two settings);
- grants the role to `authenticator` (a no-op if already granted);
- **revokes EXECUTE on its own nine functions** from PUBLIC, `anon`, `authenticated` and `service_role`, leaving them to `lc_mcp_reader`. If production's self-check is executable by others today, this narrows it, and the report says so. **Confirm nothing calls it as those roles.** It is privilege introspection, used only by the reader.

**It creates:**
- the missing functions;
- SELECT grants and `lc_mcp_reader_select` policies (FOR SELECT, `USING (true)`, for `lc_mcp_reader` only) on the reader's inventory tables that exist.

**It never:**
- drops or alters the role's attributes;
- revokes a membership, a setting it does not own, or any grant on another object;
- writes, updates or deletes a row.

**Existing integrations.** Because the role is already granted to `authenticator`, a token carrying `role: lc_mcp_reader` may already be in use somewhere. Completing link 1 only **adds** reads for it. The one narrowing is the self-check ACL above, and the one behavioural change is the 5 s statement timeout. Both are listed for review.

## 5. Running it

The same script as before, `scripts/db/reader-activation.sh`, now reconciles first. It is run on the operator machine, where `PROD_ADMIN_URL` is set by the owner and never printed:

```bash
MODE=preflight scripts/db/reader-activation.sh          # read-only: reconciliation.md, the verdicts, the fingerprint
# review reconciliation.md; then, if link 1 is identical:
MODE=apply BACKUP_CONFIRMED="<PITR time>" scripts/db/reader-activation.sh
# or, if link 1 is partial/divergent and the owner accepts the listed effects:
MODE=apply BACKUP_CONFIRMED="<PITR time>" LINK1_COMPLETION_APPROVED=<fingerprint> scripts/db/reader-activation.sh
```

**After the apply, it checks:**
- the §7 validation;
- no non-SELECT grant;
- a DELETE as `lc_mcp_reader` is refused;
- one all-history page as the reader;
- every counted row count is unchanged;
- no other role changed;
- **a second reconciliation**: every link must now be `identical` to the reviewed files.

**Tested on disposable PostgreSQL 17** with the production-shaped emulations:

| State | Result |
|---|---|
| The reported production state (role + self-check with default ACL) | `divergent` (the ACL), and the run stops |
| A wrong approval fingerprint | Refused |
| The exact approval | Link 1 completed and links 2–5 applied; all validations `true`; the write refused; counts unchanged; post-apply reconciliation `identical` for all five |
| Links 1–4 present | Only link 5 applied |
| All five present | Nothing applied |

**Migration history.** Applying the files with `psql` records nothing in `supabase_migrations.schema_migrations`. Recording them there afterwards (for example `supabase migration repair`) is a separate owner decision. It is not needed for the reader to work.

## 6. What the owner does next

1. Run `scripts/db/reader-reconcile.sql` read-only against production and share the JSON. It is metadata only and contains no secrets.
2. Read the comparator's report: the verdict per link, the version of each existing object, and the effects of completing link 1.
3. Then either:
   - run the activation with the backup confirmed (link 1 identical); or
   - approve the listed effects with the printed fingerprint; or
   - stop if anything is unexplained.

## 7. The production inventory of 2026-10-30, and the one membership difference

**The owner's run of `reader-reconcile.sql` (v1) against production found:**
- **Link 1:** divergent for one reason only.
  - All nine function signatures, definition hashes (the self-check is commit `53a09f86`, the reviewed one), configurations and ACLs match.
  - The two existing reads carry the reader's EXECUTE.
  - All 18 SELECT grants and the reader policies match.
  - The role's attributes and settings match.
- **Links 2–5:** absent.
- **Migration history:** no reader rows.

**The difference.** `lc_mcp_reader` has two members in production, where the first reference had one:

| Member | Grantor | ADMIN | INHERIT | SET |
|---|---|---|---|---|
| `authenticator` | `postgres` | false | false | true |
| `postgres` | `supabase_admin` | true | false | false |

**Investigation: this is PostgreSQL 16+'s automatic creator self-grant, not a manual grant.**
- When a role with CREATEROLE that is **not** a superuser runs `CREATE ROLE`, PostgreSQL 16+ grants the new role to its creator. That grant:
  - has ADMIN OPTION;
  - is recorded as granted by the **bootstrap superuser** (OID 10);
  - carries INHERIT and SET only if `createrole_self_grant` asks for them (empty by default).
- On Supabase, `postgres` is such a role and `supabase_admin` is the bootstrap superuser. Link 1 run as `postgres` therefore produces exactly the membership above.
- The first reference inventories had been built as a real superuser, which receives no such grant. That is the only reason they differed.

**Reproduced exactly on disposable PostgreSQL 17:**
- `initdb -U supabase_admin`, then `postgres` created NOSUPERUSER CREATEROLE.
- `CREATE ROLE` run as `postgres` gives the same two rows: same grantors, same options.
- The whole of link 1, run as `postgres` on a Supabase-shaped database, gives them too.
- The reference inventories in `reader-reconcile-expected/` are now built that way: Supabase platform roles by `supabase_admin`, every link by `postgres`. Their functions, ACLs, grants and policies are identical to the earlier references.

**Why it is safe:**
- The grant runs from `postgres` **to** the reader, not the reverse. `lc_mcp_reader` is a member of nothing and gains no privilege.
- Without INHERIT, `postgres` does not inherit the reader's privileges. Without SET, it cannot `SET ROLE lc_mcp_reader`.
- ADMIN lets `postgres` grant or revoke membership in the reader role. `postgres` could already do that as a CREATEROLE role. It is also the owner of the tables and functions concerned, so this adds no data access.
- Revoking it is unnecessary. It would also break Supabase's own expectation that `postgres` administers the roles it creates. It is kept.

**How the comparator recognizes it: pinned, not waived.** `reader-reconcile.mjs` now checks the memberships against an exact pinned set (inventory v2 records each membership's grantor and options):
- `authenticator`: granted by `postgres`, ADMIN false, INHERIT false, SET true;
- `postgres`: granted by the inventory's own bootstrap superuser, ADMIN true, INHERIT false, SET false, and only while `createrole_self_grant` is empty.

Any other member, option or grantor is `divergent`. A v1 inventory, which cannot show options, is `divergent` whenever a member other than `authenticator` appears. Tested:
- **Identical:** the production shape.
- **Divergent:** SET on the self-grant; INHERIT on it; another grantor; ADMIN on `authenticator`; an extra member; a non-empty `createrole_self_grant`; a v1 inventory listing `postgres`.

**A defect this found, now fixed.** The activation's post-apply checks used `SET ROLE lc_mcp_reader`. In production `postgres` holds the role without SET, so that would have failed, and the write probe would have mistaken the failure for a refused write.

They now use privilege introspection only:
- no INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER on any `public` relation, directly or through PUBLIC;
- no CREATE on `public`;
- the reader's own `lc_mcp_reader_self_check` with link 4's full inventory.

Nothing is granted to make them work. The reader's real reads are proven in Phase 2, through PostgREST with its own token.

**Two further changes for production:**
- A full `pg_dump` is optional, because `postgres` may lack SELECT on some `public` tables. The schema record is a catalog snapshot (every function with its definition hash and ACL, every relation with its ACL and RLS flag, every policy). After the apply, it must differ **only** by the applied links' own functions.
- **Replica rehearsal, run as `postgres`, of the production state** (link 1 present with both memberships, links 2–5 absent):
  - reconciliation: link 1 identical, links 2–5 absent;
  - links 2–5 applied, link 1 not touched;
  - validation all true, and the self-check passes (20 relations, 20 functions) with no write privilege anywhere;
  - row counts unchanged; the catalog shows only the applied functions;
  - post-apply reconciliation identical for all five;
  - a second run applies nothing.

**Next: revalidating production.** The owner's run used inventory v1, which records no membership grantor or options.
1. Run `reader-reconcile.sql` (v2) once more, read-only, and share the JSON; the comparator confirms the pinned membership.
2. Then the activation, which re-reads the v2 inventory itself in its read-only preflight, applies links 2–5 only with the backup confirmed.
