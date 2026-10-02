/**
 * Seller portal — lifecycle notifications from canonical state changes.
 *
 * This is not a lifecycle system. Each canonical writer that changes something
 * a seller should hear about calls `emitSellerLifecycle` AFTER its own write
 * succeeded:
 *
 *   offer_ready        seller_offers.sent_at stamped    bindOfferToQueueRow
 *   action_needed      closing_title_issues owner=seller openTitleIssue
 *   closing_scheduled  closing date first confirmed      setClosingDate
 *   closing_changed    confirmed closing date changed    setClosingDate
 *   closed             finalize_closing_case committed   finalizeClosing
 *   message            Prominent replied in the portal  operatorReply
 *   document_ready     an operator shared a document    shareDocument
 *   (calls: scheduled / rescheduled / cancelled / reminders are sent by the
 *    Prominent scheduling adapter at the scheduling core's commit points.)
 *
 * Guarantees: only sellers with an active portal grant on that opportunity
 * are emailed; each (event, seller) is sent at most once, keyed in
 * seller_portal_notifications; the call never throws into the canonical
 * write path and is a no-op until SELLER_PORTAL_ENABLED=1.
 */

import { child } from '@/lib/logging/logger.js';

import { createSupabaseSellerPortalStore } from './seller-portal-store.js';
import { createSellerNotifier } from './seller-portal-notify.js';

const logger = child({ module: 'domain.seller_portal.lifecycle' });
const clean = (v) => String(v ?? '').trim();

export const SELLER_LIFECYCLE_KINDS = new Set(['offer_ready', 'action_needed', 'closing_scheduled', 'closing_changed', 'closed', 'message', 'document_ready']);

export async function emitSellerLifecycle({ kind, opportunityId, dedupeKey, context = {} } = {}, deps = {}) {
  const env = deps.env ?? process.env;
  try {
    if (clean(env.SELLER_PORTAL_ENABLED) !== '1' && !deps.force) return { ok: true, skipped: 'portal_disabled' };
    if (!SELLER_LIFECYCLE_KINDS.has(kind) || !clean(opportunityId) || !clean(dedupeKey)) return { ok: false, skipped: 'invalid_event' };
    const store = deps.store ?? createSupabaseSellerPortalStore(deps);
    const notify = deps.notify ?? createSellerNotifier({ env });
    const identities = await store.listIdentitiesForOpportunity(clean(opportunityId));
    if (!identities.length) return { ok: true, sent: 0, skipped: 'no_portal_account' };
    let sent = 0;
    for (const identity of identities) {
      const claim = await store.claimNotification({ dedupe_key: `${dedupeKey}:${identity.id}`, opportunity_id: clean(opportunityId), identity_id: identity.id, kind });
      if (!claim) continue; // already sent for this event
      const result = await notify({ kind, to: identity.email, context: { ...context, name: identity.display_name } });
      await store.updateNotification(claim.id, result?.sent ? { status: 'sent', sent_at: new Date().toISOString() } : { status: 'skipped', reason: clean(result?.reason) || 'not_sent' });
      if (result?.sent) sent++;
      else if (result?.reason && result.reason !== 'seller_email_disabled') logger.warn('seller_portal.notification_failed', { kind, reason: result.reason });
    }
    return { ok: true, sent };
  } catch (error) {
    logger.warn('seller_portal.notification_failed', { kind, reason: clean(error?.code || error?.message).slice(0, 80) });
    return { ok: false, error: 'notification_failed' };
  }
}
