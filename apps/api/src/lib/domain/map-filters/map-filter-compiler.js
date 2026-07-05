import { MAP_FILTER_SCHEMA_VERSION } from "./versions.js";
import { validateExpression, summarizeExpression } from "./map-filter-expression.js";
import { getRegistryField } from "./active-field-registry.js";

/**
 * Recursively compile expression tree into CompiledPredicateNode AST.
 * Preserves AND/OR/NOT structure across mixed entities.
 */
export function compileExpressionTree(node, state = { params: [], nextIndex: 0 }) {
  if (!node || node.enabled === false) {
    return { type: "literal", value: true };
  }

  if (node.type === "rule") {
    const field = getRegistryField(node.fieldKey);
    if (!field) throw new Error(`unknown_field:${node.fieldKey}`);

    const paramIndices = pushParams(state, node.operator, node.value);
    const base = {
      fieldKey: field.key,
      operator: node.operator,
      paramIndices,
    };

    if (field.entity === "prospect") {
      return {
        type: "prospect_rule",
        relationshipMatch: node.relationshipMatch || "any_linked",
        ...base,
      };
    }
    if (field.entity === "master_owner") {
      return { type: "owner_rule", ...base };
    }
    if (field.entity === "geo") {
      return { type: "geo_rule", ...base };
    }
    return { type: "property_rule", ...base };
  }

  const children = (node.children || [])
    .map((child) => compileExpressionTree(child, state))
    .filter((child) => child.type !== "literal" || child.value !== true);

  if (!children.length) {
    return { type: "literal", value: true };
  }

  if (children.length === 1 && !node.negated && node.combinator === "AND") {
    return children[0];
  }

  return {
    type: "group",
    combinator: node.combinator || "AND",
    negated: Boolean(node.negated),
    enabled: true,
    children,
  };
}

function pushParams(state, operator, value) {
  const noParamOps = new Set([
    "is_blank", "is_not_blank", "is_empty", "is_not_empty",
    "is_true", "is_false", "is_unknown", "has_data", "has_no_data",
  ]);
  if (noParamOps.has(operator)) return [];

  if (operator === "between" || operator === "outside_range") {
    const indices = [];
    for (const item of value || []) {
      indices.push(state.nextIndex);
      state.params.push(item);
      state.nextIndex += 1;
    }
    return indices;
  }

  if (Array.isArray(value)) {
    const indices = [];
    for (const item of value) {
      indices.push(state.nextIndex);
      state.params.push(item);
      state.nextIndex += 1;
    }
    return indices;
  }

  const index = state.nextIndex;
  state.params.push(value);
  state.nextIndex += 1;
  return [index];
}

export function compileMapFilter(expression) {
  const validation = validateExpression(expression);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }

  const state = { params: [], nextIndex: 0 };
  const compiledPredicateAst = compileExpressionTree(validation.normalized, state);

  return {
    ok: true,
    compiled: {
      version: MAP_FILTER_SCHEMA_VERSION,
      normalizedExpression: validation.normalized,
      compiledPredicateAst,
      params: state.params,
      summary: summarizeExpression(validation.normalized),
      activeRuleCount: validation.stats.activeRuleCount,
      referencedFieldKeys: validation.stats.referencedFieldKeys,
      referencedEntities: validation.stats.referencedEntities,
    },
  };
}