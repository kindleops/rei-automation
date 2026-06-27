import { contactabilityBlocksSend } from '@/lib/domain/lead-state/universal-lead-state-registry.js';

function clean(value) {
  return String(value ?? '').trim();
}

/**
 * Load inbox_thread_state contactability for a thread and determine whether outbound sends are blocked.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} threadKey
 * @returns {Promise<{
 *   ok: boolean,
 *   blocks_send: boolean,
 *   contactability_status: string|null,
 *   reason: string|null,
 * }>}
 */
export async function checkThreadContactability(supabase, threadKey) {
  const key = clean(threadKey);
  if (!key || !supabase) {
    return {
      ok: true,
      blocks_send: false,
      contactability_status: null,
      reason: null,
    };
  }

  const { data, error } = await supabase
    .from('inbox_thread_state')
    .select('contactability_status')
    .eq('thread_key', key)
    .maybeSingle();

  if (error) throw error;

  const contactability_status = clean(data?.contactability_status) || null;
  const blocks_send = contactabilityBlocksSend(contactability_status);

  return {
    ok: !blocks_send,
    blocks_send,
    contactability_status,
    reason: blocks_send ? 'contactability_blocked' : null,
  };
}

export default checkThreadContactability;