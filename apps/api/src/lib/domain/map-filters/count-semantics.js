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
      "Distinct master_owners.master_owner_id linked to matching properties and satisfying all applicable owner predicates. " +
      "When no owner-specific predicates exist, count all owners linked to matching properties.",
  },
  matchingPhones: {
    id: "matchingPhones",
    label: "Matching phones",
    definition:
      "Distinct phones.phone_id linked to matching properties via map_filter_property_phone_links and satisfying all applicable phone predicates. " +
      "When no phone-specific predicates exist, count all phones linked to matching properties.",
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