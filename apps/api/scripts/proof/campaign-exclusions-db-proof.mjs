#!/usr/bin/env node
// Real-Postgres proof for PROPOSED_20261008120000_campaign_recipient_exclusions.sql
// and the shared rule in src/lib/domain/campaigns/campaign-recipient-exclusions.js.
//
// Runs ONLY against a disposable loopback Postgres (CI service container). Never production.
//   CAMPAIGN_EXCLUSIONS_PROOF_DB_URL=postgres://postgres:postgres@127.0.0.1:5432/proofdb \
//     node apps/api/scripts/proof/campaign-exclusions-db-proof.mjs
//
// Prerequisite (done by the CI workflow): stub `campaigns` table + Supabase roles,
// then the PROPOSED migration applied.
//
// Invariants (genuinely parallel connections):
//   1. N concurrent upserts of one (campaign, phone) in mixed formats -> exactly 1 row, version N, active.
//   2. Every write is audited exactly once (events = writes), audit is append-only.
//   3. Concurrent upsert/deactivate interleave -> final state equals the last committed writer; no lost row.
//   4. Uniqueness is per campaign: the same phone in another campaign is a separate row.
//   5. Normalization: malformed phone / empty actor / empty reason rejected; direct malformed insert violates CHECK.
//   6. Physical delete refused; deactivate keeps history.
//   7. Access control: anon/authenticated cannot read or write; functions not executable by PUBLIC roles.
//   8. Shared rule over the real DB: empty set ok + blocks nobody; active rows load; inactive ignored;
//      lookup failure -> ok:false (never "empty"); retry after recovery -> ok:true.

import pgPkg from "pg";
import { loadCampaignRecipientExclusions, isRecipientExcluded } from "../../src/lib/domain/campaigns/campaign-recipient-exclusions.js";

const { Pool } = pgPkg;
const DB_URL = process.env.CAMPAIGN_EXCLUSIONS_PROOF_DB_URL || "";
if (!DB_URL) { console.error("CAMPAIGN_EXCLUSIONS_PROOF_DB_URL is required (disposable local Postgres)."); process.exit(2); }
{
  let host; try { host = new URL(DB_URL).hostname; } catch { console.error("unparseable URL"); process.exit(2); }
  if (!new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(host)) { console.error(`refusing non-loopback host ${host}`); process.exit(2); }
}
const PARALLEL = Number(process.env.CAMPAIGN_EXCLUSIONS_PROOF_PARALLEL || 24);
const pool = new Pool({ connectionString: DB_URL, max: PARALLEL + 4 });

const failures = [];
function check(name, ok, detail) {
  if (ok) console.log(`PASS ${name}`);
  else { console.error(`FAIL ${name} :: ${JSON.stringify(detail)}`); failures.push(name); }
}
async function expectError(fn) { try { await fn(); return null; } catch (e) { return e; } }

/** Minimal supabase-shaped adapter over pg for the shared rule (select/eq/eq only). */
function pgSupabase(p, { table = "campaign_recipient_exclusions" } = {}) {
  return {
    from(t) {
      const filters = [];
      const chain = {
        select() { return chain; },
        eq(col, val) {
          filters.push([col, val]);
          if (filters.length < 2) return chain;
          const where = filters.map(([c], i) => `${c} = $${i + 1}`).join(" AND ");
          return p.query(`select phone_e164 from public.${t === "campaign_recipient_exclusions" ? table : t} where ${where}`, filters.map(([, v]) => v))
            .then((r) => ({ data: r.rows, error: null }), (e) => ({ data: null, error: { message: e.message } }));
        },
      };
      return chain;
    },
  };
}

const C1 = "00000000-0000-0000-0000-0000000000a1";
const C2 = "00000000-0000-0000-0000-0000000000a2";
const C3 = "00000000-0000-0000-0000-0000000000a3";

async function main() {
  await pool.query(`insert into public.campaigns (id, name, status) values ($1,'proof a1','paused'),($2,'proof a2','paused'),($3,'proof a3','paused') on conflict do nothing`, [C1, C2, C3]);

  // 1 + 2: concurrent upserts, mixed formats
  const formats = ["3055550101", "+13055550101", "(305) 555-0101", "1-305-555-0101"];
  await Promise.all(Array.from({ length: PARALLEL }, (_, i) =>
    pool.query("select public.upsert_campaign_recipient_exclusion($1,$2,$3,$4)", [C1, formats[i % formats.length], `r${i}`, `actor${i}`])));
  const r1 = await pool.query("select count(*)::int n, max(version) v, bool_and(is_active) a from public.campaign_recipient_exclusions where campaign_id=$1", [C1]);
  check("1 concurrent upserts -> one active row, version N", r1.rows[0].n === 1 && r1.rows[0].v === PARALLEL && r1.rows[0].a === true, r1.rows[0]);
  const e1 = await pool.query("select count(*)::int n from public.campaign_recipient_exclusion_events where campaign_id=$1", [C1]);
  check("2 every write audited exactly once", e1.rows[0].n === PARALLEL, e1.rows[0]);
  const auditMut = await expectError(() => pool.query("update public.campaign_recipient_exclusion_events set actor='x' where campaign_id=$1", [C1]));
  check("2b audit table is append-only", !!auditMut, auditMut?.message);

  // 3: interleaved upsert/deactivate
  await Promise.all(Array.from({ length: PARALLEL }, (_, i) => i % 2
    ? pool.query("select public.deactivate_campaign_recipient_exclusion($1,$2,$3,$4)", [C1, "3055550101", `d${i}`, "toggle"])
    : pool.query("select public.upsert_campaign_recipient_exclusion($1,$2,$3,$4)", [C1, "3055550101", "toggle", `u${i}`])));
  const r3 = await pool.query("select count(*)::int n, bool_and((is_active and deactivated_at is null) or (not is_active and deactivated_at is not null)) consistent from public.campaign_recipient_exclusions where campaign_id=$1", [C1]);
  const last = await pool.query("select action from public.campaign_recipient_exclusion_events where campaign_id=$1 order by id desc limit 1", [C1]);
  const state = await pool.query("select is_active from public.campaign_recipient_exclusions where campaign_id=$1", [C1]);
  const lastIsDeactivate = last.rows[0].action === "deactivated";
  check("3 interleaved writes -> one consistent row; state == last committed writer", r3.rows[0].n === 1 && r3.rows[0].consistent && (state.rows[0].is_active === !lastIsDeactivate), { ...r3.rows[0], last: last.rows[0], state: state.rows[0] });

  // 4: per-campaign uniqueness
  await pool.query("select public.upsert_campaign_recipient_exclusion($1,$2,$3,$4)", [C2, "3055550101", "other campaign", "tester"]);
  const r4 = await pool.query("select campaign_id from public.campaign_recipient_exclusions where phone_e164='+13055550101' order by campaign_id");
  check("4 same phone in another campaign is a separate row", r4.rows.length === 2, r4.rows);

  // 5: normalization + validation
  const badPhone = await expectError(() => pool.query("select public.upsert_campaign_recipient_exclusion($1,$2,$3,$4)", [C1, "12345", "x", "tester"]));
  const badActor = await expectError(() => pool.query("select public.upsert_campaign_recipient_exclusion($1,$2,$3,$4)", [C1, "3055550199", "x", " "]));
  const badReason = await expectError(() => pool.query("select public.upsert_campaign_recipient_exclusion($1,$2,$3,$4)", [C1, "3055550199", "", "tester"]));
  const badDirect = await expectError(() => pool.query("insert into public.campaign_recipient_exclusions (campaign_id, phone_e164, reason, created_by, updated_by) values ($1,'305-555-0199','x','t','t')", [C1]));
  check("5 malformed phone / actor / reason rejected; direct malformed insert violates CHECK", !!badPhone && !!badActor && !!badReason && !!badDirect, [badPhone?.message, badActor?.message, badReason?.message, badDirect?.message]);

  // 6: delete refused; deactivation keeps history
  const del = await expectError(() => pool.query("delete from public.campaign_recipient_exclusions where campaign_id=$1", [C2]));
  await pool.query("select public.deactivate_campaign_recipient_exclusion($1,$2,$3,$4)", [C2, "3055550101", "tester", "review complete"]);
  const r6 = await pool.query("select is_active, deactivated_by from public.campaign_recipient_exclusions where campaign_id=$1", [C2]);
  const h6 = await pool.query("select array_agg(action order by id) a from public.campaign_recipient_exclusion_events where campaign_id=$1", [C2]);
  check("6 delete refused; deactivation retains row + history", !!del && r6.rows[0].is_active === false && JSON.stringify(h6.rows[0].a) === JSON.stringify(["created", "deactivated"]), { del: del?.message, row: r6.rows[0], h: h6.rows[0].a });

  // 7: access control
  const asRole = async (role, sql, params = []) => {
    const client = await pool.connect();
    try { await client.query("begin"); await client.query(`set local role ${role}`); const r = await client.query(sql, params); await client.query("rollback"); return { ok: true, rows: r.rows }; }
    catch (e) { await client.query("rollback").catch(() => {}); return { ok: false, error: e.message }; }
    finally { client.release(); }
  };
  const anonRead = await asRole("anon", "select count(*) from public.campaign_recipient_exclusions");
  const authRead = await asRole("authenticated", "select count(*) from public.campaign_recipient_exclusions");
  const anonExec = await asRole("anon", "select public.upsert_campaign_recipient_exclusion($1,$2,$3,$4)", [C3, "3055550111", "x", "anon"]);
  const anonEvents = await asRole("anon", "select count(*) from public.campaign_recipient_exclusion_events");
  const authExec = await asRole("authenticated", "select public.deactivate_campaign_recipient_exclusion($1,$2,$3,$4)", [C1, "3055550101", "auth", "x"]);
  const privs = await pool.query(`select r.rolname, has_function_privilege(r.rolname, 'public.upsert_campaign_recipient_exclusion(uuid,text,text,text,text)', 'EXECUTE') up,
      has_function_privilege(r.rolname, 'public.deactivate_campaign_recipient_exclusion(uuid,text,text,text)', 'EXECUTE') de
    from pg_roles r where r.rolname in ('anon','authenticated','service_role') order by 1`);
  const p = Object.fromEntries(privs.rows.map((r) => [r.rolname, r.up || r.de]));
  const rlsVisible = (r) => !r.ok || Number(r.rows?.[0]?.count ?? 0) === 0;
  check("7 anon/authenticated cannot read or write; only service_role may execute writers",
    rlsVisible(anonRead) && rlsVisible(authRead) && !anonExec.ok && !authExec.ok && rlsVisible(anonEvents)
      && p.anon === false && p.authenticated === false && p.service_role === true,
    { anonRead, authRead, anonExec, authExec, anonEvents, privs: privs.rows });

  // 8: shared rule against the real DB
  const sb = pgSupabase(pool);
  const empty = await loadCampaignRecipientExclusions(sb, C3);
  check("8a empty exclusion set is valid and blocks nobody", empty.ok && empty.phones.size === 0 && !isRecipientExcluded(empty.phones, { canonical_e164: "+13055550101" }), empty);
  await pool.query("select public.upsert_campaign_recipient_exclusion($1,$2,$3,$4)", [C3, "305 555 0177", "proof", "tester"]);
  const loaded = await loadCampaignRecipientExclusions(sb, C3);
  check("8b active rows load; queued-opener phone formats match", loaded.ok && isRecipientExcluded(loaded.phones, { to_phone_number: "13055550177" }), [...(loaded.phones || [])]);
  const inactive = await loadCampaignRecipientExclusions(sb, C2);
  check("8c inactive exclusions are ignored", inactive.ok && inactive.phones.size === 0, [...(inactive.phones || [])]);
  const broken = await loadCampaignRecipientExclusions(pgSupabase(pool, { table: "campaign_recipient_exclusions_missing" }), C3);
  check("8d lookup failure -> ok:false, never an empty set", broken.ok === false && broken.error === "campaign_recipient_exclusions_unreadable", broken);
  const retry = await loadCampaignRecipientExclusions(sb, C3);
  check("8e retry after recovery -> ok:true with the real set", retry.ok && retry.phones.has("+13055550177"), [...(retry.phones || [])]);

  // cleanup (cascade path)
  await pool.query("delete from public.campaigns where id = any($1)", [[C1, C2, C3]]);
  const left = await pool.query("select count(*)::int n from public.campaign_recipient_exclusions where campaign_id = any($1)", [[C1, C2, C3]]);
  check("9 campaign delete cascades (test campaigns only)", left.rows[0].n === 0, left.rows[0]);
}

main()
  .catch((e) => { console.error("PROOF CRASHED", e); failures.push("crash"); })
  .finally(async () => {
    await pool.end();
    if (failures.length) { console.error(`\n${failures.length} invariant(s) FAILED: ${failures.join(", ")}`); process.exit(1); }
    console.log("\nALL CAMPAIGN EXCLUSION INVARIANTS HOLD");
  });
