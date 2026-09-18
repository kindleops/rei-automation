/**
 * WHAT MAKES A QUEUE ROW BUYER TRAFFIC.
 *
 * This lives in the buyers domain rather than in the transport layer for a
 * structural reason: delivery reconciliation, the dispatcher and the inbound
 * router all need to ask the question, and the transport layer needs to ask it
 * too. Defining it here and re-exporting it from `sms-engine` keeps ONE
 * definition without the buyers domain and the SMS engine importing each other.
 *
 * The kind is deliberately its own value and NOT `manual_inbox`. That kind
 * bypasses the contact window — correct for a human typing a reply right now,
 * catastrophic for scheduled bulk disposition outreach. Reusing it would have
 * been the easy way past the seller-name guard and would have quietly
 * authorised 2 AM buyer blasts.
 *
 * What a buyer row still passes, unchanged: quiet hours, suppression, sender
 * eligibility and dispatch-time revalidation, operator emergency stop, canonical
 * send authority, daily caps, claim/lease discipline, idempotency, and provider
 * reconciliation.
 */
export const BUYER_DISPOSITION_SEND_KIND = "buyer_disposition";

const lower = (value) => String(value ?? "").trim().toLowerCase();

export function isBuyerDispositionSend(row = {}) {
  const metadata = row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return (
    lower(row?.send_kind) === BUYER_DISPOSITION_SEND_KIND ||
    lower(metadata.send_kind) === BUYER_DISPOSITION_SEND_KIND ||
    lower(metadata.outreach_domain) === "buyer"
  );
}
