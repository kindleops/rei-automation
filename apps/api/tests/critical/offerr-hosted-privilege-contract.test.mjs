/**
 * Offerr hosted privilege contract — regression guard for the two privilege
 * mechanisms that hosted Supabase applies and a bare PostgreSQL container does
 * not.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * The Offerr migration originally contained only:
 *
 *   REVOKE ALL ON FUNCTION public.offerr_touch_updated_at() FROM PUBLIC;
 *
 * That is sufficient on stock PostgreSQL, where the only EXECUTE grant on a new
 * function is the implicit one to PUBLIC. It is NOT sufficient on hosted
 * Supabase, which additionally seeds
 *
 *   ALTER DEFAULT PRIVILEGES IN SCHEMA public
 *     GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
 *
 * Those materialise as EXPLICIT per-role grants, and revoking from PUBLIC does
 * not remove an explicit role grant. On the hosted preview branch the resulting
 * ACL was {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,
 * service_role=X/postgres} — anon and authenticated held EXECUTE on an internal
 * Offerr routine while every catalog check about *tables* passed.
 *
 * Requires OFFERR_VERIFY_DATABASE_URL pointing at a disposable database that
 * has had offerr-supabase-prereqs.sql (or hosted Supabase's own defaults), the
 * staging bootstrap, and the Offerr migration applied. Skips without it, the
 * same way the other database-backed Offerr contract suites do.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import pg from 'pg';

const DATABASE_URL = process.env.OFFERR_VERIFY_DATABASE_URL || '';
const SKIP = !DATABASE_URL;

test(
  'Offerr hosted privilege contract',
  { skip: SKIP ? 'OFFERR_VERIFY_DATABASE_URL not set' : false },
  async (t) => {
    const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    t.after(() => pool.end());

    await t.test('no offerr_* routine is executable by anon or authenticated', async () => {
      const { rows } = await pool.query(`
        SELECT p.proname,
               has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_exec,
               has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed_exec,
               coalesce(p.proacl::text, '(default)') AS acl
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE '%offerr%'
      `);

      assert.ok(rows.length > 0, 'expected at least one offerr_* routine to exist');

      const leaking = rows.filter((r) => r.anon_exec || r.authed_exec);
      assert.deepEqual(
        leaking.map((r) => `${r.proname} ${r.acl}`),
        [],
        'anon/authenticated must hold no EXECUTE on any offerr_* routine. '
          + 'REVOKE ... FROM PUBLIC alone does not remove the explicit per-role '
          + 'grants that Supabase ALTER DEFAULT PRIVILEGES creates.',
      );
    });

    await t.test('the updated_at trigger function is owner-only', async () => {
      const { rows } = await pool.query(`
        SELECT coalesce(p.proacl::text, '(default)') AS acl
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'offerr_touch_updated_at'
      `);
      assert.equal(rows.length, 1, 'offerr_touch_updated_at must exist exactly once');

      const acl = rows[0].acl;
      // A non-default ACL that names no API role is what "owner-only" looks
      // like. '(default)' would mean the PUBLIC grant was never revoked at all.
      assert.notEqual(acl, '(default)', 'implicit PUBLIC EXECUTE grant was never revoked');
      for (const role of ['anon', 'authenticated', 'service_role']) {
        assert.ok(
          !acl.includes(`${role}=`),
          `${role} must not appear in the trigger function ACL, got ${acl}`,
        );
      }
    });

    // ── Table grants: catalog functions, never information_schema ──────────
    //
    // information_schema.role_table_grants only reports grants involving roles
    // that are CURRENTLY ENABLED for the session. A verifier connected as a
    // superuser or as the schema owner is typically not a member of anon or
    // authenticated, so the view returns zero rows whether or not those grants
    // exist — an "is empty" assertion over it can pass vacuously and prove
    // nothing. has_table_privilege() and aclexplode() read the catalog directly
    // and are membership-independent, which is why the production proof in
    // docs/offerr/offerr-staging-verification-report.md §14.4 uses them.

    await t.test('anon and authenticated hold zero privileges on offerr_* tables', async () => {
      const { rows } = await pool.query(`
        SELECT c.relname AS table_name, r.rolname AS grantee, p.privilege_type
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN (VALUES ('anon'), ('authenticated')) AS roles(rolname)
        JOIN pg_roles r ON r.rolname = roles.rolname
        CROSS JOIN unnest(ARRAY[
          'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'
        ]) AS p(privilege_type)
        WHERE n.nspname = 'public'
          AND c.relname LIKE 'offerr%'
          AND c.relkind = 'r'
          AND has_table_privilege(r.rolname, c.oid, p.privilege_type)
      `);
      assert.deepEqual(
        rows.map((r) => `${r.grantee}:${r.privilege_type} on ${r.table_name}`),
        [],
        'anon/authenticated must hold no privilege on any offerr_* table',
      );
    });

    await t.test('PUBLIC appears in no offerr_* table ACL', async () => {
      // aclexplode() renders grantee OID 0 as PUBLIC. A PUBLIC grant would be
      // invisible to a per-role has_table_privilege sweep of named roles.
      const { rows } = await pool.query(`
        SELECT c.relname AS table_name, a.privilege_type
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(c.relacl) AS a
        WHERE n.nspname = 'public'
          AND c.relname LIKE 'offerr%'
          AND c.relkind = 'r'
          AND a.grantee = 0
      `);
      assert.deepEqual(
        rows.map((r) => `PUBLIC:${r.privilege_type} on ${r.table_name}`),
        [],
      );
    });

    await t.test('evaluations and events remain append-only for service_role', async () => {
      const { rows } = await pool.query(`
        SELECT c.relname AS table_name, p.privilege_type
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN unnest(ARRAY['UPDATE','DELETE','TRUNCATE']) AS p(privilege_type)
        WHERE n.nspname = 'public'
          AND c.relname IN ('offerr_evaluations', 'offerr_evaluation_events')
          AND has_table_privilege('service_role', c.oid, p.privilege_type)
      `);
      assert.deepEqual(
        rows.map((r) => `${r.privilege_type} on ${r.table_name}`),
        [],
        'service_role must not be able to mutate a persisted evaluation or event',
      );
    });

    await t.test('service_role retains the append path it needs', async () => {
      // The negative assertions above would also pass if service_role had lost
      // every grant, which would break the spine silently. Pin the positive.
      const { rows } = await pool.query(`
        SELECT c.relname AS table_name, p.privilege_type
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN unnest(ARRAY['SELECT','INSERT']) AS p(privilege_type)
        WHERE n.nspname = 'public'
          AND c.relname LIKE 'offerr%'
          AND c.relkind = 'r'
          AND has_table_privilege('service_role', c.oid, p.privilege_type)
      `);
      // 3 Offerr tables x {SELECT, INSERT}
      assert.equal(rows.length, 6, `expected 6 service_role read/append grants, got ${rows.length}`);
    });
  },
);
