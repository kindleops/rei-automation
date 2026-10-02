/**
 * Scheduling core — database proof on a real Postgres engine, in-process.
 *
 * Applies the actual migrations (seller portal, scheduling core, Prominent
 * types) to PGlite — Postgres compiled to WebAssembly, no server, no Docker —
 * over minimal stubs of the canonical tables they reference, then proves the
 * invariants that application code must not be trusted with:
 *
 *   1. no two live appointments overlap on one person, across brands (23P01)
 *   2. touching appointments do not conflict (half-open ranges)
 *   3. cancelling releases the time immediately
 *   4. reschedule is atomic: into a taken time it fails and the original is
 *      untouched; into a free time old→rescheduled, new→scheduled, linked
 *   5. anon / authenticated cannot read or write any scheduling table
 *
 * Run:  (cd /tmp/pgl && npm i @electric-sql/pglite) then
 *       node scripts/proof/scheduling-db-proof.mjs   with PGLITE_DIR=/tmp/pgl
 *
 * PGlite is single-connection, so it proves the constraint and the function,
 * not two simultaneous sessions; scripts/proof/scheduling-staging-race.mjs
 * proves the race on a real multi-connection staging database.
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const pgliteDir = process.env.PGLITE_DIR || ROOT
const req = createRequire(path.join(pgliteDir, "noop.js"))
const { PGlite } = await import(pathToFileURL(req.resolve("@electric-sql/pglite")).href)
const { btree_gist } = await import(pathToFileURL(req.resolve("@electric-sql/pglite/contrib/btree_gist")).href)

const results = []
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`) }
const expectError = async (fn) => { try { await fn(); return null } catch (e) { return e } }

const db = new PGlite({ extensions: { btree_gist } })
await db.exec(`
  CREATE SCHEMA IF NOT EXISTS extensions; CREATE ROLE anon; CREATE ROLE authenticated;
  CREATE TABLE public.acquisition_opportunities (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE public.email_attachments (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
`)
for (const f of ["20261002120000_seller_portal.sql", "20261003120000_scheduling_core.sql", "20261003121000_scheduling_prominent_types.sql"]) {
  await db.exec(readFileSync(path.join(ROOT, "supabase/migrations", f), "utf8"))
}
check("migrations apply on Postgres 17 (PGlite)", true)

const one = async (sql, params) => (await db.query(sql, params)).rows[0]
const person = (await one(`INSERT INTO scheduling_resources (display_name, timezone, weekly_hours) VALUES ('Test Advisor (fixture)', 'America/New_York', '{}') RETURNING id`)).id
const prominentType = (await one(`SELECT id FROM scheduling_event_types WHERE brand_key='prominent_cash_offer' AND type_key='offer_review'`)).id
const otherType = (await one(`INSERT INTO scheduling_event_types (brand_key, type_key, name, duration_minutes, environment) VALUES ('second_brand_test', 'onboarding', 'Onboarding', 30, 'test') RETURNING id`)).id
const book = (brand, typeId, s, e) => one(`INSERT INTO scheduling_appointments (brand_key, event_type_id, resource_id, start_at, end_at, block_start_at, block_end_at, source) VALUES ($1,$2,$3,$4,$5,$4,$5,'proof') RETURNING id, status, version`, [brand, typeId, person, s, e])

const a = await book("prominent_cash_offer", prominentType, "2026-10-06T18:00:00Z", "2026-10-06T18:30:00Z")
const overlap = await expectError(() => book("second_brand_test", otherType, "2026-10-06T18:15:00Z", "2026-10-06T18:45:00Z"))
check("cross-brand overlap on the same person is rejected by the database", overlap?.code === "23P01", overlap?.code)
const adjacent = await book("second_brand_test", otherType, "2026-10-06T18:30:00Z", "2026-10-06T19:00:00Z")
check("touching appointments do not conflict", Boolean(adjacent?.id))
await db.query(`UPDATE scheduling_appointments SET status='cancelled' WHERE id=$1`, [a.id])
const reuse = await book("second_brand_test", otherType, "2026-10-06T18:00:00Z", "2026-10-06T18:30:00Z")
check("cancelling releases the time immediately", Boolean(reuse?.id))

const intoTaken = await expectError(() => db.query(`SELECT scheduling_reschedule_appointment($1, NULL, $2::jsonb, 'proof')`, [reuse.id, JSON.stringify({ start_at: "2026-10-06T18:40:00Z", end_at: "2026-10-06T19:10:00Z", block_start_at: "2026-10-06T18:40:00Z", block_end_at: "2026-10-06T19:10:00Z" })]))
const untouched = await one(`SELECT status, version FROM scheduling_appointments WHERE id=$1`, [reuse.id])
check("reschedule into a taken time fails and leaves the original untouched", intoTaken?.code === "23P01" && untouched.status === "scheduled" && untouched.version === 1, `${intoTaken?.code} ${untouched.status} v${untouched.version}`)
const moved = await one(`SELECT scheduling_reschedule_appointment($1, 1, $2::jsonb, 'proof') AS id`, [reuse.id, JSON.stringify({ start_at: "2026-10-06T20:00:00Z", end_at: "2026-10-06T20:30:00Z", block_start_at: "2026-10-06T20:00:00Z", block_end_at: "2026-10-06T20:30:00Z" })])
const oldRow = await one(`SELECT status, rescheduled_to_id FROM scheduling_appointments WHERE id=$1`, [reuse.id])
const newRow = await one(`SELECT status, rescheduled_from_id FROM scheduling_appointments WHERE id=$1`, [moved.id])
check("reschedule into a free time is atomic and linked", oldRow.status === "rescheduled" && oldRow.rescheduled_to_id === moved.id && newRow.status === "scheduled" && newRow.rescheduled_from_id === reuse.id)
const freed = await book("prominent_cash_offer", prominentType, "2026-10-06T18:00:00Z", "2026-10-06T18:30:00Z")
check("the old time is released by the reschedule", Boolean(freed?.id))
const stale = await expectError(() => db.query(`SELECT scheduling_reschedule_appointment($1, 7, $2::jsonb, 'proof')`, [moved.id, JSON.stringify({ start_at: "2026-10-07T20:00:00Z", end_at: "2026-10-07T20:30:00Z", block_start_at: "2026-10-07T20:00:00Z", block_end_at: "2026-10-07T20:30:00Z" })]))
check("a reschedule with a stale version is refused", /appointment_version_conflict/.test(stale?.message || ""))

for (const role of ["anon", "authenticated"]) {
  await db.exec(`SET ROLE ${role}`)
  const read = await expectError(() => db.query(`SELECT * FROM scheduling_appointments`))
  const write = await expectError(() => db.query(`INSERT INTO scheduling_calendar_connections (resource_id) VALUES ('${person}')`))
  const fn = await expectError(() => db.query(`SELECT scheduling_reschedule_appointment('${moved.id}', NULL, '{}'::jsonb, 'x')`))
  await db.exec(`RESET ROLE`)
  check(`${role} cannot read, write or call scheduling objects`, read?.code === "42501" && write?.code === "42501" && fn?.code === "42501", [read?.code, write?.code, fn?.code].join(","))
}
const portal = await (async () => { await db.exec("SET ROLE anon"); const e = await expectError(() => db.query("SELECT * FROM seller_portal_sessions")); await db.exec("RESET ROLE"); return e })()
check("anon cannot read seller portal sessions", portal?.code === "42501")

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} database invariants proven`)
process.exit(failed.length ? 1 : 0)
