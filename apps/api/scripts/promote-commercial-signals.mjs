/**
 * promote-commercial-signals.mjs
 *
 * Promotes seller-stated commercial facts into the EXISTING canonical
 * acquisition model. No new tables, no new CRM layer: asking_price,
 * opportunity_status, next_action and next_action_due already exist on
 * acquisition_opportunities and are written through updateOpportunity.
 *
 * WHAT IS DELIBERATELY NOT WRITTEN HERE
 *   #10 external $1.2M -- a THIRD PARTY's offer, not the seller's ask.
 *        current_offer means OUR offer, so writing it there would invent a
 *        $1.2M bid from us. updateOpportunity's allowlist has no metadata
 *        field, so there is no truthful canonical home for it yet.
 *   #11/#12/#13 alternate properties -- the addresses do not exist in the
 *        provider-sourced properties table and there is no canonical
 *        create-property-from-address workflow. Creating them would fabricate
 *        property records with no parcel, valuation or county lineage.
 *   #13's $255k / $160k belong to 3442 Tioga St, NOT to the Rhobell
 *        opportunity this thread points at. Writing them onto the original
 *        opportunity would attach a price to the wrong house.
 *
 *   node scripts/promote-commercial-signals.mjs           # preview
 *   node scripts/promote-commercial-signals.mjs --apply
 */

import { updateOpportunity } from "@/lib/domain/opportunity/opportunity-service.js";
import { supabase } from "@/lib/supabase/client.js";

const APPLY = process.argv.includes("--apply");

const PROMOTIONS = [
  {
    label: "#7 conditional ask $1.5M",
    opportunityId: "995cd567-1893-4b22-a084-c892b2b67be2",
    patch: { asking_price: 1500000 },
    why: '"not for sale. Well unless you want to pay 1.5 million" -- conditional seller ask',
  },
  {
    label: "#8 ask $750k, future seller after Jan 1",
    opportunityId: "d93a0176-fb1e-44bd-8bdb-b7e106a12d8b",
    // "no sale till jan 1, cap gains 2 much", said 2026-05-28. Capital-gains
    // timing points at the next tax year boundary, so 2027-01-01 is the only
    // sensible reading of "jan 1" from May 2026. Deterministic, not invented.
    patch: {
      asking_price: 750000,
      next_action: "future_seller_followup",
      next_action_due: "2027-01-01T00:00:00.000Z",
    },
    why: '"750 k" / "750,000 paid off no mrtg" + "no sale till jan 1, cap gains 2 much"',
  },
  {
    label: "#9 future seller, tenant timing, NO date",
    opportunityId: "f0615bc0-4ae5-4b9d-8bfe-8ade7a0e1634",
    // Explicitly must not remain dead. No date is fabricated: "until our old
    // guy tenant is done with it" carries no resolvable instant.
    patch: {
      opportunity_status: "active",
      next_action: "future_seller_followup_tenant_timing",
    },
    why: '"Not selling that one until our old guy tenant is done with it"',
  },
  {
    label: "#14 active seller, ask $400k",
    opportunityId: "4aa72df8-81ec-41db-b670-ce58ce8bf188",
    patch: { asking_price: 400000 },
    why: '"If there was enough money, yes" -> "400,000. Duplex, 2 rentals" -> "$2000/mo"',
  },
];

/** Held back for operator judgement; asserted so they cannot be written here. */
const NOT_WRITTEN = {
  "#10": "external $1.2M offer -- third party, not seller ask; no canonical field",
  "#11": "6650 S Seeley Ave not in canonical properties; no create-from-address workflow",
  "#12": "474 Chalkstone Ave not in canonical properties; also seller says already listed",
  "#13": "3442 Tioga St not in canonical properties; $255k/$160k belong to it, not to Rhobell",
};

const FORBIDDEN_OPPS = new Set([
  "a918641d-8558-4f73-a4f6-ee717886e048", // #10
  "2ca9d868-e399-413c-97e5-0bde5fb05b75", // #11
  "a8a68af2-7016-487b-ab72-6c27cf51c523", // #12
  "b811088d-b2c2-444f-8bdc-8def8a444198", // #13
]);
for (const p of PROMOTIONS) {
  if (FORBIDDEN_OPPS.has(p.opportunityId)) throw new Error(`${p.label} targets a held opportunity`);
}

for (const p of PROMOTIONS) {
  if (!APPLY) {
    console.log(`PREVIEW ${p.label}: ${JSON.stringify(p.patch)}`);
    continue;
  }
  const res = await updateOpportunity(p.opportunityId, p.patch, { supabase });
  console.log(`${res?.ok ? "OK " : "FAIL"} ${p.label}: ${JSON.stringify(p.patch)}${res?.ok ? "" : " -> " + (res?.error || "unknown")}`);
}

console.log("\nHELD (not written):");
for (const [k, v] of Object.entries(NOT_WRITTEN)) console.log(`  ${k}  ${v}`);
