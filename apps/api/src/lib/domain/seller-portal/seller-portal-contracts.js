/**
 * Seller portal — the seller-facing contract.
 *
 * The portal never owns transaction state. It PRESENTS canonical state:
 *   acquisition_opportunities  (deal, stage, status)
 *   offerr_evaluations         (non-binding estimate — seller_projection only)
 *   seller_offers              (written offer — only once sent)
 *   closing_cases / closing_milestones / closing_title_issues  (S6–S10)
 *
 * Everything here is a pure function from those rows to what a seller sees,
 * so the mapping is testable without a database and can never write back.
 */

export const SELLER_PORTAL_SESSION_TTL_DAYS = 30;
export const SELLER_PORTAL_CODE_TTL_MINUTES = 15;
export const SELLER_PORTAL_CODE_MAX_ATTEMPTS = 5;
export const SELLER_PORTAL_CODE_LENGTH = 6;
export const SELLER_PORTAL_MESSAGE_MAX = 4000;
export const SELLER_PORTAL_SIGNED_URL_SECONDS = 300;

export const CALL_REASONS = Object.freeze({
  property: 'My property',
  offer: 'My offer',
  timing: 'Timing',
  details: 'Property details',
  closing: 'Closing',
  other: 'Something else',
});

const REVIEW_INTAKE = new Set(['needs_review', 'ownership_confirmation']);
const REVIEW = new Set([
  'interest_qualification', 'offer_interest', 'asking_price', 'price_discovery',
  'property_condition', 'underwriting',
]);
const OFFER = new Set(['offer', 'decision_and_offer']);
const AGREEMENT = new Set(['formal_contract']);
const TITLE = new Set(['under_contract', 'disposition', 'contract_to_close']);
const INACTIVE_STATUS = new Set(['lost', 'dead', 'suppressed', 'archived']);

/** Seller-facing states, in transaction order. Copy is calm and plain. */
export const SELLER_STATES = Object.freeze({
  received: { label: 'Property received', headline: 'We have your property.', detail: "We're reviewing the information available for this property." },
  under_review: { label: 'Under review', headline: "We're reviewing your property.", detail: "You'll see your offer here when it's ready. No action is needed right now." },
  offer_being_prepared: { label: 'Offer being prepared', headline: 'Your offer is being prepared.', detail: "We're putting the written terms together. You'll see them here first." },
  estimate_ready: { label: 'Preliminary estimate', headline: 'Your preliminary estimate is ready.', detail: 'This is an estimate, not an offer. A written offer follows a review of the property.' },
  offer_ready: { label: 'Offer ready for review', headline: 'Your offer is ready.', detail: 'Review the written terms, ask anything, and decide when you are ready.' },
  agreement: { label: 'Agreement', headline: 'Your purchase agreement is in progress.', detail: 'The agreement turns the accepted offer into a contract.' },
  title_review: { label: 'Title review', headline: "We're in title review.", detail: "We're confirming ownership and clearing anything that could prevent closing." },
  closing_scheduled: { label: 'Closing scheduled', headline: 'Your closing is scheduled.', detail: 'Everything for closing day is gathered here.' },
  closing_today: { label: 'Closing today', headline: 'Closing today.', detail: 'Everything you need for today is below.' },
  closed: { label: 'Closed', headline: 'Your sale is complete.', detail: 'Your documents remain available here.' },
  not_moving_forward: { label: 'Not moving forward', headline: 'This sale is not moving forward.', detail: 'Your records remain available here. You can message us at any time.' },
});

const clean = (v) => String(v ?? '').trim();
const ts = (v) => (v ? new Date(v).toISOString() : null);

function sameLocalDay(a, b, tz) {
  if (!a || !b) return false;
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date(a)) === fmt.format(new Date(b));
}

/** A written offer counts only once it has actually been sent to the seller. */
export function sentOffer(offers = []) {
  const sent = offers.filter((o) => o?.sent_at && o.direction !== 'inbound' && ['active', 'accepted'].includes(o.status));
  return sent.find((o) => o.status === 'accepted') || sent.sort((a, b) => (b.offer_version ?? 0) - (a.offer_version ?? 0))[0] || null;
}

/** Latest unexpired estimate that the Offerr spine itself marked range-eligible. */
export function usableEstimate(evaluations = [], now = new Date()) {
  return evaluations
    .filter((e) => e?.seller_projection?.preliminary_range && (!e.expires_at || new Date(e.expires_at) > now))
    .sort((a, b) => new Date(b.computed_at || b.created_at) - new Date(a.computed_at || a.created_at))[0] || null;
}

function closingConfirmed(closing) {
  return Boolean(closing?.scheduled_closing_date && closing?.closing_date_confirmed_at);
}

/** One dominant state, derived — never stored. */
export function deriveSellerState({ opportunity, offers = [], evaluations = [], closing = null, now = new Date() }) {
  if (!opportunity) return null;
  const stage = clean(opportunity.acquisition_stage);
  const status = clean(opportunity.opportunity_status);
  if (stage === 'closed' || status === 'won' || closing?.closed_at) return 'closed';
  if (INACTIVE_STATUS.has(status) || closing?.terminal_outcome) return 'not_moving_forward';
  if (stage === 'prepared_to_close' || (TITLE.has(stage) && closingConfirmed(closing))) {
    if (!closingConfirmed(closing)) return 'title_review';
    return sameLocalDay(closing.scheduled_closing_date, now, closing.closing_tz) ? 'closing_today' : 'closing_scheduled';
  }
  if (TITLE.has(stage)) return 'title_review';
  if (AGREEMENT.has(stage)) return 'agreement';
  const offer = sentOffer(offers);
  if (offer?.status === 'accepted') return 'agreement';
  if (offer) return 'offer_ready';
  if (OFFER.has(stage)) return 'offer_being_prepared';
  if (usableEstimate(evaluations, now)) return 'estimate_ready';
  if (REVIEW_INTAKE.has(stage)) return 'received';
  if (REVIEW.has(stage)) return 'under_review';
  return 'under_review';
}

/**
 * The offer as the seller may see it. Tiers are explicit so the UI can never
 * present an estimate as a binding offer.
 */
export function projectOffer({ offers = [], evaluations = [], closing = null, now = new Date() }) {
  if (closing && ['fully_executed', 'executed', 'signed'].includes(clean(closing.contract_status))) {
    return {
      tier: 'purchase_agreement',
      binding: true,
      amount: closing.seller_contract_price ?? null,
      closing_date: closing.scheduled_closing_date ? ts(closing.scheduled_closing_date) : null,
      earnest_money: closing.earnest_money ?? null,
      signed_at: ts(closing.contract_signed_date),
    };
  }
  const offer = sentOffer(offers);
  if (offer) {
    return {
      tier: 'written_offer',
      binding: false,
      status: offer.status,
      version: offer.offer_version,
      amount: Number(offer.purchase_price),
      closing_date: offer.closing_date || null,
      closing_term: offer.closing_term || null,
      earnest_money: offer.emd_amount != null ? Number(offer.emd_amount) : null,
      earnest_money_term: offer.emd_term || null,
      sent_at: ts(offer.sent_at),
      accepted_at: ts(offer.accepted_at),
      seller_costs: 'Prominent pays the closing costs. No commission and no fees are charged to you.',
    };
  }
  const estimate = usableEstimate(evaluations, now);
  if (estimate) {
    const p = estimate.seller_projection;
    return {
      tier: 'estimate',
      binding: false,
      low: p.preliminary_range?.low ?? null,
      high: p.preliminary_range?.high ?? null,
      confidence: p.confidence_label || null,
      assumptions: Array.isArray(p.assumptions) ? p.assumptions : [],
      disclaimer: p.disclaimer || 'This is a preliminary estimate, not an offer.',
      expires_at: ts(estimate.expires_at),
    };
  }
  return { tier: 'none' };
}

const STAGES = [
  ['submitted', 'Property submitted'],
  ['review', 'Property review'],
  ['offer', 'Offer prepared'],
  ['decision', 'Your decision'],
  ['agreement', 'Purchase agreement'],
  ['title', 'Title'],
  ['closing', 'Closing'],
  ['closed', 'Closed'],
];
const ORDER = { received: 1, under_review: 1, estimate_ready: 1, offer_being_prepared: 2, offer_ready: 3, agreement: 4, title_review: 5, closing_scheduled: 6, closing_today: 6, closed: 8 };

/**
 * The transaction timeline. Dates appear only when a canonical record holds
 * them; a stage with no record shows no date rather than an invented one.
 */
export function buildTimeline({ opportunity, offers = [], closing = null, titleIssues = [], state }) {
  const offer = sentOffer(offers);
  const reached = state === 'not_moving_forward' ? -1 : ORDER[state] ?? 1;
  const dates = {
    submitted: ts(opportunity?.created_at),
    offer: ts(offer?.sent_at),
    decision: ts(offer?.accepted_at),
    agreement: ts(closing?.contract_signed_date),
    title: ts(closing?.clear_to_close_at),
    closing: closingConfirmed(closing) ? ts(closing.scheduled_closing_date) : null,
    closed: ts(closing?.closed_at),
  };
  const sellerIssues = titleIssues.filter((i) => i.owner === 'seller' && ['open', 'in_progress'].includes(i.status));
  const detail = {
    review: 'We look at the property, its records, and anything you told us about it.',
    offer: 'A written offer with the price, the closing timing, and the terms.',
    decision: 'Review the terms, ask questions, and decide. You are under no obligation.',
    agreement: 'The accepted offer becomes a purchase agreement you sign.',
    title: "We're confirming ownership and clearing anything that could prevent closing.",
    closing: 'You sign the closing documents and the sale funds.',
    closed: 'The sale is complete and your documents stay here.',
  };
  return STAGES.map(([key, label], index) => {
    let status;
    if (state === 'not_moving_forward') status = dates[key] ? 'complete' : 'upcoming';
    else if (index === 0 || index < reached || (state === 'closed' && index <= 7)) status = 'complete';
    else if (index === reached) status = 'current';
    else status = 'upcoming';
    if (key === 'submitted') status = 'complete';
    const action = key === 'title' && status === 'current' && sellerIssues.length
      ? { kind: 'action_needed', label: sellerIssues[0].description || 'We need one item from you.' }
      : status === 'current' ? { kind: 'none', label: 'No action is needed from you right now.' } : null;
    return { key, label, status, at: dates[key] ?? null, detail: detail[key] ?? null, action };
  });
}

/** One next action, or none. */
export function nextAction({ state, closing = null, titleIssues = [] }) {
  const sellerIssue = titleIssues.find((i) => i.owner === 'seller' && ['open', 'in_progress'].includes(i.status));
  if (sellerIssue) return { kind: 'action_needed', title: 'We need one item from you.', body: sellerIssue.description || 'Please check your messages for the details.', href: '/account/messages/' };
  if (state === 'offer_ready') return { kind: 'review_offer', title: 'Review your offer.', body: 'The written terms are ready.', href: '/account/offer/' };
  if (state === 'agreement' && closing?.docusign_envelope_id && !closing?.contract_signed_date) {
    return { kind: 'review_agreement', title: 'Review your purchase agreement.', body: `It was sent for signature${closing.signer_email ? ` to ${closing.signer_email}` : ''}.`, href: '/account/documents/' };
  }
  if (state === 'closing_today') return { kind: 'closing_today', title: 'Closing today.', body: 'Everything you need is on the closing page.', href: '/account/closing/' };
  return null;
}

/** The closing projection — only fields a seller should see. */
export function projectClosing(closing) {
  if (!closing) return null;
  return {
    status: clean(closing.closing_status) || null,
    scheduled_at: closingConfirmed(closing) ? ts(closing.scheduled_closing_date) : null,
    proposed_at: !closingConfirmed(closing) && closing.scheduled_closing_date ? ts(closing.scheduled_closing_date) : null,
    timezone: closing.closing_tz || null,
    title_company: closing.title_company_name || null,
    title_status: clean(closing.title_status) || null,
    escrow_file_number: closing.escrow_file_number || null,
    contract_price: closing.seller_contract_price ?? null,
    earnest_money: closing.earnest_money ?? null,
    title_opened_at: ts(closing.title_opened_date),
    clear_to_close_at: ts(closing.clear_to_close_at),
    closed_at: ts(closing.closed_at),
    terminal_outcome: closing.terminal_outcome || null,
  };
}

/** Closing milestones the seller can see, mapped from the canonical ledger. */
// Canonical types from the closing ledger (closing-execution-model MILESTONE_LABEL).
// Buyer-side milestones (buyer_committed, escrow_funded) are not shown to sellers.
const MILESTONE_LABELS = {
  contract_fully_executed: 'Purchase agreement signed',
  title_opened: 'Title opened',
  clear_to_close: 'Clear to close',
  closing_scheduled: 'Closing scheduled',
  closed: 'Closing complete',
};
export function projectMilestones(milestones = []) {
  return milestones
    .filter((m) => MILESTONE_LABELS[m.milestone_type])
    .sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at))
    .map((m) => ({ key: m.milestone_type, label: MILESTONE_LABELS[m.milestone_type], at: ts(m.occurred_at) }));
}
