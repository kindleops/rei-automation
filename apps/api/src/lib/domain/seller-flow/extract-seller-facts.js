// ─── extract-seller-facts.js ─────────────────────────────────────────────────
// Deterministic, evidence-backed structured-fact extraction for seller
// conversations. This is NOT a classifier — classify.js remains the only
// production intent classifier. This module converts explicit message
// evidence into typed facts with provenance so downstream consumers (the
// stage-transition resolver, deal persistence, Workflow Studio) never act on
// a fact that cannot be traced to the exact words that produced it.
//
// Design rules (activation-readiness spec):
//   • Facts come from explicit evidence only — weak evidence extracts nothing.
//     "The house has a roof" is a feature, not a defect. "I work nights" is a
//     schedule, not property work. "That offer could work" is not a repair.
//   • Every fact carries: normalized value, confidence, source message id,
//     exact evidence text, evidence position, timestamp, extractor version,
//     needs_review flag and (where applicable) a conflict flag.
//   • Authority is claim-tracking, never verification: authority_verified is
//     false unless an external authoritative event says otherwise. "I own it"
//     confirms an ownership claim, not sole signing authority.
//   • Monetary understanding is delegated to monetary-understanding.js (the
//     existing production module) — no second price parser.

import {
  resolveAskingPriceSignal,
} from "@/lib/domain/seller-flow/monetary-understanding.js";

export const SELLER_FACT_EXTRACTOR_VERSION = "seller_fact_extractor_v1";

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

/**
 * Find the first regex match and return {text, index} evidence, scanning the
 * original (case-preserved) message so evidence_text is the seller's words.
 */
function findEvidence(message, regex) {
  const match = regex.exec(message);
  if (!match) return null;
  return { text: match[0].trim(), index: match.index };
}

function fact(value, { confidence, evidence, sourceMessageId, now, needsReview = false, conflict = false }) {
  return {
    value,
    confidence,
    source_message_id: sourceMessageId || null,
    evidence_text: evidence?.text || null,
    evidence_index: Number.isInteger(evidence?.index) ? evidence.index : null,
    extracted_at: now,
    extractor_version: SELLER_FACT_EXTRACTOR_VERSION,
    needs_review: Boolean(needsReview),
    conflict: Boolean(conflict),
  };
}

// ── Repairs / condition ──────────────────────────────────────────────────────
// A repair item extracts only when a component co-occurs with defect language
// in the same clause. Component mention alone ("has a roof and two bathrooms")
// must extract nothing.

const REPAIR_COMPONENTS = [
  { key: "roof", re: /\broof|techo\b/i },
  { key: "hvac", re: /\bhvac|furnace|a\/?c\b|air condition|heater|heating|calefacci[oó]n|aire acondicionado/i },
  { key: "plumbing", re: /\bplumbing|pipes?|water heater|plomer[ií]a|tuber[ií]a/i },
  { key: "electrical", re: /\belectric(al|ity)?|wiring|panel|el[eé]ctric/i },
  { key: "foundation", re: /\bfoundation|cimientos?|slab\b/i },
  { key: "water_damage_mold", re: /\bmold|mildew|water damage|flood(ed|ing)?|moho|inundaci[oó]n/i },
  { key: "windows", re: /\bwindows?|ventanas?\b/i },
  { key: "flooring", re: /\bfloor(s|ing)?|carpet|pisos?\b/i },
  { key: "kitchen_bath", re: /\bkitchen|bathrooms?|ba[nñ]os?|cocina\b/i },
  { key: "fire_damage", re: /\bfire damage|burned|quemad/i },
  { key: "termites", re: /\btermites?|termitas?\b/i },
  { key: "sewer_septic", re: /\bsewer|septic|drenaje\b/i },
];

const DEFECT_CUE_RE =
  /\bleak(s|ing|y|ed)?|broken?|busted|fail(s|ed|ing)?|doesn'?t work|not working|needs? (a |to be |some )?(repair|replac|fix|work|updat|remodel)|needs? new|cracked|crack(s|ing)?|damaged?|rotted|rotten|outdated|falling apart|caving|hole in|issues? with|problems? with|bad shape|rough shape|old and|gotea(ndo)?|da[nñ]ad[oa]|rot[oa]\b|necesita (reparaci|arreglo|cambi)|fugas?\b|se est[aá] cayendo/i;

const MAJOR_SEVERITY_COMPONENTS = new Set([
  "foundation",
  "fire_damage",
  "water_damage_mold",
  "sewer_septic",
  "termites",
]);

const MAJOR_SEVERITY_CUE_RE =
  /\bneeds? (a )?new roof|roof.{0,24}replac|replac.{0,18}roof|full (rehab|remodel|gut)|gut(ted)?\b|complete remodel|down to the studs|condemned|uninhabitable|no habitable/i;

const NO_REPAIRS_RE =
  /\bno repairs?( needed| necessary)?\b|doesn'?t need (any )?(repairs?|work|anything)|nothing (needs|wrong)|move[- ]?in ready|turn[- ]?key\b|(great|good|excellent|perfect|mint) (shape|condition)|well maintained|fully (renovated|remodeled|updated)|recently (renovated|remodeled|updated)|no necesita (reparaciones|arreglos|nada)|(buenas?|excelentes?) condiciones|todo est[aá] bien|reci[eé]n remodelad/i;

// Guard: "I work nights", "that could work", "work with you" must never read
// as property work. Defect matching runs per-clause against property context.
function splitClauses(message) {
  return String(message || "")
    .split(/(?<=[.!?;])\s+|,\s+(?=\w)/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function extractRepairs(message, base) {
  const items = [];
  for (const clause of splitClauses(message)) {
    if (!DEFECT_CUE_RE.test(clause)) continue;
    for (const component of REPAIR_COMPONENTS) {
      if (!component.re.test(clause)) continue;
      const severity =
        MAJOR_SEVERITY_COMPONENTS.has(component.key) || MAJOR_SEVERITY_CUE_RE.test(clause)
          ? "major"
          : "standard";
      items.push({
        item: component.key,
        severity,
        evidence_text: clause,
      });
    }
    // Defect language with no named component ("needs a lot of work") is a
    // general condition disclosure, not an itemized repair.
    if (!items.length && /\bneeds? (a lot of |some |major |mucho )?(work|repairs?|trabajo|reparaciones)\b/i.test(clause) && !/\bi work|we work|trabajo (en|de) (noche|d[ií]a)/i.test(clause)) {
      items.push({ item: "general", severity: "standard", evidence_text: clause });
    }
  }
  if (!items.length) return null;
  const severity = items.some((i) => i.severity === "major") ? "major" : "standard";
  const evidence = { text: items[0].evidence_text, index: message.indexOf(items[0].evidence_text) };
  return fact(
    { repairs_needed: true, items, severity },
    { ...base, confidence: 0.85, evidence }
  );
}

function extractCondition(message, base) {
  const noRepairs = findEvidence(message, new RegExp(NO_REPAIRS_RE.source, "i"));
  if (noRepairs) {
    return fact(
      { condition_level: "good", repairs_needed: false, seller_words: noRepairs.text },
      { ...base, confidence: 0.85, evidence: noRepairs }
    );
  }
  return null;
}

// ── Timeline ─────────────────────────────────────────────────────────────────

const TIMELINE_RULES = [
  { urgency: "immediate", re: /\basap\b|right away|immediately|as soon as possible|this week|yesterday if|lo antes posible|inmediatamente|cuanto antes|esta semana/i },
  { urgency: "soon", re: /\bthis month|within (a|one|two|\d+) (month|months|weeks?)|next month|(30|60|90) days|in a (few|couple) (of )?(weeks?|months?)|este mes|pr[oó]ximo mes|en unos meses/i },
  { urgency: "flexible", re: /\bno (rush|hurry)|whenever|not in a hurry|flexible on timing|sin prisa|no hay prisa/i },
  { urgency: "long_term", re: /\bnext year|in a year|not (until|for) (a year|next)|maybe (next|in the) (year|spring|summer|fall|winter)|el pr[oó]ximo a[nñ]o/i },
];

function extractTimeline(message, base) {
  for (const rule of TIMELINE_RULES) {
    const evidence = findEvidence(message, new RegExp(rule.re.source, "i"));
    if (evidence) {
      return fact({ urgency: rule.urgency, raw: evidence.text }, { ...base, confidence: 0.8, evidence });
    }
  }
  return null;
}

// ── Occupancy ────────────────────────────────────────────────────────────────

const OCCUPANCY_RULES = [
  { status: "tenant_occupied", re: /\btenants? (live|living|there|in it|occup)|renters? (live|living|in it)|it'?s rented|i rent it out|rented out|inquilinos?\b|est[aá] rentad|arrendatario/i },
  { status: "vacant", re: /\bvacant|empty|no one (lives|living)|nobody (lives|living)|sitting empty|boarded( |-)?up|desocupad|vac[ií]a|nadie vive/i },
  { status: "owner_occupied", re: /\b(i|we) live (in|there|here)|my primary (home|residence)|owner[- ]occupied|vivo (aqu[ií]|ah[ií]|en la casa)|vivimos (aqu[ií]|ah[ií])/i },
];

function extractOccupancy(message, base) {
  for (const rule of OCCUPANCY_RULES) {
    const evidence = findEvidence(message, new RegExp(rule.re.source, "i"));
    if (evidence) {
      return fact({ occupancy_status: rule.status }, { ...base, confidence: 0.85, evidence });
    }
  }
  return null;
}

// ── Listing / agent involvement ──────────────────────────────────────────────

const LISTING_RULES = [
  { status: "listed_with_agent", re: /\blisted with (an? )?(agent|realtor|broker)|it'?s (already )?listed|on the (mls|market)|my (realtor|agent|broker) (has|is|listed)|est[aá] listada|con un agente/i },
  { status: "agent_involved", re: /\btalk to my (agent|realtor|broker)|my (agent|realtor|broker) (handles|will)|through my (agent|realtor)|habla con mi agente/i },
  { status: "fsbo", re: /\bfor sale by owner|selling it (myself|ourselves)|no agent|sin agente|la vendo yo/i },
];

function extractListingStatus(message, base) {
  for (const rule of LISTING_RULES) {
    const evidence = findEvidence(message, new RegExp(rule.re.source, "i"));
    if (evidence) {
      return fact({ listing_status: rule.status }, { ...base, confidence: 0.85, evidence });
    }
  }
  return null;
}

// ── Offer interest ───────────────────────────────────────────────────────────

const OFFER_INTEREST_RE =
  /\bmake (me|us) an offer|what('?s| is) your offer|send (me |us )?(an|the|your) offer|what (would|will|can) you (pay|offer|give)|how much (would|will|can) you (pay|offer|give)|i'?d (listen to|consider|entertain) an offer|open to (an offer|offers|hearing)|h[aá]game una oferta|cu[aá]nto (me )?(ofrece|dar[ií]a|pagar[ií]a)/i;

function extractOfferInterest(message, base) {
  const evidence = findEvidence(message, new RegExp(OFFER_INTEREST_RE.source, "i"));
  if (!evidence) return null;
  return fact({ wants_offer: true }, { ...base, confidence: 0.9, evidence });
}

// ── Objections (explicit only) ──────────────────────────────────────────────

const OBJECTION_RULES = [
  { objection: "price_too_low", re: /\btoo low|lowball|low[- ]?ball|insulting|that'?s (way )?(too )?low|not (selling|going) (it )?(that|for that) (cheap|low)|worth (way |much )?more|muy (bajo|poco)|demasiado bajo/i },
  { objection: "trust_concern", re: /\bis this a scam|sounds like a scam|how do i know (this is|you'?re) (real|legit)|proof of funds|are you (real|legit|a real)|es una estafa|c[oó]mo s[eé] que/i },
  { objection: "not_ready", re: /\bnot ready (yet|to sell)|need (more )?time|thinking about it|haven'?t decided|todav[ií]a no|necesito (m[aá]s )?tiempo|lo estoy pensando/i },
  { objection: "family_signoff", re: /\b(ask|talk to|check with|discuss with) my (wife|husband|spouse|family|kids|son|daughter|brother|sister)|we need to (talk|discuss)|consultar(lo)? con mi/i },
];

function extractObjections(message, base) {
  const found = [];
  let firstEvidence = null;
  for (const rule of OBJECTION_RULES) {
    const evidence = findEvidence(message, new RegExp(rule.re.source, "i"));
    if (evidence) {
      found.push({ objection: rule.objection, evidence_text: evidence.text });
      if (!firstEvidence) firstEvidence = evidence;
    }
  }
  if (!found.length) return null;
  return fact({ objections: found.map((f) => f.objection), detail: found }, { ...base, confidence: 0.8, evidence: firstEvidence });
}

// ── Ownership claims (evidence layer — routing stays in classify.js and
//    resolve-inbound-relationship.js) ─────────────────────────────────────────

const OWNERSHIP_POSITIVE_RE =
  /\b(yes,? )?(i|we) own (it|that|this|the (house|property|place|home))|it'?s (my|our) (house|property|place|home)|i'?m the owner|that'?s (my|our) (house|property)|(soy|somos) (el|la|los) due[nñ][oa]s?|es (mi|nuestra) (casa|propiedad)/i;

const OWNERSHIP_NEGATIVE_RE =
  /\b(i|we) (don'?t|do not|never) own(ed)?|not (my|the owner'?s?|mine)|it'?s not mine|wrong (number|person)|(i|we) sold (it|that|the)|no longer (own|mine)|i('?m| am) (just )?(the |a )?(tenant|renter)|i('?m| am) renting|no soy (el|la) due[nñ][oa]|ya (la|lo) vend[ií]/i;

function extractOwnership(message, base) {
  const positive = findEvidence(message, new RegExp(OWNERSHIP_POSITIVE_RE.source, "i"));
  const negative = findEvidence(message, new RegExp(OWNERSHIP_NEGATIVE_RE.source, "i"));
  if (positive && negative) {
    return fact(
      { ownership_claim: "contradictory" },
      { ...base, confidence: 0.4, evidence: positive, needsReview: true, conflict: true }
    );
  }
  if (positive) {
    // An ownership claim is a claim: it does not prove sole signing authority.
    return fact({ ownership_claim: "confirmed" }, { ...base, confidence: 0.9, evidence: positive });
  }
  if (negative) {
    return fact({ ownership_claim: "denied" }, { ...base, confidence: 0.9, evidence: negative });
  }
  return null;
}

// ── Authority / signer claims ────────────────────────────────────────────────
// Claims only. authority_verified is ALWAYS false here; verification comes
// from external authoritative events (title/contract engine), never from text.

const AUTHORITY_RULES = [
  {
    type: "executor",
    re: /\bi('?m| am) the (executor|executrix)|executor of (the|my|her|his)|soy (el|la) albacea/i,
  },
  {
    type: "trustee",
    re: /\bi('?m| am) the trustee|as trustee|it'?s in a trust and i|soy (el|la) fideicomisari/i,
  },
  {
    type: "poa",
    re: /\bpower of attorney|i have poa|hold(s)? poa|poder notarial/i,
  },
  {
    type: "heir",
    re: /\b(i|we) inherited|left (it )?to (me|us)|my (late|deceased) (mother|father|husband|wife|parents?)('s)? (house|property|home)|lo hered/i,
  },
  {
    type: "entity_representative",
    re: /\b(my|our|the) (llc|company|business|corporation) owns|owned by (my|our|an?) (llc|company|corporation)|es de (mi|la) empresa/i,
  },
];

const SPOUSE_ON_TITLE_RE =
  /\b(my )?(wife|husband|spouse|esposa?|esposo)('s name)? (is )?(also )?on (the )?(title|deed|escritura)|both (of us|our names) (are )?on (the )?(title|deed)|(wife|husband|spouse).{0,40}(has to|must|needs to|will have to) sign|(los dos|ambos) (estamos|firmamos)/i;

const CO_OWNER_RE =
  /\b(my|our) (brother|sister|siblings?|partner|son|daughter|mother|father|family) (and i )?(own|co-?own)|we own it together|co-?owner|due[nñ]os? junto/i;

function extractAuthority(message, ownershipFact, base) {
  const claims = [];
  const additional_signers = [];
  let firstEvidence = null;

  for (const rule of AUTHORITY_RULES) {
    const evidence = findEvidence(message, new RegExp(rule.re.source, "i"));
    if (evidence) {
      claims.push(rule.type);
      if (!firstEvidence) firstEvidence = evidence;
    }
  }

  const spouseEvidence = findEvidence(message, new RegExp(SPOUSE_ON_TITLE_RE.source, "i"));
  if (spouseEvidence) {
    additional_signers.push({ relationship: "spouse", basis: "claimed_on_title_or_must_sign" });
    if (!firstEvidence) firstEvidence = spouseEvidence;
  }

  const coOwnerEvidence = findEvidence(message, new RegExp(CO_OWNER_RE.source, "i"));
  if (coOwnerEvidence) {
    claims.push("co_owner");
    additional_signers.push({ relationship: "co_owner", basis: "claimed_co_ownership" });
    if (!firstEvidence) firstEvidence = coOwnerEvidence;
  }

  if (!claims.length && !additional_signers.length) return null;

  const authority_type = claims[0] || (additional_signers.length ? "co_owner" : "unknown");
  return fact(
    {
      authority_type,
      authority_claimed: true,
      authority_verified: false,
      can_execute_alone: additional_signers.length ? false : null,
      additional_signers_claimed: additional_signers,
      requires_authority_review: true,
    },
    { ...base, confidence: 0.85, evidence: firstEvidence, needsReview: true }
  );
}

// ── Reason for selling (explicit only) ───────────────────────────────────────

const REASON_RULES = [
  { reason: "divorce", re: /\bdivorce|divorcio|separat(ed|ing|ion)/i },
  { reason: "inherited_probate", re: /\binherit(ed|ance)|probate|estate sale|herencia|sucesi[oó]n/i },
  { reason: "relocating", re: /\b(re)?locat(ing|e|ed)( out| to)?|moving (to|out of|away)|got a job in|me mudo|nos mudamos/i },
  { reason: "financial_pressure", re: /\bbehind on (payments|the mortgage|taxes)|foreclosure|can'?t afford|back taxes|atrasado en los pagos|ejecuci[oó]n hipotecaria/i },
  { reason: "tired_landlord", re: /\btired of (tenants|renting|being a landlord)|tenants? (trashed|destroyed)|done being a landlord|cansado de (los inquilinos|rentar)/i },
  { reason: "health", re: /\bhealth (issues|problems|reasons)|too (old|sick) to|assisted living|nursing home|problemas de salud/i },
];

function extractReasonForSelling(message, base) {
  for (const rule of REASON_RULES) {
    const evidence = findEvidence(message, new RegExp(rule.re.source, "i"));
    if (evidence) {
      return fact({ reason: rule.reason }, { ...base, confidence: 0.75, evidence });
    }
  }
  return null;
}

// ── Preferred contact instructions (explicit only) ──────────────────────────

const CONTACT_RULES = [
  { instruction: "call_only", re: /\b(just |please )?call me|prefer (a )?(phone )?call|don'?t text,? call|ll[aá]m[ae]me|prefiero (una )?llamada/i },
  { instruction: "no_calls", re: /\bdon'?t call|text only|no (phone )?calls|no me llames?|solo mensajes/i },
  { instruction: "email", re: /\bemail me|send (it )?(by|via|to my) email|correo electr[oó]nico|env[ií]ame un correo/i },
  { instruction: "time_window", re: /\b(call|text|reach) (me )?(only )?(after|before|between) [0-9]|after (work|5|6|7)pm?|evenings? (only|are best)|weekends? only|despu[eé]s de las \d/i },
];

function extractContactInstructions(message, base) {
  const found = [];
  let firstEvidence = null;
  for (const rule of CONTACT_RULES) {
    const evidence = findEvidence(message, new RegExp(rule.re.source, "i"));
    if (evidence) {
      found.push({ instruction: rule.instruction, evidence_text: evidence.text });
      if (!firstEvidence) firstEvidence = evidence;
    }
  }
  if (!found.length) return null;
  return fact({ instructions: found }, { ...base, confidence: 0.8, evidence: firstEvidence });
}

// ── Explicit language requests ───────────────────────────────────────────────
// A lightweight evidence record only. Thread language continuity is resolved
// by resolve-thread-language.js — this never overwrites canonical language.

const LANGUAGE_CLAIM_RULES = [
  { language: "Spanish", re: /\ben espa[nñ]ol( por favor)?|hablo espa[nñ]ol|no (hablo|entiendo) ingl[eé]s|spanish please|in spanish/i },
  { language: "English", re: /\bin english( please)?|english only|no spanish/i },
];

function extractLanguageClaim(message, base) {
  for (const rule of LANGUAGE_CLAIM_RULES) {
    const evidence = findEvidence(message, new RegExp(rule.re.source, "i"));
    if (evidence) {
      return fact({ language: rule.language, explicit_request: true }, { ...base, confidence: 0.95, evidence });
    }
  }
  return null;
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Extract evidence-backed structured facts from one inbound seller message.
 *
 * @param {object} args
 * @param {string} args.message - Raw inbound message body.
 * @param {string|number} [args.sourceMessageId] - message_events id / provider sid.
 * @param {object} [args.priceSignal] - Precomputed resolveAskingPriceSignal result
 *   (the orchestrator already computes it with negotiation context; passing it
 *   avoids double-parsing and keeps one monetary authority).
 * @param {object} [args.priceSignalOptions] - Options when priceSignal is absent.
 * @param {string} [args.now] - Injectable ISO timestamp for deterministic tests.
 */
export function extractSellerFacts({
  message = "",
  sourceMessageId = null,
  priceSignal = null,
  priceSignalOptions = {},
  now = new Date().toISOString(),
} = {}) {
  const text = clean(message);
  const base = { sourceMessageId, now };

  const result = {
    extractor_version: SELLER_FACT_EXTRACTOR_VERSION,
    extracted_at: now,
    source_message_id: sourceMessageId || null,
    facts: {},
    conflicts: [],
    needs_review: false,
    asking_price_needs_clarification: false,
  };

  if (!text) return result;

  // Asking price — delegated to the existing monetary authority.
  const price = priceSignal || resolveAskingPriceSignal(text, { ...priceSignalOptions, sourceMessageId });
  if (price?.asking_price?.value > 0) {
    result.facts.asking_price = fact(
      {
        amount: price.asking_price.value,
        price_type: price.asking_price.price_type || "exact",
        range: price.asking_price.range || null,
        is_counter: Boolean(price.is_counter),
      },
      {
        ...base,
        confidence: price.asking_price.confidence ?? 0.7,
        evidence: price.asking_price.extracted_text
          ? { text: price.asking_price.extracted_text, index: text.indexOf(price.asking_price.extracted_text) }
          : null,
      }
    );
  } else if (price?.needs_clarification) {
    result.asking_price_needs_clarification = true;
    result.needs_review = true;
    result.conflicts.push({
      field: "asking_price",
      reason: price.clarification_reason || "ambiguous_monetary_statement",
    });
  }

  const repairs = extractRepairs(text, base);
  if (repairs) result.facts.repairs = repairs;

  const condition = extractCondition(text, base);
  if (condition) {
    if (repairs) {
      // "Good condition but the roof leaks" — keep both, flag the conflict.
      condition.conflict = true;
      repairs.conflict = true;
      result.conflicts.push({ field: "condition", reason: "no_repairs_claim_with_repair_evidence" });
      result.needs_review = true;
    }
    result.facts.condition = condition;
  }

  const timeline = extractTimeline(text, base);
  if (timeline) result.facts.timeline = timeline;

  const occupancy = extractOccupancy(text, base);
  if (occupancy) result.facts.occupancy = occupancy;

  const listing = extractListingStatus(text, base);
  if (listing) result.facts.listing_status = listing;

  const offerInterest = extractOfferInterest(text, base);
  if (offerInterest) result.facts.offer_interest = offerInterest;

  const objections = extractObjections(text, base);
  if (objections) result.facts.objections = objections;

  const ownership = extractOwnership(text, base);
  if (ownership) {
    result.facts.ownership = ownership;
    if (ownership.conflict) {
      result.conflicts.push({ field: "ownership", reason: "contradictory_ownership_statements" });
      result.needs_review = true;
    }
  }

  const authority = extractAuthority(text, ownership, base);
  if (authority) {
    result.facts.authority = authority;
    result.needs_review = true; // authority claims always require review
  }

  const reason = extractReasonForSelling(text, base);
  if (reason) result.facts.reason_for_selling = reason;

  const contact = extractContactInstructions(text, base);
  if (contact) result.facts.contact_instructions = contact;

  const languageClaim = extractLanguageClaim(text, base);
  if (languageClaim) result.facts.language_claim = languageClaim;

  return result;
}

/**
 * Project extraction output into the flat fact keys the stage-transition
 * resolver understands (mergeSellerFacts). Only resolver-relevant scalars —
 * the full evidence payload stays on the extraction record itself.
 */
export function extractionToResolverFacts(extraction = null) {
  if (!extraction || typeof extraction !== "object") return {};
  const facts = extraction.facts || {};
  const out = { extractor_version: extraction.extractor_version || SELLER_FACT_EXTRACTOR_VERSION };

  if (facts.repairs?.value?.repairs_needed) {
    out.repairs_summary = (facts.repairs.value.items || [])
      .map((item) => `${item.item}:${item.severity}`)
      .join(", ") || "repairs_disclosed";
    out.condition_disclosed = true;
  }
  if (facts.condition?.value?.repairs_needed === false && !facts.repairs) {
    out.repairs_needed = false;
    out.condition_level = facts.condition.value.condition_level || "good";
    out.condition_disclosed = true;
  }
  if (facts.occupancy?.value?.occupancy_status) {
    out.occupancy_status = facts.occupancy.value.occupancy_status;
  }
  if (facts.timeline?.value?.urgency) {
    out.timeline = facts.timeline.value.urgency;
  }
  if (facts.offer_interest?.value?.wants_offer) {
    out.wants_offer = true;
  }
  if (facts.listing_status?.value?.listing_status) {
    out.listing_status = facts.listing_status.value.listing_status;
  }
  if (facts.authority?.value) {
    out.authority_claims = facts.authority.value;
  }
  if (facts.ownership?.value?.ownership_claim === "confirmed") {
    // A claim, not verified sole authority — the resolver's ownership predicate
    // treats "confirmed" as the S1 milestone exactly as classify.js does today.
    out.ownership_claim_evidence = facts.ownership.evidence_text || null;
  }
  if (
    facts.ownership?.value?.ownership_claim === "contradictory" ||
    facts.ownership?.conflict === true ||
    (extraction.conflicts || []).some((c) => c?.field === "ownership")
  ) {
    // Contradictory ownership in one message is never settled truth — the
    // resolver's conflict guard holds the stage and routes to human review.
    out.ownership_conflict = true;
  }
  if (facts.reason_for_selling?.value?.reason) {
    out.reason_for_selling = facts.reason_for_selling.value.reason;
  }

  return out;
}

export default extractSellerFacts;
