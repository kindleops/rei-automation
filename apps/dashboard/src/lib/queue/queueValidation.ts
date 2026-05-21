/**
 * Queue Validation Logic
 * 
 * Centralized gatekeeper for outbound messaging queue health.
 * Prevents malformed rows from causing silent failures in the runner.
 */

import { normalizePhone } from '../data/inboxWorkflowData';

export interface QueueValidationResult {
  isValid: boolean;
  errors: string[];
  repairable: boolean;
  suggestedThreadKey: string | null;
  sanitizedBody: string;
}

/**
 * Validates a queued row for transmission readiness.
 */
export function validateQueueRow(row: any): QueueValidationResult {
  const errors: string[] = [];
  let suggestedThreadKey = row.thread_key || null;
  
  // 1. Mandatory Phone Validation
  const toPhone = normalizePhone(row.to_phone_number);
  const fromPhone = normalizePhone(row.from_phone_number);

  if (!toPhone) errors.push('missing_to_phone_number');
  if (!fromPhone) errors.push('missing_from_phone_number');

  // 2. Body Validation
  let body = (row.message_body || row.message_text || '').trim();
  if (!body) {
    errors.push('missing_message_body');
  } else {
    // Feeder Template Fix: Correct blank greetings
    // LEGACY: there fallback is forbidden. 
    // Strict name hydration required.
  }

  // 3. Thread Key Integrity
  if (!suggestedThreadKey) {
    if (toPhone && fromPhone) {
      // Backfill with canonical identifier
      suggestedThreadKey = `${toPhone}|${fromPhone}`;
    } else {
      errors.push('unrepairable_missing_thread_key');
    }
  }

  // 4. Critical Dependencies
  if (!row.textgrid_number_id && !row.from_phone_number) {
    errors.push('missing_outbound_route');
  }

  const isRepairable = !errors.includes('unrepairable_missing_thread_key') && 
                      errors.filter(e => e !== 'missing_thread_key').length === 0;

  return {
    isValid: errors.length === 0,
    errors,
    repairable: isRepairable,
    suggestedThreadKey,
    sanitizedBody: body
  };
}
