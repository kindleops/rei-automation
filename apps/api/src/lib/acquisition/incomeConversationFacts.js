/**
 * Acquisition Engine V3 — Item 5C: conversation-derived income fact contract
 * (mission §7).
 *
 * Normalizes facts a seller stated in conversation (monthly rent, occupied
 * units, vacancy, tenant payment status, taxes, insurance, mortgage payment,
 * loan balance, interest rate, arrears, repairs) into provenance-bearing fields.
 *
 * Guarantees:
 *   - preserves the exact source message/thread id
 *   - a seller STATEMENT is OWNER_REPORTED, never VERIFIED_DOCUMENT
 *   - carries extraction confidence + user-confirmation status
 *   - detects contradictions against an existing snapshot
 *   - NEVER overwrites verified/actual data with a conversational estimate
 *
 * READ-ONLY and pure. This module does NOT read messages, classify, or alter any
 * messaging/conversation behavior — it normalizes already-extracted facts that a
 * caller supplies.
 */

import {
  EVIDENCE_BASIS,
  CONFLICT_STATUS,
  VALIDATION_STATUS,
  provField,
  isKnown,
  basisRank,
} from './incomeSnapshotContract.js';
import { num } from './modelConstants.js';

/** Conversation fact key → canonical snapshot field it maps onto. */
export const CONVERSATION_FACT_MAP = Object.freeze({
  monthly_rent: 'actual_monthly_base_rent',
  occupied_units: 'occupied_units',
  vacancy: 'vacant_units',
  taxes: 'property_taxes',
  insurance: 'insurance',
  mortgage_payment: 'total_monthly_debt_service',
  loan_balance: 'loan_balance',
  interest_rate: 'interest_rate',
  arrears: 'arrears',
  repairs: 'repairs_maintenance',
});

/** Facts that are tenant-status descriptors (not numeric snapshot scalars). */
export const STATUS_FACTS = Object.freeze(['tenant_payment_status']);

/**
 * Normalize one extracted conversation fact into a provenance field.
 * @param {object} fact {
 *   key, value, thread_id, message_id, extracted_at, extraction_confidence,
 *   user_confirmed (bool), verbatim
 * }
 */
export function normalizeConversationFact(fact = {}) {
  const field = CONVERSATION_FACT_MAP[fact.key] ?? null;
  const confirmed = fact.user_confirmed === true;
  // A confirmed fact is OWNER_REPORTED; an unconfirmed extraction is still
  // OWNER_REPORTED in basis but carries lower confidence and UNVALIDATED status.
  const basis = EVIDENCE_BASIS.OWNER_REPORTED;
  const confidence = Math.max(
    0,
    Math.min(100, (num(fact.extraction_confidence) ?? 50) - (confirmed ? 0 : 20)),
  );
  return {
    fact_key: fact.key,
    snapshot_field: field,
    is_status_fact: STATUS_FACTS.includes(fact.key),
    field: provField(fact.value, {
      source: 'conversation',
      source_record_id: fact.message_id ?? fact.thread_id ?? null,
      observed_at: fact.extracted_at ?? null,
      confidence,
      basis,
      extraction_method: 'conversation_extraction',
      validation_status: confirmed ? VALIDATION_STATUS.VALID : VALIDATION_STATUS.UNVALIDATED,
    }),
    provenance: {
      thread_id: fact.thread_id ?? null,
      message_id: fact.message_id ?? null,
      verbatim: fact.verbatim ?? null,
      user_confirmed: confirmed,
      seller_statement: true,
      verified_document: false,
    },
  };
}

/**
 * Reconcile a normalized conversation fact against an existing snapshot field.
 * Returns the action the loader should take — conversational estimates NEVER
 * overwrite a more-reliable existing value; contradictions are flagged.
 *
 * @returns {{ action:'APPLY'|'KEEP_EXISTING'|'CONFLICT', reason, conflict, existing_basis }}
 */
export function reconcileConversationFact(normalized, existingField) {
  if (!normalized.snapshot_field) {
    return { action: 'KEEP_EXISTING', reason: 'status_or_unmapped_fact', conflict: CONFLICT_STATUS.NONE, existing_basis: existingField?.basis ?? EVIDENCE_BASIS.UNKNOWN };
  }
  if (!isKnown(existingField)) {
    return { action: 'APPLY', reason: 'no_existing_value', conflict: CONFLICT_STATUS.NONE, existing_basis: EVIDENCE_BASIS.UNKNOWN };
  }
  const convBasis = normalized.field.basis;
  // Existing value is MORE reliable (lower rank index) → never overwrite.
  if (basisRank(existingField.basis) < basisRank(convBasis)) {
    // If they disagree materially, surface a conflict but keep the verified value.
    const a = num(existingField.value); const b = num(normalized.field.value);
    let conflict = CONFLICT_STATUS.NONE;
    if (a !== null && b !== null) {
      const v = Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1);
      conflict = v >= 0.2 ? CONFLICT_STATUS.MATERIAL : v >= 0.1 ? CONFLICT_STATUS.MINOR : CONFLICT_STATUS.NONE;
    }
    return { action: 'KEEP_EXISTING', reason: 'existing_more_reliable_than_conversation', conflict, existing_basis: existingField.basis };
  }
  // Conversation is equal/more reliable → apply, flagging numeric disagreement.
  const a = num(existingField.value); const b = num(normalized.field.value);
  let conflict = CONFLICT_STATUS.NONE;
  if (a !== null && b !== null) {
    const v = Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1);
    conflict = v >= 0.2 ? CONFLICT_STATUS.MATERIAL : v >= 0.1 ? CONFLICT_STATUS.MINOR : CONFLICT_STATUS.NONE;
  }
  return { action: conflict === CONFLICT_STATUS.MATERIAL ? 'CONFLICT' : 'APPLY', reason: 'conversation_at_least_as_reliable', conflict, existing_basis: existingField.basis };
}
