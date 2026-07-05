/**
 * Field-specific JSON storage shapes for safe compilation.
 * Generic text-array operators must not be applied to structured object arrays.
 */
export const JSON_STORAGE_SHAPES = {
  text_array: {
    id: "text_array",
    description: "JSON array of plain text tokens (tags, flags, market names).",
    defaultOperators: "json_text_array",
    extractionStrategy: "jsonb_array_elements_text",
    presenceStrategy: "jsonb_array_length_gt_zero",
    emptySemantics: "null_or_empty_array",
  },
  uuid_array: {
    id: "uuid_array",
    description: "JSON array of canonical UUID/text identifiers.",
    defaultOperators: "json_text_array",
    extractionStrategy: "jsonb_array_elements_text",
    presenceStrategy: "jsonb_array_length_gt_zero",
    emptySemantics: "null_or_empty_array",
  },
  object_array: {
    id: "object_array",
    description: "JSON array of structured contact/object records.",
    defaultOperators: "json_object_array",
    extractionStrategy: "field_specific_compiler",
    presenceStrategy: "field_specific_compiler",
    emptySemantics: "null_or_empty_array",
  },
  object: {
    id: "object",
    description: "Single JSON object value.",
    defaultOperators: "json_object_array",
    extractionStrategy: "field_specific_compiler",
    presenceStrategy: "jsonb_typeof_object",
    emptySemantics: "null_or_empty_object",
  },
  location_array: {
    id: "location_array",
    description: "JSON array of structured owner location records.",
    defaultOperators: "json_object_array",
    extractionStrategy: "owner_location_array_compiler",
    presenceStrategy: "owner_location_array_compiler",
    emptySemantics: "null_or_empty_array",
  },
};

export const JSON_COMPILER_KEYS = {
  prospect_contact_array: "prospect_contact_array",
  prospect_flag_array: "prospect_flag_array",
  owner_location_array: "owner_location_array",
  owner_uuid_link_array: "owner_uuid_link_array",
  property_flag_array: "property_flag_array",
  property_tag_array: "property_tag_array",
};