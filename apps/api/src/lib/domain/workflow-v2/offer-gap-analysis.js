// Workflow Studio V2 — offer/ask gap analysis from canonical acquisition output.

function clean(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function asNumber(value) {
  const parsed = Number(String(value ?? '').replace(/[$,]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function ratio(offer, asking) {
  if (!offer || !asking) return null;
  return Number((offer / asking).toFixed(4));
}

function resolveAcquisitionOutput(context = {}, acqOutput = null) {
  if (acqOutput && typeof acqOutput === 'object') return acqOutput;
  if (context.acquisition_output && typeof context.acquisition_output === 'object') {
    return context.acquisition_output;
  }
  if (context.acquisition_engine_output && typeof context.acquisition_engine_output === 'object') {
    return context.acquisition_engine_output;
  }
  return {};
}

function resolveAskingPrice(context = {}, acqOutput = {}) {
  return (
    asNumber(context.asking_price) ??
    asNumber(context.seller_asking_price) ??
    asNumber(acqOutput.seller_asking_price) ??
    asNumber(acqOutput.asking_price) ??
    null
  );
}

function recommendNegotiationRoute({ gapPercentage, bestStrategy, ratios }) {
  const gap = gapPercentage ?? 0;
  const strategy = lower(bestStrategy ?? '');

  if (gap <= 0.08) return 'cash_close';
  if (gap <= 0.15 && (ratios.cash ?? 0) >= 0.85) return 'cash_negotiate';
  if (strategy.includes('novation') || (ratios.novation ?? 0) >= 0.9) return 'novation_bridge';
  if (strategy.includes('seller_finance') || (ratios.seller_finance ?? 0) >= 0.85) {
    return 'seller_finance_structure';
  }
  if (strategy.includes('subject') || (ratios.subject_to ?? 0) >= 0.85) return 'subject_to_structure';
  if (gap >= 0.25) return 'reframe_or_nurture';
  return 'cash_negotiate';
}

export function calculateOfferAskGap(context = {}, acqOutput = null) {
  const output = resolveAcquisitionOutput(context, acqOutput);
  const askingPrice = resolveAskingPrice(context, output);

  const cashOffer =
    asNumber(output.recommended_cash_offer) ??
    asNumber(output.cash_offer) ??
    asNumber(output.offer?.recommended_cash_offer);
  const novationOffer =
    asNumber(output.novation_offer) ??
    asNumber(output.recommended_novation_offer) ??
    (cashOffer && output.novation_viability
      ? cashOffer * (Number(output.novation_viability) / 100)
      : null);
  const sellerFinanceOffer =
    asNumber(output.seller_finance_offer) ??
    asNumber(output.seller_finance_offer_mid) ??
    (cashOffer && output.seller_finance_score
      ? cashOffer * (1 + Number(output.seller_finance_score) / 200)
      : null);
  const subjectToOffer =
    asNumber(output.subject_to_offer) ??
    (cashOffer && output.subject_to_viability
      ? cashOffer * (Number(output.subject_to_viability) / 100)
      : null);

  const primaryOffer = cashOffer ?? novationOffer ?? sellerFinanceOffer ?? subjectToOffer ?? null;
  const gapAmount =
    askingPrice && primaryOffer ? Number((askingPrice - primaryOffer).toFixed(2)) : null;
  const gapPercentage =
    askingPrice && primaryOffer ? Number(((askingPrice - primaryOffer) / askingPrice).toFixed(4)) : null;

  const ratios = {
    cash: ratio(cashOffer, askingPrice),
    novation: ratio(novationOffer, askingPrice),
    seller_finance: ratio(sellerFinanceOffer, askingPrice),
    subject_to: ratio(subjectToOffer, askingPrice),
  };

  return {
    asking_price: askingPrice,
    cash_offer: cashOffer,
    novation_offer: novationOffer,
    seller_finance_offer: sellerFinanceOffer,
    subject_to_offer: subjectToOffer,
    cash_ratio: ratios.cash,
    novation_ratio: ratios.novation,
    seller_finance_ratio: ratios.seller_finance,
    subject_to_ratio: ratios.subject_to,
    gap_amount: gapAmount,
    gap_percentage: gapPercentage,
    best_strategy: output.best_strategy ?? null,
    recommended_negotiation_route: recommendNegotiationRoute({
      gapPercentage,
      bestStrategy: output.best_strategy,
      ratios,
    }),
    source: 'canonical_acquisition_output',
  };
}