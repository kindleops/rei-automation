/**
 * Canonical Advanced Map Filter expression and compiled predicate AST types.
 *
 * The compiler recursively compiles the full boolean tree into one
 * property-eligibility predicate AST. Do not flatten mixed-entity groups
 * into independent condition arrays.
 */

/** @typedef {'property' | 'prospect' | 'master_owner' | 'geo'} MapFilterEntity */

/**
 * @typedef {object} AdvancedMapFilterRule
 * @property {string} id
 * @property {'rule'} type
 * @property {string} fieldKey
 * @property {string} operator
 * @property {unknown} value
 * @property {boolean} [enabled]
 * @property {'any_linked' | 'primary_only' | 'all_linked' | 'none_linked'} [relationshipMatch]
 */

/**
 * @typedef {object} AdvancedMapFilterGroup
 * @property {string} id
 * @property {'group'} type
 * @property {'AND' | 'OR'} combinator
 * @property {boolean} negated
 * @property {boolean} enabled
 * @property {AdvancedMapFilterNode[]} children
 */

/** @typedef {AdvancedMapFilterGroup | AdvancedMapFilterRule} AdvancedMapFilterNode */

/**
 * Compiled predicate AST node — retains exact boolean tree structure.
 * SQL/predicate interpretation occurs only in trusted server/RPC code.
 *
 * @typedef {object} CompiledPropertyRuleNode
 * @property {'property_rule'} type
 * @property {string} fieldKey
 * @property {string} operator
 * @property {number[]} paramIndices
 * @property {boolean} [negated]
 */

/**
 * @typedef {object} CompiledProspectRuleNode
 * @property {'prospect_rule'} type
 * @property {string} fieldKey
 * @property {string} operator
 * @property {number[]} paramIndices
 * @property {'any_linked' | 'primary_only' | 'all_linked' | 'none_linked'} relationshipMatch
 * @property {boolean} [negated]
 */

/**
 * @typedef {object} CompiledOwnerRuleNode
 * @property {'owner_rule'} type
 * @property {string} fieldKey
 * @property {string} operator
 * @property {number[]} paramIndices
 * @property {boolean} [negated]
 */

/**
 * @typedef {object} CompiledGeoRuleNode
 * @property {'geo_rule'} type
 * @property {string} fieldKey
 * @property {string} operator
 * @property {number[]} paramIndices
 * @property {boolean} [negated]
 */

/**
 * @typedef {object} CompiledPredicateGroupNode
 * @property {'group'} type
 * @property {'AND' | 'OR'} combinator
 * @property {boolean} negated
 * @property {boolean} enabled
 * @property {CompiledPredicateNode[]} children
 */

/**
 * @typedef {object} CompiledLiteralNode
 * @property {'literal'} type
 * @property {boolean} value
 */

/** @typedef {CompiledPropertyRuleNode | CompiledProspectRuleNode | CompiledOwnerRuleNode | CompiledGeoRuleNode | CompiledPredicateGroupNode | CompiledLiteralNode} CompiledPredicateNode */

/**
 * @typedef {object} CompiledMapFilter
 * @property {number} version
 * @property {AdvancedMapFilterNode} normalizedExpression
 * @property {CompiledPredicateNode} compiledPredicateAst
 * @property {unknown[]} params
 * @property {string} summary
 * @property {number} activeRuleCount
 * @property {string[]} referencedFieldKeys
 * @property {MapFilterEntity[]} referencedEntities
 */

/**
 * Persisted filter token payload (no executable SQL).
 * @typedef {object} MapFilterTokenRecord
 * @property {string} filterTokenDigest
 * @property {string} organizationId
 * @property {string} createdBy
 * @property {string} permissionScope
 * @property {number} filterSchemaVersion
 * @property {string} registryVersion
 * @property {AdvancedMapFilterNode} normalizedExpression
 * @property {CompiledPredicateNode} compiledPredicateAst
 * @property {string[]} referencedFieldKeys
 * @property {string} summary
 * @property {string} createdAt
 * @property {string} expiresAt
 * @property {string|null} lastUsedAt
 */

export const MAP_FILTER_NODE_TYPES = ["group", "rule"];
export const MAP_FILTER_COMBINATORS = ["AND", "OR"];