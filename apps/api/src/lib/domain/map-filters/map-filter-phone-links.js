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

/** `FROM … JOIN phones` for the phones linked to `propertyRef` (e.g. "p.property_id"). */
export function buildLinkedPhonesFromSql(propertyRef, { linkAlias = MAP_FILTER_PHONE_LINKS_ALIAS, phoneAlias = "ph" } = {}) {
  return `FROM ${MAP_FILTER_PHONE_LINKS_TABLE} ${linkAlias}
    INNER JOIN public.phones ${phoneAlias}
      ON ${phoneAlias}.canonical_e164 = ${linkAlias}.canonical_e164
    WHERE ${linkAlias}.property_id = ${propertyRef}
      AND ${linkAlias}.canonical_e164 IS NOT NULL`;
}
