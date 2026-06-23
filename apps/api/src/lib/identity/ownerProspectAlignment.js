import { clean, lower, collapseWhitespace } from "@/lib/utils/strings.js";

// ── Entity detection ───────────────────────────────────────────────────────

const ENTITY_TOKENS = new Set([
  "llc", "l.l.c", "l.l.c.", "inc", "incorporated", "corp", "corporation",
  "co.", "company", "holdings", "properties", "property", "assets",
  "apartments", "church", "ministries", "ministry", "trust", "estate",
  "lp", "llp", "partners", "partnership", "ventures", "capital",
  "investments", "investment", "group", "fund", "bank", "lender",
  "realty", "management", "enterprises", "international", "associates",
  "assoc", "ltd", "limited", "services", "systems", "foundation",
  "university", "college", "school", "board", "authority", "department",
  "agency", "network", "solutions", "development", "resources",
]);

/**
 * Returns true if the name contains entity/corporate indicator tokens.
 * Used to route entity owners into the entity identity path.
 */
export function detectEntityOwner(name) {
  if (!name) return false;
  const words = lower(clean(name))
    .replace(/[.,\/#!$%^&*;:{}=`~()]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
  return words.some((w) => ENTITY_TOKENS.has(w));
}

// Kept as alias for backward-compat usage across the codebase.
export const isLikelyCorporateName = detectEntityOwner;

// ── Matching-flags normalization ───────────────────────────────────────────

/**
 * Maps the raw `prospects.matching_flags` text to a canonical linkage type.
 * Scans the full flags string (can be comma-separated) and returns the
 * highest-priority linkage found.
 *
 * Priority (first match wins):
 *   linked_to_company > likely_linked_to_company > potentially_linked_to_company >
 *   unrelated > tenant > likely_owner > potential_owner > related_party > unknown
 */
export function normalizeMatchingFlags(rawText) {
  if (!rawText) return "unknown";
  const f = lower(clean(rawText));
  if (!f) return "unknown";

  // Company linkage signals — most-specific first to avoid substring collisions.
  // "Potentially Linked To Company" contains "linked" so check it before "linked".
  if (f.includes("potentially linked") || f.includes("potentially_linked"))
    return "potentially_linked_to_company";
  // "Likely Linked To Company" contains "linked" so check it before bare "linked".
  if (f.includes("likely linked") || f.includes("likely_linked"))
    return "likely_linked_to_company";
  if (f.includes("linked to company") || f.includes("linked_to_company"))
    return "linked_to_company";

  // Wrong-party hard blocks
  if (f.includes("wrong party") || f.includes("wrong person") ||
      f.includes("unrelated") || f.includes("not owner"))
    return "unrelated";

  // Tenant / renter signals
  if (f.includes("likely renting") || f.includes("likely_renting") ||
      f.includes("tenant") || f.includes("renter"))
    return "tenant";

  // Owner signals (individual)
  if (f.includes("likely owner") || f.includes("likely_owner"))
    return "likely_owner";
  if (f.includes("potential owner") || f.includes("potential_owner"))
    return "potential_owner";

  // Related / household (not the direct owner)
  if (f.includes("family") || f.includes("relative") ||
      f.includes("household") || f.includes("resident") ||
      f.includes("related"))
    return "related_party";

  return "unknown";
}

// ── Name utilities ─────────────────────────────────────────────────────────

export function normalizePersonName(name) {
  let normalized = lower(clean(name))
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const suffixes =
    /\b(jr|sr|ii|iii|iv|v|md|phd|esq|tr|trs|trustee|trustees|revocable|living|trust)\b$/g;
  return normalized.replace(suffixes, "").trim();
}

export function splitPersonName(name) {
  const normalized = normalizePersonName(name);
  const tokens = normalized.split(" ").filter((t) => t.length > 1);
  if (tokens.length === 0) return { first: "", last: "", tokens: [] };
  if (tokens.length === 1) return { first: tokens[0], last: "", tokens };
  return { first: tokens[0], last: tokens[tokens.length - 1], tokens };
}

export function extractNameTokens(name) {
  return splitPersonName(name).tokens;
}

// ── Entity owner alignment ─────────────────────────────────────────────────

// Operator-role signals in person_flags_text that indicate the prospect is
// acting on behalf of or managing the entity — eligible for outreach.
const OPERATOR_PERSON_FLAG_PATTERNS = [
  "business owner",
  "property owner",
  "primary decision maker",
];

function hasOperatorPersonFlag(personFlagsText) {
  const p = lower(clean(personFlagsText || ""));
  return OPERATOR_PERSON_FLAG_PATTERNS.some((pattern) => p.includes(pattern));
}

function resolveEntityAlignment({
  matchingFlags,
  personFlagsText,
  likelyOwner,
  prospectFullName,
  bestPhoneScore,
  reasons: baseReasons,
}) {
  const reasons = [...baseReasons, "entity_owner_detected"];
  const normalized_linkage = normalizeMatchingFlags(matchingFlags || personFlagsText);

  // Confirmed company linkage → strongly eligible
  if (normalized_linkage === "linked_to_company") {
    return {
      status: "entity_company_linked",
      score: 75,
      hardBlock: false,
      reasons: [...reasons, "entity_company_linkage_confirmed", `normalized_linkage:${normalized_linkage}`],
      contactMode: "entity_safe",
      ownerIsEntity: true,
      normalizedLinkage: normalized_linkage,
    };
  }

  // Probable company linkage → eligible at lower confidence
  if (normalized_linkage === "likely_linked_to_company") {
    return {
      status: "entity_company_probable",
      score: 70,
      hardBlock: false,
      reasons: [...reasons, "entity_probable_company_linkage", `normalized_linkage:${normalized_linkage}`],
      contactMode: "entity_safe",
      ownerIsEntity: true,
      normalizedLinkage: normalized_linkage,
    };
  }

  // Softer company linkage → eligible if prospect present, else hold
  if (normalized_linkage === "potentially_linked_to_company") {
    const has_prospect = Boolean(clean(prospectFullName));
    const phone_ok = !bestPhoneScore || Number(bestPhoneScore) >= 50;
    if (has_prospect && phone_ok) {
      return {
        status: "entity_company_linked",
        score: 65,
        hardBlock: false,
        reasons: [...reasons, "entity_soft_company_linkage", `normalized_linkage:${normalized_linkage}`],
        contactMode: "entity_safe",
        ownerIsEntity: true,
        normalizedLinkage: normalized_linkage,
      };
    }
    return {
      status: "weak",
      score: 40,
      hardBlock: false,
      reasons: [...reasons, "entity_potentially_linked_no_prospect", `normalized_linkage:${normalized_linkage}`],
      contactMode: "neutral",
      ownerIsEntity: true,
      normalizedLinkage: normalized_linkage,
    };
  }

  // Wrong-party hard block
  if (normalized_linkage === "unrelated") {
    return {
      status: "mismatch",
      score: 10,
      hardBlock: true,
      reasons: [...reasons, "entity_wrong_party_detected", `normalized_linkage:${normalized_linkage}`],
      contactMode: "blocked",
      ownerIsEntity: true,
      normalizedLinkage: normalized_linkage,
    };
  }

  // Tenant/renter hard block
  if (normalized_linkage === "tenant") {
    return {
      status: "mismatch",
      score: 10,
      hardBlock: true,
      reasons: [...reasons, "entity_tenant_detected", `normalized_linkage:${normalized_linkage}`],
      contactMode: "blocked",
      ownerIsEntity: true,
      normalizedLinkage: normalized_linkage,
    };
  }

  // likely_owner for entity: check for operator person flags before holding
  if (normalized_linkage === "likely_owner") {
    if (hasOperatorPersonFlag(personFlagsText)) {
      return {
        status: "entity_operator_probable",
        score: 65,
        hardBlock: false,
        reasons: [...reasons, "entity_operator_person_flag_confirmed", `normalized_linkage:${normalized_linkage}`],
        contactMode: "entity_safe",
        ownerIsEntity: true,
        normalizedLinkage: normalized_linkage,
      };
    }
    // likely_owner alone for entity → hold (may be a managed entity, no operator confirmed)
    return {
      status: "weak",
      score: 50,
      hardBlock: false,
      reasons: [...reasons, "entity_individual_ownership_signal_hold", `normalized_linkage:${normalized_linkage}`],
      contactMode: "neutral",
      ownerIsEntity: true,
      normalizedLinkage: normalized_linkage,
    };
  }

  // potential_owner for entity → hold
  if (normalized_linkage === "potential_owner") {
    return {
      status: "weak",
      score: 50,
      hardBlock: false,
      reasons: [...reasons, "entity_individual_ownership_signal_hold", `normalized_linkage:${normalized_linkage}`],
      contactMode: "neutral",
      ownerIsEntity: true,
      normalizedLinkage: normalized_linkage,
    };
  }

  // related_party / unknown → hold
  return {
    status: "weak",
    score: 40,
    hardBlock: false,
    reasons: [...reasons, "entity_unknown_linkage_hold", `normalized_linkage:${normalized_linkage}`],
    contactMode: "neutral",
    ownerIsEntity: true,
    normalizedLinkage: normalized_linkage,
  };
}

// ── Main alignment function ────────────────────────────────────────────────

/**
 * Calculates identity alignment between a property owner and the prospect/phone
 * on the candidate record.
 *
 * Entity owners are routed immediately into the entity branch which uses
 * `prospects.matching_flags` as the authority (never attempts name matching
 * between an entity name and a person name).
 *
 * Individual owners use name-comparison + `likely_owner` + phone signals.
 *
 * Returns { status, score, hardBlock, reasons, contactMode, ownerIsEntity?, normalizedLinkage? }
 */
export function calculateOwnerProspectAlignment(input = {}) {
  const {
    masterOwnerName,
    ownerDisplayName,
    ownerName,
    prospectFullName,
    phoneFullName,
    phoneOwner,
    cnam,
    likelyOwner,
    likelyRenting,
    matchingFlags,
    personFlagsText,
    bestPhoneScore,
    contactScoreFinal,
    linkedPropertyIdsText,
    joinedPropertySource,
    smsEligible,
    canonicalProspectId,
    primaryProspectId,
    normalizedPhoneId,
    bestPhoneId,
    phoneId,
    sellerFullName,
    sellerFirstName,
  } = input;

  const resolvedOwnerName = clean(masterOwnerName || ownerDisplayName || ownerName);
  const reasons = [];

  if (!resolvedOwnerName) {
    reasons.push("missing_owner_name");
    return { status: "unknown", score: 0, hardBlock: false, reasons, contactMode: "neutral" };
  }

  const isEntity = detectEntityOwner(resolvedOwnerName);

  // ── Entity owner branch ─────────────────────────────────────────────────
  // Skip name-matching entirely; use matching_flags as the authority.
  if (isEntity) {
    return resolveEntityAlignment({
      matchingFlags,
      personFlagsText,
      likelyOwner,
      prospectFullName,
      bestPhoneScore,
      reasons,
    });
  }

  // ── Individual owner branch ─────────────────────────────────────────────
  const ownerNorm = normalizePersonName(resolvedOwnerName);
  const ownerSplit = splitPersonName(resolvedOwnerName);
  const ownerTokens = new Set(
    ownerSplit.tokens.filter((t) => !["and", "or", "the", "for", "with"].includes(t))
  );

  let score = 50;
  let status = "unknown";
  let hardBlock = false;

  // Rule: exact seller_full_name match → verified
  const resolvedSellerFullName = clean(sellerFullName);
  if (resolvedSellerFullName) {
    const sellerFullNorm = normalizePersonName(resolvedSellerFullName);
    if (ownerNorm === sellerFullNorm && ownerNorm.length > 0) {
      return {
        status: "verified",
        score: 100,
        hardBlock: false,
        reasons: [...reasons, "seller_full_name_exact_match"],
        contactMode: "owner_verified",
      };
    }
  }

  // Rule: seller_first_name + prospect_id match → probable
  const resolvedSellerFirstName = clean(sellerFirstName);
  const hasMatchedProspectId = Boolean(canonicalProspectId || primaryProspectId);
  if (resolvedSellerFirstName && hasMatchedProspectId) {
    const sellerFirstNorm = normalizePersonName(resolvedSellerFirstName);
    if (sellerFirstNorm && ownerTokens.has(sellerFirstNorm)) {
      score = Math.max(score, 80);
      status = "probable";
      reasons.push("seller_first_name_match_with_prospect_id");
    }
  }

  // Rule: likely_owner + sms_eligible + prospect_id + best_phone → probable
  const phoneMatchesBest = Boolean(
    bestPhoneId &&
      ((normalizedPhoneId && normalizedPhoneId === bestPhoneId) ||
        (phoneId && phoneId === bestPhoneId))
  );
  if (likelyOwner === true && smsEligible === true && hasMatchedProspectId && phoneMatchesBest) {
    if (score < 75) score = 75;
    if (status === "unknown" || status === "weak" || status === "mismatch") {
      status = "probable";
      hardBlock = false;
      reasons.push("system_verified_likely_owner_with_best_phone");
    }
  }

  // Rule: likely_owner flag in matching_flags → boost even without full phone match
  const normalizedLinkage = normalizeMatchingFlags(matchingFlags || personFlagsText);
  if (normalizedLinkage === "likely_owner" && status === "unknown") {
    score = Math.max(score, 65);
    status = "probable";
    reasons.push("matching_flags_likely_owner");
  }
  if (normalizedLinkage === "potential_owner" && status === "unknown") {
    score = Math.max(score, 55);
    status = "weak";
    reasons.push("matching_flags_potential_owner");
  }

  // Prospect name matching
  const resolvedProspectName = clean(prospectFullName);
  if (resolvedProspectName) {
    const prospectNorm = normalizePersonName(resolvedProspectName);
    const prospectSplit = splitPersonName(resolvedProspectName);

    if (ownerNorm === prospectNorm && ownerNorm.length > 0) {
      return {
        status: "verified",
        score: 100,
        hardBlock: false,
        reasons: [...reasons, "exact_name_match"],
        contactMode: "owner_verified",
      };
    }

    const commonWords = new Set(["and", "or", "the", "for", "with"]);
    const prospectTokens = prospectSplit.tokens.filter((t) => !commonWords.has(t));
    const intersectingTokens = prospectTokens.filter((t) => ownerTokens.has(t));
    const hasFirstMatch = prospectSplit.first && ownerTokens.has(prospectSplit.first);
    const hasLastMatch = prospectSplit.last && ownerTokens.has(prospectSplit.last);

    if (hasFirstMatch && hasLastMatch) {
      score = Math.max(score, 95);
      status = "verified";
      reasons.push("prospect_first_and_last_name_found_in_owner_tokens");
    } else if (hasLastMatch) {
      score = Math.max(score, 80);
      if (status !== "verified") status = "probable";
      reasons.push("prospect_last_name_found_in_owner_tokens");
    } else if (hasFirstMatch) {
      score = Math.max(score, 65);
      if (status === "unknown") status = "weak";
      reasons.push("prospect_first_name_found_in_owner_tokens");
    } else if (intersectingTokens.length > 0) {
      score = Math.max(score, 60);
      if (status === "unknown") status = "weak";
      reasons.push("partial_token_intersection_with_owner");
    } else if (status === "unknown") {
      // Full mismatch for individual owner — hard block
      score = 20;
      status = "mismatch";
      hardBlock = true;
      reasons.push("owner_prospect_full_name_mismatch");
    }
  }

  // Phone name confirmation
  const phoneIdentity = clean(phoneFullName || phoneOwner || cnam);
  if (phoneIdentity) {
    const phoneNorm = normalizePersonName(phoneIdentity);
    const phoneSplit = splitPersonName(phoneIdentity);
    if (phoneNorm === ownerNorm) {
      score += 15;
      reasons.push("phone_identity_matches_owner");
      if (status === "unknown") status = "verified";
      else if (status === "weak") status = "probable";
    } else if (phoneSplit.last && ownerTokens.has(phoneSplit.last)) {
      score += 10;
      reasons.push("phone_last_name_found_in_owner_tokens");
      if (status === "unknown") status = "weak";
    }
    const prospectNorm = resolvedProspectName
      ? normalizePersonName(resolvedProspectName)
      : null;
    if (prospectNorm && phoneNorm === prospectNorm) {
      score += 10;
      reasons.push("phone_identity_matches_prospect");
    }
  }

  // Household / association logic
  const mFlags = lower(clean(matchingFlags));
  const pFlags = lower(clean(personFlagsText));
  const isPotentialOwner = mFlags.includes("potential owner");
  const hasHouseholdEvidence =
    mFlags.includes("household") ||
    pFlags.includes("household") ||
    pFlags.includes("relative") ||
    pFlags.includes("spouse") ||
    pFlags.includes("family") ||
    pFlags.includes("heir") ||
    pFlags.includes("associate") ||
    pFlags.includes("occupant");
  const hasStrongLinkage =
    clean(linkedPropertyIdsText).length > 0 ||
    joinedPropertySource === "properties.master_owner_id";

  if ((isPotentialOwner || hasHouseholdEvidence) && hasStrongLinkage) {
    if (status !== "verified") {
      status = "household_associated";
      score = Math.max(score, 65);
      hardBlock = false;
      if (!reasons.includes("household_or_occupant_association_detected")) {
        reasons.push("household_or_occupant_association_detected");
      }
    }
  }

  // Renter / wrong-party downgrade
  // Hard renter: signal from matching_flags or likelyRenting boolean → always block
  const isRenterHard =
    likelyRenting === true ||
    mFlags.includes("likely renting") ||
    mFlags.includes("tenant") ||
    mFlags.includes("renter");

  // Soft renter: signal only from person_flags_text, not matching_flags
  // If likely_owner=true AND matching_flags has an ownership signal, suppress hard-block.
  const isRenterSoft =
    !isRenterHard && (pFlags.includes("renter") || pFlags.includes("tenant"));
  const hasOwnershipCounterSignal =
    likelyOwner === true ||
    normalizedLinkage === "likely_owner" ||
    normalizedLinkage === "linked_to_company" ||
    normalizedLinkage === "likely_linked_to_company";
  const renterShouldBlock = isRenterHard || (isRenterSoft && !hasOwnershipCounterSignal);

  if (isRenterHard || isRenterSoft) {
    if (!renterShouldBlock) {
      // Soft renter overridden by ownership signal — surface as warning only
      reasons.push("renter_flag_suppressed_by_ownership_signal");
      score -= 5;
    } else if (status === "household_associated") {
      reasons.push("renter_flag_with_association_downgrade");
      score -= 10;
    } else {
      score -= 40;
      reasons.push("renter_or_tenant_detected");
      if (status !== "verified") {
        hardBlock = true;
        status = "mismatch";
      }
    }
  }

  const isWrongParty =
    mFlags.includes("wrong party") ||
    pFlags.includes("wrong party") ||
    mFlags.includes("wrong person") ||
    pFlags.includes("possible wrong party");

  if (isWrongParty) {
    score -= 50;
    reasons.push("wrong_party_flag_detected");
    hardBlock = true;
    status = "mismatch";
  }

  score = Math.max(0, Math.min(100, score));

  if (
    status !== "household_associated" &&
    status !== "verified" &&
    status !== "probable" &&
    status !== "mismatch"
  ) {
    if (score >= 90) status = "verified";
    else if (score >= 70) status = "probable";
    else if (score >= 40) status = "weak";
    else if (score < 40 && hardBlock) status = "mismatch";
  }

  let contactMode = "neutral";
  if (status === "verified") contactMode = "owner_verified";
  else if (status === "probable") contactMode = "owner_safe";
  else if (status === "household_associated") contactMode = "household_safe";

  return { status, score, hardBlock, reasons, contactMode };
}

// ── Live outbound eligibility gate ─────────────────────────────────────────

/**
 * Determines if an aligned identity is eligible for live cold outbound.
 *
 * Eligible statuses:
 *   verified, probable, household_associated  — individual owner path
 *   entity_company_linked                     — entity owner with confirmed company link
 *
 * Blocked:  mismatch (hardBlock=true)
 * Held:     weak, unknown (unless explicitly allowed via options)
 */
export function isIdentityEligibleForLiveOutbound(alignment = {}, options = {}) {
  const { status, hardBlock } = alignment;
  const identity_gate_mode = lower(clean(options.identity_gate_mode || "strict"));
  const allowWeak =
    options.allow_weak_identity_outbound === true || identity_gate_mode === "relaxed";
  const allowUnknown =
    options.allow_identity_unknown === true || identity_gate_mode === "relaxed";

  if (hardBlock || status === "mismatch") {
    return { eligible: false, reason: "identity_mismatch" };
  }

  if (status === "verified" || status === "probable") {
    return { eligible: true, reason: "identity_safe" };
  }

  if (status === "household_associated") {
    return { eligible: true, reason: "household_association_allowed" };
  }

  // Entity path — company linkage (confirmed and probable) + operator probable
  if (status === "entity_company_linked") {
    return { eligible: true, reason: "entity_company_linkage_confirmed" };
  }
  if (status === "entity_company_probable") {
    return { eligible: true, reason: "entity_company_probable_eligible" };
  }
  if (status === "entity_operator_probable") {
    return { eligible: true, reason: "entity_operator_probable_eligible" };
  }

  if (status === "weak") {
    return allowWeak
      ? { eligible: true, reason: "identity_weak_allowed" }
      : { eligible: false, reason: "identity_not_verified" };
  }

  if (status === "unknown") {
    if (allowUnknown || allowWeak) {
      return {
        eligible: true,
        reason: allowUnknown ? "identity_unknown_allowed" : "identity_weak_allowed",
      };
    }
    return { eligible: false, reason: "identity_not_verified" };
  }

  return { eligible: false, reason: "identity_unknown_policy" };
}
