/**
 * dispatch-manual-operator-send.js
 *
 * The manual-send bridge to the canonical dispatch seam.
 *
 * A manual send is the path most likely to be argued into an exception: an
 * operator is watching, they believe the last one failed, and they want it
 * sent now. That is exactly when a duplicate reaches a seller.
 *
 * So this adapter grants no privileges the queue runner lacks. Ambiguity is
 * still absorbing, an unresolved sibling attempt still blocks a new one, and
 * provider_request_started is still committed before the network. What an
 * operator CAN legitimately do is take a NEW action -- a new operator_action_id
 * produces a new logical communication, optionally recording which ambiguous
 * communication it follows. That is a decision with a name and an audit trail,
 * not a silent retry of something that may already have been delivered.
 */

import { child } from '@/lib/logging/logger.js';
import { executeSellerCommunicationAttempt } from '@/lib/domain/communications/canonical-communication-dispatch.js';
import { createSellerCommunicationStore } from '@/lib/domain/communications/seller-communication-store.js';
import { evaluateCanonicalSendAuthority } from '@/lib/domain/queue/canonical-send-authority.js';
import { classifyTextGridProviderError } from '@/lib/domain/messaging/textgrid-provider-error-classifier.js';
import { assertNoEmDash } from '@/lib/domain/messaging/outbound-content-guard.js';
import { COMMUNICATION_TYPES } from '@/lib/domain/communications/logical-communication-key.js';

const logger = child({ module: 'domain.communications.manual_dispatch' });

function clean(value) {
  return String(value ?? '').trim();
}

export async function dispatchManualOperatorSend(input = {}) {
  const store = input.store || createSellerCommunicationStore({ supabase: input.supabase });
  const operator_action_id = clean(input.operator_action_id);

  if (!operator_action_id) {
    // Without a durable action there is nothing to be idempotent ABOUT.
    logger.warn('manual_dispatch.missing_operator_action');
    return {
      ok: false, sent: false, provider_invoked: false,
      stage: 'identity', reason: 'manual_send_requires_operator_action_id',
    };
  }

  let raw_provider_result = null;
  const sendProviderImpl = input.sendProvider;
  const sendProvider = async (args) => {
    const result = await sendProviderImpl(args);
    raw_provider_result = result;
    return result;
  };

  const outcome = await executeSellerCommunicationAttempt(
    {
      communication_type: COMMUNICATION_TYPES.MANUAL_OPERATOR_SEND,
      anchors: { operator_action_id },
      lineage: {
        operator_action_id,
        thread_key: input.thread_key || null,
        to_phone_number: input.to_phone_number || null,
      },
      queue_row_id: input.queue_row_id || null,
      message: input.message || {},
    },
    {
      store,
      sendProvider,
      classifyProviderError: input.classifyProviderError || classifyTextGridProviderError,
      now: input.now || new Date().toISOString(),
      logger,
      // An operator action is not a licence to cross the brake, and a seller
      // who sent STOP is still opted out while an operator is looking at them.
      evaluateRuntimeAuthority: async () => {
        const authority = await evaluateCanonicalSendAuthority({
          getSystemValue: input.getSystemValue,
          action: 'manual_inbox_send_now',
          scopedCanary: input.scoped_canary === true,
        });
        return authority.ok ? { ok: true } : { ok: false, reason: authority.reason };
      },
      assertOutboundContent: async (message) => {
        const verdict = assertNoEmDash(message?.body);
        return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason };
      },
    }
  );

  return { ...outcome, raw_provider_result, operator_action_id };
}

export default dispatchManualOperatorSend;
