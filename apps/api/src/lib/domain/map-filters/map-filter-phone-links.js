/**
 * Property ↔ phone execution bridge for map filters.
 *
 * A property's phone is the one the campaign target graph carries for it
 * (campaign_target_graph.canonical_e164 — the number the Composer audience would
 * text), joined to public.phones on canonical_e164 for the phone attributes.
 * Indexes: campaign_target_graph(property_id), phones(canonical_e164).
 *
 * This replaced public.map_filter_property_phone_links, which was never
 * populated (0 rows in prod) — every phone filter, including the has_phone
 * preset, matched nothing and every phone count read 0.
 *
 * The graph holds one phone per property, so that phone is also the "primary"
 * link: primary_only ≡ any_linked.
 */
export const MAP_FILTER_PHONE_LINKS_TABLE = "public.campaign_target_graph";
export const MAP_FILTER_PHONE_LINKS_ALIAS = "plink";
export const MAP_FILTER_PHONE_LINK_JOIN_COLUMN = "canonical_e164";

/** Phone fields evaluated on the graph row itself (present even without a phones row). */
export const GRAPH_NATIVE_PHONE_COLUMNS = Object.freeze(new Set(["canonical_e164"]));

/**
 * The graph stores canonical_e164 as 10 national digits ("2012101887");
 * public.phones stores full E.164 ("+12012101887"). Normalise the graph side so
 * the phones(canonical_e164) btree stays usable. (A plain equality join matched
 * 0 rows in prod — measured 2026-10-05.)
 */
export function graphPhoneAsE164Sql(column) {
  return `(CASE WHEN ${column} LIKE '+%' THEN ${column} ELSE '+1' || ${column} END)`;
}

/** `FROM … JOIN phones` for the phones linked to `propertyRef` (e.g. "p.property_id"). */
export function buildLinkedPhonesFromSql(propertyRef, { linkAlias = MAP_FILTER_PHONE_LINKS_ALIAS, phoneAlias = "ph", withPhones = true } = {}) {
  if (!withPhones) {
    // Graph-native predicate (e.g. has_phone): no phones join needed.
    return `FROM ${MAP_FILTER_PHONE_LINKS_TABLE} ${linkAlias}
    WHERE ${linkAlias}.property_id = ${propertyRef}
      AND ${linkAlias}.canonical_e164 IS NOT NULL`;
  }
  // LEFT JOIN: public.phones knows only 44,849 of the graph's 136,127 property
  // phones (2026-10-05); the rest come from seller.owner_phone etc. A property
  // HAS a phone when the graph carries one; phone attributes come from phones.
  return `FROM ${MAP_FILTER_PHONE_LINKS_TABLE} ${linkAlias}
    LEFT JOIN public.phones ${phoneAlias}
      ON ${phoneAlias}.canonical_e164 = ${graphPhoneAsE164Sql(`${linkAlias}.canonical_e164`)}
    WHERE ${linkAlias}.property_id = ${propertyRef}
      AND ${linkAlias}.canonical_e164 IS NOT NULL`;
}
