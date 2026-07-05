import { MAP_FILTER_COMBINATORS, MAP_FILTER_NODE_TYPES } from "./map-filter-types.js";
import { RELATIONSHIP_MATCH_MODES } from "./relationship-semantics.js";
import { getRegistryField, resolveRegistryFieldKey } from "./active-field-registry.js";
import { isOperatorValidForDataType } from "./operators.js";
import { MAP_FILTER_LIMITS } from "./map-filter-limits.js";

function clean(value) {
  return String(value ?? "").trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function newId(prefix = "node") {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createEmptyExpressionRoot() {
  return {
    id: "root",
    type: "group",
    combinator: "AND",
    negated: false,
    enabled: true,
    children: [],
  };
}

export function normalizeExpressionNode(node, depth = 0) {
  if (!node || typeof node !== "object") {
    return createEmptyExpressionRoot();
  }

  if (node.type === "rule") {
    const fieldKey = resolveRegistryFieldKey(clean(node.fieldKey));
    return {
      id: clean(node.id) || newId("rule"),
      type: "rule",
      fieldKey: fieldKey || clean(node.fieldKey),
      operator: clean(node.operator),
      value: node.value,
      enabled: node.enabled !== false,
      ...(node.relationshipMatch ? { relationshipMatch: clean(node.relationshipMatch) } : {}),
    };
  }

  const combinator = MAP_FILTER_COMBINATORS.includes(clean(node.combinator).toUpperCase())
    ? clean(node.combinator).toUpperCase()
    : "AND";

  const children = Array.isArray(node.children)
    ? node.children.map((child) => normalizeExpressionNode(child, depth + 1))
    : [];

  return {
    id: clean(node.id) || (depth === 0 ? "root" : newId("group")),
    type: "group",
    combinator,
    negated: Boolean(node.negated),
    enabled: node.enabled !== false,
    children,
  };
}

export function collectExpressionStats(node, depth = 0) {
  const stats = {
    ruleCount: 0,
    groupCount: 0,
    maxDepth: depth,
    paramCount: 0,
    referencedFieldKeys: new Set(),
    referencedEntities: new Set(),
    activeRuleCount: 0,
  };

  if (!node || typeof node !== "object") return stats;

  if (node.type === "rule") {
    stats.ruleCount = 1;
    if (node.enabled !== false) stats.activeRuleCount = 1;
    if (node.fieldKey) stats.referencedFieldKeys.add(node.fieldKey);
    const field = getRegistryField(node.fieldKey);
    if (field?.entity) stats.referencedEntities.add(field.entity);
    if (node.value !== undefined && node.value !== null && node.value !== "") stats.paramCount += 1;
    if (Array.isArray(node.value)) stats.paramCount += node.value.length;
    return stats;
  }

  stats.groupCount = 1;
  for (const child of node.children || []) {
    const childStats = collectExpressionStats(child, depth + 1);
    stats.ruleCount += childStats.ruleCount;
    stats.groupCount += childStats.groupCount;
    stats.maxDepth = Math.max(stats.maxDepth, childStats.maxDepth);
    stats.paramCount += childStats.paramCount;
    stats.activeRuleCount += childStats.activeRuleCount;
    childStats.referencedFieldKeys.forEach((k) => stats.referencedFieldKeys.add(k));
    childStats.referencedEntities.forEach((e) => stats.referencedEntities.add(e));
  }

  return stats;
}

function validateRuleValue(field, operator, value) {
  if (["is_blank", "is_not_blank", "is_empty", "is_not_empty", "has_data", "has_no_data"].includes(operator)) {
    return [];
  }
  if (["is_true", "is_false", "is_unknown"].includes(operator)) {
    return [];
  }
  if (operator === "between" || operator === "outside_range") {
    if (!Array.isArray(value) || value.length !== 2) return ["invalid_between_value"];
    return [];
  }
  if (value === undefined || value === null || value === "") return ["missing_rule_value"];
  if (typeof value === "string" && value.length > MAP_FILTER_LIMITS.maxParamStringLength) {
    return ["value_too_long"];
  }
  if (Array.isArray(value) && value.length > MAP_FILTER_LIMITS.maxParamArrayLength) {
    return ["array_too_long"];
  }
  return [];
}

export function validateExpression(node) {
  const errors = [];
  const normalized = normalizeExpressionNode(node);
  const stats = collectExpressionStats(normalized);

  const walk = (current, depth = 0) => {
    if (!current || typeof current !== "object") {
      errors.push("invalid_node");
      return;
    }
    if (!MAP_FILTER_NODE_TYPES.includes(current.type)) {
      errors.push(`invalid_node_type:${current.type}`);
      return;
    }
    if (depth > MAP_FILTER_LIMITS.maxGroupDepth) {
      errors.push("max_depth_exceeded");
      return;
    }

    if (current.type === "rule") {
      if (current.enabled === false) return;
      const fieldKey = resolveRegistryFieldKey(current.fieldKey);
      if (!fieldKey) {
        errors.push(`unknown_field_key:${current.fieldKey}`);
        return;
      }
      const field = getRegistryField(fieldKey);
      if (!field?.safeToExpose) {
        errors.push(`field_not_exposed:${fieldKey}`);
        return;
      }
      if (!isOperatorValidForDataType(field.dataType, current.operator, field)) {
        errors.push(`invalid_operator:${fieldKey}:${current.operator}`);
      }
      errors.push(...validateRuleValue(field, current.operator, current.value).map((e) => `${e}:${fieldKey}`));

      if (field.entity === "prospect" && current.relationshipMatch) {
        if (!RELATIONSHIP_MATCH_MODES.includes(current.relationshipMatch)) {
          errors.push(`invalid_relationship_match:${current.relationshipMatch}`);
        }
      }

      // Reject SQL injection patterns in string values
      const suspicious = JSON.stringify(current.value || "");
      if (/\b(select|insert|update|delete|drop|alter|;|--)\b/i.test(suspicious)) {
        errors.push(`suspicious_value:${fieldKey}`);
      }
      return;
    }

    if (!Array.isArray(current.children)) {
      errors.push("group_children_invalid");
      return;
    }
    current.children.forEach((child) => walk(child, depth + 1));
  };

  walk(normalized);

  if (stats.ruleCount > MAP_FILTER_LIMITS.maxRules) errors.push("rule_limit_exceeded");
  if (stats.groupCount > MAP_FILTER_LIMITS.maxGroups) errors.push("group_limit_exceeded");

  return {
    ok: errors.length === 0,
    errors,
    normalized,
    stats: {
      ...stats,
      referencedFieldKeys: [...stats.referencedFieldKeys],
      referencedEntities: [...stats.referencedEntities],
    },
  };
}

export function summarizeExpression(node) {
  const parts = [];
  const walk = (current) => {
    if (!current || current.enabled === false) return;
    if (current.type === "rule") {
      const field = getRegistryField(current.fieldKey);
      parts.push(field?.label || current.fieldKey);
      return;
    }
    (current.children || []).forEach(walk);
  };
  walk(node);
  if (!parts.length) return "All properties";
  if (parts.length <= 4) return parts.join(" · ");
  return `${parts.slice(0, 3).join(" · ")} +${parts.length - 3}`;
}