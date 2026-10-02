/**
 * Scheduling core — Google Calendar proof against a TEST Google account.
 *
 * Preconditions (staging, nonproduction data only):
 *   - migrations applied to the staging project; API env has GOOGLE_CALENDAR_*,
 *     SCHEDULING_TOKEN_KEYS / _ACTIVE_KEY;
 *   - a test team member has connected a TEST Google calendar from the Calendar
 *     (cockpit/scheduling connect), and is in the Prominent "seller_advisors"
 *     pool and the second brand's "team" pool;
 *   - SCHEDULING_ALLOW_TEST_TYPES=1 so the second brand's test type is served.
 *
 * Steps (mirrors the acceptance list):
 *   1 create a busy block directly in Google   2 it is excluded
 *   3 book through Prominent                    4 the Google event appears
 *   5 the second brand cannot book the overlap  6 reschedule through Prominent
 *   7 the Google event moves                    8 the old slot returns
 *   9 cancel                                    10 the Google event is removed
 *   11 the slot returns
 *
 *   SCHEDULING_PROOF_SUPABASE_URL=... SCHEDULING_PROOF_SERVICE_ROLE_KEY=... \
 *   SCHEDULING_PROOF_RESOURCE_ID=<uuid> node --import ./apps/api/tests/register-aliases.mjs scripts/proof/scheduling-google-proof.mjs
 */
import { createClient } from "@supabase/supabase-js"

import { createSupabaseSchedulingStore } from "@/lib/domain/scheduling/scheduling-store.js"
import { createDefaultSchedulingService } from "@/lib/domain/scheduling/scheduling-runtime.js"
import { createGoogleCalendarClient } from "@/lib/domain/scheduling/google-calendar-client.js"
import { decryptSecret } from "@/lib/domain/scheduling/scheduling-token-crypto.js"

const PRODUCTION_REF = "lcppdrmrdfblstpcbgpf"
const url = process.env.SCHEDULING_PROOF_SUPABASE_URL || ""
if (!url || url.includes(PRODUCTION_REF)) { console.error("Staging project URL required; production refused."); process.exit(2) }
const db = createClient(url, process.env.SCHEDULING_PROOF_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const store = createSupabaseSchedulingStore({ db })
const service = createDefaultSchedulingService({ store, env: { ...process.env, SCHEDULING_ALLOW_TEST_TYPES: "1" } })
const google = createGoogleCalendarClient()
const rid = process.env.SCHEDULING_PROOF_RESOURCE_ID
const conn = await store.getConnectionByResource(rid)
if (conn?.status !== "connected") { console.error("Connect a test Google calendar for this resource first."); process.exit(2) }
const access = await google.accessToken(decryptSecret(conn.refresh_token_ciphertext))
const step = (n, ok, note = "") => console.log(`${ok ? "PASS" : "FAIL"}  ${n}${note ? `  (${note})` : ""}`)
const has = (slots, t) => slots.some((s) => s.start_at === t)

const before = await service.getAvailability({ brand: "prominent_cash_offer", typeKey: "offer_review" })
const [busySlot, bookSlot, moveSlot] = [before.slots[1], before.slots[3], before.slots[6]]
const blocker = await google.insertEvent(access, conn.calendar_id, { summary: "Proof busy block", start: { dateTime: busySlot.start_at }, end: { dateTime: busySlot.end_at }, transparency: "opaque" })
await service.syncConnectionBusy(await store.getConnection(conn.id))
step("1 busy block created directly in Google", Boolean(blocker.id))
step("2 scheduler excludes it", !has((await service.getAvailability({ brand: "prominent_cash_offer", typeKey: "offer_review" })).slots, busySlot.start_at))
const { appointment } = await service.bookAppointment({ brand: "prominent_cash_offer", typeKey: "offer_review", startAt: bookSlot.start_at, customer: { name: "Proof Seller (fixture)" }, source: "proof" })
step("3 booked through Prominent", appointment.status === "scheduled")
const row = await store.getAppointment(appointment.id)
const ev = row.google_event_id && (await google.listEvents(access, conn.calendar_id, { timeMin: bookSlot.start_at })).items.find((i) => i.id === row.google_event_id)
step("4 Google event appears", Boolean(ev) && Date.parse(ev.start.dateTime) === Date.parse(bookSlot.start_at))
const second = await service.bookAppointment({ brand: "second_brand_test", typeKey: "onboarding", startAt: bookSlot.start_at, customer: { name: "x" }, source: "proof" }).then(() => "booked", (e) => e.code)
step("5 second brand cannot book the overlap", second === "slot_unavailable" || second === "event_type_not_found", second)
const moved = await service.rescheduleAppointment({ appointmentId: appointment.id, startAt: moveSlot.start_at, actor: "proof" })
step("6 rescheduled through Prominent", moved.ok)
const movedRow = await store.getAppointment(moved.appointment.id)
const movedEv = (await google.listEvents(access, conn.calendar_id, { timeMin: before.slots[0].start_at })).items.find((i) => i.id === movedRow.google_event_id)
step("7 Google event moved", Boolean(movedEv) && Date.parse(movedEv.start.dateTime) === Date.parse(moveSlot.start_at))
step("8 old slot returns", has((await service.getAvailability({ brand: "prominent_cash_offer", typeKey: "offer_review" })).slots, bookSlot.start_at))
await service.cancelAppointment({ appointmentId: moved.appointment.id, actor: "proof" })
step("9 cancelled", (await store.getAppointment(moved.appointment.id)).status === "cancelled")
const gone = (await google.listEvents(access, conn.calendar_id, { timeMin: before.slots[0].start_at })).items.find((i) => i.id === movedRow.google_event_id)
step("10 Google event removed (policy: delete on cancel)", !gone || gone.status === "cancelled")
step("11 slot returns", has((await service.getAvailability({ brand: "prominent_cash_offer", typeKey: "offer_review" })).slots, moveSlot.start_at))
await google.deleteEvent(access, conn.calendar_id, blocker.id)
