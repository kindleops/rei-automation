/**
 * Prospect ↔ property relationship matching modes.
 * Compiler must implement exactly these semantics (see unit tests in PR2).
 */
export const RELATIONSHIP_MATCH_MODES = [
  "any_linked",
  "primary_only",
  "all_linked",
  "none_linked",
];

/** Prospect and phone rules share the same relationship modes. */
export const PHONE_RELATIONSHIP_MATCH_MODES = RELATIONSHIP_MATCH_MODES;

export const RELATIONSHIP_MATCH_SEMANTICS = {
  any_linked: {
    id: "any_linked",
    label: "Any linked",
    description: "EXISTS a linked record satisfying the predicate.",
  },
  primary_only: {
    id: "primary_only",
    label: "Primary only",
    description: "EXISTS a linked record marked primary and satisfying the predicate.",
  },
  none_linked: {
    id: "none_linked",
    label: "None linked",
    description: "NOT EXISTS a linked record satisfying the predicate.",
  },
  all_linked: {
    id: "all_linked",
    label: "All linked",
    description:
      "EXISTS at least one linked record AND NOT EXISTS a linked record that fails the predicate. " +
      "Must not return true when no linked records exist.",
  },
};