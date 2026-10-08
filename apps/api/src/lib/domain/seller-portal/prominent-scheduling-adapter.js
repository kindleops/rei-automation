/**
 * Prominent Cash Offer — the scheduling core's first client.
 *
 * Everything Prominent-specific about appointments lives here: which seller
 * reason maps to which appointment type, who "owns" an opportunity, how a call
 * reads on a team member's calendar, and how the seller is told. The core
 * never sees a property, an offer or a closing; it sees "opportunity:<id>"
 * and "closing_case:<id>" references that this adapter interprets.
 */

import { createSupabaseSellerPortalStore } from './seller-portal-store.js';
import { createSellerNotifier, renderSellerEmail } from './seller-portal-notify.js';
import { CALL_REASONS } from './seller-portal-contracts.js';

export const PROMINENT_BRAND = 'prominent_cash_offer';

/** Seller-facing reason → Prominent appointment type (configuration lives in scheduling_event_types). */
export const REASON_TO_TYPE = {
  property: 'property_conversation',
  details: 'property_conversation',
  timing: 'property_conversation',
  other: 'property_conversation',
  offer: 'offer_review',
  closing: 'title_closing_question',
};

const clean = (v) => String(v ?? '').trim();
const refId = (refs, type) => clean((refs || []).find((r) => String(r).startsWith(`${type}:`))?.slice(type.length + 1)) || null;

export function createProminentSchedulingAdapter(deps = {}) {
  const env = deps.env ?? process.env;
  const portalStore = () => deps.sellerPortalStore ?? createSupabaseSellerPortalStore(deps);
  const notify = deps.notify ?? createSellerNotifier({ env });

  async function opportunityOf(refs) {
    const id = refId(refs, 'opportunity');
    return id ? portalStore().getOpportunity(id) : null;
  }

  return {
    brand_key: PROMINENT_BRAND,
    // email_senders.sender_key for Prominent (PROPOSED_20261004090100_email_sender_prominent.sql).
    email_sender_key: 'prominent',

    /**
     * Owner roles used by Prominent's routing configuration.
     *   opportunity_owner  → acquisition_opportunities.assigned_operator
     *   transaction_owner  → closing cases record no owner today, so this
     *                        resolves to nobody and routing uses the pool.
     */
    async resolveOwner({ role, refs }) {
      if (role === 'opportunity_owner') return clean((await opportunityOf(refs))?.assigned_operator) || null;
      return null;
    },

    /** What a team member sees on their calendar. No phone numbers, no deal terms. */
    async describe({ appointment, eventType }) {
      const opp = await opportunityOf(appointment.related_refs).catch(() => null);
      const street = clean(opp?.property_address_full).split(',')[0] || null;
      const seller = clean(appointment.customer?.name) || clean(opp?.seller_display_name) || null;
      const ops = clean(env.SCHEDULING_OPS_APP_URL);
      return {
        summary: `Prominent · ${eventType.name}${street ? ` · ${street}` : ''}`,
        description: [
          seller ? `Seller: ${seller}` : null,
          appointment.reason_key ? `Reason: ${CALL_REASONS[appointment.reason_key] || appointment.reason_key}` : null,
          'Prominent calls the seller at this time.',
          ops ? `Details (sign-in required): ${ops}/calendar?appointment=${appointment.id}` : null,
        ].filter(Boolean).join('\n'),
      };
    },

    /** Domain exposure (opportunity history + inbox attention) and the seller's confirmation. */
    async onChange(kind, { appointment, previous }) {
      const opp = await opportunityOf(appointment.related_refs);
      const at = new Date().toISOString();
      const label = CALL_REASONS[appointment.reason_key] || 'a call';
      const history = { booked: 'seller_call_scheduled', rescheduled: 'seller_call_rescheduled', cancelled: 'seller_call_cancelled', completed: 'seller_call_completed', no_show: 'seller_call_no_show' }[kind];
      if (opp && history) {
        await portalStore().appendHistory({ opportunity_id: opp.id, event_type: history, actor: appointment.created_by || 'seller', source: appointment.source, created_at: at, metadata: { appointment_id: appointment.id, start_at: appointment.start_at, reason: appointment.reason_key, previous_appointment_id: previous?.id ?? null } });
        if (['booked', 'rescheduled', 'cancelled'].includes(kind)) await portalStore().flagInbox(opp.primary_thread_key, at, `Call ${kind === 'booked' ? 'scheduled' : kind}: ${label}`);
      }
      const email = clean(appointment.customer?.email);
      const template = { booked: 'call_scheduled', rescheduled: 'call_rescheduled', cancelled: 'call_cancelled' }[kind];
      if (email && template) {
        const ctx = { start_at: appointment.start_at, timezone: appointment.customer_timezone || 'America/New_York', reason: label, name: appointment.customer?.name };
        await notify({ kind: template, to: email, context: ctx });
      }
    },

    reminder({ appointment, offsetMinutes }) {
      const r = renderSellerEmail({ kind: 'call_reminder', context: { start_at: appointment.start_at, timezone: appointment.customer_timezone || 'America/New_York', reason: CALL_REASONS[appointment.reason_key] || 'your property', offset_minutes: offsetMinutes } }, env);
      return r ? { subject: r.subject, html: r.html, text: r.text } : null;
    },
  };
}
