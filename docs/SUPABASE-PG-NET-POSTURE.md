# Supabase pg_net posture: the pinned platform exception of the role self-checks

Status: PROPOSED (branch `fix/gateway-platform-egress`). Nothing here is applied to production. Each migration
still needs its own owner authorization. The Supabase support request asking them to confirm this posture is
**still pending**.

## 1. The blocker

Two migrations create least-privilege PostgREST roles and refuse to apply unless the role's privilege self-check is
clean:

| link | migration | role | self-check |
|---|---|---|---|
| #25 | `PROPOSED_20261019150000_lc_mcp_reader.sql` | `lc_mcp_reader` (read-only MCP) | `public.lc_mcp_reader_self_check(text[], text[], name)` |
| #26 | `PROPOSED_20261019160000_action_gateway.sql` (+ #27 `_t2`, which redefines it) | `lc_action_gateway` (Action MCP) | `action_gateway.self_check(name)` |

Both checks treat any network-egress function the role can reach as a finding, and also any write or sequence
privilege it holds. On production, PUBLIC holds USAGE on schema `net`, EXECUTE on `net.http_*`, and ALL on
`net.http_request_queue` / `net._http_response` (role audit 2026-10-16, pg_net 0.20.0). Both applies therefore
refused, and so did both MCP servers' boot checks.

## 2. What Supabase says

Source: Supabase troubleshooting, "Revoking access to pg_net objects has no effect":
<https://supabase.com/docs/guides/troubleshooting/revoking-access-to-pg_net-objects-has-no-effect-0bbc16>

- pg_net is created by `supabase_admin`, which owns schema `net` and its objects. `postgres` cannot revoke them, and
  Supabase does not support changing these grants per project.
- Removing the PUBLIC table grants breaks pg_net and pg_cron.
- The default ACLs:
  - PUBLIC has USAGE on `net`, all privileges on the net tables and sequences, and (on most projects) EXECUTE on
    `net.http_*`;
  - USAGE on `net` is also granted to `postgres`, `anon`, `authenticated` and `service_role`.
- Supabase's own position is that `anon`, `authenticated` and `service_role` "can't use pg_net by default", because
  they cannot connect directly and the Data API does not expose `net`. Its mitigations are:
  - allow login only for trusted roles;
  - keep `net` out of the exposed schemas.
- The exposed schemas are the `pgrst.db_schemas` role setting of `authenticator` when it is set, and the dashboard
  configuration otherwise. PostgREST answers PGRST106 when Accept-Profile names a schema that is not exposed.
- pg_graphql reflects the schemas on the role's `search_path`.

## 3. Threat model

The concern is rows leaving the database: an MCP credential calling `net.http_post` (directly or through a wrapper),
or inserting into `net.http_request_queue`.

- The LC roles are NOLOGIN. They are reached only by PostgREST switching to them from a JWT the owner mints. So
  their only path to `net` is the Data API (REST or GraphQL), or a function they can execute that calls `net.*`.
- PUBLIC grants reach the role. Grants to `anon` / `authenticated` / `service_role` / `postgres` /
  `supabase_functions_admin` reach it only through role membership, which control (a) forbids.
- If `net` is not exposed, REST cannot address it (PGRST106).
- If `net` is not on the role's `search_path`, pg_graphql does not reflect it.
- If no function the role can execute wraps egress, there is no indirect path. That rule (e) stays exactly as strict
  as before, and is now **transitive**: §4a closes the gap where a wrapper reaches `net` only through another
  function, through dynamic SQL (`EXECUTE`), through a trigger / Database Webhook on a table the role can write,
  through an event trigger, through `cron`, or through an owner-rights view.

The exception therefore depends on two things. First, exactly Supabase's platform objects, and nothing else in
`net`. Second, every one of those path closures holding and being checked.

## 4. The exception (fingerprint `supabase_pg_net_default_acl.v1`)

The exception is one block of plpgsql:

- `action_gateway.platform_egress_exceptions(oid)` in #26;
- the same block inlined in `lc_mcp_reader_self_check` in #25, because #25 creates no helper schema.

`scripts/db/sync-platform-exception-block.mjs` verifies the two copies are byte-identical (`--write` copies it), and
the posture test pins that. All three copies of `action_gateway.self_check` (#26, #27, and #27's rollback restore)
call it.

The exception **applies** only when ALL of the following hold:

1. Extension `pg_net` exists and is owned by `supabase_admin`. Schema `net` is owned by `supabase_admin`.
2. **Every** object in `net` is owned by `supabase_admin` **and** is a member of extension `pg_net` (`pg_depend`
   deptype `'e'`). "Every object" covers:
   - relations, functions and types;
   - operators, collations and conversions;
   - operator classes and families;
   - text search configurations and dictionaries;
   - extended statistics.
3. Every ACL entry meets all three conditions:
   - it comes from grantor `supabase_admin`;
   - it carries no grant option;
   - its `kind|object|grantee|privilege` is in the pinned fingerprint.

   This covers the schema, relations, columns, functions and types. A NULL ACL is evaluated as PostgreSQL's
   `acldefault`. The owner's own rights are ignored. Column-level grants are never in the fingerprint.

The fingerprint is a reviewed constant in the SQL (`-- lc-platform-exception:fingerprint`). Any change to it means a
new version, which the JS pin (`PG_NET_FINGERPRINT_VERSION`) must match.

| kind | object | grantees | privileges | source |
|---|---|---|---|---|
| schema | `net` | PUBLIC, postgres, anon, authenticated, service_role, supabase_functions_admin | USAGE | Supabase doc; the platform's pg_net access grant (`supabase_functions_admin`) |
| table | `net.http_request_queue`, `net._http_response` | PUBLIC | SELECT INSERT UPDATE DELETE TRUNCATE REFERENCES TRIGGER MAINTAIN | Supabase doc |
| sequence | `net.http_request_queue_id_seq` | PUBLIC | USAGE SELECT UPDATE | Supabase doc |
| function | `net.http_get`, `net.http_post`, `net.http_delete` | PUBLIC; postgres, anon, authenticated, service_role, supabase_functions_admin | EXECUTE | Supabase doc; the platform's pg_net access grant |
| function | `net._await_response`, `_urlencode_string`, `_encode_url_with_params_array`, `_http_collect_response`, `http_collect_response`, `worker_restart`, `wait_until_running`, `wake`, `check_worker_is_up` | PUBLIC | EXECUTE | PostgreSQL's default function ACL for pg_net's helpers |
| type | `*` | PUBLIC | USAGE | PostgreSQL's default type ACL (USAGE on a type grants no data and no egress) |

When the exception applies, the members of `net` are skipped by the following, and only by these:

- the write loop, the sequence loop and the egress loop of both checks;
- the gateway's select-outside-inventory loop.

The read-only check's informational `select_outside_inventory` still lists the `net` tables.

The **definer rule has no exception**. A SECURITY DEFINER function in `net` that the role can execute is still a
finding.

## 4a. The indirect / transitive egress rule (`public.lc_reachable_egress_indirect`)

The original egress rule grepped each reachable function's **own** `prosrc`. That misses every indirect path: a
wrapper that reaches `net` only through a callee, a raw-SQL `EXECUTE`, a trigger, or `cron`. One shared helper
(`public.lc_reachable_egress_indirect(oid)`, created byte-identically by #25 and #26, synced by
`scripts/db/sync-platform-exception-block.mjs`, and called by **both** self-checks **and** both frozen strict
references) closes it. It walks the `pg_proc` call graph **backwards** from the egress leaves (comment-stripped
`prosrc` name resolution; cost `~|bad| × |procs|`, never `|procs|²`) and emits, for the role, each HARD finding:

| finding | what |
|---|---|
| `indirect_egress_function:<fn>` | a function the role can EXECUTE (incl. an allowlisted SECURITY DEFINER entry point or domain writer, judged by its owner's reach) that **transitively** reaches `net` / `pg_net` / `http` / `dblink` / `postgres_fdw` / an untrusted language / a PUBLIC side-effect (`lo_*`, `pg_notify`, `pg_logical_emit_message`) |
| `dynamic_sql_function:<fn>` | a reachable `sql`/`plpgsql` function whose body runs dynamic SQL (`EXECUTE`) — it can reach `net.*` through PUBLIC's pg_net grants. A finding unless listed in the reviewed `dynamic-sql-allowlist` with a reason (empty today) |
| `egress_trigger:<table>:<trigger> -> <fn>` | a trigger (incl. **Supabase Database Webhooks** `supabase_functions.http_request` and any pg_net-calling trigger) on a table the role can INSERT/UPDATE/DELETE/TRUNCATE whose function reaches egress |
| `event_trigger_egress:<event> -> <fn>` | an event trigger whose function reaches egress |
| `cron_schema_access:<detail>` | any access to schema `cron` (pg_cron): `usage`, a privilege on `cron.job`, or EXECUTE on a `cron.*` function. The role must have **none** |
| `dangerous_role_membership:<role>` | membership in `pg_execute_server_program` / `pg_read_server_files` / `pg_write_server_files` (COPY TO/FROM PROGRAM and server-file egress; `superuser` is caught by `attr_superuser`) |
| `egress_definer_view:<view>` | an owner-rights (`security_invoker=false`) view the role can SELECT whose definition depends on an egress function |

`net`-schema / pg_net-member functions are never roots here (they are the platform's own internals, judged by the
direct rule + the exception). Because the helper is called by the strict reference too, a `not_applied` exception
still reports exactly the same indirect findings — the exception never weakens this rule.

Other paths from the owner directive, and where each is closed: **COPY TO PROGRAM** needs superuser (caught by
`attr_superuser`) or one of the dangerous roles above; **LISTEN/NOTIFY** and **large objects** are leaf side-effect
functions (`pg_notify`, `lo_*`), so a wrapper reaching them is an `indirect_egress_function`; **dblink / postgres_fdw**
are egress leaves by extension membership and name; **untrusted languages** are leaves by `lanpltrusted`;
**`graphql_public.graphql`** and **PostgREST RPC to an exposed schema** resolve to functions — any such function the
role can execute that wraps egress is caught as a reachable / indirect egress function, and `graphql_public` reflection
of `net` is additionally blocked by control (d) (search_path) and the live probe (c).

A reachable PUBLIC raw-SQL helper (the audit's `run_sql`-class function) is the concrete gap this closed: as SECURITY
INVOKER it runs **as the role** and can `EXECUTE` an `INSERT INTO net.http_request_queue` / `net.http_post(...)`,
exfiltrating rows despite the pg_net exception. It is now a `dynamic_sql_function` finding; **PUBLIC EXECUTE on any
such function must be revoked before either credential is safe** (surfaced by the §9a verification before go-live).

When any condition fails, the status is `not_applied` and its `reasons` name the cause. The `net` objects then count
through PUBLIC as before, and the findings are **exactly** those of the pre-exception function. The posture test
asserts this equality against a verbatim frozen copy.

## 5. Compensating controls (every one a hard finding when the exception applies)

| # | control | enforced by | finding |
|---|---|---|---|
| a | The role is NOLOGIN, NOINHERIT, not BYPASSRLS, not SUPERUSER, and a member of no role. | SQL (plus the existing `attr_*` / `member_of` findings) | `platform_exception_control_a:<canlogin\|inherit\|bypassrls\|superuser\|member_of:x>` |
| b | `net`, `extensions` and `cron` are not in `authenticator`'s `pgrst.db_schemas` role setting. Both the all-database setting and the current-database setting are read. | SQL | `platform_exception_control_b:exposed_schema:<s>`; if the setting is absent, the note `exposed_schemas_from_dashboard_unverified_in_sql` is recorded and (c) is the proof |
| c | A live probe at boot, sent AS the credential's own token. PostgREST must answer **PGRST106** to each of: `Accept-Profile: net` (GET, zero rows of the queue), `Content-Profile: net` (POST to a function that cannot exist, so there is no side effect even when `net` is exposed), and `Accept-Profile: extensions` / `cron` (GET). `/graphql/v1` must answer an **unknown-field** error for `http_request_queueCollection`, `_http_responseCollection`, `httpRequestQueueCollection` and `httpResponseCollection`. | both MCP servers (`mcp/leadcommand-mcp/src/data/platform-exposure.mjs`). It is mandatory whenever the exception applies. The read-only server re-runs it on every credential re-check. | `exposure_probe_failed:<check>:HTTP <status> <code>`; the server does not start |
| d | The migration sets `ALTER ROLE … SET search_path = public`, and the check verifies that the role's setting exists and names none of `net` / `extensions` / `cron`. | SQL | `platform_exception_control_d:search_path_includes:<s>` / `…:search_path_unset` |
| e | No function the role can execute outside the exception wraps egress or a side effect. This is the existing body-text rule: `net.http_*`, `http_*`, `dblink*`, `lo_*`, `pg_notify`, `pg_logical_emit_message`, untrusted languages, and members of http / dblink / postgres_fdw. | SQL (unchanged) | `reachable_egress_function(s):…` |
| f | The role has CREATE nowhere. | SQL (existing) | `schema_create:` / `database_create` |

The servers also re-judge the report independently, before any probe
(`evaluatePlatformExceptions`). They accept only a known exception id and only the pinned fingerprint version.
Every control must be reported as holding, and every excepted object must be in `net`. Otherwise:
`platform_exception_*`, and the server does not start.

## 6. The report

Both checks now return `platform_exceptions` next to `findings` (`ok` = no findings). Each entry contains:

- `id`, `fingerprint_version`, `status` (`applied` / `not_applied`) and `reasons`;
- `owner`, `extension` and `extension_version`;
- `objects` and the observed `acl`;
- `controls`, `notes`, `live_exposure_probe_required` and `doc`.

The MCP audit line (`credential_self_check`) records a summary of the exception and the result of each probe check.
Nothing is dropped.

On a database without schema `net` (any disposable or non-Supabase database), `platform_exceptions` is `[]` and
every finding is exactly as before.

## 7. What makes it refuse

Each of these refuses: the apply aborts, or the server does not start.

- Any extra grantee or privilege on `net`, including any grant to an LC role.
- A grantor other than `supabase_admin`, or a grant option.
- A column grant.
- A non-extension object in `net`, even one owned by `supabase_admin`.
- A `net` object, the schema or the extension with another owner.
- A pg_net version whose functions are not in the fingerprint (a new pinned version must be reviewed).
- `net` / `extensions` / `cron` in `pgrst.db_schemas`.
- PostgREST exposing any of them (probe), GraphQL reflecting `net`, or GraphQL answering anything but unknown-field
  (including a permission error, 5xx or a network failure).
- The role's `search_path` unset or naming them.
- The role with LOGIN, INHERIT, BYPASSRLS or SUPERUSER, or any membership.
- A SECURITY DEFINER `net` function the role can execute.
- A public (or any) wrapper calling `net.*` that the role can execute — **directly or transitively** (§4a).
- A reachable `sql`/`plpgsql` function that runs dynamic SQL (`EXECUTE`) and is not allowlisted with a reason.
- A trigger / Supabase Database Webhook / pg_net trigger whose function reaches egress on a table the role can write.
- An event trigger whose function reaches egress.
- Any access to schema `cron`, or membership in `pg_execute_server_program` / `pg_read_server_files` /
  `pg_write_server_files`.
- An owner-rights view the role can SELECT that depends on an egress function.
- CREATE anywhere.

## 8. Proof (disposable PostgreSQL 17 + PostgREST only)

| test | what |
|---|---|
| `apps/api/tests/critical/action-gateway-pg-net-posture-pg.test.mjs` | Both self-checks, with the REAL migrations applied ON TOP of Supabase-shaped pg_net. Covers the default (ok, exception listed) and every refusal case in section 7, run AS the role — including the §4a indirect cases: a transitive `A→B→net` wrapper, a dynamic-SQL wrapper, a pg_net Database-Webhook trigger on a role-writable table, an event trigger reaching `net`, `cron` access, and `pg_read_server_files`, plus the `run_sql` re-grant positive/negative pair. It also covers no-exception-context and no-pg_net, with findings asserted **equal** to the frozen pre-exception functions (`apps/api/tests/pg/pg_net_emulation/strict_reference_*.sql`, which call the same indirect-egress helper). |
| `mcp/leadcommand-action-mcp/test/pg-net-exposure-e2e.test.mjs` | Real PostgREST 16 plus a minimal Supabase-style gateway. When `net` is not exposed, the probe passes and BOTH servers boot. When `PGRST_DB_SCHEMAS` includes `net`, the probe fails, BOTH servers refuse to start, and nothing is enqueued. It also covers GraphQL reflecting `net` (role search_path) → fail, and a GraphQL permission error → fail. |
| `mcp/leadcommand-mcp/test/platform-exposure.test.mjs`, `mcp/leadcommand-action-mcp/test/platform-exposure-boot.test.mjs` | The server-side re-judgement (every tamper case), the probe's answer matrix, the boot wiring, and the absence of any probe when no exception applies. |

Fidelity notes:

- **pg_net** is a shape-only emulation (`apps/api/tests/pg/pg_net_emulation/pg_net.control` and `pg_net--0.20.0.sql`:
  no C module, no worker, no network). It has the real object set and signatures. It is installed by a REAL
  `CREATE EXTENSION pg_net` AS a superuser role named `supabase_admin`, from a cloned PostgreSQL share directory, so
  ownership, extension membership and the ACLs (grantor `supabase_admin`) are genuine catalog state.
- **pg_graphql** is not available locally. `graphql_public.graphql` is emulated: it reflects tables on the calling
  role's search_path that the role can SELECT, and answers pg_graphql's "Unknown field" otherwise. The gateway route
  `/graphql/v1 → /rpc/graphql` (Content-Profile `graphql_public`) is the one Supabase's API gateway uses.
  PostgREST 16 applied the role's `search_path` setting in this test (the reflecting case flips when it names
  `net`).
- The migration-test runner and the MCP local stack refuse any server carrying `supabase_admin`, as a production
  guard. That is why the posture world runs on a cluster of its own.

## 9. Owner production verification (read-only; before authorizing either apply)

Run these with a role-enforced read-only credential only (never one derived from an env file), and never inside a
migration session.

1. **pg_net is exactly the platform shape.** Expect: owner `supabase_admin` everywhere, every object a pg_net member.
   The second query must return no rows.

   ```sql
   select e.extversion, pg_get_userbyid(e.extowner) ext_owner, pg_get_userbyid(n.nspowner) schema_owner
     from pg_extension e cross join pg_namespace n where e.extname = 'pg_net' and n.nspname = 'net';
   select o.kind, o.name, pg_get_userbyid(o.own) owner,
          exists (select 1 from pg_depend d join pg_extension e on e.oid = d.refobjid and e.extname = 'pg_net'
                   where d.classid = o.cls and d.objid = o.oid and d.deptype = 'e') member
     from (select 'pg_namespace'::regclass cls, n.oid, 'schema' kind, n.nspname::text name, n.nspowner own from pg_namespace n where n.nspname = 'net'
           union all select 'pg_class'::regclass, c.oid, 'relation', c.relname::text, c.relowner from pg_class c where c.relnamespace = 'net'::regnamespace and c.relkind in ('r','p','v','m','f','S')
           union all select 'pg_proc'::regclass, p.oid, 'function', p.proname::text, p.proowner from pg_proc p where p.pronamespace = 'net'::regnamespace
           union all select 'pg_type'::regclass, t.oid, 'type', t.typname::text, t.typowner from pg_type t where t.typnamespace = 'net'::regnamespace) o
    where pg_get_userbyid(o.own) <> 'supabase_admin'
       or not exists (select 1 from pg_depend d join pg_extension e on e.oid = d.refobjid and e.extname = 'pg_net'
                       where d.classid = o.cls and d.objid = o.oid and d.deptype = 'e');
   ```

2. **The ACL set, compared with the fingerprint in section 4.** Every row must be in the table. Any other row means
   the exception will not apply: send it for review, which leads to a new fingerprint version.

   ```sql
   select o.kind, o.name, case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end grantee,
          a.privilege_type, pg_get_userbyid(a.grantor) grantor, a.is_grantable
     from (select 'schema' kind, 'net' name, nspowner own, nspacl acl, 'n'::"char" dk from pg_namespace where nspname = 'net'
           union all select case relkind when 'S' then 'sequence' else 'table' end, 'net.' || relname, relowner, relacl, case relkind when 'S' then 's' else 'r' end::"char" from pg_class where relnamespace = 'net'::regnamespace and relkind in ('r','p','v','m','f','S')
           union all select 'function', 'net.' || proname, proowner, proacl, 'f'::"char" from pg_proc where pronamespace = 'net'::regnamespace) o
     cross join lateral aclexplode(coalesce(o.acl, acldefault(o.dk, o.own))) a
    where not (a.grantee = o.own and a.grantor = o.own)
    order by 1, 2, 3, 4;
   select attrelid::regclass, attname, attacl from pg_attribute where attrelid in (select oid from pg_class where relnamespace = 'net'::regnamespace) and attacl is not null;  -- expect no rows
   ```

3. **No SECURITY DEFINER `net` function that PUBLIC can execute.** Expect no rows. The platform's pg_net access grant
   makes `http_get` / `http_post` SECURITY DEFINER and, at the same time, revokes PUBLIC from them. A row here
   refuses the apply.

   ```sql
   select p.oid::regprocedure from pg_proc p where p.pronamespace = 'net'::regnamespace and p.prosecdef
      and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE');
   ```

4. **The exposed schemas.** If no `pgrst.db_schemas` row exists, the dashboard holds the setting. Read it in
   Settings → API → Exposed schemas, and check that it lists none of `net`, `extensions` or `cron`. The boot probe
   proves it either way.

   ```sql
   select setdatabase, c from pg_db_role_setting s cross join lateral unnest(s.setconfig) c
    where s.setrole = 'authenticator'::regrole and c like 'pgrst.%';
   ```

5. **GraphQL reachability for the LC roles.** The probe requires an unknown-field answer, and a permission error
   **refuses**. Supabase grants USAGE on `graphql_public` to `postgres`, `anon`, `authenticated` and `service_role`.
   The LC roles are members of none of them, so check this first:

   ```sql
   select has_schema_privilege('public', 'graphql_public', 'USAGE') public_usage,
          (select array_agg(p.oid::regprocedure) from pg_proc p where p.pronamespace = 'graphql_public'::regnamespace) resolver;
   ```

   If PUBLIC lacks USAGE, the LC roles cannot run the resolver at all, and the probe will refuse the start as
   designed. That needs an owner decision **before** go-live. Either accept "the role cannot run GraphQL" as proof
   (a reviewed change to the probe), or grant the roles USAGE on `graphql_public` and EXECUTE on the resolver (a
   reviewed migration).

6. **The role search_path effect.** With `search_path = public`, a function the role can execute that is not pinned
   and refers to an `extensions` object without a schema qualifier would stop resolving. Expect no rows that matter
   (inspect any that appear):

   ```sql
   select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) s where s like 'search_path=%')
      and p.oid in (to_regprocedure('public.campaign_entity_contact_review_flags(text[])'), to_regprocedure('public.entity_graph_property_records(text)'));
   ```

7. **After an authorized apply:** run the role's own report through the live API, then the live probes by hand.
   Read the tokens from their 0600 credential files. Each of the requests below must answer `"code":"PGRST106"`.

   ```sh
   # REST: each must answer {"code":"PGRST106",...}
   curl -s "$URL/rest/v1/http_request_queue?select=id&limit=0" -H "apikey: $(cat "$ANON_FILE")" -H "Authorization: Bearer $(cat "$TOKEN_FILE")" -H "Accept-Profile: net"
   curl -s -X POST "$URL/rest/v1/rpc/lc_exposure_probe_never_exists" -H "apikey: $(cat "$ANON_FILE")" -H "Authorization: Bearer $(cat "$TOKEN_FILE")" -H "Content-Profile: net" -H "Content-Type: application/json" -d '{}'
   curl -s "$URL/rest/v1/job?select=jobid&limit=0" -H "apikey: $(cat "$ANON_FILE")" -H "Authorization: Bearer $(cat "$TOKEN_FILE")" -H "Accept-Profile: cron"
   # GraphQL: must answer an "Unknown field" error, never data
   curl -s -X POST "$URL/graphql/v1" -H "apikey: $(cat "$ANON_FILE")" -H "Authorization: Bearer $(cat "$TOKEN_FILE")" -H "Content-Type: application/json" -d '{"query":"{ http_request_queueCollection(first: 1) { __typename } }"}'
   ```

   Then start each MCP server as usual. Its boot runs the same probe, and its audit line `credential_self_check`
   must show `outcome: ok`, `platform_exceptions[0].status: applied`, and every `exposure_probe` entry
   `…:refused_as_required`.

### 9a. Indirect / transitive egress (run BEFORE the roles exist)

The §4a surface must be checked **before** `lc_action_gateway` / `lc_mcp_reader` are created, because any path PUBLIC
can reach, a new NOLOGIN NOINHERIT member-of-nothing role inherits. The script
`scripts/db/pg_net_indirect_egress_prod_verify.sql` computes, for the **PUBLIC** pseudo-role, exactly the findings
`public.lc_reachable_egress_indirect(oid)` computes for the role: transitive `indirect_egress_function`,
`dynamic_sql_function`, `egress_trigger` (incl. Supabase Database Webhooks), `event_trigger_egress`,
`cron_schema_access`, and `egress_definer_view`. It is read-only and creates nothing.

```sh
psql "$RO_URL" -f scripts/db/pg_net_indirect_egress_prod_verify.sql   # RO role-enforced credential; never from .env
```

**Expected:** zero rows. Any row is a real indirect path the owner must remediate before go-live:

- `dynamic_sql_function:<fn>` — a PUBLIC-executable raw-SQL helper (e.g. the audit's `public.run_sql`). As SECURITY
  INVOKER it runs as the future role and can `EXECUTE` an insert into `net.http_request_queue` / a `net.http_post`.
  **Revoke PUBLIC EXECUTE** (or drop it).
- `egress_trigger:<table>:<trigger>` — a Database Webhook / pg_net trigger on a PUBLIC-writable table. Remove the
  webhook or the PUBLIC write grant.
- `indirect_egress_function` / `event_trigger_egress` / `egress_definer_view` — revoke the PUBLIC grant or remove the
  wrapper / view / event trigger.
- `cron_schema_access` — PUBLIC must have no access to schema `cron`.

After an authorized apply, re-run the role's own self-check (it calls the same helper for the real role) and the §9
step 7 live probes; the boot audit's `credential_self_check` must be `outcome: ok` with none of these findings.

8. **Pending.** Supabase support has not yet confirmed that this ACL set and the "not exposed ⇒ not usable" posture
   are the supported state for this project. Until they confirm, the exception rests on the public doc above and on
   the read-only verification in steps 1–5.
