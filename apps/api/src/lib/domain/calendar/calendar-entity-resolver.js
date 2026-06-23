function clean(value) {
  return String(value ?? '').trim();
}

function normalizePhone(value) {
  const raw = clean(value);
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  return raw.startsWith('+') ? `+${digits}` : digits;
}

function buildKey(parts) {
  return parts.filter(Boolean).join(':');
}

export function createEntityResolver() {
  const byThread = new Map();
  const byOwner = new Map();
  const byProperty = new Map();
  const byPhone = new Map();
  const byOpportunity = new Map();

  return {
    ingestOpportunity(row = {}) {
      const opportunityId = clean(row.id);
      const threadKey = clean(row.primary_thread_key);
      const ownerId = clean(row.master_owner_id);
      const propertyId = clean(row.primary_property_id);
      const snapshot = {
        opportunityId,
        masterOwnerId: ownerId || null,
        propertyId: propertyId || null,
        threadKey: threadKey || null,
        sellerName: clean(row.seller_display_name) || null,
        propertyAddress: clean(row.property_address_full) || null,
        market: clean(row.market) || null,
        propertyType: clean(row.asset_class) || null,
        stage: clean(row.acquisition_stage) || null,
        status: clean(row.opportunity_status) || null,
        temperature: clean(row.temperature) || null,
      };
      if (opportunityId) byOpportunity.set(opportunityId, snapshot);
      if (threadKey) byThread.set(threadKey, snapshot);
      if (ownerId) byOwner.set(ownerId, snapshot);
      if (propertyId) byProperty.set(propertyId, snapshot);
    },

    ingestThread(thread = {}) {
      const threadKey = clean(thread.threadKey || thread.thread_key || thread.id);
      const ownerId = clean(thread.ownerId || thread.master_owner_id);
      const propertyId = clean(thread.propertyId || thread.property_id);
      const phones = [
        normalizePhone(thread.phoneNumber),
        normalizePhone(thread.canonicalE164),
        normalizePhone(thread.sellerPhone),
        normalizePhone(thread.to_phone_number),
      ].filter(Boolean);
      const snapshot = {
        opportunityId: clean(thread.opportunityId || thread.opportunity_id) || null,
        masterOwnerId: ownerId || null,
        propertyId: propertyId || null,
        threadKey: threadKey || null,
        sellerName: clean(thread.ownerDisplayName || thread.ownerName || thread.sellerName) || null,
        propertyAddress: clean(thread.propertyAddressFull || thread.propertyAddress || thread.subject) || null,
        market: clean(thread.market || thread.marketName) || null,
        propertyType: clean(thread.propertyType || thread.asset_class) || null,
        stage: clean(thread.conversationStage || thread.inboxStage) || null,
        status: clean(thread.inboxStatus || thread.opportunity_status) || null,
        temperature: clean(thread.temperature) || null,
      };
      if (threadKey) byThread.set(threadKey, snapshot);
      if (ownerId) byOwner.set(ownerId, snapshot);
      if (propertyId) byProperty.set(propertyId, snapshot);
      phones.forEach((phone) => {
        if (!byPhone.has(phone)) byPhone.set(phone, snapshot);
      });
    },

    resolve(input = {}) {
      const threadKey = clean(input.thread_key || input.threadKey || input.thread_id);
      const ownerId = clean(input.master_owner_id || input.owner_id || input.seller_id);
      const propertyId = clean(input.property_id);
      const opportunityId = clean(input.opportunity_id);
      const phone = normalizePhone(input.phone || input.to_phone_number || input.from_phone_number);
      const queueMeta = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};

      let match = null;
      let resolutionSource = null;

      if (opportunityId && byOpportunity.has(opportunityId)) {
        match = byOpportunity.get(opportunityId);
        resolutionSource = 'opportunity_id';
      } else if (threadKey && byThread.has(threadKey)) {
        match = byThread.get(threadKey);
        resolutionSource = 'thread_key';
      } else if (propertyId && byProperty.has(propertyId)) {
        match = byProperty.get(propertyId);
        resolutionSource = 'property_id';
      } else if (ownerId && byOwner.has(ownerId)) {
        match = byOwner.get(ownerId);
        resolutionSource = 'master_owner_id';
      } else if (phone && byPhone.has(phone)) {
        match = byPhone.get(phone);
        resolutionSource = 'phone';
      }

      const rowSeller = clean(input.seller_name || input.seller_display_name || input.owner_name || queueMeta.seller_display_name);
      const rowProperty = clean(input.property_address_full || input.property_address || input.address);
      const rowMarket = clean(input.market);

      const sellerName = match?.sellerName || rowSeller || null;
      const propertyAddress = match?.propertyAddress || rowProperty || null;
      const market = match?.market || rowMarket || null;

      const unresolvedReasons = [];
      if (!sellerName) unresolvedReasons.push('seller_unresolved');
      if (!propertyAddress) unresolvedReasons.push('property_unresolved');
      if (!market) unresolvedReasons.push('market_unresolved');
      if (!match?.threadKey && !threadKey) unresolvedReasons.push('thread_unresolved');

      const fallbackSeller = !sellerName
        ? (clean(input.source_domain) === 'queue' ? 'Unresolved queue recipient' : 'Unresolved event')
        : sellerName;

      return {
        sellerName: fallbackSeller,
        propertyAddress: propertyAddress || (propertyId ? 'Property pending resolution' : ''),
        market: market || 'Market Unknown',
        propertyType: match?.propertyType || clean(input.property_type) || null,
        stage: match?.stage || null,
        status: match?.status || null,
        temperature: match?.temperature || null,
        opportunityId: match?.opportunityId || opportunityId || null,
        masterOwnerId: match?.masterOwnerId || ownerId || null,
        propertyId: match?.propertyId || propertyId || null,
        threadKey: match?.threadKey || threadKey || null,
        resolutionSource,
        unresolvedReason: unresolvedReasons.length ? unresolvedReasons.join(',') : null,
        resolutionKey: buildKey([resolutionSource, match?.opportunityId, match?.threadKey, ownerId, propertyId]),
      };
    },

    report(events = []) {
      const totals = {
        total_events: events.length,
        seller_resolved: 0,
        property_resolved: 0,
        market_resolved: 0,
        thread_resolved: 0,
        unresolved_events: 0,
        orphaned_references: 0,
        duplicate_events: 0,
      };

      const seen = new Set();
      for (const event of events) {
        if (event.seller_name && !event.seller_name.startsWith('Unknown') && !event.seller_name.startsWith('Unresolved') && event.seller_name !== 'Unresolved event') {
          totals.seller_resolved += 1;
        }
        if (event.property_address && event.property_address !== 'Property Unknown' && !event.property_address.includes('pending resolution')) totals.property_resolved += 1;
        if (event.market && event.market !== 'Market Unknown') totals.market_resolved += 1;
        if (event.thread_key) totals.thread_resolved += 1;
        if (event.unresolved_reason) totals.unresolved_events += 1;
        if (!event.master_owner_id && !event.property_id && !event.thread_key && !event.opportunity_id) {
          totals.orphaned_references += 1;
        }
        if (seen.has(event.event_id)) totals.duplicate_events += 1;
        seen.add(event.event_id);
      }

      return totals;
    },
  };
}

export async function hydrateResolverFromDatabase(client, opts = {}) {
  const resolver = createEntityResolver();
  const startIso = opts.startIso;
  const endIso = opts.endIso;

  let oppQuery = client
    .from('acquisition_opportunities')
    .select('id, master_owner_id, primary_property_id, primary_thread_key, seller_display_name, property_address_full, market, asset_class, acquisition_stage, opportunity_status, temperature, next_action_due')
    .limit(5000);

  if (startIso) oppQuery = oppQuery.or(`next_action_due.gte.${startIso},updated_at.gte.${startIso}`);
  const { data: opportunities } = await oppQuery;
  for (const row of opportunities ?? []) resolver.ingestOpportunity(row);

  if (Array.isArray(opts.threads)) {
    for (const thread of opts.threads) resolver.ingestThread(thread);
  }

  return resolver;
}