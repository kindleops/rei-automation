/**
 * SENDER ROUTING 2.0 — the PROPOSED initial routing graph (owner brief §D.2).
 *
 * STATUS: PROPOSAL. Pending owner approval. Runtime selection NEVER reads this
 * file: the router reads market_sender_routes / sender_pools /
 * sender_pool_numbers from the database (sender-routing-graph.js). This module
 * exists so the dry run, the Sender Coverage surface ("proposed, not enabled")
 * and the seed SQL generator all present the SAME proposal.
 *
 * provenance
 *   owner     a relationship the owner described in the brief (2026-10-02)
 *   proposal  this build's proposal (canonical markets x existing inventory x
 *             lead volume); the owner approves or edits it
 *   confirm   the owner named the relationship loosely ("selected Ohio",
 *             "selected OK"); the market is proposed and needs confirmation
 *
 * Pools are sending hubs. A number belongs to exactly one pool. Members are
 * listed by E.164 and resolved to textgrid_numbers ids when the seed is built.
 * pending_onboarding members (Chicago +18722547122, r3) join their pool in the
 * seed but stay ineligible (status paused, onboarding_stage 'configuring')
 * until the inbound round-trip proof and activate-number.mjs. Indianapolis and
 * Tampa completed onboarding on 2026-10-03 and are regular members since r3.
 */

import { AFFINITY_TIERS as T } from "./sender-routing-policy.js";

export const PROPOSED_GRAPH_VERSION = "proposal-2026-10-07-r3";

/**
 * REVISION 3 — the owner's regional map of 2026-10-07 (approved for first
 * touch), reconciled with the 2026-10-02 owner rules (memory
 * feedback_sender_market_affinity_routing):
 *   West (CA NV AZ UT WA OR ID CO NM)  Los Angeles; Dallas last resort only (10-02)
 *   Texas + Oklahoma                   Dallas / Houston
 *   Florida + Alabama                  Florida numbers (Orlando: Tampa, Miami)
 *   Chicago / IL, Detroit, Ohio        Chicago (new +18722547122); Indianapolis keeps its
 *                                      10-02 role (IN, Chicago, Detroit, Cincinnati/Columbus)
 *   Kansas City + Midwest              St. Louis + Minneapolis
 *   East Coast                         Charlotte + Atlanta (Charlotte tiered: Carolinas /
 *                                      Virginia strong, farther Northeast weak)
 * Markets the owner's words do not clearly cover are NOT routed (they HOLD,
 * exactly as today, where none of them has a local number): UNMAPPED_MARKETS.
 */
export const PROPOSED_POOLS = Object.freeze([
  { pool_key: "minneapolis", display_name: "Minneapolis", home_market_id: "minneapolis-mn", members: ["+16128060495", "+16125092382", "+16125092623"] },
  { pool_key: "st_louis", display_name: "St. Louis", home_market_id: "st-louis-mo", members: ["+13149268488"] },
  { pool_key: "chicago", display_name: "Chicago", home_market_id: "chicago-il", members: [], pending_onboarding: ["+18722547122"] },
  { pool_key: "indianapolis", display_name: "Indianapolis", home_market_id: "indianapolis-in", members: ["+13173494612"] },
  { pool_key: "dallas", display_name: "Dallas", home_market_id: "dallas-tx", members: ["+14693131600"] },
  { pool_key: "houston", display_name: "Houston", home_market_id: "houston-tx", members: ["+12818458577"] },
  { pool_key: "los_angeles", display_name: "Los Angeles", home_market_id: "los-angeles-ca", members: ["+13234104544", "+13235589881"] },
  { pool_key: "atlanta", display_name: "Atlanta", home_market_id: "atlanta-ga", members: ["+14704920588", "+14702936385", "+14702936402"] },
  { pool_key: "charlotte", display_name: "Charlotte", home_market_id: "charlotte-nc", members: ["+17042405818", "+19804589889"] },
  { pool_key: "jacksonville", display_name: "Jacksonville", home_market_id: "jacksonville-fl", members: ["+19048774448"] },
  { pool_key: "tampa", display_name: "Tampa", home_market_id: "tampa-fl", members: ["+18138947553"] },
  // +13057604780 (local-only, retired, absent from the provider) is NOT a member.
  { pool_key: "miami", display_name: "Miami", home_market_id: "miami-fl", members: ["+17866052999", "+13058975670"] },
]);

const r = (pool_key, tier, provenance, notes = null) => ({ pool_key, tier, provenance, notes });

const O7 = "owner 2026-10-07";
const O2 = "owner 2026-10-02";
const LA_WEST = (tier = T.PREFERRED) => r("los_angeles", tier, "owner", `${O7}: LA numbers cover the West`);
const DALLAS_LAST = r("dallas", T.LAST_RESORT, "owner", `${O2}: West uses LA first, Dallas as last resort only`);
const TX = (pool, tier) => r(pool, tier, "owner", `${O7}: Texas numbers cover all Texas markets and Oklahoma`);
const FL = (pool, tier, note = "Florida numbers cover Alabama") => r(pool, tier, "owner", `${O7}: ${note}`);
const CHI = (tier, note = "Chicago covers Ohio markets and Detroit") => r("chicago", tier, "owner", `${O7}: ${note}`);
const IND = (tier, note) => r("indianapolis", tier, "owner", `${O2}: ${note}`);
const MW = (pool, tier, why) => r(pool, tier, "owner", `${O7}: St. Louis + Minneapolis cover Kansas City and the Midwest — ${why}`);
const EAST = (pool, tier, note) => r(pool, tier, "owner", `${O7}: Charlotte and Atlanta cover the East Coast${note ? ` — ${note}` : ""}`);

/**
 * market_id -> ordered routes (array order = priority 10, 20, 30 …).
 * Walk: thread continuity -> exact/local -> preferred -> regional -> last resort -> HOLD.
 * The blocklist decides number health, the graph decides geography: nothing
 * here unblocks anything, and a pool with no eligible number is skipped.
 *
 * Midwest order (owner asked us to choose and justify):
 *   St. Louis first for MO / KS / IN (same state or nearest hub; 314 is a
 *   Missouri area code sellers in KC and Wichita know), Minneapolis first for
 *   MN / IA / NE / WI (nearer by road, 612 is the Upper-Midwest code).
 * Ohio + Detroit order: the owner's 10-07 words put Chicago on Ohio and Detroit;
 * Indianapolis keeps its 10-02 role. Cincinnati and Columbus are 110 / 175 mi
 * from Indianapolis vs 300+ from Chicago, so Indianapolis leads there and
 * Chicago follows; Detroit and Cleveland lead with Chicago, Indianapolis next.
 * (Owner decision to confirm — see the activation report.)
 */
export const PROPOSED_ROUTES = Object.freeze({
  // ── West: Los Angeles, Dallas last resort ───────────────
  "los-angeles-ca": [r("los_angeles", T.PRIMARY, "owner", `${O7}: LA local`), DALLAS_LAST],
  "inland-empire-ca": [LA_WEST(), DALLAS_LAST],
  "san-diego-ca": [LA_WEST(), DALLAS_LAST],
  "bakersfield-ca": [LA_WEST(), DALLAS_LAST],
  "fresno-ca": [LA_WEST(), DALLAS_LAST],
  "modesto-ca": [LA_WEST(), DALLAS_LAST],
  "stockton-ca": [LA_WEST(), DALLAS_LAST],
  "sacramento-ca": [LA_WEST(), DALLAS_LAST],
  "las-vegas-nv": [LA_WEST(), DALLAS_LAST],
  "phoenix-az": [LA_WEST(), DALLAS_LAST],
  "tucson-az": [LA_WEST(), DALLAS_LAST],
  "salt-lake-city-ut": [LA_WEST(), DALLAS_LAST],
  "boise-id": [LA_WEST(), DALLAS_LAST],
  "spokane-wa": [LA_WEST(), DALLAS_LAST],
  "seattle-wa": [LA_WEST(), DALLAS_LAST],
  "albuquerque-nm": [LA_WEST(), DALLAS_LAST],
  "colorado-springs-co": [LA_WEST(), DALLAS_LAST],
  // ── Texas + Oklahoma ────────────────────────────────────
  "dallas-tx": [TX("dallas", T.PRIMARY), TX("houston", T.PREFERRED)],
  "houston-tx": [TX("houston", T.PRIMARY), TX("dallas", T.PREFERRED)],
  "austin-tx": [TX("dallas", T.PREFERRED), TX("houston", T.REGIONAL)],
  "san-antonio-tx": [TX("houston", T.PREFERRED), TX("dallas", T.REGIONAL)],
  "el-paso-tx": [TX("dallas", T.PREFERRED), TX("houston", T.REGIONAL)],
  "oklahoma-city-ok": [r("dallas", T.PREFERRED, "owner", `${O2}+${O7}: Dallas covers Oklahoma`), TX("houston", T.REGIONAL)],
  "tulsa-ok": [r("dallas", T.PREFERRED, "owner", `${O2}+${O7}: Dallas covers Oklahoma`), TX("houston", T.REGIONAL)],
  // ── Florida + Alabama ───────────────────────────────────
  "miami-fl": [r("miami", T.PRIMARY, "owner", `${O7}: Florida numbers (Miami local)`), r("tampa", T.PREFERRED, "proposal", "intra-Florida fallback, implied by 'Florida numbers'"), r("jacksonville", T.REGIONAL, "proposal", "intra-Florida fallback")],
  "tampa-fl": [r("tampa", T.PRIMARY, "owner", `${O7}: Florida numbers (Tampa local)`), r("miami", T.PREFERRED, "proposal", "intra-Florida fallback, implied by 'Florida numbers'"), r("jacksonville", T.REGIONAL, "proposal", "intra-Florida fallback")],
  "jacksonville-fl": [r("jacksonville", T.PRIMARY, "owner", `${O7}: Florida numbers (Jacksonville local)`), r("tampa", T.PREFERRED, "proposal", "intra-Florida fallback, implied by 'Florida numbers'"), r("miami", T.REGIONAL, "proposal", "intra-Florida fallback")],
  "orlando-fl": [FL("tampa", T.PREFERRED, "Miami or Tampa cover Orlando (Tampa first: 85 mi)"), FL("miami", T.REGIONAL, "Miami or Tampa cover Orlando")],
  "birmingham-al": [FL("jacksonville", T.PREFERRED), FL("tampa", T.REGIONAL), FL("miami", T.LAST_RESORT)],
  // ── Chicago / Detroit / Ohio / Indiana ──────────────────
  "chicago-il": [CHI(T.PRIMARY, "Chicago covers Chicago / IL"), IND(T.PREFERRED, "Indianapolis serves Chicago"), r("minneapolis", T.REGIONAL, "owner", `${O2}: Chicago -> Indianapolis / Minneapolis`)],
  "detroit-mi": [CHI(T.PREFERRED), IND(T.REGIONAL, "Indianapolis serves Detroit")],
  "cleveland-oh": [CHI(T.PREFERRED), IND(T.LAST_RESORT, "other Ohio: Indianapolis as lower priority")],
  "cincinnati-oh": [IND(T.PREFERRED, "Indianapolis serves Cincinnati (110 mi)"), CHI(T.REGIONAL)],
  "columbus-oh": [IND(T.PREFERRED, "Indianapolis serves Columbus (175 mi)"), CHI(T.REGIONAL)],
  "indianapolis-in": [IND(T.PRIMARY, "Indiana first"), MW("st_louis", T.REGIONAL, "St. Louis nearer (240 mi)"), MW("minneapolis", T.LAST_RESORT, "Minneapolis farther")],
  // ── Kansas City + Midwest: St. Louis + Minneapolis ──────
  "st-louis-mo": [MW("st_louis", T.PRIMARY, "St. Louis local"), MW("minneapolis", T.REGIONAL, "Minneapolis second")],
  "kansas-city-mo": [MW("st_louis", T.PREFERRED, "same state, 314 is a Missouri code (250 mi)"), MW("minneapolis", T.REGIONAL, "Minneapolis 440 mi")],
  "wichita-ks": [MW("st_louis", T.PREFERRED, "nearest Midwest hub"), MW("minneapolis", T.REGIONAL, "Minneapolis farther")],
  "minneapolis-mn": [MW("minneapolis", T.PRIMARY, "Minneapolis local"), MW("st_louis", T.REGIONAL, "St. Louis second")],
  "des-moines-ia": [MW("minneapolis", T.PREFERRED, "Minneapolis 245 mi"), MW("st_louis", T.REGIONAL, "St. Louis 350 mi")],
  "omaha-ne": [MW("minneapolis", T.PREFERRED, "Minneapolis 380 mi; 10-02 MSP may serve NE"), MW("st_louis", T.REGIONAL, "St. Louis 440 mi")],
  "milwaukee-wi": [MW("minneapolis", T.PREFERRED, "Minneapolis; 10-02 MSP may serve WI"), MW("st_louis", T.REGIONAL, "St. Louis second")],
  // ── East Coast: Charlotte + Atlanta (Charlotte tiered) ──
  "atlanta-ga": [EAST("atlanta", T.PRIMARY, "Atlanta local"), EAST("charlotte", T.REGIONAL)],
  "charlotte-nc": [EAST("charlotte", T.PRIMARY, "Charlotte local"), EAST("atlanta", T.REGIONAL)],
  "durham-nc": [EAST("charlotte", T.PREFERRED, "Carolinas strong"), EAST("atlanta", T.REGIONAL)],
  "fayetteville-nc": [EAST("charlotte", T.PREFERRED, "Carolinas strong"), EAST("atlanta", T.REGIONAL)],
  "rocky-mount-nc": [EAST("charlotte", T.PREFERRED, "Carolinas strong"), EAST("atlanta", T.REGIONAL)],
  "richmond-va": [EAST("charlotte", T.PREFERRED, "Virginia strong"), EAST("atlanta", T.REGIONAL)],
  "hampton-roads-va": [EAST("charlotte", T.PREFERRED, "Virginia strong"), EAST("atlanta", T.REGIONAL)],
  "baltimore-md": [EAST("charlotte", T.REGIONAL, "Mid-Atlantic, broader than Carolinas/Virginia"), EAST("atlanta", T.LAST_RESORT)],
  "philadelphia-pa": [EAST("charlotte", T.LAST_RESORT, "farther Northeast: weak"), EAST("atlanta", T.LAST_RESORT, "farther Northeast: weak")],
  "hartford-ct": [EAST("charlotte", T.LAST_RESORT, "farther Northeast: weak"), EAST("atlanta", T.LAST_RESORT, "farther Northeast: weak")],
  "providence-ri": [EAST("charlotte", T.LAST_RESORT, "farther Northeast: weak"), EAST("atlanta", T.LAST_RESORT, "farther Northeast: weak")],
});

/**
 * Canonical markets the 10-07 map does not clearly cover. No routes are seeded
 * for them: they HOLD (market_has_no_routes) — today they already send 0,
 * because none has a local number. The owner assigns them.
 */
export const UNMAPPED_MARKETS = Object.freeze([
  { market_id: "memphis-tn", why: "Tennessee is not named (Atlanta? Dallas?)" },
  { market_id: "new-orleans-la", why: "Louisiana is not named (Houston?)" },
  { market_id: "louisville-ky", why: "Kentucky is not named (Indianapolis is 115 mi; Midwest or South?)" },
  { market_id: "pittsburgh-pa", why: "East Coast? Western PA is not coastal (r2 had Charlotte last resort)" },
  { market_id: "rochester-ny", why: "East Coast? Upstate NY is not coastal (r2 had Charlotte last resort)" },
]);

/**
 * Raw graph rows (buildRoutingGraph input) for the proposal, resolved against
 * the live fleet. includePending=true models the post-onboarding world: the
 * Indianapolis/Tampa numbers join their pools (they still have to pass every
 * eligibility gate, so the caller supplies an onboarded fleet row for them).
 */
export function proposedGraphRows({ markets = [], fleet = [], includePending = false } = {}) {
  const idByPhone = new Map((fleet || []).map((row) => [String(row.phone_number), row.id]));
  const pools = PROPOSED_POOLS.map((p) => ({ pool_key: p.pool_key, display_name: p.display_name, home_market_id: p.home_market_id, is_active: true }));
  const pool_numbers = [];
  for (const p of PROPOSED_POOLS) {
    const phones = [...p.members, ...(includePending ? p.pending_onboarding || [] : [])];
    for (const phone of phones) pool_numbers.push({ pool_key: p.pool_key, phone_number: phone, textgrid_number_id: idByPhone.get(phone) || null, status: "active" });
  }
  const routes = [];
  for (const [market_id, list] of Object.entries(PROPOSED_ROUTES)) {
    list.forEach((route, i) => routes.push({ market_id, pool_key: route.pool_key, priority: (i + 1) * 10, affinity_tier: route.tier, enabled: true, provenance: route.provenance, notes: route.notes }));
  }
  return { markets, pools, pool_numbers, routes, version: PROPOSED_GRAPH_VERSION, source: includePending ? "proposal+onboarded" : "proposal" };
}

/**
 * The evidence backfill the PROPOSED seed (20261002130100) writes, frozen from
 * the 2026-10-02 reconciliation (TextGrid API GET + inbound message history).
 * The Sender Coverage surface applies it IN MEMORY in proposal mode so the
 * owner reviews the graph as it would behave once seeded; nothing is written.
 */
export const PROPOSED_SEED_BACKFILL = Object.freeze([
  { phone: "+12818458577", registration_status: "registered", sms_webhook_status: "verified" },
  { phone: "+13058975670", registration_status: "registered", sms_webhook_status: "verified" },
  { phone: "+13234104544", registration_status: "registered", sms_webhook_status: "configured" },
  { phone: "+13235589881", registration_status: "registered", sms_webhook_status: "verified" },
  { phone: "+14693131600", registration_status: "registered", sms_webhook_status: "verified" },
  { phone: "+14702936385", registration_status: null, sms_webhook_status: "configured" },
  { phone: "+14702936402", registration_status: null, sms_webhook_status: "configured" },
  { phone: "+14704920588", registration_status: "registered", sms_webhook_status: "verified" },
  { phone: "+16125092382", registration_status: "registered", sms_webhook_status: "verified" },
  { phone: "+16125092623", registration_status: "registered", sms_webhook_status: "verified" },
  { phone: "+16128060495", registration_status: "registered", sms_webhook_status: "verified" },
  { phone: "+17042405818", registration_status: "registered", sms_webhook_status: "verified" },
  { phone: "+17866052999", registration_status: "registered", sms_webhook_status: "verified" },
  { phone: "+19048774448", registration_status: "registered", sms_webhook_status: "verified" },
  { phone: "+19804589889", registration_status: "registered", sms_webhook_status: "verified" },
  // r3 (TextGrid API GET 2026-10-07): St. Louis is on CHM4NL2 with the inbound webhook set,
  // but no inbound SMS has reached LeadCommand yet -> 'configured' (v2 treats it as
  // webhook_unverified until the owner's proof text lands).
  { phone: "+13149268488", registration_status: "registered", sms_webhook_status: "configured" },
]);
