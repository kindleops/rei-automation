/**
 * Locked entity count definitions for preview, API responses, and accounting tests.
 */
export const MAP_FILTER_COUNT_SEMANTICS = {
  matchingProperties: {
    id: "matchingProperties",
    label: "Matching properties",
    definition:
      "Distinct properties.property_id satisfying the complete filter expression.",
  },
  matchingProspects: {
    id: "matchingProspects",
    label: "Matching prospects",
    definition:
      "Distinct prospects.prospect_id linked to matching properties and satisfying all applicable prospect predicates. " +
      "When no prospect-specific predicates exist, count all prospects linked to matching properties.",
  },
  matchingMasterOwners: {
    id: "matchingMasterOwners",
    label: "Matching Master Owners",
    definition:
      "Distinct master_owner_id linked to matching properties via properties.master_owner_id OR the " +
      "property→prospect→owner bridge (map_filter_property_prospect_links), satisfying all applicable owner predicates. " +
      "Null when it could not be computed — never a fabricated 0.",
  },
  matchingPhones: {
    id: "matchingPhones",
    label: "Matching phones",
    definition:
      "Distinct campaign_target_graph.canonical_e164 for matching properties — the phone the campaign audience would text. " +
      "Null when it could not be computed — never a fabricated 0.",
  },
  propertiesInBounds: {
    id: "propertiesInBounds",
    label: "Properties in bounds",
    definition:
      "Distinct matching properties inside the supplied geographic bounds.",
  },
  representedProperties: {
    id: "representedProperties",
    label: "Represented properties",
    definition:
      "Distinct matching properties represented through aggregates, clusters, or MVT features for the active scope.",
  },
};