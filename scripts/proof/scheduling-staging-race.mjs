/**
 * Scheduling core — the two-session race, on a real multi-connection database.
 *
 * Fires N simultaneous INSERTs for the same final slot through PostgREST
 * (each request runs on its own pooled connection) and asserts exactly one
 * commits; the others must fail with 23P01. Then it proves a second brand
 * cannot take the same time, and cleans up everything it created.
 *
 * NONPRODUCTION ONLY. Refuses the production project ref.
 *   SCHEDULING_PROOF_SUPABASE_URL=https://<staging-ref>.supabase.co \
 *   SCHEDULING_PROOF_SERVICE_ROLE_KEY=... node scripts/proof/scheduling-staging-race.mjs
 */
import { createClient } from "@supabase/supabase-js"

const PRODUCTION_REF = "lcppdrmrdfblstpcbgpf"
const url = process.env.SCHEDULING_PROOF_SUPABASE_URL || ""
const key = process.env.SCHEDULING_PROOF_SERVICE_ROLE_KEY || ""
if (!url || !key) { console.error("Set SCHEDULING_PROOF_SUPABASE_URL and SCHEDULING_PROOF_SERVICE_ROLE_KEY (staging)."); process.exit(2) }
if (url.includes(PRODUCTION_REF)) { console.error("Refusing: this is the production project."); process.exit(2) }

const N = Number(process.env.RACERS || 12)
const clients = Array.from({ length: N }, () => createClient(url, key, { auth: { persistSession: false } }))
const db = clients[0]
const created = { resource: null, types: [], appointments: [] }
try {
  const { data: resource, error: re } = await db.from("scheduling_resources").insert({ display_name: "Race proof (fixture)", timezone: "America/New_York", environment: "test" }).select("id").single()
  if (re) throw re
  created.resource = resource.id
  const mk = async (brand) => { const { data, error } = await db.from("scheduling_event_types").insert({ brand_key: brand, type_key: `race_${Date.now()}`, name: "Race proof", duration_minutes: 30, environment: "test" }).select("id").single(); if (error) throw error; created.types.push(data.id); return data.id }
  const prominent = await mk("prominent_cash_offer")
  const second = await mk("second_brand_test")
  const start = new Date(Date.now() + 30 * 86400e3); start.setUTCMinutes(0, 0, 0)
  const end = new Date(start.getTime() + 30 * 60e3)
  const row = (brand, typeId, i) => ({ brand_key: brand, event_type_id: typeId, resource_id: resource.id, start_at: start.toISOString(), end_at: end.toISOString(), block_start_at: start.toISOString(), block_end_at: end.toISOString(), source: "race_proof", customer: { name: `racer ${i}` } })
  const results = await Promise.all(clients.map((c, i) => c.from("scheduling_appointments").insert(row(i % 2 ? "second_brand_test" : "prominent_cash_offer", i % 2 ? second : prominent, i)).select("id").maybeSingle()))
  const winners = results.filter((r) => !r.error)
  const losers = results.filter((r) => r.error)
  created.appointments.push(...winners.map((w) => w.data.id))
  console.log(`racers: ${N}  committed: ${winners.length}  rejected: ${losers.length}  rejection codes: ${[...new Set(losers.map((l) => l.error.code))].join(",")}`)
  const ok = winners.length === 1 && losers.every((l) => l.error.code === "23P01")
  console.log(ok ? "PASS  exactly one booking committed; every other session got slot-unavailable (23P01)" : "FAIL")
  const again = await db.from("scheduling_appointments").insert(row("second_brand_test", second, "late")).select("id").maybeSingle()
  console.log(again.error?.code === "23P01" ? "PASS  the time is gone for the second brand too" : "FAIL  second brand could book")
  process.exitCode = ok && again.error?.code === "23P01" ? 0 : 1
} finally {
  if (created.appointments.length) await db.from("scheduling_appointments").delete().in("id", created.appointments)
  if (created.types.length) { await db.from("scheduling_appointments").delete().in("event_type_id", created.types); await db.from("scheduling_event_types").delete().in("id", created.types) }
  if (created.resource) await db.from("scheduling_resources").delete().eq("id", created.resource)
}
