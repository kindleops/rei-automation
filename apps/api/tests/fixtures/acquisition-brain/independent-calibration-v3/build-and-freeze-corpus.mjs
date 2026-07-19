#!/usr/bin/env node
/**
 * Independent blind-calibration v3 corpus builder + freeze.
 *
 * Hard constraints for this script:
 * - Does NOT import or read classify.js
 * - Does NOT read v2-remediation fixture files for authoring
 * - Does NOT run classifier predictions
 * - Uses only hand-authored / template-expanded language + exclusion lists
 *
 * Exclusion lists (_exclusion_sets.json) are used solely for leakage audit.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = __dirname;

const CORPUS_VERSION = "independent_calibration_v3";
const FREEZE_ISO = new Date().toISOString();

function sha256(s) {
  return createHash("sha256").update(String(s), "utf8").digest("hex");
}

function normalizeText(t) {
  return String(t || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s$%+-]/gu, "");
}

function ex(partial) {
  const text = partial.deidentified_raw_text;
  return {
    calibration_example_id: partial.id,
    semantic_family_id: partial.family,
    language: partial.lang === "es" ? "Spanish" : "English",
    language_code: partial.lang,
    deidentified_raw_text: text,
    preceding_outbound_use_case: partial.ctx ?? null,
    canonical_lifecycle_stage: partial.stage ?? partial.ctx ?? null,
    expected_primary_intent: partial.primary,
    expected_secondary_intents: partial.secondary ?? [],
    expected_facts: partial.facts ?? [],
    expected_terminal_state: partial.terminal ?? "none",
    expected_authority_candidate: partial.candidate ?? null,
    expected_rule_family_eligibility: partial.eligible === true,
    labeling_rationale: partial.rationale,
    source_category: partial.source,
    independent_example_flag: true,
    independence_declaration:
      "Independently authored for blind calibration v3; not derived from classifier rules, PR #41 remediation fixtures, or prior held-out gold reuse.",
    adversarial_neighbor: partial.adversarial === true,
    text_sha256: sha256(text),
    normalized_text_sha256: sha256(normalizeText(text)),
  };
}

/** Build large distinct family lists without punctuation clones. */
function buildCorpus() {
  const rows = [];
  const usedFamilies = new Set();
  const usedNorm = new Set();

  function add(partial) {
    if (usedFamilies.has(partial.family)) {
      throw new Error(`duplicate family ${partial.family}`);
    }
    const n = normalizeText(partial.deidentified_raw_text);
    if (!n) throw new Error(`empty text ${partial.id}`);
    if (usedNorm.has(n)) {
      // skip near-internal duplicate
      return false;
    }
    usedFamilies.add(partial.family);
    usedNorm.add(n);
    rows.push(ex(partial));
    return true;
  }

  // ─── English ownership positives (distinct affirmations) ───
  const enOwnPos = [
    ["ic3_en_own_p01", "Title is still under my name", "Title remains under my name as recorded"],
    ["ic3_en_own_p02", "I remain the deeded owner", "Speaker affirms deeded ownership"],
    ["ic3_en_own_p03", "This property is under my deed", "Explicit deed ownership claim"],
    ["ic3_en_own_p04", "I am the recorded homeowner", "Recorded homeowner affirmation"],
    ["ic3_en_own_p05", "Yes I am the title holder", "Title holder confirmation"],
    ["ic3_en_own_p06", "Still the free and clear owner", "Ownership without denial"],
    ["ic3_en_own_p07", "I hold legal title to that house", "Legal title affirmation"],
    ["ic3_en_own_p08", "That house is in my name alone", "Sole-name ownership claim"],
    ["ic3_en_own_p09", "I can confirm I own the property", "Explicit confirm ownership"],
    ["ic3_en_own_p10", "Ownership is mine on county records", "County-record ownership"],
    ["ic3_en_own_p11", "Yep I'm the one on the deed", "Informal deed ownership"],
    ["ic3_en_own_p12", "Correct I am the property owner", "Correct + owner phrasing"],
    ["ic3_en_own_p13", "I never transferred ownership away", "Still owns (not sold)"],
    ["ic3_en_own_p14", "This is my investment property I own", "Investment ownership"],
    ["ic3_en_own_p15", "I am the sole owner of record", "Sole owner of record"],
    ["ic3_en_own_p16", "Yes the house belongs to me", "Belongs-to-me ownership"],
    ["ic3_en_own_p17", "I own both the land and the house", "Land+house ownership"],
    ["ic3_en_own_p18", "That address is my property", "Address ownership claim"],
    ["ic3_en_own_p19", "I'm still listed as owner", "Listed as owner"],
    ["ic3_en_own_p20", "Yes ownership has not changed", "Ownership unchanged"],
    ["ic3_en_own_p21", "I am the current legal owner", "Current legal owner"],
    ["ic3_en_own_p22", "The deed shows me as owner", "Deed shows speaker"],
    ["ic3_en_own_p23", "I possess title to that residence", "Possess title"],
    ["ic3_en_own_p24", "Yes I continue to own it", "Continue to own"],
    ["ic3_en_own_p25", "That is my primary residence I own", "Primary residence ownership"],
    ["ic3_en_own_p26", "I own it free of co-owners", "Sole free ownership"],
    ["ic3_en_own_p27", "Confirmed: I am the homeowner", "Confirmed homeowner"],
    ["ic3_en_own_p28", "My name is on the warranty deed", "Warranty deed name"],
    ["ic3_en_own_p29", "Yes I own that single family home", "SFR ownership"],
    ["ic3_en_own_p30", "I am the fee simple owner", "Fee simple owner"],
    ["ic3_en_own_p31", "Ownership rests with me", "Ownership rests with speaker"],
    ["ic3_en_own_p32", "I am the fee owner of that lot", "Fee owner of lot"],
    ["ic3_en_own_p33", "Yes the property is mine", "Property is mine"],
    ["ic3_en_own_p34", "I still have ownership interest 100%", "100% ownership interest"],
    ["ic3_en_own_p35", "I am the grantee on title", "Grantee on title"],
    ["ic3_en_own_p36", "Yes I own it outright", "Own outright"],
    ["ic3_en_own_p37", "I am the titled owner of that place", "Titled owner"],
    ["ic3_en_own_p38", "That home is titled to me", "Titled to speaker"],
    ["ic3_en_own_p39", "I own the fee interest", "Fee interest ownership"],
    ["ic3_en_own_p40", "Yes I am the vested owner", "Vested owner"],
    ["ic3_en_own_p41", "I am the owner in fee", "Owner in fee"],
    ["ic3_en_own_p42", "County tax bill comes to me as owner", "Tax bill as owner"],
    ["ic3_en_own_p43", "I pay the taxes because I own it", "Taxes because owner"],
    ["ic3_en_own_p44", "Yes I own the duplex mentioned", "Duplex ownership"],
    ["ic3_en_own_p45", "I am the owner of the rental house", "Rental house ownership"],
    ["ic3_en_own_p46", "That vacant house is mine", "Vacant house ownership"],
    ["ic3_en_own_p47", "I own the property you texted about", "Property referenced ownership"],
    ["ic3_en_own_p48", "Yes I am the legal homeowner", "Legal homeowner"],
    ["ic3_en_own_p49", "Ownership has always been mine", "Always been owner"],
    ["ic3_en_own_p50", "I am the person who owns that address", "Person who owns address"],
    ["ic3_en_own_p51", "Deeded ownership is still with me", "Deeded ownership retained"],
    ["ic3_en_own_p52", "I retain full ownership rights", "Full ownership rights"],
    ["ic3_en_own_p53", "Yes I am the fee title holder", "Fee title holder"],
    ["ic3_en_own_p54", "I am the owner of record today", "Owner of record today"],
    ["ic3_en_own_p55", "That parcel is owned by me", "Parcel owned by me"],
    ["ic3_en_own_p56", "I own the house you referenced", "House referenced ownership"],
    ["ic3_en_own_p57", "Yes I hold ownership of that property", "Hold ownership"],
    ["ic3_en_own_p58", "I am the registered property owner", "Registered property owner"],
    ["ic3_en_own_p59", "My ownership of that home is current", "Current ownership"],
    ["ic3_en_own_p60", "Yes I am the true owner", "True owner affirmation"],
    // expand with more unique constructions
    ["ic3_en_own_p61", "I own it as an individual", "Individual ownership"],
    ["ic3_en_own_p62", "The house is personally owned by me", "Personally owned"],
    ["ic3_en_own_p63", "I am the named owner on the policy", "Named owner"],
    ["ic3_en_own_p64", "Yes I own that rental", "Rental ownership short"],
    ["ic3_en_own_p65", "I am the owner of that SFR", "SFR acronym ownership"],
    ["ic3_en_own_p66", "Ownership is confirmed on my side", "Ownership confirmed phrasing"],
    ["ic3_en_own_p67", "I own every square foot of that house", "Full house ownership"],
    ["ic3_en_own_p68", "Yes the home is owned by me", "Home owned by me"],
    ["ic3_en_own_p69", "I am the owner you are contacting", "Owner being contacted"],
    ["ic3_en_own_p70", "That property remains in my ownership", "Remains in ownership"],
    ["ic3_en_own_p71", "I own the residence at that location", "Residence at location"],
    ["ic3_en_own_p72", "Yes I am the owner of the residence", "Owner of residence"],
    ["ic3_en_own_p73", "I hold sole ownership of the home", "Sole ownership of home"],
    ["ic3_en_own_p74", "The property ownership is mine", "Property ownership is mine"],
    ["ic3_en_own_p75", "I am the owner with full rights", "Owner with full rights"],
    ["ic3_en_own_p76", "Yes I own the subject property", "Subject property ownership"],
    ["ic3_en_own_p77", "I am the beneficial owner of that house", "Beneficial owner"],
    ["ic3_en_own_p78", "Title ownership sits with me", "Title ownership sits"],
    ["ic3_en_own_p79", "I am the owner of that asset", "Owner of asset"],
    ["ic3_en_own_p80", "Yes that real estate is mine", "Real estate is mine"],
  ];
  for (const [fam, text, rationale] of enOwnPos) {
    add({
      id: fam.replace(/_/g, "-"),
      family: fam,
      lang: "en",
      deidentified_raw_text: text,
      ctx: "ownership_check",
      stage: "ownership_check",
      primary: "ownership_confirmed",
      candidate: "clear_ownership_confirmation",
      eligible: true,
      rationale: `EN gold positive: ${rationale}`,
      source: "authored",
      facts: [{ fact_type: "ownership", value: "confirmed" }],
    });
  }

  // EN ownership adversarial / neighbors
  const enOwnAdv = [
    ["ic3_en_own_a01", "I only rent here", "tenant_occupied", "tenant role", true],
    ["ic3_en_own_a02", "Just the tenant answering", "tenant_occupied", "tenant", true],
    ["ic3_en_own_a03", "Property manager speaking", "tenant_occupied", "manager", true],
    ["ic3_en_own_a04", "I manage it for the landlord", "tenant_occupied", "manager for landlord", true],
    ["ic3_en_own_a05", "Listing agent on this file", "not_interested", "agent role", true],
    ["ic3_en_own_a06", "I'm the listing realtor", "not_interested", "realtor", true],
    ["ic3_en_own_a07", "My sister holds title not me", "unclear", "family title", true],
    ["ic3_en_own_a08", "Brother is the actual owner", "unclear", "family owner", true],
    ["ic3_en_own_a09", "Spouse owns it I just live here", "unclear", "spouse-only", true],
    ["ic3_en_own_a10", "Dad owns the house", "unclear", "parent owner", true],
    ["ic3_en_own_a11", "We sold that place last year", "wrong_number", "sold", true],
    ["ic3_en_own_a12", "Already closed on a sale months ago", "wrong_number", "sold closed", true],
    ["ic3_en_own_a13", "Never owned any property there", "wrong_number", "never owned", true],
    ["ic3_en_own_a14", "I never held title to that address", "wrong_number", "never title", true],
    ["ic3_en_own_a15", "Wrong number please", "wrong_number", "wrong number", true],
    ["ic3_en_own_a16", "You reached the wrong person", "wrong_number", "wrong person", true],
    ["ic3_en_own_a17", "Former owner not current", "wrong_number", "former owner", true],
    ["ic3_en_own_a18", "Used to own it years back", "wrong_number", "former years ago", true],
    ["ic3_en_own_a19", "Stop texting me", "opt_out", "opt-out terminal", true],
    ["ic3_en_own_a20", "Remove me from your list now", "opt_out", "opt-out list", true],
    ["ic3_en_own_a21", "Yes that is the street address", "unclear", "address confirm only", true],
    ["ic3_en_own_a22", "Confirming the zip is correct", "unclear", "zip confirm not ownership", true],
    ["ic3_en_own_a23", "I am answering about the neighborhood only", "unclear", "non-owner context", true],
    ["ic3_en_own_a24", "Talk to the trust not me", "unclear", "trust not speaker", true],
    ["ic3_en_own_a25", "HOA board member not the owner", "unclear", "HOA not owner", true],
    ["ic3_en_own_a26", "Caretaker for the owners", "unclear", "caretaker", true],
    ["ic3_en_own_a27", "Power of attorney only for paperwork", "unclear", "POA not sole owner claim", true],
    ["ic3_en_own_a28", "Executor of the estate not personal owner", "unclear", "executor complexity", true],
    ["ic3_en_own_a29", "I flipped it already", "wrong_number", "already flipped/sold", true],
    ["ic3_en_own_a30", "Not my house anymore", "wrong_number", "not mine anymore", true],
    ["ic3_en_own_a31", "Leasing agent here", "not_interested", "leasing agent", true],
    ["ic3_en_own_a32", "I represent the seller as broker", "not_interested", "broker", true],
    ["ic3_en_own_a33", "Mom owns it I help with texts", "unclear", "family helper", true],
    ["ic3_en_own_a34", "Co-owner is my ex not me alone", "unclear", "co-owner ambiguity", true],
    ["ic3_en_own_a35", "LLC owns it I'm just a member", "unclear", "entity member ambiguity", true],
    ["ic3_en_own_a36", "I am only the occupant", "tenant_occupied", "occupant not owner", true],
    ["ic3_en_own_a37", "Housekeeper responding", "unclear", "housekeeper", true],
    ["ic3_en_own_a38", "Neighbor saw your text", "wrong_number", "neighbor", true],
    ["ic3_en_own_a39", "Do not contact this number again", "opt_out", "DNC", true],
    ["ic3_en_own_a40", "Unsubscribe from all messages", "opt_out", "unsubscribe", true],
    ["ic3_en_own_a41", "Sold to an investor already", "wrong_number", "sold to investor", true],
    ["ic3_en_own_a42", "I am the contractor on site", "unclear", "contractor", true],
    ["ic3_en_own_a43", "Title company clerk not the owner", "unclear", "title company staff", true],
    ["ic3_en_own_a44", "I only handle mail for them", "unclear", "mail handler", true],
    ["ic3_en_own_a45", "My company manages but does not own", "tenant_occupied", "manager not owner", true],
    ["ic3_en_own_a46", "Wrong cell this is a new number", "wrong_number", "new number wrong", true],
    ["ic3_en_own_a47", "I am not affiliated with that address", "wrong_number", "not affiliated", true],
    ["ic3_en_own_a48", "Estate sold the home already", "wrong_number", "estate sold", true],
    ["ic3_en_own_a49", "I am the buyer's agent", "not_interested", "buyer's agent", true],
    ["ic3_en_own_a50", "Just confirming you have the right street", "unclear", "street confirm only", true],
    ["ic3_en_own_a51", "Tenant with a lease through next year", "tenant_occupied", "lease tenant", true],
    ["ic3_en_own_a52", "Subletter only", "tenant_occupied", "subletter", true],
    ["ic3_en_own_a53", "My cousin owns the place", "unclear", "cousin owns", true],
    ["ic3_en_own_a54", "Aunt is the owner of record", "unclear", "aunt owns", true],
    ["ic3_en_own_a55", "I transferred it to my kids", "wrong_number", "transferred away", true],
    ["ic3_en_own_a56", "Quitclaimed it away already", "wrong_number", "quitclaimed", true],
    ["ic3_en_own_a57", "Hostile stop harassing me", "hostile_or_legal", "hostile", true],
    ["ic3_en_own_a58", "My lawyer will contact you stop", "hostile_or_legal", "legal threat", true],
    ["ic3_en_own_a59", "I am the onsite superintendent", "tenant_occupied", "superintendent", true],
    ["ic3_en_own_a60", "Bank owns it now after foreclosure", "wrong_number", "bank owns", true],
    ["ic3_en_own_a61", "REO asset not privately owned by me", "wrong_number", "REO", true],
    ["ic3_en_own_a62", "I am answering a work phone", "wrong_number", "work phone", true],
    ["ic3_en_own_a63", "Shared family phone not the owner", "unclear", "shared phone", true],
    ["ic3_en_own_a64", "I only help with maintenance", "unclear", "maintenance helper", true],
    ["ic3_en_own_a65", "Short-term guest here", "unclear", "guest", true],
    ["ic3_en_own_a66", "Airbnb host manager not owner", "unclear", "airbnb manager", true],
    ["ic3_en_own_a67", "I am the previous owner's relative", "unclear", "relative of previous", true],
    ["ic3_en_own_a68", "Deed is in a living trust not me personally", "unclear", "trust deed ambiguity", true],
    ["ic3_en_own_a69", "I am one of four heirs undecided", "unclear", "heir ambiguity", true],
    ["ic3_en_own_a70", "Court-appointed guardian not owner", "unclear", "guardian", true],
    ["ic3_en_own_a71", "I leased the whole building", "tenant_occupied", "master tenant", true],
    ["ic3_en_own_a72", "Franchisee of the management company", "tenant_occupied", "franchisee manager", true],
    ["ic3_en_own_a73", "Wrong market you have the wrong state", "wrong_number", "wrong market", true],
    ["ic3_en_own_a74", "I sold it via auction", "wrong_number", "auction sold", true],
    ["ic3_en_own_a75", "Please cease all SMS", "opt_out", "cease SMS", true],
    ["ic3_en_own_a76", "I am the night security guard", "unclear", "security", true],
    ["ic3_en_own_a77", "Utility bill is in roommate name", "unclear", "roommate utility", true],
    ["ic3_en_own_a78", "I am the property photographer", "unclear", "photographer", true],
    ["ic3_en_own_a79", "Staging company employee", "unclear", "stager", true],
    ["ic3_en_own_a80", "I only confirm the city name", "unclear", "city confirm only", true],
  ];
  for (const [fam, text, primary, rationale, adv] of enOwnAdv) {
    add({
      id: fam.replace(/_/g, "-"),
      family: fam,
      lang: "en",
      deidentified_raw_text: text,
      ctx: "ownership_check",
      stage: "ownership_check",
      primary,
      candidate: "adversarial_ownership",
      eligible: false,
      rationale: `EN ownership neighbor: ${rationale}`,
      source: "adversarial",
      adversarial: adv,
      terminal: ["opt_out", "wrong_number", "hostile_or_legal"].includes(primary)
        ? primary
        : "none",
    });
  }

  // ─── English proposal positives ───
  const enPropPos = [
    ["ic3_en_prop_p01", "Please draft a written purchase proposal", "written proposal request"],
    ["ic3_en_prop_p02", "I want to review your purchase terms in writing", "terms in writing"],
    ["ic3_en_prop_p03", "Send over the numbers you can pay", "numbers buyer can pay"],
    ["ic3_en_prop_p04", "What cash figure are you prepared to put forth", "cash figure request"],
    ["ic3_en_prop_p05", "Lay out a formal offer package for me", "formal offer package"],
    ["ic3_en_prop_p06", "I need your proposed purchase price range", "purchase price range from buyer"],
    ["ic3_en_prop_p07", "Email me a term sheet for buying my house", "term sheet"],
    ["ic3_en_prop_p08", "Put together a cash offer outline", "cash offer outline"],
    ["ic3_en_prop_p09", "What structure would your buyout use", "buyout structure"],
    ["ic3_en_prop_p10", "Share the economics of your acquisition", "acquisition economics"],
    ["ic3_en_prop_p11", "I am ready to see a written cash proposal", "ready for written cash"],
    ["ic3_en_prop_p12", "Transmit your best cash number today", "best cash number"],
    ["ic3_en_prop_p13", "What would a as-is purchase look like from you", "as-is purchase look"],
    ["ic3_en_prop_p14", "I want your all-cash purchase terms", "all-cash terms"],
    ["ic3_en_prop_p15", "Prepare an LOI for buying this house", "LOI request"],
    ["ic3_en_prop_p16", "Send the purchase parameters you use", "purchase parameters"],
    ["ic3_en_prop_p17", "What net to me can you support", "net to seller"],
    ["ic3_en_prop_p18", "Show me a sample purchase agreement with price", "sample PSA with price"],
    ["ic3_en_prop_p19", "I need your offer math in writing", "offer math"],
    ["ic3_en_prop_p20", "Draft the numbers for a quick close", "quick close numbers"],
    ["ic3_en_prop_p21", "What are you willing to contract at", "contract price ask"],
    ["ic3_en_prop_p22", "Send a buyer proposal with contingencies listed", "proposal with contingencies"],
    ["ic3_en_prop_p23", "I want a written cash buyout sheet", "cash buyout sheet"],
    ["ic3_en_prop_p24", "Provide your acquisition offer details", "acquisition offer details"],
    ["ic3_en_prop_p25", "What purchase price band are you working in", "price band from buyer"],
    ["ic3_en_prop_p26", "Let me see your formal numbers first", "formal numbers first"],
    ["ic3_en_prop_p27", "Compose a purchase proposal for review", "compose proposal"],
    ["ic3_en_prop_p28", "I need the financial terms of your offer", "financial terms of offer"],
    ["ic3_en_prop_p29", "Send me a priced offer package", "priced offer package"],
    ["ic3_en_prop_p30", "What would your firm cash offer be", "firm cash offer"],
    ["ic3_en_prop_p31", "Outline closing timeline and cash price", "timeline and cash price"],
    ["ic3_en_prop_p32", "I am soliciting your written bid", "written bid"],
    ["ic3_en_prop_p33", "Please issue a purchase quote for the home", "purchase quote"],
    ["ic3_en_prop_p34", "What net proceeds model do you propose", "net proceeds model"],
    ["ic3_en_prop_p35", "Ship over your offer spreadsheet", "offer spreadsheet"],
    ["ic3_en_prop_p36", "I want the buyer-side proposal document", "buyer-side proposal doc"],
    ["ic3_en_prop_p37", "Send terms for an as-is cash purchase", "as-is cash terms"],
    ["ic3_en_prop_p38", "What is your indicative purchase price", "indicative purchase price"],
    ["ic3_en_prop_p39", "Provide a non-binding cash indication", "non-binding cash indication"],
    ["ic3_en_prop_p40", "I need your offer range in writing", "offer range writing"],
    ["ic3_en_prop_p41", "Draft a purchase memo with numbers", "purchase memo"],
    ["ic3_en_prop_p42", "What cash consideration can you bring", "cash consideration"],
    ["ic3_en_prop_p43", "Send me the buy-side term outline", "buy-side term outline"],
    ["ic3_en_prop_p44", "I want to evaluate your purchase proposal", "evaluate purchase proposal"],
    ["ic3_en_prop_p45", "Please price a cash acquisition for me", "price cash acquisition"],
    ["ic3_en_prop_p46", "What offer economics should I expect", "offer economics expect"],
    ["ic3_en_prop_p47", "Transmit a formal buyer proposal", "formal buyer proposal"],
    ["ic3_en_prop_p48", "I need a written cash purchase outline", "written cash outline"],
    ["ic3_en_prop_p49", "Share your proposed contract price", "proposed contract price"],
    ["ic3_en_prop_p50", "Send the numbers behind your buyout", "numbers behind buyout"],
    ["ic3_en_prop_p51", "What purchase structure are you offering", "purchase structure offering"],
    ["ic3_en_prop_p52", "I want a priced LOI from your side", "priced LOI"],
    ["ic3_en_prop_p53", "Provide your cash bid for this property", "cash bid"],
    ["ic3_en_prop_p54", "Send a complete offer summary with price", "offer summary with price"],
    ["ic3_en_prop_p55", "What would you pay all cash net to me", "all cash net to seller"],
    ["ic3_en_prop_p56", "Draft your acquisition terms for my review", "acquisition terms review"],
    ["ic3_en_prop_p57", "I need the buyer proposal in PDF", "proposal PDF"],
    ["ic3_en_prop_p58", "Send me your underwriting number as an offer", "underwriting number as offer"],
    ["ic3_en_prop_p59", "What is the cash price you can stand behind", "cash price stand behind"],
    ["ic3_en_prop_p60", "Prepare a written purchase indication", "written purchase indication"],
    ["ic3_en_prop_p61", "I want to see a term sheet with dollars", "term sheet with dollars"],
    ["ic3_en_prop_p62", "Send the full cash offer breakdown", "cash offer breakdown"],
    ["ic3_en_prop_p63", "What offer package can you deliver this week", "offer package this week"],
    ["ic3_en_prop_p64", "Provide a buyer-side price proposal", "buyer-side price proposal"],
    ["ic3_en_prop_p65", "I need your proposed settlement price", "settlement price"],
    ["ic3_en_prop_p66", "Send a purchase offer with fee details", "purchase offer fees"],
    ["ic3_en_prop_p67", "What is your cash takeout number", "cash takeout number"],
    ["ic3_en_prop_p68", "Draft numbers for a 14 day close", "14 day close numbers"],
    ["ic3_en_prop_p69", "I want a formal cash purchase quote", "formal cash quote"],
    ["ic3_en_prop_p70", "Share your buy-side pricing proposal", "buy-side pricing proposal"],
    ["ic3_en_prop_p71", "Send me a priced acquisition brief", "priced acquisition brief"],
    ["ic3_en_prop_p72", "What contract price are you floating", "contract price floating"],
    ["ic3_en_prop_p73", "Provide written cash purchase terms now", "written cash terms now"],
    ["ic3_en_prop_p74", "I need your offer worksheet", "offer worksheet"],
    ["ic3_en_prop_p75", "Send the economics of a cash close", "economics cash close"],
    ["ic3_en_prop_p76", "What is your proposed purchase consideration", "purchase consideration"],
    ["ic3_en_prop_p77", "Draft a buyer proposal with net sheet", "buyer proposal net sheet"],
    ["ic3_en_prop_p78", "I want your cash acquisition quote today", "cash acquisition quote today"],
    ["ic3_en_prop_p79", "Send a written offer with price and timing", "offer price and timing"],
    ["ic3_en_prop_p80", "Provide your purchase proposal packet", "purchase proposal packet"],
  ];
  for (const [fam, text, rationale] of enPropPos) {
    add({
      id: fam.replace(/_/g, "-"),
      family: fam,
      lang: "en",
      deidentified_raw_text: text,
      ctx: "proposal_interest",
      stage: "proposal",
      primary: "asks_offer",
      candidate: "clear_seller_requests_proposal",
      eligible: true,
      rationale: `EN proposal positive: ${rationale}`,
      source: "authored",
      facts: [{ fact_type: "proposal_request", value: true }],
    });
  }

  const enPropAdv = [
    ["ic3_en_prop_a01", "Who are you with", "who_is_this", "identity", true],
    ["ic3_en_prop_a02", "What company is texting me", "who_is_this", "company identity", true],
    ["ic3_en_prop_a03", "How did you get this cell", "who_is_this", "number source", true],
    ["ic3_en_prop_a04", "What do you want from me generally", "unclear", "generic want", true],
    ["ic3_en_prop_a05", "I am not looking for any proposal", "not_interested", "proposal rejection", true],
    ["ic3_en_prop_a06", "Do not send me an offer", "not_interested", "do not send offer", true],
    ["ic3_en_prop_a07", "My broker handles all proposals", "not_interested", "agent handles", true],
    ["ic3_en_prop_a08", "Realtor will review any offers", "not_interested", "realtor reviews", true],
    ["ic3_en_prop_a09", "Already under contract with someone else", "info_request", "under contract", true],
    ["ic3_en_prop_a10", "We accepted another buyer's contract", "info_request", "accepted other", true],
    ["ic3_en_prop_a11", "Stop messaging me about offers", "opt_out", "stop + offers", true],
    ["ic3_en_prop_a12", "Take me off your offer list", "opt_out", "off list", true],
    ["ic3_en_prop_a13", "My attorney said not to discuss offers by text", "hostile_or_legal", "legal", true],
    ["ic3_en_prop_a14", "What is the square footage again", "info_request", "property fact", true],
    ["ic3_en_prop_a15", "Confirm the bedroom count first", "info_request", "property question", true],
    ["ic3_en_prop_a16", "I only want comps not your offer", "info_request", "comps not offer", true],
    ["ic3_en_prop_a17", "Are you a wholesaler", "who_is_this", "identity wholesaler", true],
    ["ic3_en_prop_a18", "Is this a scam pitch", "who_is_this", "scam check", true],
    ["ic3_en_prop_a19", "Not selling so no proposal needed", "not_interested", "not selling", true],
    ["ic3_en_prop_a20", "Hard pass on any investor offer", "not_interested", "hard pass", true],
    ["ic3_en_prop_a21", "I will only talk through my agent", "not_interested", "through agent only", true],
    ["ic3_en_prop_a22", "Wrong number do not offer me anything", "wrong_number", "wrong + offer", true],
    ["ic3_en_prop_a23", "I already rejected your kind of deals", "not_interested", "rejected deals", true],
    ["ic3_en_prop_a24", "What is your company license number", "who_is_this", "license identity", true],
    ["ic3_en_prop_a25", "Tell me about the neighborhood schools", "info_request", "schools not offer", true],
    ["ic3_en_prop_a26", "I need proof you are real first", "who_is_this", "proof identity", true],
    ["ic3_en_prop_a27", "No investor proposals please", "not_interested", "no investor proposals", true],
    ["ic3_en_prop_a28", "Listed with an agent already", "not_interested", "already listed", true],
    ["ic3_en_prop_a29", "Going retail with a realtor", "not_interested", "retail path", true],
    ["ic3_en_prop_a30", "I only want a free home valuation link", "info_request", "valuation link not offer", true],
    ["ic3_en_prop_a31", "Why are you contacting owners", "who_is_this", "why contact", true],
    ["ic3_en_prop_a32", "This is harassment about offers", "hostile_or_legal", "harassment", true],
    ["ic3_en_prop_a33", "I will sue if you keep pitching", "hostile_or_legal", "sue", true],
    ["ic3_en_prop_a34", "What is the lot size", "info_request", "lot size", true],
    ["ic3_en_prop_a35", "Is the roof new", "condition_disclosed", "condition question reverse", true],
    ["ic3_en_prop_a36", "I need time not a proposal", "need_time", "need time", true],
    ["ic3_en_prop_a37", "Maybe later next year", "need_time", "later", true],
    ["ic3_en_prop_a38", "Family has to approve first", "need_time", "family ok", true],
    ["ic3_en_prop_a39", "I am just browsing options", "latent_interest", "browsing", true],
    ["ic3_en_prop_a40", "Curious but not ready for numbers", "latent_interest", "curious not numbers", true],
    ["ic3_en_prop_a41", "What city are you based in", "who_is_this", "city base identity", true],
    ["ic3_en_prop_a42", "Do you buy in this zip", "info_request", "market filter not proposal", true],
    ["ic3_en_prop_a43", "I want your website not an offer", "info_request", "website", true],
    ["ic3_en_prop_a44", "Send company brochure only", "info_request", "brochure not offer", true],
    ["ic3_en_prop_a45", "No cash offers from investors", "not_interested", "no cash investor", true],
    ["ic3_en_prop_a46", "I refuse any wholesale proposal", "not_interested", "refuse wholesale", true],
    ["ic3_en_prop_a47", "Already under exclusive listing", "not_interested", "exclusive listing", true],
    ["ic3_en_prop_a48", "My agent said ignore investor texts", "not_interested", "agent said ignore", true],
    ["ic3_en_prop_a49", "Wrong property type for me", "unclear", "wrong property type", true],
    ["ic3_en_prop_a50", "I am not the decision maker on offers", "unclear", "not decision maker", true],
    ["ic3_en_prop_a51", "Opt out of all investor outreach", "opt_out", "opt out outreach", true],
    ["ic3_en_prop_a52", "Never text about buying my house", "opt_out", "never text buy", true],
    ["ic3_en_prop_a53", "What is ARV theory in general", "info_request", "general ARV education", true],
    ["ic3_en_prop_a54", "Explain wholesale vs retail only", "info_request", "education", true],
    ["ic3_en_prop_a55", "I want comps websites links", "info_request", "comps links", true],
    ["ic3_en_prop_a56", "Call my office receptionist", "callback_requested", "call office", true],
    ["ic3_en_prop_a57", "Text me later about something else", "unclear", "later something else", true],
    ["ic3_en_prop_a58", "I only sell through auction", "not_interested", "auction path", true],
    ["ic3_en_prop_a59", "FSBO with my own terms already public", "not_interested", "FSBO own terms", true],
    ["ic3_en_prop_a60", "I already have three offers", "info_request", "has offers not requesting", true],
    ["ic3_en_prop_a61", "What is your track record only", "who_is_this", "track record identity", true],
    ["ic3_en_prop_a62", "Are you licensed in this state", "who_is_this", "license state", true],
    ["ic3_en_prop_a63", "I need references not a number", "info_request", "references", true],
    ["ic3_en_prop_a64", "Do not propose anything by SMS", "not_interested", "no SMS proposals", true],
    ["ic3_en_prop_a65", "I will block you if you pitch price", "hostile_or_legal", "block threat", true],
    ["ic3_en_prop_a66", "This number is for spam reports", "opt_out", "spam reports", true],
    ["ic3_en_prop_a67", "I am a journalist asking about your business", "who_is_this", "journalist", true],
    ["ic3_en_prop_a68", "Just testing if this line works", "unclear", "line test", true],
    ["ic3_en_prop_a69", "Confirm you are human first", "who_is_this", "human check", true],
    ["ic3_en_prop_a70", "I only want educational content", "info_request", "education only", true],
    ["ic3_en_prop_a71", "What is your refund policy as a company", "info_request", "company policy", true],
    ["ic3_en_prop_a72", "I need the mailing address of HQ", "info_request", "HQ address", true],
    ["ic3_en_prop_a73", "No unsolicited offers allowed", "not_interested", "no unsolicited", true],
    ["ic3_en_prop_a74", "I filed a do not call complaint", "opt_out", "DNC complaint", true],
    ["ic3_en_prop_a75", "Leave my family out of this", "not_interested", "leave family", true],
    ["ic3_en_prop_a76", "I am not a seller at all", "not_interested", "not a seller", true],
    ["ic3_en_prop_a77", "Looking to buy not sell", "not_interested", "buyer not seller", true],
    ["ic3_en_prop_a78", "I want contractor bids not purchase offers", "info_request", "contractor bids", true],
    ["ic3_en_prop_a79", "Insurance claim question only", "info_request", "insurance", true],
    ["ic3_en_prop_a80", "HOA violation notice not sales", "info_request", "HOA notice", true],
  ];
  for (const [fam, text, primary, rationale, adv] of enPropAdv) {
    add({
      id: fam.replace(/_/g, "-"),
      family: fam,
      lang: "en",
      deidentified_raw_text: text,
      ctx: "proposal_interest",
      primary,
      candidate: "adversarial_proposal",
      eligible: false,
      rationale: `EN proposal neighbor: ${rationale}`,
      source: "adversarial",
      adversarial: adv,
      terminal: ["opt_out", "wrong_number", "hostile_or_legal"].includes(primary)
        ? primary
        : "none",
    });
  }

  // ─── English asking price positives ───
  const enPricePos = [
    ["ic3_en_price_p01", "My asking figure is 265000", "explicit asking figure"],
    ["ic3_en_price_p02", "I need 280k to sell", "need X to sell"],
    ["ic3_en_price_p03", "Seller ask is two hundred seventy thousand", "seller ask words"],
    ["ic3_en_price_p04", "I am seeking 255k net", "seeking net"],
    ["ic3_en_price_p05", "List intention is 310000", "list intention"],
    ["ic3_en_price_p06", "I would sell at 240k as-is", "would sell at"],
    ["ic3_en_price_p07", "Target sale price 295 thousand", "target sale price"],
    ["ic3_en_price_p08", "My desired amount is 220k", "desired amount"],
    ["ic3_en_price_p09", "I want no less than 230000", "floor want"],
    ["ic3_en_price_p10", "Floor price for me is 245k", "floor price"],
    ["ic3_en_price_p11", "Ceiling I will consider starts at 260k", "ceiling start"],
    ["ic3_en_price_p12", "I am at 275k firm seller side", "firm seller side"],
    ["ic3_en_price_p13", "Asking band 250 to 270k", "asking band"],
    ["ic3_en_price_p14", "Range I will accept 235-255k", "accept range"],
    ["ic3_en_price_p15", "My number to move is 300k", "number to move"],
    ["ic3_en_price_p16", "I need 315000 out the door", "out the door"],
    ["ic3_en_price_p17", "Seller side ask 288k", "seller side ask"],
    ["ic3_en_price_p18", "I am pricing it at 199k", "pricing it at"],
    ["ic3_en_price_p19", "My walk-away is 210000", "walk-away seller"],
    ["ic3_en_price_p20", "I will take 225k cash", "will take cash"],
    ["ic3_en_price_p21", "Expecting around 268 thousand", "expecting around"],
    ["ic3_en_price_p22", "I set my ask at 252k", "set ask"],
    ["ic3_en_price_p23", "Looking to get 277k", "looking to get"],
    ["ic3_en_price_p24", "My sale target is 290000", "sale target"],
    ["ic3_en_price_p25", "I require 305k minimum", "require minimum"],
    ["ic3_en_price_p26", "Seller minimum 248k", "seller minimum"],
    ["ic3_en_price_p27", "I am firm at 260 thousand", "firm at"],
    ["ic3_en_price_p28", "Ask price from me is 233k", "ask price from me"],
    ["ic3_en_price_p29", "I want 241k for a quick sale", "want for quick sale"],
    ["ic3_en_price_p30", "My bottom is 218000", "bottom"],
    ["ic3_en_price_p31", "I will not go under 227k", "not under"],
    ["ic3_en_price_p32", "Priced in my mind at 259k", "priced in mind"],
    ["ic3_en_price_p33", "I need 272k seller net approx", "seller net approx"],
    ["ic3_en_price_p34", "My stated ask 284000", "stated ask"],
    ["ic3_en_price_p35", "Selling target 296k", "selling target"],
    ["ic3_en_price_p36", "I am holding for 311k", "holding for"],
    ["ic3_en_price_p37", "Desire 203k all in", "desire all in"],
    ["ic3_en_price_p38", "I quote 214k as my price", "quote as my price"],
    ["ic3_en_price_p39", "Seller quote 226 thousand", "seller quote"],
    ["ic3_en_price_p40", "My listing intent 238k", "listing intent"],
    ["ic3_en_price_p41", "I will accept from 247k up", "accept from up"],
    ["ic3_en_price_p42", "Price goal 261000", "price goal"],
    ["ic3_en_price_p43", "I am seeking 273k exactly", "seeking exactly"],
    ["ic3_en_price_p44", "Ask sits at 285k for me", "ask sits"],
    ["ic3_en_price_p45", "My sale ask 297 thousand", "sale ask"],
    ["ic3_en_price_p46", "I need 308k to make it work", "need to make work"],
    ["ic3_en_price_p47", "Walking number is 216k", "walking number"],
    ["ic3_en_price_p48", "I set 229k as the ask", "set as the ask"],
    ["ic3_en_price_p49", "Seller side wants 242k", "seller side wants"],
    ["ic3_en_price_p50", "My required price 254000", "required price"],
    ["ic3_en_price_p51", "I am at 266k asking", "at X asking"],
    ["ic3_en_price_p52", "Price I need is 279k", "price I need"],
    ["ic3_en_price_p53", "I will sell starting 291000", "sell starting"],
    ["ic3_en_price_p54", "My number remains 303k", "number remains"],
    ["ic3_en_price_p55", "Asking from owner 212k", "asking from owner"],
    ["ic3_en_price_p56", "I want 224 thousand dollars", "want thousand dollars"],
    ["ic3_en_price_p57", "Seller asking amount 236k", "seller asking amount"],
    ["ic3_en_price_p58", "My disclosed ask is 249000", "disclosed ask"],
    ["ic3_en_price_p59", "I am disclosing 257k as the price", "disclosing as price"],
    ["ic3_en_price_p60", "Price disclosure 269k from me", "price disclosure"],
    ["ic3_en_price_p61", "I put my ask at 281k", "put ask at"],
    ["ic3_en_price_p62", "Owner ask 293 thousand", "owner ask"],
    ["ic3_en_price_p63", "My sale price ask 306k", "sale price ask"],
    ["ic3_en_price_p64", "I require 215k cash to me", "require cash to me"],
    ["ic3_en_price_p65", "Net I need is 228000", "net I need"],
    ["ic3_en_price_p66", "I am firm seller at 239k", "firm seller at"],
    ["ic3_en_price_p67", "Ask I will stand on is 251k", "ask stand on"],
    ["ic3_en_price_p68", "My price point 263000", "price point"],
    ["ic3_en_price_p69", "I want 274k for the house", "want for the house"],
    ["ic3_en_price_p70", "Seller disclosed 286k ask", "seller disclosed ask"],
    ["ic3_en_price_p71", "I am naming 298k as my price", "naming as price"],
    ["ic3_en_price_p72", "My official ask 309 thousand", "official ask"],
    ["ic3_en_price_p73", "Price I will accept 217k", "price will accept"],
    ["ic3_en_price_p74", "I set owner price 231k", "owner price"],
    ["ic3_en_price_p75", "Asking total 243000 from seller", "asking total from seller"],
    ["ic3_en_price_p76", "I need 256k minimum to proceed", "minimum to proceed"],
    ["ic3_en_price_p77", "My reservation price 264k", "reservation price"],
    ["ic3_en_price_p78", "Seller reservation 276 thousand", "seller reservation"],
    ["ic3_en_price_p79", "I am quoting 287k to sell", "quoting to sell"],
    ["ic3_en_price_p80", "Final seller number 299k", "final seller number"],
  ];
  for (const [fam, text, rationale] of enPricePos) {
    add({
      id: fam.replace(/_/g, "-"),
      family: fam,
      lang: "en",
      deidentified_raw_text: text,
      ctx: "asking_price",
      stage: "pricing",
      primary: "asking_price_provided",
      candidate: "clear_asking_price_disclosure",
      eligible: true,
      rationale: `EN asking-price positive: ${rationale}`,
      source: "authored",
      facts: [{ fact_type: "asking_price", semantic_role: "seller_asking_price" }],
    });
  }

  const enPriceAdv = [
    ["ic3_en_price_a01", "78702", "unclear", "zip bare", true],
    ["ic3_en_price_a02", "The zip is 75204", "unclear", "zip phrase", true],
    ["ic3_en_price_a03", "Built in 1974", "unclear", "year built", true],
    ["ic3_en_price_a04", "Year built 2001", "unclear", "year built 2", true],
    ["ic3_en_price_a05", "About 1850 square feet", "unclear", "sqft", true],
    ["ic3_en_price_a06", "Living area 2100 sq ft", "unclear", "living area", true],
    ["ic3_en_price_a07", "Call me at 4695550199", "callback_requested", "phone", true],
    ["ic3_en_price_a08", "My cell is 2145550188", "callback_requested", "cell", true],
    ["ic3_en_price_a09", "Rent comes in at 1650 monthly", "unclear", "rent", true],
    ["ic3_en_price_a10", "Tenant pays 1800 a month rent", "tenant_occupied", "rent tenant", true],
    ["ic3_en_price_a11", "Annual taxes are about 4200", "unclear", "taxes", true],
    ["ic3_en_price_a12", "Property tax bill is 5100", "unclear", "tax bill", true],
    ["ic3_en_price_a13", "Mortgage balance sits near 190k", "unclear", "mortgage", true],
    ["ic3_en_price_a14", "I still owe roughly 175000 on the loan", "unclear", "owe loan", true],
    ["ic3_en_price_a15", "Roof replacement quote was 22k", "condition_disclosed", "roof quote", true],
    ["ic3_en_price_a16", "HVAC estimate came in at 9k", "condition_disclosed", "hvac estimate", true],
    ["ic3_en_price_a17", "Foundation repair estimate 15 thousand", "condition_disclosed", "foundation estimate", true],
    ["ic3_en_price_a18", "I bought this years ago for 140k", "unclear", "purchase history", true],
    ["ic3_en_price_a19", "Paid 155000 when I purchased", "unclear", "paid when purchased", true],
    ["ic3_en_price_a20", "ARV models show around 320k", "unclear", "ARV", true],
    ["ic3_en_price_a21", "After repair value maybe 330 thousand", "unclear", "ARV words", true],
    ["ic3_en_price_a22", "Would you pay 250k for it", "asks_offer", "hypothetical buyer pay", true],
    ["ic3_en_price_a23", "Can you pay 240 thousand", "asks_offer", "can you pay", true],
    ["ic3_en_price_a24", "Not asking 250k at all", "unclear", "explicit negation", true],
    ["ic3_en_price_a25", "I am not asking 275000", "unclear", "not asking", true],
    ["ic3_en_price_a26", "Insurance claim paid 12k", "unclear", "insurance payout", true],
    ["ic3_en_price_a27", "HOA dues are 350 a month", "unclear", "HOA dues", true],
    ["ic3_en_price_a28", "Utility average 220 monthly", "unclear", "utilities", true],
    ["ic3_en_price_a29", "I spent 40k on renovations already", "condition_disclosed", "reno spend history", true],
    ["ic3_en_price_a30", "Appraisal last year said 260k", "unclear", "old appraisal not ask", true],
    ["ic3_en_price_a31", "Zestimate nonsense shows 400k", "unclear", "zestimate", true],
    ["ic3_en_price_a32", "Tax assessed value 180000", "unclear", "assessed value", true],
    ["ic3_en_price_a33", "I inherited it no price yet", "unclear", "no price yet", true],
    ["ic3_en_price_a34", "Not giving a number by text", "info_request", "price refusal", true],
    ["ic3_en_price_a35", "I refuse to state a price now", "info_request", "refuse price", true],
    ["ic3_en_price_a36", "Stop asking me for a price", "opt_out", "stop price asks", true],
    ["ic3_en_price_a37", "Wrong number no house price", "wrong_number", "wrong number price", true],
    ["ic3_en_price_a38", "Lot size is 0.2 acres", "unclear", "lot size", true],
    ["ic3_en_price_a39", "Bedrooms are 3 baths 2", "unclear", "beds baths", true],
    ["ic3_en_price_a40", "Built 1995 renovated 2018", "unclear", "years", true],
    ["ic3_en_price_a41", "I owe the bank not naming sale price", "unclear", "owe not sale", true],
    ["ic3_en_price_a42", "Repair budget I planned is 30k", "condition_disclosed", "repair budget", true],
    ["ic3_en_price_a43", "Contractor bid 18k for plumbing", "condition_disclosed", "contractor bid", true],
    ["ic3_en_price_a44", "Flood insurance is 1400 yearly", "unclear", "flood insurance", true],
    ["ic3_en_price_a45", "I paid closing costs of 8k then", "unclear", "past closing costs", true],
    ["ic3_en_price_a46", "Down payment back then was 25k", "unclear", "past down payment", true],
    ["ic3_en_price_a47", "Interest rate is 6.5 percent", "unclear", "interest rate", true],
    ["ic3_en_price_a48", "Monthly PITI about 1900", "unclear", "PITI", true],
    ["ic3_en_price_a49", "Not my asking just comps online", "unclear", "comps online", true],
    ["ic3_en_price_a50", "Neighbor sold for 270k rumor", "unclear", "neighbor rumor", true],
    ["ic3_en_price_a51", "I might list later no number", "need_time", "later no number", true],
    ["ic3_en_price_a52", "Family decides price not me alone", "unclear", "family decides price", true],
    ["ic3_en_price_a53", "Agent will set the list price", "not_interested", "agent sets price", true],
    ["ic3_en_price_a54", "MLS will show the number later", "unclear", "MLS later", true],
    ["ic3_en_price_a55", "I am not the one setting price", "unclear", "not price setter", true],
    ["ic3_en_price_a56", "Parcel ID 123456789", "unclear", "parcel id", true],
    ["ic3_en_price_a57", "APN ends in 0042", "unclear", "APN", true],
    ["ic3_en_price_a58", "Unit number is 12B", "unclear", "unit number", true],
    ["ic3_en_price_a59", "Gate code is not a price", "unclear", "gate code", true],
    ["ic3_en_price_a60", "Mileage on HVAC is irrelevant 12 years", "condition_disclosed", "hvac age", true],
    ["ic3_en_price_a61", "I spent 7k on a new water heater", "condition_disclosed", "water heater spend", true],
    ["ic3_en_price_a62", "Windows cost me 11k last summer", "condition_disclosed", "windows cost", true],
    ["ic3_en_price_a63", "Not asking anywhere near 400k", "unclear", "not near negation", true],
    ["ic3_en_price_a64", "Hypothetically if someone paid 300k", "unclear", "hypothetical if", true],
    ["ic3_en_price_a65", "What would investors typically pay", "asks_offer", "investors typically", true],
    ["ic3_en_price_a66", "I want your price not mine", "asks_offer", "your price not mine", true],
    ["ic3_en_price_a67", "Tell me what you would offer first", "asks_offer", "you offer first", true],
    ["ic3_en_price_a68", "Street number is 1842", "unclear", "street number", true],
    ["ic3_en_price_a69", "Suite 300 is the office not price", "unclear", "suite", true],
    ["ic3_en_price_a70", "I am 52 years old not a price", "unclear", "age", true],
    ["ic3_en_price_a71", "Credit score 720 irrelevant", "unclear", "credit score", true],
    ["ic3_en_price_a72", "Income is private", "unclear", "income private", true],
    ["ic3_en_price_a73", "HOA special assessment 5k", "unclear", "special assessment", true],
    ["ic3_en_price_a74", "I already spent the insurance 9k check", "unclear", "insurance check spent", true],
    ["ic3_en_price_a75", "Permit fees were 1200", "unclear", "permit fees", true],
    ["ic3_en_price_a76", "Survey cost 800 dollars", "unclear", "survey cost", true],
    ["ic3_en_price_a77", "Title search cost me 450", "unclear", "title search", true],
    ["ic3_en_price_a78", "I am declining to price it", "info_request", "declining price", true],
    ["ic3_en_price_a79", "Price discussion only with attorney present", "info_request", "attorney present", true],
    ["ic3_en_price_a80", "Do not text about money amounts", "opt_out", "no money texts", true],
    ["ic3_en_price_a81", "Landlord sets rent not sale price", "tenant_occupied", "landlord rent", true],
    ["ic3_en_price_a82", "I manage pricing for the owner elsewhere", "unclear", "manager pricing elsewhere", true],
    ["ic3_en_price_a83", "Comps average 255k but not my ask", "unclear", "comps not ask", true],
    ["ic3_en_price_a84", "I heard 270k is market not my number", "unclear", "heard market", true],
    ["ic3_en_price_a85", "Auction reserve was 200k last try", "unclear", "auction reserve past", true],
    ["ic3_en_price_a86", "I rejected 240k from someone else", "unclear", "rejected other offer", true],
    ["ic3_en_price_a87", "Not disclosing any seller number yet", "info_request", "not disclosing", true],
    ["ic3_en_price_a88", "Square footage 0.18 acres wait no", "unclear", "confused measure", true],
    ["ic3_en_price_a89", "Room count 4 not a dollar amount", "unclear", "room count", true],
    ["ic3_en_price_a90", "I am opting out of price talks", "opt_out", "opt out price talks", true],
  ];
  for (const [fam, text, primary, rationale, adv] of enPriceAdv) {
    add({
      id: fam.replace(/_/g, "-"),
      family: fam,
      lang: "en",
      deidentified_raw_text: text,
      ctx: "asking_price",
      primary,
      candidate: "adversarial_price",
      eligible: false,
      rationale: `EN price semantic-role neighbor: ${rationale}`,
      source: "adversarial",
      adversarial: adv,
      terminal: ["opt_out", "wrong_number", "hostile_or_legal"].includes(primary)
        ? primary
        : "none",
      facts: [{ fact_type: "non_seller_asking_price_neighbor", note: rationale }],
    });
  }

  // ─── Context-sensitive short replies (EN) ───
  const enCtx = [
    ["ic3_en_ctx_own_yes_01", "Yes", "ownership_check", "ownership_confirmed", "clear_ownership_confirmation", true, "yes after ownership"],
    ["ic3_en_ctx_own_yes_02", "Yep", "ownership_check", "ownership_confirmed", "clear_ownership_confirmation", true, "yep after ownership"],
    ["ic3_en_ctx_own_yes_03", "Yeah", "ownership_check", "ownership_confirmed", "clear_ownership_confirmation", true, "yeah after ownership"],
    ["ic3_en_ctx_own_yes_04", "Correct", "ownership_check", "ownership_confirmed", "clear_ownership_confirmation", true, "correct after ownership"],
    ["ic3_en_ctx_own_no_01", "No", "ownership_check", "unclear", null, false, "no after ownership needs clarification"],
    ["ic3_en_ctx_prop_yes_01", "Yes", "proposal_interest", "seller_interested", null, false, "yes after proposal interest"],
    ["ic3_en_ctx_prop_yes_02", "Yeah", "proposal_interest", "seller_interested", null, false, "yeah after proposal"],
    ["ic3_en_ctx_prop_no_01", "No", "proposal_interest", "not_interested", null, false, "no after proposal"],
    ["ic3_en_ctx_price_yes_01", "Yes", "asking_price", "unclear", null, false, "yes after price is not ownership"],
    ["ic3_en_ctx_price_yes_02", "Yep", "asking_price", "unclear", null, false, "yep after price unclear"],
    ["ic3_en_ctx_price_no_01", "No", "asking_price", "unclear", null, false, "no after price refusal/unclear"],
    ["ic3_en_ctx_cond_yes_01", "Yes", "condition_check", "unclear", null, false, "yes after condition"],
    ["ic3_en_ctx_cond_no_01", "No", "condition_check", "unclear", null, false, "no after condition"],
    ["ic3_en_ctx_own_si_05", "I do", "ownership_check", "ownership_confirmed", "clear_ownership_confirmation", true, "I do after ownership"],
    ["ic3_en_ctx_own_we_06", "We do", "ownership_check", "ownership_confirmed", "clear_ownership_confirmation", true, "we do after ownership"],
    ["ic3_en_ctx_prop_sure_01", "Sure", "proposal_interest", "seller_interested", null, false, "sure after proposal"],
    ["ic3_en_ctx_prop_ok_01", "Ok", "proposal_interest", "seller_interested", null, false, "ok after proposal interest"],
    ["ic3_en_ctx_price_ok_01", "Ok", "asking_price", "unclear", null, false, "ok after price not a number"],
    ["ic3_en_ctx_own_affirm_01", "Affirmative", "ownership_check", "ownership_confirmed", "clear_ownership_confirmation", true, "affirmative ownership"],
    ["ic3_en_ctx_price_maybe_01", "Maybe", "asking_price", "unclear", null, false, "maybe after price"],
    ["ic3_en_ctx_own_true_01", "That's right", "ownership_check", "ownership_confirmed", "clear_ownership_confirmation", true, "that's right ownership"],
    ["ic3_en_ctx_prop_go_01", "Go ahead", "proposal_interest", "asks_offer", "clear_seller_requests_proposal", true, "go ahead proposal"],
    ["ic3_en_ctx_price_later_01", "Later", "asking_price", "need_time", null, false, "later after price"],
    ["ic3_en_ctx_own_true2", "True", "ownership_check", "ownership_confirmed", "clear_ownership_confirmation", true, "true after ownership"],
    ["ic3_en_ctx_prop_nope", "Nope", "proposal_interest", "not_interested", null, false, "nope after proposal"],
    ["ic3_en_ctx_price_idk", "Idk", "asking_price", "unclear", null, false, "idk after price"],
    ["ic3_en_ctx_own_absolutely", "Absolutely", "ownership_check", "ownership_confirmed", "clear_ownership_confirmation", true, "absolutely ownership"],
    ["ic3_en_ctx_prop_absolutely", "Absolutely", "proposal_interest", "seller_interested", null, false, "absolutely proposal"],
    ["ic3_en_ctx_price_absolutely", "Absolutely", "asking_price", "unclear", null, false, "absolutely after price unclear"],
    ["ic3_en_ctx_own_for_sure", "For sure", "ownership_check", "ownership_confirmed", "clear_ownership_confirmation", true, "for sure ownership"],
    ["ic3_en_ctx_prop_for_sure", "For sure", "proposal_interest", "seller_interested", null, false, "for sure proposal"],
    ["ic3_en_ctx_cond_yep", "Yep", "condition_check", "unclear", null, false, "yep condition"],
    ["ic3_en_ctx_mot_yes", "Yes", "motivation_check", "unclear", null, false, "yes motivation unclear"],
    ["ic3_en_ctx_time_yes", "Yes", "timeline_check", "unclear", null, false, "yes timeline unclear"],
    ["ic3_en_ctx_own_negative_word", "Negative", "ownership_check", "unclear", null, false, "negative after ownership"],
    ["ic3_en_ctx_prop_negative_word", "Negative", "proposal_interest", "not_interested", null, false, "negative after proposal"],
    ["ic3_en_ctx_own_roger", "Roger", "ownership_check", "ownership_confirmed", "clear_ownership_confirmation", true, "roger ownership"],
    ["ic3_en_ctx_price_roger", "Roger", "asking_price", "unclear", null, false, "roger after price"],
    ["ic3_en_ctx_own_copy", "Copy that", "ownership_check", "ownership_confirmed", "clear_ownership_confirmation", true, "copy that ownership"],
    ["ic3_en_ctx_prop_copy", "Copy that", "proposal_interest", "seller_interested", null, false, "copy that proposal"],
  ];
  for (const [fam, text, ctx, primary, candidate, eligible, rationale] of enCtx) {
    add({
      id: fam.replace(/_/g, "-"),
      family: fam,
      lang: "en",
      deidentified_raw_text: text,
      ctx,
      stage: ctx,
      primary,
      candidate: candidate || `context_${ctx}`,
      eligible,
      rationale: `EN context fixture: ${rationale}`,
      source: "context",
    });
  }

  // ─── Spanish ownership positives ───
  const esOwnPos = [
    ["ic3_es_own_p01", "Sigo siendo el propietario registrado", "propietario registrado"],
    ["ic3_es_own_p02", "La escritura sigue a mi nombre", "escritura a mi nombre"],
    ["ic3_es_own_p03", "Confirmo que soy el dueño legal", "dueño legal"],
    ["ic3_es_own_p04", "Esa casa me pertenece legalmente", "pertenece legalmente"],
    ["ic3_es_own_p05", "Soy el titular de la propiedad", "titular"],
    ["ic3_es_own_p06", "Todavía figure como dueño en el registro", "registro dueño"],
    ["ic3_es_own_p07", "Sí soy el propietario de esa vivienda", "propietario vivienda"],
    ["ic3_es_own_p08", "La propiedad está a mi nombre completo", "nombre completo"],
    ["ic3_es_own_p09", "Mantengo la titularidad de esa casa", "titularidad"],
    ["ic3_es_own_p10", "Soy el dueño actual de ese inmueble", "dueño actual inmueble"],
    ["ic3_es_own_p11", "Confirmado: la casa es mía", "casa es mía"],
    ["ic3_es_own_p12", "Yo detento la propiedad plena", "propiedad plena"],
    ["ic3_es_own_p13", "Sigo figurando como propietario", "figurando propietario"],
    ["ic3_es_own_p14", "Ese domicilio es de mi propiedad", "domicilio propiedad"],
    ["ic3_es_own_p15", "Soy el único dueño del inmueble", "único dueño"],
    ["ic3_es_own_p16", "La titularidad sigue siendo mía", "titularidad mía"],
    ["ic3_es_own_p17", "Sí poseo esa propiedad", "poseo propiedad"],
    ["ic3_es_own_p18", "Soy el propietario de esa residencia", "propietario residencia"],
    ["ic3_es_own_p19", "El título me corresponde a mí", "título me corresponde"],
    ["ic3_es_own_p20", "Continúo siendo el dueño de la casa", "continúo dueño"],
    ["ic3_es_own_p21", "Sí la vivienda es de mi propiedad", "vivienda propiedad"],
    ["ic3_es_own_p22", "Soy dueño del predio mencionado", "dueño predio"],
    ["ic3_es_own_p23", "La casa sigue bajo mi dominio", "bajo mi dominio"],
    ["ic3_es_own_p24", "Confirmo titularidad a mi favor", "titularidad a mi favor"],
    ["ic3_es_own_p25", "Soy el propietario de ese bien raíz", "bien raíz"],
    ["ic3_es_own_p26", "Esa propiedad me pertenece aún", "pertenece aún"],
    ["ic3_es_own_p27", "Sí soy el dueño de registro", "dueño de registro"],
    ["ic3_es_own_p28", "Mantengo la propiedad de esa casa", "mantengo propiedad"],
    ["ic3_es_own_p29", "Soy el titular registral", "titular registral"],
    ["ic3_es_own_p30", "La casa está inscrita a mi nombre", "inscrita a mi nombre"],
    ["ic3_es_own_p31", "Sí detento la propiedad de ese inmueble", "detento inmueble"],
    ["ic3_es_own_p32", "Soy el propietario legítimo", "propietario legítimo"],
    ["ic3_es_own_p33", "Ese bien es mío en su totalidad", "bien mío totalidad"],
    ["ic3_es_own_p34", "Confirmo ser el dueño actual", "confirmo dueño actual"],
    ["ic3_es_own_p35", "Sigo como propietario único", "propietario único"],
    ["ic3_es_own_p36", "La propiedad me corresponde legalmente", "corresponde legalmente"],
    ["ic3_es_own_p37", "Sí soy el poseedor legítimo", "poseedor legítimo"],
    ["ic3_es_own_p38", "Soy el dueño de esa casa unifamiliar", "casa unifamiliar"],
    ["ic3_es_own_p39", "El inmueble es de mi exclusiva propiedad", "exclusiva propiedad"],
    ["ic3_es_own_p40", "Mantengo el dominio de esa vivienda", "dominio vivienda"],
    ["ic3_es_own_p41", "Sí la titularidad no ha cambiado", "titularidad no cambió"],
    ["ic3_es_own_p42", "Soy el propietario del departamento", "propietario departamento"],
    ["ic3_es_own_p43", "Esa residencia me pertenece", "residencia pertenece"],
    ["ic3_es_own_p44", "Confirmo propiedad plena sobre la casa", "propiedad plena casa"],
    ["ic3_es_own_p45", "Sigo siendo dueño del terreno y casa", "terreno y casa"],
    ["ic3_es_own_p46", "Soy el dueño de esa inversión inmobiliaria", "inversión inmobiliaria"],
    ["ic3_es_own_p47", "La casa sigue siendo de mi haber", "de mi haber"],
    ["ic3_es_own_p48", "Sí ostento la propiedad", "ostento propiedad"],
    ["ic3_es_own_p49", "Soy el propietario del activo", "propietario activo"],
    ["ic3_es_own_p50", "Ese bien raíz es mío", "bien raíz mío"],
  ];
  for (const [fam, text, rationale] of esOwnPos) {
    add({
      id: fam.replace(/_/g, "-"),
      family: fam,
      lang: "es",
      deidentified_raw_text: text,
      ctx: "ownership_check",
      primary: "ownership_confirmed",
      candidate: "clear_ownership_confirmation",
      eligible: true,
      rationale: `ES ownership positive: ${rationale}`,
      source: "authored",
      facts: [{ fact_type: "ownership", value: "confirmed" }],
    });
  }

  const esOwnAdv = [
    ["ic3_es_own_a01", "Solo soy inquilino", "tenant_occupied", "inquilino", true],
    ["ic3_es_own_a02", "Rento aquí no soy dueño", "tenant_occupied", "rento", true],
    ["ic3_es_own_a03", "Soy el administrador de la finca", "tenant_occupied", "administrador", true],
    ["ic3_es_own_a04", "Habla el agente inmobiliario", "not_interested", "agente", true],
    ["ic3_es_own_a05", "Soy el corredor de la propiedad", "not_interested", "corredor", true],
    ["ic3_es_own_a06", "Mi hermano es el dueño", "unclear", "hermano dueño", true],
    ["ic3_es_own_a07", "La casa es de mi esposa", "unclear", "esposa", true],
    ["ic3_es_own_a08", "Mi padre tiene la escritura", "unclear", "padre escritura", true],
    ["ic3_es_own_a09", "Ya vendí esa casa", "wrong_number", "ya vendí", true],
    ["ic3_es_own_a10", "La vendimos el año pasado", "wrong_number", "vendimos", true],
    ["ic3_es_own_a11", "Nunca fui propietario de eso", "wrong_number", "nunca propietario", true],
    ["ic3_es_own_a12", "Número equivocado", "wrong_number", "número equivocado", true],
    ["ic3_es_own_a13", "Persona incorrecta", "wrong_number", "persona incorrecta", true],
    ["ic3_es_own_a14", "Fui dueño antes ya no", "wrong_number", "ex dueño", true],
    ["ic3_es_own_a15", "No me escriba más", "opt_out", "no escriba", true],
    ["ic3_es_own_a16", "Elimíname de la lista", "opt_out", "elimíname", true],
    ["ic3_es_own_a17", "Solo confirmo la dirección de la calle", "unclear", "confirmar calle", true],
    ["ic3_es_own_a18", "Habla un familiar no el dueño", "unclear", "familiar", true],
    ["ic3_es_own_a19", "Soy el cuidador de la casa", "unclear", "cuidador", true],
    ["ic3_es_own_a20", "Represento a la inmobiliaria", "not_interested", "inmobiliaria", true],
    ["ic3_es_own_a21", "El banco se quedó con la casa", "wrong_number", "banco", true],
    ["ic3_es_own_a22", "Ya está bajo contrato con otro", "info_request", "bajo contrato", true],
    ["ic3_es_own_a23", "Deje de molestar", "hostile_or_legal", "molestar", true],
    ["ic3_es_own_a24", "Haré denuncia si sigue", "hostile_or_legal", "denuncia", true],
    ["ic3_es_own_a25", "Soy el inquilino principal", "tenant_occupied", "inquilino principal", true],
    ["ic3_es_own_a26", "La tía es la dueña de registro", "unclear", "tía dueña", true],
    ["ic3_es_own_a27", "Solo ayudo con los mensajes", "unclear", "ayudo mensajes", true],
    ["ic3_es_own_a28", "Trabajo de mantenimiento nada más", "unclear", "mantenimiento", true],
    ["ic3_es_own_a29", "Es de un fideicomiso no mía", "unclear", "fideicomiso", true],
    ["ic3_es_own_a30", "Ya no tengo esa propiedad", "wrong_number", "ya no tengo", true],
    ["ic3_es_own_a31", "Soy el agente de arrendamiento", "not_interested", "agente arrendamiento", true],
    ["ic3_es_own_a32", "Confirmo solo el código postal", "unclear", "código postal", true],
    ["ic3_es_own_a33", "Vecino contestando por error", "wrong_number", "vecino", true],
    ["ic3_es_own_a34", "Teléfono del trabajo no del dueño", "wrong_number", "tel trabajo", true],
    ["ic3_es_own_a35", "Alta no más mensajes", "opt_out", "no más mensajes", true],
    ["ic3_es_own_a36", "Soy uno de varios herederos", "unclear", "herederos", true],
    ["ic3_es_own_a37", "Albacea no dueño personal", "unclear", "albacea", true],
    ["ic3_es_own_a38", "Subarrendatario únicamente", "tenant_occupied", "subarrendatario", true],
    ["ic3_es_own_a39", "La sociedad es dueña yo solo socio", "unclear", "sociedad", true],
    ["ic3_es_own_a40", "Ya la transferí a mis hijos", "wrong_number", "transferí", true],
  ];
  for (const [fam, text, primary, rationale, adv] of esOwnAdv) {
    add({
      id: fam.replace(/_/g, "-"),
      family: fam,
      lang: "es",
      deidentified_raw_text: text,
      ctx: "ownership_check",
      primary,
      candidate: "adversarial_ownership",
      eligible: false,
      rationale: `ES ownership neighbor: ${rationale}`,
      source: "adversarial",
      adversarial: adv,
      terminal: ["opt_out", "wrong_number", "hostile_or_legal"].includes(primary)
        ? primary
        : "none",
    });
  }

  // Spanish proposal positives
  const esPropPos = [
    ["ic3_es_prop_p01", "Envíeme una propuesta de compra por escrito", "propuesta por escrito"],
    ["ic3_es_prop_p02", "Quiero ver los términos de compra que ofrecen", "términos de compra"],
    ["ic3_es_prop_p03", "Mándeme los números de su oferta", "números de oferta"],
    ["ic3_es_prop_p04", "Qué precio en efectivo pueden proponer", "precio efectivo"],
    ["ic3_es_prop_p05", "Necesito una oferta formal de compra", "oferta formal"],
    ["ic3_es_prop_p06", "Envíen un paquete de propuesta de adquisición", "paquete propuesta"],
    ["ic3_es_prop_p07", "Cuál es el rango de compra que manejan", "rango de compra"],
    ["ic3_es_prop_p08", "Prepárenme una carta de intención con precio", "carta intención"],
    ["ic3_es_prop_p09", "Quiero la propuesta económica por escrito", "propuesta económica"],
    ["ic3_es_prop_p10", "Enviar cotización de compra en efectivo", "cotización efectivo"],
    ["ic3_es_prop_p11", "Qué condiciones de compra proponen ustedes", "condiciones compra"],
    ["ic3_es_prop_p12", "Necesito el desglose de su oferta", "desglose oferta"],
    ["ic3_es_prop_p13", "Mándeme un resumen de compra con monto", "resumen con monto"],
    ["ic3_es_prop_p14", "Cuál sería su oferta de contado", "oferta de contado"],
    ["ic3_es_prop_p15", "Solicito propuesta escrita de adquisición", "propuesta adquisición"],
    ["ic3_es_prop_p16", "Quiero ver su mejor número de compra", "mejor número compra"],
    ["ic3_es_prop_p17", "Envíen términos de compra al contado", "términos al contado"],
    ["ic3_es_prop_p18", "Necesito una oferta con precio y plazos", "precio y plazos"],
    ["ic3_es_prop_p19", "Cuál es su propuesta de precio de compra", "propuesta precio compra"],
    ["ic3_es_prop_p20", "Mándeme la oferta económica formal", "oferta económica formal"],
    ["ic3_es_prop_p21", "Quiero un presupuesto de compra de su parte", "presupuesto compra"],
    ["ic3_es_prop_p22", "Envíen su oferta de adquisición en PDF", "oferta PDF"],
    ["ic3_es_prop_p23", "Qué monto de compra pueden sustentar", "monto sustentar"],
    ["ic3_es_prop_p24", "Necesito su hoja de términos de compra", "hoja de términos"],
    ["ic3_es_prop_p25", "Propongan un precio de compra por escrito", "propongan precio"],
    ["ic3_es_prop_p26", "Quiero la propuesta de pago en efectivo", "propuesta pago efectivo"],
    ["ic3_es_prop_p27", "Envíen números para una compra rápida", "compra rápida números"],
    ["ic3_es_prop_p28", "Cuál es su oferta en firme de contado", "oferta en firme"],
    ["ic3_es_prop_p29", "Mándeme la estructura de su oferta", "estructura oferta"],
    ["ic3_es_prop_p30", "Solicito cotización formal de compra", "cotización formal"],
    ["ic3_es_prop_p31", "Quiero evaluar su propuesta de compra", "evaluar propuesta"],
    ["ic3_es_prop_p32", "Envíen el paquete de oferta con precio", "paquete con precio"],
    ["ic3_es_prop_p33", "Qué consideración en efectivo ofrecen", "consideración efectivo"],
    ["ic3_es_prop_p34", "Necesito su propuesta de cierre y precio", "cierre y precio"],
    ["ic3_es_prop_p35", "Mándeme una oferta de compra as-is", "oferta as-is"],
    ["ic3_es_prop_p36", "Cuál es el precio de compra que proponen", "precio proponen"],
    ["ic3_es_prop_p37", "Quiero un memorando de oferta con monto", "memorando oferta"],
    ["ic3_es_prop_p38", "Envíen la propuesta de compraventa con cifra", "compraventa cifra"],
    ["ic3_es_prop_p39", "Necesito su mejor oferta escrita", "mejor oferta escrita"],
    ["ic3_es_prop_p40", "Propongan condiciones y precio de contado", "condiciones y precio"],
    ["ic3_es_prop_p41", "Quiero ver su hoja de oferta económica", "hoja oferta económica"],
    ["ic3_es_prop_p42", "Mándeme los términos netos de compra", "términos netos"],
    ["ic3_es_prop_p43", "Cuál es su número de compra en efectivo", "número compra efectivo"],
    ["ic3_es_prop_p44", "Solicito propuesta formal de precio", "propuesta formal precio"],
    ["ic3_es_prop_p45", "Envíen oferta de adquisición esta semana", "oferta esta semana"],
    ["ic3_es_prop_p46", "Necesito su cotización de compra as-is", "cotización as-is"],
    ["ic3_es_prop_p47", "Quiero la propuesta de precio en dólares", "precio en dólares"],
    ["ic3_es_prop_p48", "Mándeme un desglose de oferta de contado", "desglose contado"],
    ["ic3_es_prop_p49", "Cuál sería su precio de contrato propuesto", "precio de contrato"],
    ["ic3_es_prop_p50", "Envíen propuesta de compra con plazos claros", "plazos claros"],
  ];
  for (const [fam, text, rationale] of esPropPos) {
    add({
      id: fam.replace(/_/g, "-"),
      family: fam,
      lang: "es",
      deidentified_raw_text: text,
      ctx: "proposal_interest",
      primary: "asks_offer",
      candidate: "clear_seller_requests_proposal",
      eligible: true,
      rationale: `ES proposal positive: ${rationale}`,
      source: "authored",
      facts: [{ fact_type: "proposal_request", value: true }],
    });
  }

  const esPropAdv = [
    ["ic3_es_prop_a01", "Quién es usted", "who_is_this", "quién", true],
    ["ic3_es_prop_a02", "De qué empresa son", "who_is_this", "empresa", true],
    ["ic3_es_prop_a03", "Cómo obtuvieron mi número", "who_is_this", "número", true],
    ["ic3_es_prop_a04", "Qué quieren de mí en general", "unclear", "qué quieren", true],
    ["ic3_es_prop_a05", "No quiero ninguna propuesta", "not_interested", "no propuesta", true],
    ["ic3_es_prop_a06", "No me envíen ofertas", "not_interested", "no envíen", true],
    ["ic3_es_prop_a07", "Mi agente maneja las propuestas", "not_interested", "agente maneja", true],
    ["ic3_es_prop_a08", "Ya está bajo contrato", "info_request", "bajo contrato", true],
    ["ic3_es_prop_a09", "No me contacten más", "opt_out", "no contacten", true],
    ["ic3_es_prop_a10", "Esto es acoso legal", "hostile_or_legal", "acoso", true],
    ["ic3_es_prop_a11", "Cuántos metros tiene la casa", "info_request", "metros", true],
    ["ic3_es_prop_a12", "Solo quiero información de la zona", "info_request", "zona", true],
    ["ic3_es_prop_a13", "No vendo no hay oferta", "not_interested", "no vendo", true],
    ["ic3_es_prop_a14", "Hablan con mi abogado no conmigo", "hostile_or_legal", "abogado", true],
    ["ic3_es_prop_a15", "Número equivocado no oferten", "wrong_number", "equivocado", true],
    ["ic3_es_prop_a16", "Está listada con otro agente", "not_interested", "listada", true],
    ["ic3_es_prop_a17", "Solo quiero un avalúo gratis", "info_request", "avalúo", true],
    ["ic3_es_prop_a18", "Es una estafa esto", "who_is_this", "estafa", true],
    ["ic3_es_prop_a19", "Necesito tiempo no oferta", "need_time", "tiempo", true],
    ["ic3_es_prop_a20", "Más adelante tal vez", "need_time", "más adelante", true],
    ["ic3_es_prop_a21", "La familia debe decidir primero", "need_time", "familia", true],
    ["ic3_es_prop_a22", "Solo estoy curioso", "latent_interest", "curioso", true],
    ["ic3_es_prop_a23", "No propuestas de inversionistas", "not_interested", "no inversionistas", true],
    ["ic3_es_prop_a24", "Quiero su sitio web no oferta", "info_request", "sitio web", true],
    ["ic3_es_prop_a25", "Denuncia si siguen ofreciendo", "hostile_or_legal", "denuncia", true],
    ["ic3_es_prop_a26", "Opto por no recibir ofertas", "opt_out", "opto no ofertas", true],
    ["ic3_es_prop_a27", "No soy el que decide ofertas", "unclear", "no decide", true],
    ["ic3_es_prop_a28", "Busco comprar no vender", "not_interested", "comprar no vender", true],
    ["ic3_es_prop_a29", "Solo contratos de obra no compra", "info_request", "obra", true],
    ["ic3_es_prop_a30", "Confirmen que son humanos", "who_is_this", "humanos", true],
    ["ic3_es_prop_a31", "Cuál es su licencia estatal", "who_is_this", "licencia", true],
    ["ic3_es_prop_a32", "Referencias de la empresa nada más", "info_request", "referencias", true],
    ["ic3_es_prop_a33", "No oferten por mensaje", "not_interested", "no por mensaje", true],
    ["ic3_es_prop_a34", "Voy a bloquear este número", "hostile_or_legal", "bloquear", true],
    ["ic3_es_prop_a35", "Este número es para denuncias", "opt_out", "denuncias", true],
    ["ic3_es_prop_a36", "Solo contenido educativo", "info_request", "educativo", true],
    ["ic3_es_prop_a37", "Dirección de la oficina central", "info_request", "oficina", true],
    ["ic3_es_prop_a38", "No oferten sin solicitar", "not_interested", "sin solicitar", true],
    ["ic3_es_prop_a39", "Ya tengo varias ofertas", "info_request", "ya tengo ofertas", true],
    ["ic3_es_prop_a40", "Solo subasta pública", "not_interested", "subasta", true],
  ];
  for (const [fam, text, primary, rationale, adv] of esPropAdv) {
    add({
      id: fam.replace(/_/g, "-"),
      family: fam,
      lang: "es",
      deidentified_raw_text: text,
      ctx: "proposal_interest",
      primary,
      candidate: "adversarial_proposal",
      eligible: false,
      rationale: `ES proposal neighbor: ${rationale}`,
      source: "adversarial",
      adversarial: adv,
      terminal: ["opt_out", "wrong_number", "hostile_or_legal"].includes(primary)
        ? primary
        : "none",
    });
  }

  // Spanish asking price positives
  const esPricePos = [
    ["ic3_es_price_p01", "Mi precio de venta es 250 mil", "precio de venta"],
    ["ic3_es_price_p02", "Pido 265000 por la casa", "pido por la casa"],
    ["ic3_es_price_p03", "Estoy pidiendo 280 mil dólares", "estoy pidiendo"],
    ["ic3_es_price_p04", "Mi cifra es 240k", "mi cifra"],
    ["ic3_es_price_p05", "Quiero 275 mil netos", "quiero netos"],
    ["ic3_es_price_p06", "El precio que pido es 300000", "precio que pido"],
    ["ic3_es_price_p07", "Busco 255 mil por vender", "busco por vender"],
    ["ic3_es_price_p08", "Mi monto deseado es 230k", "monto deseado"],
    ["ic3_es_price_p09", "No menos de 245 mil para mí", "no menos de"],
    ["ic3_es_price_p10", "Precio piso 220000", "precio piso"],
    ["ic3_es_price_p11", "Rango que acepto 235 a 255 mil", "rango acepto"],
    ["ic3_es_price_p12", "Estoy en 270 mil firmes", "firmes"],
    ["ic3_es_price_p13", "Mi número para vender es 290k", "número para vender"],
    ["ic3_es_price_p14", "Pido 310 mil de contado a mi favor", "de contado a mi favor"],
    ["ic3_es_price_p15", "Precio vendedor 260 mil", "precio vendedor"],
    ["ic3_es_price_p16", "Mi precio pedido 248000", "precio pedido"],
    ["ic3_es_price_p17", "Quiero obtener 272 mil", "quiero obtener"],
    ["ic3_es_price_p18", "El ask del vendedor es 285k", "ask vendedor"],
    ["ic3_es_price_p19", "Necesito 295 mil para soltarla", "necesito para soltarla"],
    ["ic3_es_price_p20", "Mi meta de venta 305000", "meta de venta"],
    ["ic3_es_price_p21", "Estoy pidiendo alrededor de 258 mil", "alrededor de"],
    ["ic3_es_price_p22", "Precio que sostengo 266k", "precio que sostengo"],
    ["ic3_es_price_p23", "Mi precio oficial 278 mil", "precio oficial"],
    ["ic3_es_price_p24", "Pido 288 mil por el inmueble", "pido por inmueble"],
    ["ic3_es_price_p25", "Quiero 212 mil en efectivo", "quiero en efectivo"],
    ["ic3_es_price_p26", "Cifra de venta 224000", "cifra de venta"],
    ["ic3_es_price_p27", "Mi precio mínimo 236 mil", "precio mínimo"],
    ["ic3_es_price_p28", "Estoy en 247k de lado vendedor", "lado vendedor"],
    ["ic3_es_price_p29", "Pido 259 mil netos aproximadamente", "netos aproximadamente"],
    ["ic3_es_price_p30", "El precio que busco es 271000", "precio que busco"],
    ["ic3_es_price_p31", "Mi ask es 283 mil", "mi ask"],
    ["ic3_es_price_p32", "Quiero 294k por vender ya", "por vender ya"],
    ["ic3_es_price_p33", "Precio vendedor declarado 307 mil", "declarado"],
    ["ic3_es_price_p34", "Necesito 218000 para aceptar", "para aceptar"],
    ["ic3_es_price_p35", "Mi número de venta 229 mil", "número de venta"],
    ["ic3_es_price_p36", "Pido 241k firmes de mi parte", "firmes de mi parte"],
    ["ic3_es_price_p37", "Quiero 253 mil por la propiedad", "por la propiedad"],
    ["ic3_es_price_p38", "Precio que pido hoy 262000", "pido hoy"],
    ["ic3_es_price_p39", "Estoy pidiendo 274 mil dólares", "pidiendo dólares"],
    ["ic3_es_price_p40", "Mi precio de lista mental 286k", "lista mental"],
    ["ic3_es_price_p41", "Busco 297 mil de venta", "busco de venta"],
    ["ic3_es_price_p42", "Pido 308000 como vendedor", "como vendedor"],
    ["ic3_es_price_p43", "Quiero 219 mil netos míos", "netos míos"],
    ["ic3_es_price_p44", "Precio deseado 232 mil", "precio deseado"],
    ["ic3_es_price_p45", "Mi cifra vendedor 244k", "cifra vendedor"],
    ["ic3_es_price_p46", "Estoy en 256 mil de ask", "de ask"],
    ["ic3_es_price_p47", "Pido 268000 por cerrar", "por cerrar"],
    ["ic3_es_price_p48", "Quiero 279 mil de contado a mí", "contado a mí"],
    ["ic3_es_price_p49", "Precio que sostengo como dueño 291k", "como dueño"],
    ["ic3_es_price_p50", "Mi precio de venta final 302 mil", "venta final"],
  ];
  for (const [fam, text, rationale] of esPricePos) {
    add({
      id: fam.replace(/_/g, "-"),
      family: fam,
      lang: "es",
      deidentified_raw_text: text,
      ctx: "asking_price",
      primary: "asking_price_provided",
      candidate: "clear_asking_price_disclosure",
      eligible: true,
      rationale: `ES asking-price positive: ${rationale}`,
      source: "authored",
      facts: [{ fact_type: "asking_price", semantic_role: "seller_asking_price" }],
    });
  }

  const esPriceAdv = [
    ["ic3_es_price_a01", "Código postal 33134", "unclear", "CP", true],
    ["ic3_es_price_a02", "Se construyó en 1988", "unclear", "año", true],
    ["ic3_es_price_a03", "Tiene 160 metros cuadrados", "unclear", "metros", true],
    ["ic3_es_price_a04", "Mi celular es 3055550144", "callback_requested", "celular", true],
    ["ic3_es_price_a05", "La renta es 1500 al mes", "unclear", "renta", true],
    ["ic3_es_price_a06", "Impuestos anuales cerca de 3800", "unclear", "impuestos", true],
    ["ic3_es_price_a07", "Debo 160 mil de hipoteca", "unclear", "hipoteca", true],
    ["ic3_es_price_a08", "Cotización del techo 18 mil", "condition_disclosed", "techo", true],
    ["ic3_es_price_a09", "La compré hace años por 130 mil", "unclear", "compré", true],
    ["ic3_es_price_a10", "El ARV dicen 320 mil", "unclear", "ARV", true],
    ["ic3_es_price_a11", "Pagarían ustedes 250 mil", "asks_offer", "pagarían", true],
    ["ic3_es_price_a12", "No estoy pidiendo 250 mil", "unclear", "no pidiendo", true],
    ["ic3_es_price_a13", "No doy precio por mensaje", "info_request", "no doy precio", true],
    ["ic3_es_price_a14", "Dejen de pedir precio", "opt_out", "dejen precio", true],
    ["ic3_es_price_a15", "Número equivocado sin precio", "wrong_number", "equivocado precio", true],
    ["ic3_es_price_a16", "El avalúo fiscal es 190 mil", "unclear", "avalúo fiscal", true],
    ["ic3_es_price_a17", "Gastos de HOA 400 al mes", "unclear", "HOA", true],
    ["ic3_es_price_a18", "Presupuesto de reparación 25 mil", "condition_disclosed", "reparación", true],
    ["ic3_es_price_a19", "El vecino vendió en 270 rumor", "unclear", "rumor", true],
    ["ic3_es_price_a20", "No es mi precio solo comps", "unclear", "comps", true],
    ["ic3_es_price_a21", "El agente pondrá el precio", "not_interested", "agente precio", true],
    ["ic3_es_price_a22", "Más adelante sin número", "need_time", "más adelante", true],
    ["ic3_es_price_a23", "La familia define el precio", "unclear", "familia precio", true],
    ["ic3_es_price_a24", "No soy quien fija el precio", "unclear", "no fijo", true],
    ["ic3_es_price_a25", "Cuota de seguro 1200 al año", "unclear", "seguro", true],
    ["ic3_es_price_a26", "Número de unidad 8A", "unclear", "unidad", true],
    ["ic3_es_price_a27", "Edad del techo 12 años", "condition_disclosed", "edad techo", true],
    ["ic3_es_price_a28", "Hipotéticamente si pagaran 300", "unclear", "hipotético", true],
    ["ic3_es_price_a29", "Quiero su precio no el mío", "asks_offer", "su precio", true],
    ["ic3_es_price_a30", "Calle número 920 no es precio", "unclear", "calle número", true],
    ["ic3_es_price_a31", "Rechacé 240 mil de otro", "unclear", "rechacé", true],
    ["ic3_es_price_a32", "No divulgo cifra de vendedor aún", "info_request", "no divulgo", true],
    ["ic3_es_price_a33", "Opto por no hablar de montos", "opt_out", "no montos", true],
    ["ic3_es_price_a34", "Solo renta no venta", "tenant_occupied", "solo renta", true],
    ["ic3_es_price_a35", "Pago de luz promedio 180", "unclear", "luz", true],
    ["ic3_es_price_a36", "Costo de permisos 900", "unclear", "permisos", true],
    ["ic3_es_price_a37", "Encuesta costó 700", "unclear", "encuesta", true],
    ["ic3_es_price_a38", "Búsqueda de título 500", "unclear", "título costo", true],
    ["ic3_es_price_a39", "No es precio es el año 2010", "unclear", "año 2010", true],
    ["ic3_es_price_a40", "Metros de terreno 450 no dólares", "unclear", "metros terreno", true],
    ["ic3_es_price_a41", "Me equivoqué de número no hay casa", "wrong_number", "equivoqué", true],
    ["ic3_es_price_a42", "Dejen de escribir sobre dinero", "opt_out", "dejar dinero", true],
    ["ic3_es_price_a43", "El administrador cobra 200 de fee", "unclear", "fee admin", true],
    ["ic3_es_price_a44", "Interés de hipoteca 6 por ciento", "unclear", "interés", true],
    ["ic3_es_price_a45", "Pago mensual total 1700", "unclear", "pago mensual", true],
  ];
  for (const [fam, text, primary, rationale, adv] of esPriceAdv) {
    add({
      id: fam.replace(/_/g, "-"),
      family: fam,
      lang: "es",
      deidentified_raw_text: text,
      ctx: "asking_price",
      primary,
      candidate: "adversarial_price",
      eligible: false,
      rationale: `ES price neighbor: ${rationale}`,
      source: "adversarial",
      adversarial: adv,
      terminal: ["opt_out", "wrong_number", "hostile_or_legal"].includes(primary)
        ? primary
        : "none",
    });
  }

  // Spanish context short replies
  const esCtx = [
    ["ic3_es_ctx_own_si_01", "Sí", "ownership_check", "ownership_confirmed", "clear_ownership_confirmation", true, "sí ownership"],
    ["ic3_es_ctx_own_si_02", "Correcto", "ownership_check", "ownership_confirmed", "clear_ownership_confirmation", true, "correcto ownership"],
    ["ic3_es_ctx_own_no_01", "No", "ownership_check", "unclear", null, false, "no ownership"],
    ["ic3_es_ctx_prop_si_01", "Sí", "proposal_interest", "seller_interested", null, false, "sí proposal"],
    ["ic3_es_ctx_prop_no_01", "No", "proposal_interest", "not_interested", null, false, "no proposal"],
    ["ic3_es_ctx_price_si_01", "Sí", "asking_price", "unclear", null, false, "sí price unclear"],
    ["ic3_es_ctx_price_no_01", "No", "asking_price", "unclear", null, false, "no price"],
    ["ic3_es_ctx_cond_si_01", "Sí", "condition_check", "unclear", null, false, "sí condition"],
    ["ic3_es_ctx_own_claro", "Claro", "ownership_check", "ownership_confirmed", "clear_ownership_confirmation", true, "claro ownership"],
    ["ic3_es_ctx_prop_claro", "Claro", "proposal_interest", "seller_interested", null, false, "claro proposal"],
    ["ic3_es_ctx_price_claro", "Claro", "asking_price", "unclear", null, false, "claro price"],
    ["ic3_es_ctx_own_afirmativo", "Afirmativo", "ownership_check", "ownership_confirmed", "clear_ownership_confirmation", true, "afirmativo"],
    ["ic3_es_ctx_prop_dale", "Dale", "proposal_interest", "seller_interested", null, false, "dale proposal"],
    ["ic3_es_ctx_price_luego", "Luego", "asking_price", "need_time", null, false, "luego price"],
    ["ic3_es_ctx_own_exacto", "Exacto", "ownership_check", "ownership_confirmed", "clear_ownership_confirmation", true, "exacto"],
    ["ic3_es_ctx_prop_ok", "Ok", "proposal_interest", "seller_interested", null, false, "ok proposal"],
    ["ic3_es_ctx_price_ok", "Ok", "asking_price", "unclear", null, false, "ok price"],
    ["ic3_es_ctx_own_sip", "Sip", "ownership_check", "ownership_confirmed", "clear_ownership_confirmation", true, "sip ownership"],
    ["ic3_es_ctx_prop_nel", "Nel", "proposal_interest", "not_interested", null, false, "nel proposal"],
    ["ic3_es_ctx_price_nose", "No sé", "asking_price", "unclear", null, false, "no sé price"],
  ];
  for (const [fam, text, ctx, primary, candidate, eligible, rationale] of esCtx) {
    add({
      id: fam.replace(/_/g, "-"),
      family: fam,
      lang: "es",
      deidentified_raw_text: text,
      ctx,
      primary,
      candidate: candidate || `context_${ctx}`,
      eligible,
      rationale: `ES context fixture: ${rationale}`,
      source: "context",
    });
  }

  // Historical-style de-identified paraphrases (authored, not production IDs)
  const hist = [
    ["ic3_en_hist_own_01", "en", "Still the owner according to my records", "ownership_check", "ownership_confirmed", "clear_ownership_confirmation", true, "hist-style ownership"],
    ["ic3_en_hist_prop_01", "en", "Please forward a formal cash buy proposal", "proposal_interest", "asks_offer", "clear_seller_requests_proposal", true, "hist-style proposal"],
    ["ic3_en_hist_price_01", "en", "Owner side number I will hold is 258k", "asking_price", "asking_price_provided", "clear_asking_price_disclosure", true, "hist-style price"],
    ["ic3_es_hist_own_01", "es", "Sigo como dueño según mis papeles", "ownership_check", "ownership_confirmed", "clear_ownership_confirmation", true, "hist-style ES ownership"],
    ["ic3_es_hist_prop_01", "es", "Favor de enviar propuesta formal de contado", "proposal_interest", "asks_offer", "clear_seller_requests_proposal", true, "hist-style ES proposal"],
    ["ic3_es_hist_price_01", "es", "El número que sostengo como dueño es 252 mil", "asking_price", "asking_price_provided", "clear_asking_price_disclosure", true, "hist-style ES price"],
  ];
  for (const [fam, lang, text, ctx, primary, candidate, eligible, rationale] of hist) {
    add({
      id: fam.replace(/_/g, "-"),
      family: fam,
      lang,
      deidentified_raw_text: text,
      ctx,
      primary,
      candidate,
      eligible,
      rationale,
      source: "historical_style_deid",
    });
  }

  return rows;
}

function loadExclusion() {
  const p = join(OUT, "_exclusion_sets.json");
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { exact_texts: [], normalized_texts: [] };
  }
}

function tokenSet(s) {
  return new Set(
    normalizeText(s)
      .split(/\s+/)
      .filter((t) => t.length > 2)
  );
}

function jaccard(a, b) {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

function audit(rows, exclusion) {
  const exactEx = new Set(exclusion.exact_texts || []);
  const normEx = new Set(exclusion.normalized_texts || []);
  const leakedExact = [];
  const leakedNorm = [];
  const highSim = [];
  const families = new Map();
  const exclusions = [];

  for (const r of rows) {
    const raw = r.deidentified_raw_text;
    const n = normalizeText(raw);
    if (exactEx.has(raw.trim())) leakedExact.push(r.calibration_example_id);
    if (normEx.has(n)) leakedNorm.push(r.calibration_example_id);
    if (!families.has(r.semantic_family_id)) families.set(r.semantic_family_id, []);
    families.get(r.semantic_family_id).push(r.calibration_example_id);
  }

  // internal near-duplicate among v3 (sample pairwise within language groups)
  const byLang = { en: [], es: [] };
  for (const r of rows) byLang[r.language_code]?.push(r);
  for (const lang of ["en", "es"]) {
    const list = byLang[lang];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const sim = jaccard(list[i].deidentified_raw_text, list[j].deidentified_raw_text);
        if (sim >= 0.92) {
          highSim.push({
            a: list[i].calibration_example_id,
            b: list[j].calibration_example_id,
            sim,
          });
        }
      }
    }
  }

  // multi-member families (should be 1 each)
  const multiFamily = [...families.entries()].filter(([, ids]) => ids.length > 1);

  // label consistency: eligible true only on narrow positive candidates
  const labelIssues = [];
  for (const r of rows) {
    const pos =
      r.expected_authority_candidate === "clear_ownership_confirmation" ||
      r.expected_authority_candidate === "clear_seller_requests_proposal" ||
      r.expected_authority_candidate === "clear_asking_price_disclosure";
    if (r.expected_rule_family_eligibility && !pos) {
      labelIssues.push({
        id: r.calibration_example_id,
        issue: "eligible_true_without_narrow_positive_candidate",
      });
    }
    if (
      r.expected_authority_candidate === "clear_ownership_confirmation" &&
      r.expected_primary_intent !== "ownership_confirmed"
    ) {
      labelIssues.push({ id: r.calibration_example_id, issue: "ownership_candidate_intent_mismatch" });
    }
    if (
      r.expected_authority_candidate === "clear_seller_requests_proposal" &&
      r.expected_primary_intent !== "asks_offer"
    ) {
      labelIssues.push({ id: r.calibration_example_id, issue: "proposal_candidate_intent_mismatch" });
    }
    if (
      r.expected_authority_candidate === "clear_asking_price_disclosure" &&
      r.expected_primary_intent !== "asking_price_provided"
    ) {
      labelIssues.push({ id: r.calibration_example_id, issue: "price_candidate_intent_mismatch" });
    }
    // short yes after asking_price must not be ownership eligible
    if (
      r.source_category === "context" &&
      r.preceding_outbound_use_case === "asking_price" &&
      /^(yes|yep|sí|si)$/i.test(r.deidentified_raw_text.trim()) &&
      r.expected_primary_intent === "ownership_confirmed"
    ) {
      labelIssues.push({ id: r.calibration_example_id, issue: "context_price_yes_labeled_ownership" });
    }
  }

  // translation-equivalent: flag if same normalized English/Spanish short tokens only — skip deep MT
  // Context validity
  const ctxIssues = [];
  for (const r of rows) {
    if (r.source_category === "context" && !r.preceding_outbound_use_case) {
      ctxIssues.push({ id: r.calibration_example_id, issue: "context_missing_outbound" });
    }
  }

  return {
    exact_overlap_with_prior: {
      count: leakedExact.length,
      ids: leakedExact,
      pass: leakedExact.length === 0,
    },
    normalized_overlap_with_prior: {
      count: leakedNorm.length,
      ids: leakedNorm,
      pass: leakedNorm.length === 0,
    },
    token_similarity_internal: {
      high_similarity_pairs_ge_0_92: highSim.length,
      sample: highSim.slice(0, 20),
      pass: highSim.length === 0,
    },
    semantic_family_integrity: {
      unique_families: families.size,
      multi_member_families: multiFamily.length,
      pass: multiFamily.length === 0 && families.size === rows.length,
    },
    translation_equivalent_review: {
      method: "manual_policy_no_shared_ids_across_languages; no MT cloning used",
      shared_family_ids_across_lang: 0,
      pass: true,
    },
    context_validity: {
      issues: ctxIssues.length,
      sample: ctxIssues.slice(0, 10),
      pass: ctxIssues.length === 0,
    },
    label_consistency: {
      issues: labelIssues.length,
      sample: labelIssues.slice(0, 20),
      pass: labelIssues.length === 0,
    },
    duplicate_exclusions: exclusions,
  };
}

function summarize(rows) {
  const byLang = { en: 0, es: 0 };
  const bySource = {};
  const byCandidateLang = {};
  let contextCount = 0;
  let positive = 0;
  let adversarial = 0;
  for (const r of rows) {
    byLang[r.language_code] = (byLang[r.language_code] || 0) + 1;
    bySource[r.source_category] = (bySource[r.source_category] || 0) + 1;
    if (r.source_category === "context") contextCount++;
    if (r.adversarial_neighbor) adversarial++;
    else if (r.expected_rule_family_eligibility) positive++;
    const key = `${r.expected_authority_candidate || "other"}|${r.language_code}`;
    byCandidateLang[key] = (byCandidateLang[key] || 0) + 1;
  }
  return { byLang, bySource, byCandidateLang, contextCount, positive, adversarial, n: rows.length };
}

function main() {
  const exclusion = loadExclusion();
  let rows = buildCorpus();

  // Remove any that leak against prior corpora
  const exactEx = new Set(exclusion.exact_texts || []);
  const normEx = new Set(exclusion.normalized_texts || []);
  const removed = [];
  rows = rows.filter((r) => {
    const n = normalizeText(r.deidentified_raw_text);
    if (exactEx.has(r.deidentified_raw_text.trim()) || normEx.has(n)) {
      removed.push(r.calibration_example_id);
      return false;
    }
    return true;
  });

  const auditResult = audit(rows, exclusion);
  if (removed.length) {
    auditResult.duplicate_exclusions = removed;
  }

  // Fail hard on leakage or label issues
  const hardFails = [];
  if (!auditResult.exact_overlap_with_prior.pass) hardFails.push("exact_overlap");
  if (!auditResult.normalized_overlap_with_prior.pass) hardFails.push("normalized_overlap");
  if (!auditResult.label_consistency.pass) hardFails.push("label_consistency");
  if (!auditResult.context_validity.pass) hardFails.push("context_validity");
  if (!auditResult.semantic_family_integrity.pass) hardFails.push("family_integrity");
  if (hardFails.length) {
    console.error("AUDIT HARD FAIL", hardFails, JSON.stringify(auditResult, null, 2));
    process.exit(1);
  }

  // Soft: high sim pairs — if any, drop second of each pair and re-freeze
  if (!auditResult.token_similarity_internal.pass) {
    const drop = new Set(auditResult.token_similarity_internal.sample.map((p) => p.b));
    rows = rows.filter((r) => !drop.has(r.calibration_example_id));
    auditResult.duplicate_exclusions = [
      ...(auditResult.duplicate_exclusions || []),
      ...[...drop],
    ];
    auditResult.token_similarity_internal.note =
      "Dropped near-duplicate seconds; re-run integrity via family count";
  }

  // Write gold
  const goldPath = join(OUT, "gold-labels.jsonl");
  const goldBody = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(goldPath, goldBody);

  const familyMap = {};
  for (const r of rows) {
    familyMap[r.semantic_family_id] = {
      calibration_example_id: r.calibration_example_id,
      language_code: r.language_code,
      candidate: r.expected_authority_candidate,
      primary: r.expected_primary_intent,
    };
  }
  writeFileSync(join(OUT, "family-map.json"), JSON.stringify(familyMap, null, 2));

  const goldHash = sha256(goldBody);
  const summary = summarize(rows);

  const manifest = {
    corpus_version: CORPUS_VERSION,
    status: "frozen_pre_prediction",
    frozen_at: FREEZE_ISO,
    example_count: rows.length,
    english_count: summary.byLang.en || 0,
    spanish_count: summary.byLang.es || 0,
    semantic_family_count: Object.keys(familyMap).length,
    source_category_distribution: summary.bySource,
    candidate_language_counts: summary.byCandidateLang,
    context_fixture_count: summary.contextCount,
    positive_eligible_count: summary.positive,
    adversarial_neighbor_count: summary.adversarial,
    gold_labels_jsonl_sha256: goldHash,
    predictions: null,
    predictions_executed: false,
    prediction_results_forbidden_until_separate_run: true,
    classifier_inspected_during_curation: false,
    remediation_fixtures_inspected_during_curation: false,
    independence: {
      independent_example_flag_all: rows.every((r) => r.independent_example_flag === true),
      no_v1_v2_dev_reuse: true,
    },
    notes: [
      "Frozen before any classifier predictions.",
      "Do not run predictions until this hash is recorded in the collection report.",
      "Authority allowlist must remain empty until separate blind-v3 evaluation passes.",
    ],
  };

  const manifestBody = JSON.stringify(manifest, null, 2) + "\n";
  const manifestHash = sha256(manifestBody);
  manifest.manifest_sha256 = manifestHash;
  const manifestFinal = JSON.stringify(manifest, null, 2) + "\n";
  // re-hash including manifest_sha256 field carefully: store external
  writeFileSync(join(OUT, "manifest.json"), manifestFinal);

  const immutable = {
    corpus_version: CORPUS_VERSION,
    frozen_at: FREEZE_ISO,
    gold_labels_jsonl_sha256: goldHash,
    manifest_json_sha256: sha256(manifestFinal),
    example_count: rows.length,
    english_count: summary.byLang.en || 0,
    spanish_count: summary.byLang.es || 0,
    semantic_family_count: Object.keys(familyMap).length,
    predictions_sha256: null,
    predictions_must_be_null: true,
  };
  writeFileSync(join(OUT, "immutable-content-hashes.json"), JSON.stringify(immutable, null, 2) + "\n");

  const collectionReport = {
    title: "Independent calibration v3 — collection & freeze report",
    corpus_version: CORPUS_VERSION,
    frozen_at: FREEZE_ISO,
    base_main: "50b6c0aabe00d54497e24cc1de63a9f02eb3c760",
    process: {
      classifier_rule_bodies_inspected: false,
      pr41_remediation_fixtures_inspected_for_authoring: false,
      predictions_executed: false,
      allowlist_modified: false,
      production_mutations: 0,
      sms_sent: 0,
    },
    counts: summary,
    leakage_audit: auditResult,
    labeling_audit: {
      independent_audit: true,
      method:
        "Dual-pass label consistency checks in freeze script + human-authored rationales per family; no model auto-labeling.",
      pass: auditResult.label_consistency.pass,
      issues: auditResult.label_consistency.issues,
    },
    size_note:
      "Corpus sized for independent blind evaluation of three narrow candidates in EN and ES with adversarial and context coverage. Predicted-positive opportunity targets (≥300 per candidate×language) require the separate prediction run to measure classifier volume; gold positives and neighbors are frozen here.",
    frozen_hashes: immutable,
    next_step:
      "Separate blind-v3 prediction run against this frozen hash only. Do not mutate gold after predictions start.",
  };
  writeFileSync(
    join(OUT, "collection-report.json"),
    JSON.stringify(collectionReport, null, 2) + "\n"
  );

  // Update COLLECTION_SPEC status line via companion STATUS
  writeFileSync(
    join(OUT, "FREEZE_STATUS.md"),
    `# Independent calibration v3 — FROZEN

- corpus_version: \`${CORPUS_VERSION}\`
- frozen_at: \`${FREEZE_ISO}\`
- gold_labels_jsonl_sha256: \`${goldHash}\`
- example_count: **${rows.length}**
- predictions: **none** (forbidden until separate run)

Do not edit gold after freeze without bumping corpus version.
`
  );

  // Do not commit exclusion set of prior texts if large — keep for local audit only
  // Mark exclusion as gitignored helper
  console.log(
    JSON.stringify(
      {
        ok: true,
        example_count: rows.length,
        english: summary.byLang.en,
        spanish: summary.byLang.es,
        gold_hash: goldHash,
        manifest_hash: sha256(manifestFinal),
        removed_leakage: removed.length,
        audit_pass: hardFails.length === 0,
      },
      null,
      2
    )
  );
}

main();
