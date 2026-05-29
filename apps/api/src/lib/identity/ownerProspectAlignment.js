import { clean, lower, collapseWhitespace } from "@/lib/utils/strings.js";

/**
 * Normalizes a person's name for comparison.
 * - Lowercase
 * - Strip punctuation
 * - Collapse whitespace
 * - Remove common suffixes (jr, sr, ii, etc.)
 */
export function normalizePersonName(name) {
  let normalized = lower(clean(name))
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, " ") // Replace punctuation with space to separate tokens
    .replace(/\s+/g, " ")
    .trim();

  // Remove common suffixes and titles
  const suffixes = /\b(jr|sr|ii|iii|iv|v|md|phd|esq|tr|trs|trustee|trustees|revocable|living|trust)\b$/g;
  normalized = normalized.replace(suffixes, "").trim();

  return normalized;
}

/**
 * Splits a normalized name into first, last, and tokens.
 */
export function splitPersonName(name) {
  const normalized = normalizePersonName(name);
  const tokens = normalized.split(" ").filter(token => token.length > 1); // Ignore single char tokens like middle initials
  
  if (tokens.length === 0) {
    return { first: "", last: "", tokens: [] };
  }

  if (tokens.length === 1) {
    return { first: tokens[0], last: "", tokens };
  }

  return {
    first: tokens[0],
    last: tokens[tokens.length - 1],
    tokens
  };
}

/**
 * Extracts all significant name tokens.
 */
export function extractNameTokens(name) {
  return splitPersonName(name).tokens;
}

/**
 * Determines if a name likely belongs to a corporate entity.
 */
export function isLikelyCorporateName(name) {
  const normalized = lower(clean(name));
  const entityTokens = [
    "llc", "l.l.c", "inc", "corp", "corporation", "company", "co.", "trust", 
    "estate", "holdings", "properties", "property", "partners", "investments", 
    "capital", "group", "fund", "bank", "lender", "realty", "management", 
    "enterprises", "international", "associates", "assoc", "ltd", "limited", 
    "services", "systems", "church", "foundation", "university", "college",
    "school", "board", "authority", "department", "agency"
  ];
  return entityTokens.some(token => normalized.includes(token));
}

/**
 * Calculates the alignment between an owner name and a prospect name.
 * 
 * @param {Object} input 
 * @returns {Object} { status, score, hardBlock, reasons, contactMode }
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
    sellerFirstName
  } = input;

  const resolvedOwnerName = clean(masterOwnerName || ownerDisplayName || ownerName);
  const resolvedProspectName = clean(prospectFullName);
  
  const reasons = [];
  let score = 50; // Starting neutral score
  let status = "unknown";
  let hardBlock = false;

  if (!resolvedOwnerName) {
    reasons.push("missing_owner_name");
    return { status: "unknown", score: 0, hardBlock: false, reasons, contactMode: "neutral" };
  }

  const ownerNorm = normalizePersonName(resolvedOwnerName);
  const ownerSplit = splitPersonName(resolvedOwnerName);
  const isCorporate = isLikelyCorporateName(resolvedOwnerName);
  const ownerTokens = new Set(ownerSplit.tokens.filter(t => !["and", "or", "the", "for", "with"].includes(t)));

  // Rule 2: If seller_full_name strongly matches owner_name/display_name, classify identity_verified.
  const resolvedSellerFullName = clean(sellerFullName);
  if (resolvedSellerFullName) {
    const sellerFullNorm = normalizePersonName(resolvedSellerFullName);
    if (ownerNorm === sellerFullNorm && ownerNorm.length > 0) {
      score = 100;
      status = "verified";
      reasons.push("seller_full_name_exact_match");
      return { status, score, hardBlock, reasons, contactMode: "owner_verified" };
    }
  }

  // Rule 3: If seller_first_name matches owner/display name and matched_prospect_id exists, classify identity_probable.
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

  // Rule 1: If likely_owner === true, sms_eligible === true, canonical_prospect_id or primary_prospect_id exists, and normalized_phone_id equals best_phone_id or phone_id equals best_phone_id, classify at least identity_probable.
  const phoneMatchesBest = Boolean(bestPhoneId && ((normalizedPhoneId && normalizedPhoneId === bestPhoneId) || (phoneId && phoneId === bestPhoneId)));
  if (likelyOwner === true && smsEligible === true && hasMatchedProspectId && phoneMatchesBest) {
    if (score < 75) score = 75;
    if (status === "unknown" || status === "weak" || status === "mismatch") {
       status = "probable";
       hardBlock = false;
       reasons.push("system_verified_likely_owner_with_best_phone");
    }
  }

  // Fallback to prospect name if available
  if (!resolvedProspectName && status === "unknown") {
    // We don't have prospect name, and no other rules bumped us out of unknown.
    // Do not classify as identity_unknown just because phone_first_name and phone_full_name are null.
    // Actually, if we have no other proof, we stay in whatever status we're in, but let's let the rest run.
  }

  if (resolvedProspectName) {
    const prospectNorm = normalizePersonName(resolvedProspectName);
    const prospectSplit = splitPersonName(resolvedProspectName);

    // Exact Match
    if (ownerNorm === prospectNorm && ownerNorm.length > 0) {
      score = 100;
      status = "verified";
      reasons.push("exact_name_match");
      return { status, score, hardBlock, reasons, contactMode: "owner_verified" };
    }

    // Multi-Token / Intersection Match
    const commonWords = new Set(["and", "or", "the", "for", "with"]);
    const prospectTokens = prospectSplit.tokens.filter(t => !commonWords.has(t));
    
    const intersectingTokens = prospectTokens.filter(t => ownerTokens.has(t));
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
    } else if (!isCorporate && status === "unknown") {
      // Full mismatch for individual owner
      score = 20;
      status = "mismatch";
      hardBlock = true;
      reasons.push("owner_prospect_full_name_mismatch");
    }
  }

  // 3. Corporate Flexibility
  if (isCorporate) {
    reasons.push("corporate_owner_flexibility_applied");
    if (status === "mismatch") {
      score = 50;
      status = "weak";
      hardBlock = false;
    }
    if (likelyOwner === true) {
      score += 20;
      reasons.push("flagged_as_likely_owner");
      if (status === "unknown") status = "probable";
    }
  }

  // 4. Phone Name Confirmation (Cross-check with CNAM/Phone Owner)
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

    const prospectNorm = clean(prospectFullName) ? normalizePersonName(prospectFullName) : null;
    if (prospectNorm && phoneNorm === prospectNorm) {
      score += 10;
      reasons.push("phone_identity_matches_prospect");
    }
  }

  // If status is still unknown, check if we have any other evidence to keep it from being unknown purely because of missing phone names.
  // The rule: "Do not classify as identity_unknown just because phone_first_name and phone_full_name are null."
  // If we reached here, and status is still unknown, we didn't find *any* positive correlation.
  // But if it was a corporate property or had a matched prospect, we might have upgraded it above.

  // 5. Household / Association Logic (Intermediate Layer)
  const mFlags = lower(clean(matchingFlags));
  const pFlags = lower(clean(personFlagsText));
  
  const isPotentialOwner = mFlags.includes("potential owner");
  const hasHouseholdEvidence = mFlags.includes("household") || 
                               pFlags.includes("household") || 
                               pFlags.includes("relative") || 
                               pFlags.includes("spouse") || 
                               pFlags.includes("family") || 
                               pFlags.includes("heir") ||
                               pFlags.includes("associate") ||
                               pFlags.includes("occupant");
  
  const hasStrongLinkage = clean(linkedPropertyIdsText).length > 0 || 
                           joinedPropertySource === "properties.master_owner_id";

  if ((isPotentialOwner || hasHouseholdEvidence) && hasStrongLinkage) {
    if (status !== "verified") {
      status = "household_associated";
      score = Math.max(score, 65);
      hardBlock = false; // Allow contact but with restricted mode
      if (!reasons.includes("household_or_occupant_association_detected")) {
        reasons.push("household_or_occupant_association_detected");
      }
    }
  }

  // 6. Renter / Wrong Party Flags (Can override household association if severe)
  const isRenter = likelyRenting === true || 
                   mFlags.includes("renter") || 
                   pFlags.includes("renter") ||
                   mFlags.includes("tenant") || 
                   pFlags.includes("tenant");
  
  if (isRenter) {
    if (status === "household_associated") {
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

  const isWrongParty = mFlags.includes("wrong party") || 
                       pFlags.includes("wrong party") ||
                       mFlags.includes("wrong person") || 
                       pFlags.includes("possible wrong party");
  
  if (isWrongParty) {
    score -= 50;
    reasons.push("wrong_party_flag_detected");
    hardBlock = true;
    status = "mismatch";
  }

  // Cap score
  score = Math.max(0, Math.min(100, score));

  // Final status adjustment based on score (if not already set to a priority status)
  if (status !== "household_associated" && status !== "verified" && status !== "probable" && status !== "mismatch") {
    if (score >= 90) status = "verified";
    else if (score >= 70) status = "probable";
    else if (score >= 40) status = "weak";
    else if (score < 40 && hardBlock) status = "mismatch";
  }

  // Determine Contact Mode
  let contactMode = "neutral";
  if (status === "verified") contactMode = "owner_verified";
  else if (status === "probable") contactMode = "owner_safe";
  else if (status === "household_associated") contactMode = "household_safe";

  return {
    status,
    score,
    hardBlock,
    reasons,
    contactMode
  };
}

/**
 * Determines if a candidate's identity is safe for live outbound contact.
 * Default policy: verified, probable, and household_associated only.
 * 
 * @param {Object} alignment Result from calculateOwnerProspectAlignment
 * @param {Object} options { allow_weak_identity_outbound: boolean }
 * @returns {Object} { eligible, reason }
 */
export function isIdentityEligibleForLiveOutbound(alignment = {}, options = {}) {
  const { status, hardBlock } = alignment;
  const identity_gate_mode = lower(clean(options.identity_gate_mode || "strict"));
  const allowWeak =
    options.allow_weak_identity_outbound === true ||
    identity_gate_mode === "relaxed";
  const allowUnknown =
    options.allow_identity_unknown === true ||
    identity_gate_mode === "relaxed";

  if (hardBlock || status === "mismatch") {
    return { eligible: false, reason: "identity_mismatch" };
  }

  if (status === "verified" || status === "probable") {
    return { eligible: true, reason: "identity_safe" };
  }

  if (status === "household_associated") {
    return { eligible: true, reason: "household_association_allowed" };
  }

  if (status === "weak") {
    if (allowWeak) {
      return { eligible: true, reason: "identity_weak_allowed" };
    }
    return { eligible: false, reason: "identity_not_verified" };
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
