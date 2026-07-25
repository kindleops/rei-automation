// ─── seller-authority-state.js ──────────────────────────────────────────────
// ONE canonical deterministic authority predicate, shared by lifecycle stage
// progression (resolve-seller-stage-transition.js) and next-best-action
// selection (resolve-seller-next-best-action.js).
//
// This module owns no vocabulary of its own. Ownership structure, authority
// type and signer counting all come from the existing production contract
// engine (stage6-seller-contract-engine.js), which is already deterministic
// and table-driven. The only thing added here is a single yes/no answer to:
//
//   "may this deal progress to offer-finalization / contract-ready?"
//
// so stage progression and NBA can never disagree about it.
//
// Pure: no I/O, no network, no Date.now unless `now` is supplied.

import {
  AUTHORITY_TYPE,
  OWNERSHIP_STRUCTURE,
  detectAuthority,
  detectHeirship,
  detectProbate,
} from "@/lib/domain/seller-flow/stage6-seller-contract-engine.js";

export const AUTHORITY_STATE_VERSION = "seller_authority_state_v1";

/** Why offer/contract progression is withheld. Reuses Stage 6 outcome names. */
export const AUTHORITY_BLOCK_REASONS = Object.freeze({
  SPOUSE_APPROVAL_REQUIRED: "waiting_on_spouse",
  CO_OWNER_APPROVAL_REQUIRED: "waiting_on_co_signer",
  FAMILY_APPROVAL_REQUIRED: "waiting_on_family",
  LLC_AUTHORITY_UNRESOLVED: "waiting_on_llc_authority",
  TRUST_AUTHORITY_UNRESOLVED: "waiting_on_trustee",
  EXECUTOR_AUTHORITY_UNRESOLVED: "waiting_on_executor",
  PROBATE_UNRESOLVED: "probate_detected",
  HEIRSHIP_UNRESOLVED: "heirship_detected",
  AUTHORITY_VERIFICATION_REQUIRED: "authority_verification_required",
});

/** Entity/estate structures that can never self-verify from seller text. */
const ENTITY_STRUCTURES = new Set([
  OWNERSHIP_STRUCTURE.LLC,
  OWNERSHIP_STRUCTURE.CORPORATION,
  OWNERSHIP_STRUCTURE.TRUST,
  OWNERSHIP_STRUCTURE.ESTATE,
  OWNERSHIP_STRUCTURE.HEIRS,
  OWNERSHIP_STRUCTURE.POWER_OF_ATTORNEY,
]);

const STRUCTURE_BLOCK_REASON = Object.freeze({
  [OWNERSHIP_STRUCTURE.MARRIED_COUPLE]: AUTHORITY_BLOCK_REASONS.SPOUSE_APPROVAL_REQUIRED,
  [OWNERSHIP_STRUCTURE.MULTIPLE_OWNERS]: AUTHORITY_BLOCK_REASONS.CO_OWNER_APPROVAL_REQUIRED,
  [OWNERSHIP_STRUCTURE.LLC]: AUTHORITY_BLOCK_REASONS.LLC_AUTHORITY_UNRESOLVED,
  [OWNERSHIP_STRUCTURE.CORPORATION]: AUTHORITY_BLOCK_REASONS.LLC_AUTHORITY_UNRESOLVED,
  [OWNERSHIP_STRUCTURE.TRUST]: AUTHORITY_BLOCK_REASONS.TRUST_AUTHORITY_UNRESOLVED,
  [OWNERSHIP_STRUCTURE.ESTATE]: AUTHORITY_BLOCK_REASONS.EXECUTOR_AUTHORITY_UNRESOLVED,
  [OWNERSHIP_STRUCTURE.HEIRS]: AUTHORITY_BLOCK_REASONS.HEIRSHIP_UNRESOLVED,
  [OWNERSHIP_STRUCTURE.POWER_OF_ATTORNEY]: AUTHORITY_BLOCK_REASONS.AUTHORITY_VERIFICATION_REQUIRED,
});

const SIGNOFF_RELATIONSHIP_STRUCTURE = Object.freeze({
  spouse: OWNERSHIP_STRUCTURE.MARRIED_COUPLE,
  co_owner: OWNERSHIP_STRUCTURE.MULTIPLE_OWNERS,
  family: OWNERSHIP_STRUCTURE.MULTIPLE_OWNERS,
});

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Map a persisted authority_claims.authority_type onto a Stage 6 structure. */
function structureFromClaimedAuthorityType(authority_type) {
  switch (lower(authority_type)) {
    case AUTHORITY_TYPE.SPOUSE:
      return OWNERSHIP_STRUCTURE.MARRIED_COUPLE;
    case AUTHORITY_TYPE.CO_OWNER:
      return OWNERSHIP_STRUCTURE.MULTIPLE_OWNERS;
    case AUTHORITY_TYPE.LLC_MEMBER_MANAGER:
      return OWNERSHIP_STRUCTURE.LLC;
    case AUTHORITY_TYPE.CORPORATE_OFFICER:
      return OWNERSHIP_STRUCTURE.CORPORATION;
    case AUTHORITY_TYPE.TRUSTEE:
    case "trust":
      return OWNERSHIP_STRUCTURE.TRUST;
    case AUTHORITY_TYPE.EXECUTOR:
    case "estate":
      return OWNERSHIP_STRUCTURE.ESTATE;
    case AUTHORITY_TYPE.HEIR:
      return OWNERSHIP_STRUCTURE.HEIRS;
    case AUTHORITY_TYPE.ATTORNEY_IN_FACT:
    case "poa":
      return OWNERSHIP_STRUCTURE.POWER_OF_ATTORNEY;
    case "entity_representative":
      return OWNERSHIP_STRUCTURE.LLC;
    default:
      return null;
  }
}

/** Highest-risk structure wins when message text and persisted claims differ. */
const STRUCTURE_RISK_ORDER = [
  OWNERSHIP_STRUCTURE.INDIVIDUAL,
  OWNERSHIP_STRUCTURE.MARRIED_COUPLE,
  OWNERSHIP_STRUCTURE.MULTIPLE_OWNERS,
  OWNERSHIP_STRUCTURE.POWER_OF_ATTORNEY,
  OWNERSHIP_STRUCTURE.CORPORATION,
  OWNERSHIP_STRUCTURE.LLC,
  OWNERSHIP_STRUCTURE.TRUST,
  OWNERSHIP_STRUCTURE.HEIRS,
  OWNERSHIP_STRUCTURE.ESTATE,
];

function riskierStructure(left, right) {
  const l = STRUCTURE_RISK_ORDER.indexOf(left);
  const r = STRUCTURE_RISK_ORDER.indexOf(right);
  if (l < 0) return right;
  if (r < 0) return left;
  return r > l ? right : left;
}

/**
 * Resolve one canonical authority state for a seller conversation turn.
 *
 * Inputs are already-canonical values only:
 *   - `message`        raw inbound text (Stage 6 detectors read it directly)
 *   - `known_facts`    merged durable seller facts (authority_claims, ...)
 *   - `new_facts`      this turn's projected extractor facts
 *   - `contract_state` persisted contract evidence (external authority)
 *   - `entity_type` / `vesting_information` / `owner_count` structured owner data
 *
 * Returns `{ can_execute_alone, offer_progression_allowed,
 * contract_progression_allowed, block_reason, required_signers, ... }`.
 */
export function resolveSellerAuthorityState({
  message = "",
  known_facts = null,
  new_facts = null,
  contract_state = null,
  entity_type = null,
  vesting_information = null,
  owner_count = null,
} = {}) {
  const known = known_facts && typeof known_facts === "object" ? known_facts : {};
  const fresh = new_facts && typeof new_facts === "object" ? new_facts : {};
  const claims = fresh.authority_claims || known.authority_claims || null;

  // ── Structure detection: canonical Stage 6 engine on the raw text ────────
  const detected = detectAuthority({
    message: clean(message),
    entity_type,
    vesting_information,
    owner_count,
  });

  // ── Persisted claims can only ever RAISE the risk, never lower it ────────
  let structure = detected.ownership_structure;
  const claimed_structure = structureFromClaimedAuthorityType(claims?.authority_type);
  if (claimed_structure) structure = riskierStructure(structure, claimed_structure);

  for (const signer of claims?.additional_signers_claimed || []) {
    const mapped = SIGNOFF_RELATIONSHIP_STRUCTURE[lower(signer?.relationship)];
    if (mapped) structure = riskierStructure(structure, mapped);
  }

  const probate_detected =
    detectProbate({ message: clean(message), ownership_structure: structure }) ||
    known.probate_detected === true ||
    fresh.probate_detected === true ||
    lower(known.reason_for_selling) === "inherited_probate" ||
    lower(fresh.reason_for_selling) === "inherited_probate";

  const heirship_detected =
    detectHeirship({ message: clean(message), ownership_structure: structure }) ||
    known.heirship_detected === true ||
    fresh.heirship_detected === true;

  // ── Signer plan: Stage 6 owns the count; claims may only increase it ─────
  let signer_count_required = detected.signer_count_required;
  if (structure === OWNERSHIP_STRUCTURE.MARRIED_COUPLE) {
    signer_count_required = Math.max(signer_count_required, 2);
  }
  if (structure === OWNERSHIP_STRUCTURE.MULTIPLE_OWNERS) {
    signer_count_required = Math.max(signer_count_required, numberOrNull(owner_count) ?? 2);
  }
  const claimed_signers = (claims?.additional_signers_claimed || []).length;
  if (claimed_signers > 0) {
    signer_count_required = Math.max(signer_count_required, claimed_signers + 1);
  }

  const signer_count_confirmed =
    numberOrNull(contract_state?.signer_count_confirmed) ??
    numberOrNull(contract_state?.signers_confirmed) ??
    1;
  const signer_gap = Math.max(0, signer_count_required - signer_count_confirmed);

  // ── External authority evidence is the ONLY way to clear a risk ──────────
  // Seller text can raise authority risk but can never verify authority —
  // exactly the posture the Stage 6 engine already takes.
  const externally_verified =
    contract_state?.authority_verified === true ||
    contract_state?.authority_doc === true ||
    claims?.authority_verified === true;

  let authority_verified;
  if (externally_verified) authority_verified = true;
  else if (structure === OWNERSHIP_STRUCTURE.INDIVIDUAL) authority_verified = true;
  else if (
    structure === OWNERSHIP_STRUCTURE.MARRIED_COUPLE ||
    structure === OWNERSHIP_STRUCTURE.MULTIPLE_OWNERS
  ) {
    authority_verified = signer_gap <= 0;
  } else {
    authority_verified = false;
  }

  const explicit_signoff_required =
    claims?.can_execute_alone === false || claims?.requires_authority_review === true;

  const unresolved =
    !authority_verified ||
    explicit_signoff_required ||
    probate_detected ||
    heirship_detected;

  let block_reason = null;
  if (unresolved) {
    if (probate_detected) block_reason = AUTHORITY_BLOCK_REASONS.PROBATE_UNRESOLVED;
    else if (heirship_detected) block_reason = AUTHORITY_BLOCK_REASONS.HEIRSHIP_UNRESOLVED;
    else block_reason =
      STRUCTURE_BLOCK_REASON[structure] || AUTHORITY_BLOCK_REASONS.AUTHORITY_VERIFICATION_REQUIRED;
  }

  const can_execute_alone = !unresolved && signer_gap <= 0;

  return {
    version: AUTHORITY_STATE_VERSION,
    ownership_structure: structure,
    authority_type: claims?.authority_type || detected.authority_type,
    authority_claimed: Boolean(claims?.authority_claimed),
    // Text NEVER verifies authority — only external contract/title evidence.
    authority_verified: Boolean(externally_verified),
    authority_resolved: !unresolved,
    can_execute_alone,
    signer_count_required,
    signer_count_confirmed,
    signer_gap,
    additional_signers_claimed: claims?.additional_signers_claimed || [],
    probate_detected,
    heirship_detected,
    estate_context: probate_detected || heirship_detected || structure === OWNERSHIP_STRUCTURE.ESTATE,
    // The two shared gates. Offer-finalization and contract progression are
    // withheld together — the same predicate both callers read.
    offer_progression_allowed: !unresolved,
    contract_progression_allowed: !unresolved,
    block_reason,
    human_review_required: Boolean(
      probate_detected || heirship_detected || ENTITY_STRUCTURES.has(structure)
    ),
  };
}

export default resolveSellerAuthorityState;
