// ─── record-terms-snapshot.js ────────────────────────────────────────────
// Durable agreement terms snapshots (spine gap G9).
//
// Writes one append-only row to public.agreement_terms_snapshots capturing the
// economics of an agreement at a decision moment. Two producers:
//   * contract_creation  — called from maybe-create-contract-from-accepted-offer
//                          with the exact terms used for the Podio contract write;
//   * negotiation_acceptance — recordAcceptanceTermsSnapshot(), the acceptance-time
//                          hook (see the INTEGRATION NOTE on that export).
//
// Idempotency: terms_hash = sha256 over the canonical (sorted-key) JSON of
// identity + economics + source. Replaying the same snapshot is a no-op
// (unique constraint; insert races resolve via 23505 → deduped).
//
// Degradation: the backing migration is written but NOT applied. Until it is,
// every write degrades to a logged no-op with an explicit reason —
// "agreement_terms_snapshots_table_missing" — and never throws into the
// contract path.

import crypto from "node:crypto";

import { hasSupabaseConfig, supabase } from "@/lib/supabase/client.js";
import { child } from "@/lib/logging/logger.js";

const logger = child({ module: "domain.agreements.record_terms_snapshot" });

export const TERMS_SNAPSHOT_SOURCES = Object.freeze([
  "negotiation_acceptance",
  "contract_creation",
  "operator",
]);

const TABLE = "agreement_terms_snapshots";

function clean(value) {
  return String(value ?? "").trim();
}

function asNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

// ── Canonical JSON (deterministic key order at every depth) ────────────────
function canonicalize(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

export function computeTermsHash({
  opportunity_id = null,
  thread_key = null,
  property_id = null,
  master_owner_id = null,
  accepted_price = null,
  accepted_terms = null,
  seller_ask_at_acceptance = null,
  our_last_offer = null,
  authorized_ceiling_at_acceptance = null,
  source = null,
} = {}) {
  const canonical = canonicalize({
    identity: {
      opportunity_id: clean(opportunity_id) || null,
      thread_key: clean(thread_key) || null,
      property_id: clean(property_id) || null,
      master_owner_id: clean(master_owner_id) || null,
    },
    economics: {
      accepted_price: asNumberOrNull(accepted_price),
      accepted_terms:
        accepted_terms && typeof accepted_terms === "object"
          ? accepted_terms
          : {},
      seller_ask_at_acceptance: asNumberOrNull(seller_ask_at_acceptance),
      our_last_offer: asNumberOrNull(our_last_offer),
      authorized_ceiling_at_acceptance: asNumberOrNull(
        authorized_ceiling_at_acceptance
      ),
    },
    source: clean(source) || null,
  });

  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

function isMissingTableError(error) {
  if (!error) return false;
  const code = clean(error.code);
  const message = clean(error.message).toLowerCase();
  // 42P01 undefined_table via PostgREST; PGRST205 = table absent from the
  // PostgREST schema cache (what an unapplied migration actually produces).
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    message.includes("does not exist") ||
    message.includes("could not find the table")
  );
}

function isUniqueViolation(error) {
  return clean(error?.code) === "23505";
}

const defaultDeps = {
  hasSupabaseConfig,
  getClient: () => supabase,
  logger,
};

let runtimeDeps = { ...defaultDeps };

export function __setRecordTermsSnapshotTestDeps(overrides = {}) {
  runtimeDeps = { ...runtimeDeps, ...overrides };
}

export function __resetRecordTermsSnapshotTestDeps() {
  runtimeDeps = { ...defaultDeps };
}

/**
 * Record a durable terms snapshot. Never throws; always returns
 * { ok, recorded, deduped, reason, terms_hash, snapshot_id }.
 */
export async function recordTermsSnapshot({
  opportunity_id = null,
  thread_key = null,
  property_id = null,
  master_owner_id = null,
  accepted_price = null,
  accepted_terms = null,
  seller_ask_at_acceptance = null,
  our_last_offer = null,
  authorized_ceiling_at_acceptance = null,
  negotiation_state_version = null,
  source = null,
  podio_contract_item_id = null,
} = {}) {
  const normalized_source = clean(source);

  if (!TERMS_SNAPSHOT_SOURCES.includes(normalized_source)) {
    return {
      ok: false,
      recorded: false,
      deduped: false,
      reason: "invalid_terms_snapshot_source",
      terms_hash: null,
      snapshot_id: null,
    };
  }

  const terms_hash = computeTermsHash({
    opportunity_id,
    thread_key,
    property_id,
    master_owner_id,
    accepted_price,
    accepted_terms,
    seller_ask_at_acceptance,
    our_last_offer,
    authorized_ceiling_at_acceptance,
    source: normalized_source,
  });

  if (!runtimeDeps.hasSupabaseConfig()) {
    runtimeDeps.logger.warn("terms_snapshot.skipped_no_supabase", {
      source: normalized_source,
      terms_hash,
    });

    return {
      ok: false,
      recorded: false,
      deduped: false,
      reason: "supabase_not_configured",
      terms_hash,
      snapshot_id: null,
    };
  }

  const client = runtimeDeps.getClient();
  const row = {
    opportunity_id: clean(opportunity_id) || null,
    thread_key: clean(thread_key) || null,
    property_id: clean(property_id) || null,
    master_owner_id: clean(master_owner_id) || null,
    accepted_price: asNumberOrNull(accepted_price),
    accepted_terms:
      accepted_terms && typeof accepted_terms === "object"
        ? canonicalize(accepted_terms)
        : {},
    seller_ask_at_acceptance: asNumberOrNull(seller_ask_at_acceptance),
    our_last_offer: asNumberOrNull(our_last_offer),
    authorized_ceiling_at_acceptance: asNumberOrNull(
      authorized_ceiling_at_acceptance
    ),
    negotiation_state_version: clean(negotiation_state_version) || null,
    terms_hash,
    source: normalized_source,
    podio_contract_item_id: asNumberOrNull(podio_contract_item_id),
  };

  try {
    // Replay fast-path: identical snapshot already durable → no-op.
    const existing = await client
      .from(TABLE)
      .select("id")
      .eq("terms_hash", terms_hash)
      .limit(1)
      .maybeSingle();

    if (existing?.error) {
      if (isMissingTableError(existing.error)) {
        runtimeDeps.logger.warn("terms_snapshot.table_missing_noop", {
          source: normalized_source,
          terms_hash,
          reason: "agreement_terms_snapshots_table_missing",
        });

        return {
          ok: false,
          recorded: false,
          deduped: false,
          reason: "agreement_terms_snapshots_table_missing",
          terms_hash,
          snapshot_id: null,
        };
      }

      runtimeDeps.logger.warn("terms_snapshot.lookup_failed", {
        source: normalized_source,
        terms_hash,
        error: clean(existing.error.message) || "unknown_error",
      });
      // Fall through to insert: worst case the unique constraint dedupes.
    }

    if (existing?.data?.id) {
      return {
        ok: true,
        recorded: false,
        deduped: true,
        reason: "terms_snapshot_already_recorded",
        terms_hash,
        snapshot_id: existing.data.id,
      };
    }

    const inserted = await client
      .from(TABLE)
      .insert(row)
      .select("id")
      .maybeSingle();

    if (inserted?.error) {
      if (isMissingTableError(inserted.error)) {
        runtimeDeps.logger.warn("terms_snapshot.table_missing_noop", {
          source: normalized_source,
          terms_hash,
          reason: "agreement_terms_snapshots_table_missing",
        });

        return {
          ok: false,
          recorded: false,
          deduped: false,
          reason: "agreement_terms_snapshots_table_missing",
          terms_hash,
          snapshot_id: null,
        };
      }

      if (isUniqueViolation(inserted.error)) {
        return {
          ok: true,
          recorded: false,
          deduped: true,
          reason: "terms_snapshot_already_recorded",
          terms_hash,
          snapshot_id: null,
        };
      }

      runtimeDeps.logger.warn("terms_snapshot.insert_failed", {
        source: normalized_source,
        terms_hash,
        error: clean(inserted.error.message) || "unknown_error",
      });

      return {
        ok: false,
        recorded: false,
        deduped: false,
        reason: "terms_snapshot_insert_failed",
        terms_hash,
        snapshot_id: null,
      };
    }

    runtimeDeps.logger.info("terms_snapshot.recorded", {
      source: normalized_source,
      terms_hash,
      snapshot_id: inserted?.data?.id || null,
      opportunity_id: row.opportunity_id,
      podio_contract_item_id: row.podio_contract_item_id,
    });

    return {
      ok: true,
      recorded: true,
      deduped: false,
      reason: "terms_snapshot_recorded",
      terms_hash,
      snapshot_id: inserted?.data?.id || null,
    };
  } catch (error) {
    runtimeDeps.logger.warn("terms_snapshot.unexpected_failure", {
      source: normalized_source,
      terms_hash,
      error: clean(error?.message) || "unknown_error",
    });

    return {
      ok: false,
      recorded: false,
      deduped: false,
      reason: "terms_snapshot_unexpected_failure",
      terms_hash,
      snapshot_id: null,
    };
  }
}

/**
 * Acceptance-time hook: snapshot the negotiation-state acceptance lock.
 *
 * INTEGRATION NOTE (for the lead — do not wire from this lane):
 * The seller-path call-site belongs in persist-seller-transition.js (Agent C's
 * file), immediately after the updated negotiation_state is persisted onto
 * acquisition_opportunities.metadata, guarded on a FRESH acceptance:
 *
 *   if (negotiation_state?.terms_accepted && !previous_state?.terms_accepted) {
 *     await recordAcceptanceTermsSnapshot(negotiation_state, opportunity);
 *   }
 *
 * The hook itself is idempotent (terms_hash dedupe), so a coarser guard
 * (calling it on every persist while terms_accepted is true) is also safe —
 * it will record exactly one row per distinct accepted-terms content.
 */
export async function recordAcceptanceTermsSnapshot(
  negotiationState = null,
  opportunity = null
) {
  if (!negotiationState?.terms_accepted) {
    return {
      ok: true,
      recorded: false,
      deduped: false,
      reason: "terms_not_accepted",
      terms_hash: null,
      snapshot_id: null,
    };
  }

  return recordTermsSnapshot({
    opportunity_id: opportunity?.id || null,
    thread_key:
      clean(opportunity?.primary_thread_key) ||
      clean(negotiationState?.thread_key) ||
      null,
    property_id: opportunity?.primary_property_id || null,
    master_owner_id: opportunity?.master_owner_id || null,
    accepted_price: negotiationState.accepted_price,
    accepted_terms: negotiationState.accepted_terms || {},
    seller_ask_at_acceptance: negotiationState.current_asking_price,
    our_last_offer: negotiationState.latest_offer,
    authorized_ceiling_at_acceptance:
      negotiationState.authorized_offer_ceiling,
    negotiation_state_version: negotiationState.version || null,
    source: "negotiation_acceptance",
  });
}

export default recordTermsSnapshot;
