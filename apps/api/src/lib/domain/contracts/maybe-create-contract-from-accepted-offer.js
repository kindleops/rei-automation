// ─── maybe-create-contract-from-accepted-offer.js ───────────────────────
import {
  CONTRACT_FIELDS,
  findContractItems,
} from "@/lib/podio/apps/contracts.js";
import { createContractFromOffer } from "@/lib/domain/contracts/create-contract-from-offer.js";
import { maybeSendContractForSigning } from "@/lib/domain/contracts/maybe-send-contract-for-signing.js";
import { recordTermsSnapshot } from "@/lib/domain/agreements/record-terms-snapshot.js";
import { syncPipelineState } from "@/lib/domain/pipelines/sync-pipeline-state.js";
import { hasSupabaseConfig, supabase } from "@/lib/supabase/client.js";

const defaultDeps = {
  findContractItems,
  createContractFromOffer,
  maybeSendContractForSigning,
  recordTermsSnapshot,
  syncPipelineState,
  loadOpportunityNegotiationState,
};

let runtimeDeps = { ...defaultDeps };

export function __setMaybeCreateContractTestDeps(overrides = {}) {
  runtimeDeps = { ...runtimeDeps, ...overrides };
}

export function __resetMaybeCreateContractTestDeps() {
  runtimeDeps = { ...defaultDeps };
}

function clean(value) {
  return String(value ?? "").trim();
}

function getFieldValue(item, external_id) {
  const fields = Array.isArray(item?.fields) ? item.fields : [];
  const field = fields.find((entry) => entry?.external_id === external_id);

  if (!field?.values?.length) return null;

  const first = field.values[0];

  if (first?.value?.item_id) return first.value.item_id;
  if (typeof first?.value === "string") return first.value;
  if (typeof first?.value === "number") return first.value;
  if (first?.value?.text) return first.value.text;
  if (first?.start) return first.start;

  return null;
}

function sortNewestFirst(items = []) {
  return [...items].sort((a, b) => {
    const a_id = Number(a?.item_id || 0);
    const b_id = Number(b?.item_id || 0);
    return b_id - a_id;
  });
}

/**
 * Progress reasons that genuinely mean the seller agreed, matched EXACTLY.
 *
 * The previous test was `reason.includes("accept")`, which also matched
 * "not accepted", "didn't accept", "offer_not_accepted" — any future reason
 * string carrying the substring would have silently created a contract.
 * decideNextOfferStatus emits exactly one acceptance reason; the rest
 * (seller_counter_signal, seller_rejection_signal, no_offer_status_change,
 * compliance_stop, missing_offer_item_id) must never match.
 */
const ACCEPTED_PROGRESS_REASONS = new Set(["seller_acceptance_signal"]);
const ACCEPTED_OFFER_STATUS = "accepted (ready for contract)";

/**
 * @returns {{accepted: boolean, corroboration: string|null}} corroboration is
 *   "text_agreement" when a seller message drove the acceptance, and
 *   "podio_status_only" when the Podio status field is the only evidence —
 *   a real operator flow (phone-negotiated deals), so it is recorded for audit
 *   rather than blocked.
 */
function isAcceptedOffer({
  offer_item = null,
  offer_status = null,
  offer_progress = null,
} = {}) {
  // A text-derived acceptance is the strongest evidence; check it first so it
  // wins the corroboration label even when Podio also shows the status.
  if (ACCEPTED_PROGRESS_REASONS.has(clean(offer_progress?.reason).toLowerCase())) {
    return { accepted: true, corroboration: "text_agreement" };
  }

  if (clean(offer_progress?.result?.status).toLowerCase() === ACCEPTED_OFFER_STATUS) {
    return { accepted: true, corroboration: "text_agreement" };
  }

  const normalized_status =
    clean(offer_status) ||
    clean(getFieldValue(offer_item, "offer-status")) ||
    "";

  if (normalized_status.toLowerCase() === ACCEPTED_OFFER_STATUS) {
    return { accepted: true, corroboration: "podio_status_only" };
  }

  return { accepted: false, corroboration: null };
}

/**
 * Best-effort read of the persisted negotiation state so an acceptance can be
 * corroborated against what the conversation actually agreed. Never throws and
 * never blocks contract creation — absence is normal for phone-negotiated deals.
 */
async function loadOpportunityNegotiationState(opportunity_id = null) {
  const id = clean(opportunity_id);
  if (!id) return null;
  try {
    if (!hasSupabaseConfig()) return null;
    const { data, error } = await supabase
      .from("acquisition_opportunities")
      .select("id,metadata")
      .eq("id", id)
      .maybeSingle();
    if (error || !data) return null;
    const metadata =
      data.metadata && typeof data.metadata === "object" ? data.metadata : {};
    return metadata.negotiation_state &&
      typeof metadata.negotiation_state === "object"
      ? metadata.negotiation_state
      : null;
  } catch {
    return null;
  }
}

/**
 * Fold the persisted negotiation state into the acceptance verdict. A recorded
 * terms_accepted upgrades a Podio-status-only acceptance to text_agreement,
 * because the conversation independently reached the same conclusion.
 */
function resolveAcceptanceCorroboration(verdict, negotiation_state) {
  const terms_accepted = negotiation_state?.terms_accepted === true;
  const corroboration =
    verdict.corroboration === "text_agreement" || terms_accepted
      ? "text_agreement"
      : "podio_status_only";

  const accepted_price =
    negotiation_state?.accepted_price ??
    negotiation_state?.terms_accepted_price ??
    null;

  return {
    acceptance_corroboration: corroboration,
    ...(negotiation_state ? { terms_accepted } : {}),
    ...(accepted_price !== null && accepted_price !== undefined
      ? { accepted_price }
      : {}),
  };
}

async function findLatestContractByOfferId(offer_item_id) {
  if (!offer_item_id) return null;

  const matches = await runtimeDeps.findContractItems(
    { [CONTRACT_FIELDS.offer]: offer_item_id },
    50,
    0
  );

  return sortNewestFirst(matches)[0] || null;
}

function firstAppRefId(payload_value) {
  if (Array.isArray(payload_value)) return payload_value[0] || null;
  return payload_value || null;
}

/**
 * Project an existing Podio contract ITEM into the same payload shape
 * createContractFromOffer returns, so the terms snapshot reads identically on
 * both branches. getFieldValue already unwraps app refs to item ids and dates
 * to their start string; the date is re-wrapped to match the payload contract.
 */
function contractPayloadFromItem(item) {
  const closing_date_target = getFieldValue(item, CONTRACT_FIELDS.closing_date_target);
  return {
    [CONTRACT_FIELDS.contract_id]: getFieldValue(item, CONTRACT_FIELDS.contract_id),
    [CONTRACT_FIELDS.contract_status]: getFieldValue(item, CONTRACT_FIELDS.contract_status),
    [CONTRACT_FIELDS.contract_type]: getFieldValue(item, CONTRACT_FIELDS.contract_type),
    [CONTRACT_FIELDS.template_type]: getFieldValue(item, CONTRACT_FIELDS.template_type),
    [CONTRACT_FIELDS.purchase_price_final]: getFieldValue(
      item,
      CONTRACT_FIELDS.purchase_price_final
    ),
    [CONTRACT_FIELDS.emd_amount]: getFieldValue(item, CONTRACT_FIELDS.emd_amount),
    [CONTRACT_FIELDS.closing_timeline_days]: getFieldValue(
      item,
      CONTRACT_FIELDS.closing_timeline_days
    ),
    [CONTRACT_FIELDS.closing_date_target]: closing_date_target
      ? { start: closing_date_target }
      : null,
    [CONTRACT_FIELDS.creative_terms]: getFieldValue(item, CONTRACT_FIELDS.creative_terms),
    [CONTRACT_FIELDS.property]: getFieldValue(item, CONTRACT_FIELDS.property),
    [CONTRACT_FIELDS.master_owner]: getFieldValue(item, CONTRACT_FIELDS.master_owner),
    [CONTRACT_FIELDS.offer]: getFieldValue(item, CONTRACT_FIELDS.offer),
  };
}

// Durable terms snapshot (spine gap G9): capture the exact economics written
// to Podio at contract creation. Never fatal — the snapshot writer degrades to
// a logged no-op (missing table / missing config) and never throws.
async function recordContractCreationTermsSnapshot({
  created_contract = null,
  metadata = {},
  corroboration = null,
} = {}) {
  const payload = created_contract?.payload || {};

  return runtimeDeps.recordTermsSnapshot({
    opportunity_id: metadata?.opportunity_id || null,
    thread_key: metadata?.thread_key || null,
    property_id: firstAppRefId(payload[CONTRACT_FIELDS.property]),
    master_owner_id: firstAppRefId(payload[CONTRACT_FIELDS.master_owner]),
    accepted_price: payload[CONTRACT_FIELDS.purchase_price_final] ?? null,
    accepted_terms: {
      contract_id: payload[CONTRACT_FIELDS.contract_id] || null,
      contract_status: payload[CONTRACT_FIELDS.contract_status] || null,
      contract_type: payload[CONTRACT_FIELDS.contract_type] || null,
      template_type: payload[CONTRACT_FIELDS.template_type] || null,
      purchase_price: payload[CONTRACT_FIELDS.purchase_price_final] ?? null,
      emd_amount: payload[CONTRACT_FIELDS.emd_amount] ?? null,
      closing_timeline_days:
        payload[CONTRACT_FIELDS.closing_timeline_days] ?? null,
      closing_date_target:
        payload[CONTRACT_FIELDS.closing_date_target]?.start || null,
      creative_terms: payload[CONTRACT_FIELDS.creative_terms] || null,
      offer_item_id: firstAppRefId(payload[CONTRACT_FIELDS.offer]),
      // How the acceptance was evidenced, so a podio_status_only contract is
      // distinguishable from a text-corroborated one at audit time.
      ...(corroboration || {}),
    },
    seller_ask_at_acceptance: metadata?.seller_ask_at_acceptance ?? null,
    our_last_offer: metadata?.our_last_offer ?? null,
    authorized_ceiling_at_acceptance:
      metadata?.authorized_ceiling_at_acceptance ?? null,
    negotiation_state_version: metadata?.negotiation_state_version || null,
    source: "contract_creation",
    podio_contract_item_id: created_contract?.contract_item_id || null,
  });
}

function isTerminalContractStatus(status = "") {
  const normalized = clean(status).toLowerCase();
  return ["fully executed", "closed", "cancelled"].includes(normalized);
}

export async function maybeCreateContractFromAcceptedOffer({
  offer_item = null,
  offer_item_id = null,
  offer_status = null,
  offer_progress = null,
  context = null,
  route = null,
  underwriting = null,
  pipeline_item_id = null,
  title_company_item_id = null,
  contract_status = "Draft",
  notes = "",
  source_message = "",
  documents = [],
  signers = [],
  subject = null,
  template_id = null,
  email_blurb = "",
  metadata = {},
  auto_send = false,
  dry_run = false,
} = {}) {
  const resolved_offer_item_id =
    offer_item?.item_id ||
    offer_item_id ||
    null;

  if (!resolved_offer_item_id) {
    return {
      ok: false,
      created: false,
      sent: false,
      reason: "missing_offer_item_id",
    };
  }

  const acceptance = isAcceptedOffer({
    offer_item,
    offer_status,
    offer_progress,
  });

  if (!acceptance.accepted) {
    return {
      ok: true,
      created: false,
      sent: false,
      reason: "offer_not_accepted",
      offer_item_id: resolved_offer_item_id,
    };
  }

  // Corroborate the acceptance against the persisted negotiation state. This
  // never blocks — a podio_status_only acceptance is a legitimate operator flow
  // (phone-negotiated deals) — it makes the seam auditable.
  const negotiation_state = await runtimeDeps.loadOpportunityNegotiationState(
    metadata?.opportunity_id || null
  );
  const corroboration = resolveAcceptanceCorroboration(
    acceptance,
    negotiation_state
  );

  const existing_contract = await findLatestContractByOfferId(
    resolved_offer_item_id
  );

  if (existing_contract?.item_id) {
    const existing_contract_status = clean(
      getFieldValue(existing_contract, CONTRACT_FIELDS.contract_status)
    );

    if (!isTerminalContractStatus(existing_contract_status)) {
      const maybe_send_existing = await runtimeDeps.maybeSendContractForSigning({
        contract: existing_contract,
        documents,
        signers,
        subject,
        template_id,
        email_blurb,
        metadata,
        auto_send,
        dry_run,
      });
      const pipeline = await runtimeDeps.syncPipelineState({
        offer_item_id: resolved_offer_item_id,
        contract_item_id: existing_contract.item_id,
        notes: maybe_send_existing?.sent
          ? "Existing contract sent for signature."
          : "Existing contract found for accepted offer.",
      });

      // The existing-contract branch used to return without recording a terms
      // snapshot, so an acceptance that landed on an already-created contract
      // left no durable record of the economics at that moment. The write is
      // terms_hash-idempotent, so recording it here cannot duplicate.
      const existing_terms_snapshot = await recordContractCreationTermsSnapshot({
        created_contract: {
          contract_item_id: existing_contract.item_id,
          payload: contractPayloadFromItem(existing_contract),
        },
        metadata,
        corroboration,
      });

      return {
        ok: true,
        created: false,
        sent: Boolean(maybe_send_existing?.sent),
        reason: "existing_contract_found",
        offer_item_id: resolved_offer_item_id,
        contract_item_id: existing_contract.item_id,
        existing_contract,
        send_result: maybe_send_existing,
        pipeline,
        terms_snapshot: existing_terms_snapshot,
        ...corroboration,
      };
    }
  }

  const created_contract = await runtimeDeps.createContractFromOffer({
    offer_item_id: resolved_offer_item_id,
    offer_item,
    context,
    route,
    underwriting,
    pipeline_item_id,
    title_company_item_id,
    contract_status,
    notes,
    source_message,
  });

  if (!created_contract?.ok || !created_contract?.contract_item_id) {
    return {
      ok: false,
      created: false,
      sent: false,
      reason: created_contract?.reason || "contract_create_failed",
      offer_item_id: resolved_offer_item_id,
      created_contract,
    };
  }

  const terms_snapshot = await recordContractCreationTermsSnapshot({
    created_contract,
    metadata,
    corroboration,
  });

  const maybe_send = await runtimeDeps.maybeSendContractForSigning({
    contract: {
      contract_item_id: created_contract.contract_item_id,
    },
    documents,
    signers,
    subject,
    template_id,
    email_blurb,
    metadata,
    auto_send,
    dry_run,
  });

  return {
    ok: true,
    created: true,
    sent: Boolean(maybe_send?.sent),
    reason: "contract_created_from_accepted_offer",
    offer_item_id: resolved_offer_item_id,
    contract_item_id: created_contract.contract_item_id,
    contract: created_contract,
    terms_snapshot,
    send_result: maybe_send,
    ...corroboration,
  };
}

export default maybeCreateContractFromAcceptedOffer;
