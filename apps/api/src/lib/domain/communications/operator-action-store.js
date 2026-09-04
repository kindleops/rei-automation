/**
 * operator-action-store.js
 *
 * Gives an operator's intent an identity that exists BEFORE it is executed.
 *
 * THE PROBLEM THIS REPLACES.
 *   send-now built its identity inside the execution path:
 *
 *     queue_key = clean(input.queue_key) || `inbox:send_now:${randomUUID()}`
 *
 *   so the identity of the operator's intent was created by the act of
 *   executing it. Nothing downstream could distinguish "the same click, retried
 *   after a timeout" from "a second, deliberate click" -- the two are only
 *   separable if the action exists durably before the send is attempted.
 *
 * WHAT A MISSING IDEMPOTENCY KEY HONESTLY MEANS.
 *   When a caller supplies request_idempotency_key, retries of that one click
 *   collapse onto one action and therefore one logical communication. When a
 *   caller supplies none, we do NOT invent one from the body, the thread or the
 *   clock: a body-derived key would merge two genuinely separate operator
 *   decisions to send the same text, and a clock-derived key would split one
 *   click into two actions on a slow retry. Both are guesses dressed up as
 *   deduplication. With no key, each call is recorded as a new action, which is
 *   the only claim the data actually supports.
 */

import { child } from '@/lib/logging/logger.js';
import { supabase as defaultSupabase } from '@/lib/supabase/client.js';

const logger = child({ module: 'domain.communications.operator_action' });

function clean(value) {
  return String(value ?? '').trim();
}

/**
 * Resolve (or create) the durable operator action for this request.
 *
 * @returns {{ok:true, operator_action_id:string, reused:boolean}|{ok:false, reason:string}}
 */
export async function resolveOperatorAction(input = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase;

  // An explicit id from the caller means the action already exists.
  const explicit = clean(input.operator_action_id);
  if (explicit) return { ok: true, operator_action_id: explicit, reused: true };

  const action_type = clean(input.action_type) || 'manual_inbox_send_now';
  const idempotency_key = clean(input.request_idempotency_key);

  // With a key, one click resolves to one row no matter how often it retries.
  if (idempotency_key) {
    const { data: existing, error: read_error } = await supabase
      .from('seller_operator_actions')
      .select('id')
      .eq('request_idempotency_key', idempotency_key)
      .maybeSingle();

    if (read_error) {
      logger.error('operator_action.lookup_failed', { error: clean(read_error.message) });
      return { ok: false, reason: 'operator_action_store_error' };
    }
    if (existing?.id) {
      return { ok: true, operator_action_id: existing.id, reused: true };
    }
  }

  const { data, error } = await supabase
    .from('seller_operator_actions')
    .insert({
      action_type,
      thread_key: clean(input.thread_key) || null,
      to_phone_number: clean(input.to_phone_number) || null,
      operator_email: clean(input.operator_email) || null,
      operator_note: clean(input.operator_note) || null,
      request_idempotency_key: idempotency_key || null,
      // A manual send may deliberately FOLLOW an ambiguous communication. It is
      // a new action with an audit trail, never a retry of the ambiguous one,
      // and it must never mutate that prior row.
      prior_logical_communication_id: clean(input.prior_logical_communication_id) || null,
    })
    .select('id')
    .single();

  if (error) {
    // A race on the idempotency key means the other caller won; adopt its row.
    if (idempotency_key && /duplicate key|unique/i.test(clean(error.message))) {
      const { data: raced } = await supabase
        .from('seller_operator_actions')
        .select('id')
        .eq('request_idempotency_key', idempotency_key)
        .maybeSingle();
      if (raced?.id) return { ok: true, operator_action_id: raced.id, reused: true };
    }
    logger.error('operator_action.create_failed', { error: clean(error.message) });
    return { ok: false, reason: 'operator_action_not_durable' };
  }

  return { ok: true, operator_action_id: data.id, reused: false };
}

export default resolveOperatorAction;
