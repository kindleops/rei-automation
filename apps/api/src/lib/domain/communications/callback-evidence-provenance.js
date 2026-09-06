/**
 * callback-evidence-provenance.js
 *
 * WHERE a piece of provider evidence came from, kept strictly separate from HOW
 * MUCH we trust it.
 *
 * THE MISTAKE THIS EXISTS TO PREVENT.
 *   All three delivery lanes funnel through syncDeliveryEvent, so it is tempting
 *   to treat everything arriving there as "a provider callback". They are not
 *   the same kind of evidence:
 *
 *     live receipt      the provider POSTed to us, once, just now
 *     recovery replay   we are re-reading a receipt we already stored
 *     poll observation  WE asked the provider; nothing was pushed to us
 *
 *   Collapsing them would let a poll result be recorded as though a webhook had
 *   arrived, and would let a recovery worker mint a second "receipt" for an
 *   event that was received once. Both corrupt the ledger's meaning: it is a
 *   record of what the provider TOLD US, unprompted, and when.
 *
 * PROVENANCE IS NOT TRUST. They answer different questions and must never be
 * substituted for one another:
 *
 *     provenance  which lane delivered this to the seam
 *     trust       what verification actually established at receipt time
 *
 *   A recovery replay of an unauthenticated live receipt is still
 *   UNAUTHENTICATED. Replaying it through an internal worker does not
 *   authenticate anything -- the worker is trusted, the original claim is not.
 *   Recovery therefore carries recovery PROVENANCE while preserving the
 *   ORIGINAL receipt trust, and never rewrites it.
 */

export const EVIDENCE_PROVENANCE_POLICY_VERSION = 'evidence_provenance_v1';

export const EVIDENCE_PROVENANCE = Object.freeze({
  /** The provider POSTed a delivery receipt to our webhook, now. */
  LIVE_PROVIDER_RECEIPT: 'live_provider_receipt',
  /** A worker is re-processing a receipt already stored durably. */
  RECORDED_CALLBACK_REPLAY: 'recorded_callback_replay',
  /** WE asked the provider for status. Nothing was pushed to us. */
  PROVIDER_POLL_OBSERVATION: 'provider_poll_observation',
  /** An internal, non-provider probe (commissioning, diagnostics). */
  INTERNAL_PROBE: 'internal_probe',
  /*
   * Named distinctly from the TRUST_CLASS value of the same idea. `test_fixture`
   * previously appeared in BOTH vocabularies, so a value could be passed into
   * either slot, typecheck, and mean the wrong thing -- "this arrived via the
   * test lane" is a different claim from "we trust this because it is a
   * fixture". A disjointness test now pins them apart.
   */
  TEST_FIXTURE_LANE: 'test_fixture_lane',
  /** Lane did not declare itself. Treated as the most restrictive case. */
  UNDECLARED: 'undeclared',
});

/**
 * May this provenance create a row in the CALLBACK RECEIPT ledger?
 *
 * Only evidence the provider actually pushed to us. A poll observation is our
 * question and their answer, not a receipt, and recording it as one would make
 * the ledger claim a webhook arrived when none did.
 *
 * A recovery replay may REFERENCE an existing receipt, but must not mint a new
 * one -- handled by fingerprint identity, which is derived from provider
 * evidence and so resolves to the same row on replay.
 */
export function mayRecordAsCallbackReceipt(provenance) {
  return provenance === EVIDENCE_PROVENANCE.LIVE_PROVIDER_RECEIPT
    || provenance === EVIDENCE_PROVENANCE.RECORDED_CALLBACK_REPLAY;
}

/**
 * May this provenance advance canonical provider truth at all?
 *
 * Poll observations are deliberately excluded. The repository has never verified
 * that TextGrid's status-lookup-by-SID is authoritative -- the capability audit
 * records it as unsupported -- so treating a poll answer as canonical truth
 * would be inventing provider semantics. Poll evidence may still inform
 * operators; it may not move the ledger.
 */
export function mayAdvanceCanonicalTruth(provenance) {
  return provenance === EVIDENCE_PROVENANCE.LIVE_PROVIDER_RECEIPT
    || provenance === EVIDENCE_PROVENANCE.RECORDED_CALLBACK_REPLAY;
}

/** Is this a recognised provenance, or did a lane forget to declare one? */
export function normalizeProvenance(value) {
  const known = Object.values(EVIDENCE_PROVENANCE);
  return known.includes(value) ? value : EVIDENCE_PROVENANCE.UNDECLARED;
}

/**
 * Trust that a REPLAY should carry.
 *
 * The original receipt's trust is the answer, always. This function exists so
 * the rule is written down in one place rather than re-derived at each call
 * site, where "it came from our own database, so it must be fine" is an easy
 * and wrong inference.
 */
export function trustForReplay(original_trust_class) {
  return original_trust_class || null;
}

export default {
  EVIDENCE_PROVENANCE,
  EVIDENCE_PROVENANCE_POLICY_VERSION,
  mayRecordAsCallbackReceipt,
  mayAdvanceCanonicalTruth,
  normalizeProvenance,
  trustForReplay,
};
