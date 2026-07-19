#!/usr/bin/env node
/**
 * Build methodology overlays for acquisition_brain_adversarial_development_pack_v3.
 * READS gold-labels.jsonl only. NEVER writes gold-labels.jsonl or frozen hashes.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const GOLD = join(ROOT, "gold-labels.jsonl");

const EXPECTED_GOLD =
  "dcbfdea9b54e60dceeaca750be7db4ba67de9f5169ba0e77e90437c3816d7b3d";

function sha256(s) {
  return createHash("sha256").update(String(s), "utf8").digest("hex");
}

function norm(t) {
  return String(t || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function loadGold() {
  const body = readFileSync(GOLD, "utf8");
  const h = sha256(body);
  if (h !== EXPECTED_GOLD) {
    throw new Error(
      `gold-labels.jsonl hash mismatch: got ${h}, expected ${EXPECTED_GOLD}. Refuse to proceed.`
    );
  }
  return body
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** True family keys from construction, not surface uniqueness. */
function trueFamilyKey(row) {
  const t = norm(row.deidentified_raw_text);
  const lang = row.language_code;
  const cand = row.expected_authority_candidate || "other";
  const ctx = row.preceding_outbound_use_case || "none";
  const primary = row.expected_primary_intent;

  // Context short replies: family = reply_token × outbound use case × lang
  if (row.source_category === "context") {
    const token = t.replace(/[^a-z0-9\s]/g, "").trim() || "empty";
    return `ctx|${lang}|${ctx}|${token}`;
  }

  // Ownership positives
  if (cand === "clear_ownership_confirmation" || primary === "ownership_confirmed") {
    if (/\b(title|titulo|titular|deed|escritura|deeded|fee simple|vested|grantee|of record|registr)\b/.test(t))
      return `own|${lang}|title_holder_of_record`;
    if (/\b(still|sigo|todavia|contin|remain|retains?|mantengo|has not changed|no ha cambiado)\b/.test(t))
      return `own|${lang}|still_own_retain`;
    if (/\b(mine|mia|mio|belongs to me|me pertenece|is mine|es mia|es mio)\b/.test(t))
      return `own|${lang}|property_is_mine`;
    if (/\b(sole|unico|exclusiv|100%|plena|alone)\b/.test(t))
      return `own|${lang}|sole_owner`;
    if (/\b(homeowner|propietario|dueno|dueño|owner of|soy el)\b/.test(t))
      return `own|${lang}|explicit_owner_claim`;
    if (/\b(legal|legitimo|legítimo|current|actual)\b/.test(t))
      return `own|${lang}|legal_current_owner`;
    return `own|${lang}|general_ownership_affirmation`;
  }

  // Proposal positives
  if (cand === "clear_seller_requests_proposal" || primary === "asks_offer") {
    if (/\b(written|escrito|por escrito|pdf|formal|loi|carta de intencion)\b/.test(t))
      return `prop|${lang}|written_formal_proposal`;
    if (/\b(numbers?|numeros|números|math|economics|desglose|spreadsheet|worksheet)\b/.test(t))
      return `prop|${lang}|send_numbers_economics`;
    if (/\b(cash|contado|efectivo|all-cash|all cash)\b/.test(t))
      return `prop|${lang}|cash_offer_request`;
    if (/\b(terms?|terminos|términos|structure|parametros|parámetros)\b/.test(t))
      return `prop|${lang}|purchase_terms_structure`;
    if (/\b(range|rango|band|precio de compra|purchase price|contract price)\b/.test(t))
      return `prop|${lang}|price_range_from_buyer`;
    if (/\b(proposal|propuesta|offer|oferta|bid|quote|cotizacion|cotización)\b/.test(t))
      return `prop|${lang}|generic_proposal_request`;
    return `prop|${lang}|other_proposal_request`;
  }

  // Price positives
  if (cand === "clear_asking_price_disclosure" || primary === "asking_price_provided") {
    if (/\b(between|rango|a \d|and \d|entre)\b/.test(t) || /\d\s*-\s*\d/.test(t))
      return `price|${lang}|range_ask`;
    if (/\b(no less|minimum|minimo|mínimo|floor|piso|not under|no menos)\b/.test(t))
      return `price|${lang}|floor_minimum`;
    if (/\b(firm|firmes|bottom|walk-away|reservation)\b/.test(t))
      return `price|${lang}|firm_or_bottom`;
    if (/\b(net|netos)\b/.test(t)) return `price|${lang}|net_to_seller`;
    if (/\b(asking|pido|pidiendo|ask|precio de venta|sale price|seller)\b/.test(t))
      return `price|${lang}|explicit_asking_price`;
    return `price|${lang}|stated_desired_amount`;
  }

  // Adversarial / neighbors by primary
  if (primary === "opt_out") return `term|${lang}|opt_out`;
  if (primary === "hostile_or_legal") return `term|${lang}|hostile_legal`;
  if (primary === "wrong_number") {
    if (/\b(sold|vend|closed|transfer|quitclaim|foreclos|bank owns|ya lo|ya la)\b/.test(t))
      return `disc|${lang}|sold_or_transferred`;
    if (/\b(never|nunca)\b/.test(t)) return `disc|${lang}|never_owned`;
    if (/\b(wrong|equivoc|incorrect|not this|persona)\b/.test(t))
      return `disc|${lang}|true_wrong_number`;
    if (/\b(former|used to|fui dueno|fui dueño|years)\b/.test(t))
      return `disc|${lang}|former_owner`;
    return `disc|${lang}|disconnect_other`;
  }
  if (primary === "tenant_occupied") {
    if (/\b(tenant|inquilino|rent|renta|lease|sublet|subarrend)\b/.test(t))
      return `role|${lang}|tenant_renter`;
    if (/\b(manager|administrador|manage|superintend)\b/.test(t))
      return `role|${lang}|property_manager`;
    return `role|${lang}|occupant_other`;
  }
  if (primary === "not_interested") {
    if (/\b(agent|realtor|broker|corredor|agente|listing)\b/.test(t))
      return `role|${lang}|agent_broker`;
    if (/\b(not selling|no vendo|no interest|no quiero|pass)\b/.test(t))
      return `neg|${lang}|not_interested_selling`;
    if (/\b(proposal|oferta|propuesta)\b/.test(t))
      return `neg|${lang}|proposal_rejected`;
    return `neg|${lang}|soft_negative`;
  }
  if (primary === "who_is_this") return `id|${lang}|identity_challenge`;
  if (primary === "condition_disclosed") {
    if (/\b(roof|techo|hvac|foundation|repair|repair|plumb|window)\b/.test(t))
      return `price_n|${lang}|repair_estimate_or_condition`;
    return `cond|${lang}|condition`;
  }
  if (primary === "callback_requested") return `cb|${lang}|callback_or_phone`;
  if (primary === "need_time") return `time|${lang}|need_time`;
  if (primary === "latent_interest") return `lat|${lang}|latent_interest`;
  if (primary === "info_request") {
    if (/\b(not giving|no doy|refuse|no divulgo|no price|sin numero|sin número)\b/.test(t))
      return `price_n|${lang}|price_refusal`;
    if (/\b(under contract|bajo contrato)\b/.test(t)) return `neg|${lang}|under_contract`;
    return `info|${lang}|info_request`;
  }
  if (primary === "unclear") {
    if (/\b(zip|postal|codigo|código)\b/.test(t) || /^\d{5}$/.test(t))
      return `price_n|${lang}|zip_or_code`;
    if (/\b(year|built|construy|19\d{2}|20\d{2})\b/.test(t))
      return `price_n|${lang}|year`;
    if (/\b(sq|square|metros|sqft)\b/.test(t)) return `price_n|${lang}|sqft`;
    if (/\b(owe|mortgage|hipoteca|debo)\b/.test(t)) return `price_n|${lang}|mortgage_balance`;
    if (/\b(rent|renta)\b/.test(t)) return `price_n|${lang}|rent`;
    if (/\b(tax|impuesto)\b/.test(t)) return `price_n|${lang}|taxes`;
    if (/\b(arv|after repair)\b/.test(t)) return `price_n|${lang}|arv`;
    if (/\b(bought|paid|compre|compré|purchase)\b/.test(t))
      return `price_n|${lang}|purchase_history`;
    if (/\b(not asking|no estoy pidiendo|not asking)\b/.test(t))
      return `price_n|${lang}|explicit_price_negation`;
    if (/\b(brother|sister|wife|husband|spouse|family|hermano|esposa|padre|tia|tía|cousin)\b/.test(t))
      return `role|${lang}|family_not_sole_owner`;
    if (/\b(address|street|zip is|confir)\b/.test(t))
      return `own_n|${lang}|address_confirm_only`;
    return `unclear|${lang}|other`;
  }

  return `misc|${lang}|${cand}|${primary}`;
}

function semanticRouting(row) {
  const t = norm(row.deidentified_raw_text);
  const primary = row.expected_primary_intent;
  const cand = row.expected_authority_candidate;

  let canonical = "unspecified";
  let production_routing_outcome = "continue_legacy";
  let suppression_action = "none";
  let terminal_state = row.expected_terminal_state || "none";
  let authority = false;

  if (primary === "opt_out") {
    canonical = "opt_out";
    production_routing_outcome = "suppress_stop";
    suppression_action = "opt_out";
    terminal_state = "opt_out";
  } else if (primary === "hostile_or_legal") {
    canonical = "hostile_or_legal";
    production_routing_outcome = "human_review";
    terminal_state = "hostile_or_legal";
  } else if (primary === "wrong_number") {
    if (/\b(sold|vend|closed|transfer|quitclaim|foreclos|bank|ya lo|ya la|auction)\b/.test(t)) {
      canonical = "sold_property";
    } else if (/\b(never|nunca)\b/.test(t)) {
      canonical = "never_owned";
    } else if (/\b(former|used to|fui|years ago|years back)\b/.test(t)) {
      canonical = "former_owner";
    } else {
      canonical = "true_wrong_number_or_person";
    }
    production_routing_outcome = "suppress_archive_compatible";
    suppression_action = "archive_wrong_number";
    terminal_state = "wrong_number";
  } else if (primary === "tenant_occupied") {
    if (/\b(manager|administrador|manage)\b/.test(t)) canonical = "property_manager";
    else canonical = "tenant_renter";
    production_routing_outcome = "continue_non_owner";
  } else if (primary === "not_interested") {
    if (/\b(agent|realtor|broker|corredor|agente|listing)\b/.test(t))
      canonical = "agent_or_broker_role";
    else if (/\b(proposal|oferta|propuesta)\b/.test(t) && /\b(no|not|dont|don't)\b/.test(t))
      canonical = "proposal_rejected";
    else canonical = "not_interested_in_selling";
    production_routing_outcome = "stop_or_soft_negative";
  } else if (primary === "ownership_confirmed") {
    canonical = "ownership_confirmed";
    authority = cand === "clear_ownership_confirmation";
  } else if (primary === "asks_offer") {
    canonical = "seller_requests_proposal";
    authority = cand === "clear_seller_requests_proposal";
  } else if (primary === "asking_price_provided") {
    canonical = "seller_asking_price_disclosed";
    authority = cand === "clear_asking_price_disclosure";
  } else if (primary === "who_is_this") {
    canonical = "identity_challenge";
  } else if (primary === "condition_disclosed") {
    if (/\b(cost|quote|estimate|cotizacion|cotización|presupuesto)\b/.test(t))
      canonical = "repair_estimate_or_condition_cost";
    else canonical = "condition_disclosed";
  } else if (primary === "callback_requested") {
    canonical = "callback_or_phone_number";
  } else if (primary === "need_time") {
    canonical = "need_time";
  } else if (primary === "latent_interest") {
    canonical = "latent_interest";
  } else if (primary === "info_request") {
    if (/\b(price|precio|number|numero|número)\b/.test(t) && /\b(not|no|refuse|doy)\b/.test(t))
      canonical = "price_refusal";
    else if (/\b(under contract|bajo contrato)\b/.test(t)) canonical = "already_under_contract";
    else canonical = "info_request";
  } else if (primary === "unclear") {
    if (row.source_category === "context" && row.preceding_outbound_use_case === "asking_price")
      canonical = "short_affirmation_needs_clarification";
    else if (row.source_category === "context" && row.preceding_outbound_use_case === "ownership_check")
      canonical = "short_ownership_denial_needs_clarification";
    else if (row.source_category === "context")
      canonical = "short_contextual_reply_needs_clarification";
    else if (/\b(zip|postal)\b/.test(t) || /^\d{5}$/.test(t)) canonical = "zip_or_code_not_price";
    else if (/\b(year|built|19\d{2}|20\d{2})\b/.test(t)) canonical = "year_not_price";
    else if (/\b(sq|square|metros)\b/.test(t)) canonical = "sqft_not_price";
    else if (/\b(owe|mortgage|hipoteca|debo)\b/.test(t)) canonical = "mortgage_balance_not_ask";
    else if (/\b(rent|renta)\b/.test(t)) canonical = "rent_not_ask";
    else if (/\b(tax|impuesto)\b/.test(t)) canonical = "taxes_not_ask";
    else if (/\b(arv)\b/.test(t)) canonical = "arv_not_ask";
    else if (/\b(bought|paid|compre|compré)\b/.test(t)) canonical = "purchase_history_not_ask";
    else if (/\b(not asking|no estoy pidiendo)\b/.test(t)) canonical = "explicit_price_negation";
    else if (/\b(brother|sister|wife|husband|hermano|esposa|family)\b/.test(t))
      canonical = "family_role_not_sole_owner";
    else canonical = "unclear_or_insufficient";
    production_routing_outcome = "human_review_or_clarify";
  }

  // Authority never true for development pack methodology review
  const authority_candidate_eligibility = false;

  return {
    calibration_example_id: row.calibration_example_id,
    canonical_semantic_outcome: canonical,
    classifier_primary_intent: primary,
    expected_secondary_intents: row.expected_secondary_intents || [],
    expected_facts: row.expected_facts || [],
    production_routing_outcome,
    suppression_action,
    terminal_state,
    // Semantic *could* map to a candidate class historically — but pack forbids authority use
    semantic_authority_candidate_class:
      cand && String(cand).startsWith("clear_") ? cand : null,
    authority_candidate_eligibility,
    may_count_for_authority_confidence: false,
  };
}

function languageNaturalness(row) {
  // heuristic flags for constructed vs natural-ish
  const t = row.deidentified_raw_text || "";
  const legalistic =
    /\b(fee simple|grantee|vested owner|beneficial owner|indicative purchase|non-binding|term sheet|LOI|titular registral|dominio|poseedor legitimo|poseedor legítimo)\b/i.test(
      t
    );
  const constructed =
    row.source_category === "authored" ||
    row.source_category === "adversarial" ||
    row.source_category === "context" ||
    legalistic;
  const historical_style = row.source_category === "historical_style_deid";
  // This pack has almost no true deidentified historical conversational language
  const natural_conversational = historical_style && !legalistic;
  return {
    legalistic_or_unnatural: legalistic,
    constructed_language: constructed && !natural_conversational,
    natural_conversational_language: natural_conversational,
    source_category: row.source_category,
  };
}

function main() {
  const rows = loadGold();
  const familyMap = new Map();
  const methodology = [];
  const semanticRoutingRows = [];
  let natural = 0;
  let constructed = 0;
  let legalistic = 0;

  for (const row of rows) {
    const fam = trueFamilyKey(row);
    if (!familyMap.has(fam)) familyMap.set(fam, []);
    familyMap.get(fam).push(row.calibration_example_id);

    const nat = languageNaturalness(row);
    if (nat.natural_conversational_language) natural++;
    if (nat.constructed_language) constructed++;
    if (nat.legalistic_or_unnatural) legalistic++;

    methodology.push({
      calibration_example_id: row.calibration_example_id,
      original_semantic_family_id: row.semantic_family_id,
      true_semantic_family_id: fam,
      calibration_status: "development_after_methodology_review",
      may_count_for_authority_confidence: false,
      development_pack_version: "acquisition_brain_adversarial_development_pack_v3",
      language_code: row.language_code,
      source_category: row.source_category,
      ...nat,
    });

    semanticRoutingRows.push(semanticRouting(row));
  }

  const sizes = [...familyMap.values()].map((a) => a.length).sort((a, b) => a - b);
  const sizeDist = {};
  for (const s of sizes) sizeDist[s] = (sizeDist[s] || 0) + 1;
  const singletons = sizes.filter((s) => s === 1).length;

  const familyReport = {
    development_pack_version: "acquisition_brain_adversarial_development_pack_v3",
    gold_hash_verified: EXPECTED_GOLD,
    example_count: rows.length,
    true_semantic_family_count: familyMap.size,
    original_claimed_family_count: 791,
    singleton_families: singletons,
    multi_member_families: familyMap.size - singletons,
    family_size_distribution: sizeDist,
    examples_per_family_mean: rows.length / familyMap.size,
    examples_per_family_median: sizes[Math.floor(sizes.length / 2)],
    max_family_size: sizes[sizes.length - 1] || 0,
    clustering_rationale: [
      "Families group shared underlying constructions (title/deed, still-own, property-is-mine, written proposal, cash offer, floor price, zip neighbor, tenant role, sold disconnect, etc.).",
      "Context short replies cluster by (language × outbound use case × reply token), not by unique punctuation.",
      "Paraphrases of the same construction share one family even if surface wording differs.",
      "Statistical evaluation of this pack must use family-cluster-aware metrics; singleton paraphrase inflation is disallowed for authority claims.",
    ],
    families: Object.fromEntries(
      [...familyMap.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([k, ids]) => [k, { size: ids.length, example_ids: ids }])
    ),
  };

  const naturalness = {
    natural_conversational_count: natural,
    constructed_language_count: constructed,
    legalistic_or_unnatural_count: legalistic,
    natural_language_percentage: Number(((100 * natural) / rows.length).toFixed(2)),
    constructed_language_percentage: Number(((100 * constructed) / rows.length).toFixed(2)),
    note: "historical_style_deid is a thin stylized slice; not independently collected seller SMS. True v3.1 requires ≥50% deidentified natural conversational language.",
  };

  writeFileSync(
    join(ROOT, "methodology-overlay.jsonl"),
    methodology.map((r) => JSON.stringify(r)).join("\n") + "\n"
  );
  writeFileSync(
    join(ROOT, "semantic-routing-labels.jsonl"),
    semanticRoutingRows.map((r) => JSON.stringify(r)).join("\n") + "\n"
  );
  writeFileSync(join(ROOT, "true-family-map.json"), JSON.stringify(familyReport, null, 2) + "\n");
  writeFileSync(join(ROOT, "naturalness-metrics.json"), JSON.stringify(naturalness, null, 2) + "\n");

  console.log(
    JSON.stringify(
      {
        true_families: familyMap.size,
        singletons,
        sizeDist,
        naturalness,
        gold_hash_ok: true,
      },
      null,
      2
    )
  );
}

main();
