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
  // Holder so report() can surface a hydration failure set after construction.
  const resolverState = { hydrationError: null };
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

    /**
     * §5 — owner and property snapshots for events that are NOT sourced from
     * an opportunity.
     *
     * Most calendar events come from send_queue and message_events, whose
     * master_owner_id / property_id are usually absent from the opportunity
     * set. The resolver had no snapshot for those ids, so 916 of 1,399
     * owner-linked events and 1,057 of 1,399 property-linked events rendered
     * "Unresolved event" / "Property pending resolution" — measured
     * 2026-09-16 over a 60-day window.
     *
     * A richer opportunity snapshot always wins: these only fill gaps, and a
     * field already known is never overwritten.
     */
    ingestOwner(row = {}) {
      const ownerId = clean(row.master_owner_id);
      if (!ownerId) return;
      const existing = byOwner.get(ownerId);
      const snapshot = {
        opportunityId: existing?.opportunityId || null,
        masterOwnerId: ownerId,
        propertyId: existing?.propertyId || null,
        threadKey: existing?.threadKey || null,
        sellerName: existing?.sellerName || clean(row.display_name) || null,
        propertyAddress: existing?.propertyAddress || null,
        market: existing?.market || clean(row.routing_market) || null,
        propertyType: existing?.propertyType || null,
        stage: existing?.stage || null,
        status: existing?.status || null,
        temperature: existing?.temperature || null,
      };
      byOwner.set(ownerId, snapshot);
    },

    ingestProperty(row = {}) {
      const propertyId = clean(row.property_id);
      if (!propertyId) return;
      const existing = byProperty.get(propertyId);
      const address = clean(row.property_address_full) || clean(row.property_address) || null;
      const snapshot = {
        opportunityId: existing?.opportunityId || null,
        masterOwnerId: existing?.masterOwnerId || clean(row.master_owner_id) || null,
        propertyId,
        threadKey: existing?.threadKey || null,
        sellerName: existing?.sellerName || clean(row.owner_display_name) || clean(row.owner_name) || null,
        propertyAddress: existing?.propertyAddress || address,
        market: existing?.market || clean(row.market) || null,
        propertyType: existing?.propertyType || clean(row.property_type) || null,
        stage: existing?.stage || null,
        status: existing?.status || null,
        temperature: existing?.temperature || null,
      };
      byProperty.set(propertyId, snapshot);
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

    setHydrationError(message) {
      resolverState.hydrationError = message || null;
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

      /**
       * §30 — "nothing resolved" and "the resolver could not read" are
       * different facts. Without this they were the same number.
       */
      totals.hydration_error = resolverState.hydrationError || null;
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
  const { data: opportunities, error: oppError } = await oppQuery;

  /**
   * A failed read here is NOT "nothing to resolve".
   *
   * The error was previously discarded, so a broken query would silently
   * label every calendar item "Unresolved event" — indistinguishable from
   * genuinely unlinked work. Recorded so the caller can say which it is.
   */
  resolver.setHydrationError(oppError ? (oppError.message || 'opportunity_read_failed') : null);

  const rows = opportunities ?? [];
  for (const row of rows) resolver.ingestOpportunity(row);

  /**
   * §5/§22 — FILL THE DISPLAY FIELDS FROM CANONICAL AUTHORITY.
   *
   * acquisition_opportunities.seller_display_name, property_address_full and
   * market are NULL on real rows — verified 2026-09-16 on the three
   * opportunities the calendar was surfacing. The resolver ingested them
   * correctly and simply had nothing to show, so Calendar rendered
   * "Unresolved event · Property pending resolution · Market Unknown" for
   * sellers whose name and address were one join away:
   *
   *   ce894ca6 -> Luis G Patino, 4404 W Mountain View Rd, Glendale AZ
   *   e0262389 -> Arnulfo & Imelda Anguiano, 2016 N 54th Ln, Phoenix AZ
   *   e35aa250 -> Rgma Real Estate Investment & Loans LLC, Indianapolis IN
   *
   * master_owners and properties are the canonical authorities the rest of the
   * system already reads (the same join v_email_records uses). This enriches
   * only what the opportunity row left blank — a present denormalized value
   * always wins, so nothing already correct is overwritten.
   */
  const ownerIds = [...new Set(rows.map((r) => clean(r.master_owner_id)).filter(Boolean))];
  const propertyIds = [...new Set(rows.map((r) => clean(r.primary_property_id)).filter(Boolean))];

  const chunk = (list, size = 400) => {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  };

  const owners = new Map();
  for (const ids of chunk(ownerIds)) {
    const { data } = await client
      .from('master_owners')
      .select('master_owner_id, display_name, routing_market, best_language')
      .in('master_owner_id', ids);
    for (const row of data ?? []) owners.set(clean(row.master_owner_id), row);
  }

  const properties = new Map();
  for (const ids of chunk(propertyIds)) {
    const { data } = await client
      .from('properties')
      .select('property_id, property_address_full, property_address, market, property_type')
      .in('property_id', ids);
    for (const row of data ?? []) properties.set(clean(row.property_id), row);
  }

  if (owners.size || properties.size) {
    for (const row of rows) {
      const owner = owners.get(clean(row.master_owner_id));
      const property = properties.get(clean(row.primary_property_id));
      if (!owner && !property) continue;
      resolver.ingestOpportunity({
        ...row,
        seller_display_name: clean(row.seller_display_name) || clean(owner?.display_name) || null,
        property_address_full:
          clean(row.property_address_full) ||
          clean(property?.property_address_full) ||
          clean(property?.property_address) ||
          null,
        market: clean(row.market) || clean(property?.market) || clean(owner?.routing_market) || null,
        asset_class: clean(row.asset_class) || clean(property?.property_type) || null,
      });
    }
  }

  if (Array.isArray(opts.threads)) {
    for (const thread of opts.threads) resolver.ingestThread(thread);
  }

  return resolver;
}

/**
 * Second enrichment pass, keyed on the ids the EVENTS actually carry.
 *
 * hydrateResolverFromDatabase() runs before the event list exists, so it can
 * only see opportunity-linked identities. Queue and message events reference
 * owners and properties that are frequently not in that set. This fills those
 * in from the canonical authorities, batched, after the raw events are built.
 */
export async function hydrateResolverForEvents(client, resolver, events = []) {
  const ownerIds = [...new Set(events.map((e) => clean(e.master_owner_id)).filter(Boolean))];
  const propertyIds = [...new Set(events.map((e) => clean(e.property_id)).filter(Boolean))];
  if (!ownerIds.length && !propertyIds.length) return { owners: 0, properties: 0, errors: [] };

  const chunk = (list, size = 400) => {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  };

  const errors = [];
  let owners = 0;
  let properties = 0;

  for (const ids of chunk(ownerIds)) {
    const { data, error } = await client
      .from('master_owners')
      .select('master_owner_id, display_name, routing_market')
      .in('master_owner_id', ids);
    // A failed lookup is recorded, never folded into "unresolved".
    if (error) { errors.push(`master_owners: ${error.message}`); continue; }
    for (const row of data ?? []) { resolver.ingestOwner(row); owners += 1; }
  }

  for (const ids of chunk(propertyIds)) {
    const { data, error } = await client
      .from('properties')
      .select('property_id, master_owner_id, property_address_full, property_address, market, property_type, owner_display_name, owner_name')
      .in('property_id', ids);
    if (error) { errors.push(`properties: ${error.message}`); continue; }
    for (const row of data ?? []) { resolver.ingestProperty(row); properties += 1; }
  }

  return { owners, properties, errors };
}
