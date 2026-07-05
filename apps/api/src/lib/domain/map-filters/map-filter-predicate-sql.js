import { getRegistryField } from "./active-field-registry.js";
import {
  MAP_FILTER_PROSPECT_LINKS_ALIAS,
  MAP_FILTER_PROSPECT_LINKS_TABLE,
} from "./map-filter-prospect-links.js";

const PROPERTY_ALIAS = "p";
const PROSPECT_ALIAS = "pr";
const OWNER_ALIAS = "mo";
const LINK_ALIAS = MAP_FILTER_PROSPECT_LINKS_ALIAS;

/**
 * Build parameterized SQL for property eligibility from CompiledPredicateNode AST.
 * Returns { sql, params } where sql is a boolean expression referencing alias p.
 */
export function buildPropertyEligibilitySql(ast, params = [], options = {}) {
  const ctx = {
    params: [...params],
    paramOffset: 0,
    bounds: options.bounds || null,
  };
  const sql = compileAstNode(ast, ctx, { mode: "property" });
  return { sql: sql || "TRUE", params: ctx.params };
}

function paramRef(ctx, index) {
  const absolute = index + 1 + ctx.paramOffset;
  return `$${absolute}`;
}

function addParam(ctx, value) {
  ctx.params.push(value);
  return `$${ctx.params.length}`;
}

function compileAstNode(node, ctx, { mode, outerProspectAlias = null } = {}) {
  if (!node) return "TRUE";

  if (node.type === "literal") {
    return node.value ? "TRUE" : "FALSE";
  }

  if (node.type === "group") {
    const parts = (node.children || []).map((child) => compileAstNode(child, ctx, { mode, outerProspectAlias }));
    const joined = node.combinator === "OR"
      ? `(${parts.join(" OR ")})`
      : `(${parts.join(" AND ")})`;
    const expr = parts.length ? joined : "TRUE";
    return node.negated ? `NOT (${expr})` : expr;
  }

  if (node.type === "property_rule") {
    return compileFieldPredicate(node, ctx, PROPERTY_ALIAS);
  }

  if (node.type === "geo_rule") {
    return compileGeoPredicate(node, ctx);
  }

  if (node.type === "owner_rule") {
    const inner = compileFieldPredicate(node, ctx, OWNER_ALIAS);
    return `EXISTS (
      SELECT 1 FROM master_owners ${OWNER_ALIAS}
      WHERE ${OWNER_ALIAS}.master_owner_id = ${PROPERTY_ALIAS}.master_owner_id
        AND (${inner})
    )`;
  }

  if (node.type === "prospect_rule") {
    return compileProspectRelationship(node, ctx, outerProspectAlias);
  }

  return "TRUE";
}

function compileProspectRelationship(node, ctx, outerProspectAlias) {
  const rel = node.relationshipMatch || "any_linked";
  const predicate = compileFieldPredicate(node, ctx, PROSPECT_ALIAS);

  const linkedProspectExists = (extra = "") => `EXISTS (
    SELECT 1
    FROM ${MAP_FILTER_PROSPECT_LINKS_TABLE} ${LINK_ALIAS}
    INNER JOIN prospects ${PROSPECT_ALIAS}
      ON ${PROSPECT_ALIAS}.prospect_id = ${LINK_ALIAS}.prospect_id
    WHERE ${LINK_ALIAS}.property_id = ${PROPERTY_ALIAS}.property_id
      ${extra}
      AND (${predicate})
  )`;

  if (rel === "any_linked") {
    if (outerProspectAlias) {
      const outerPred = compileFieldPredicate(node, ctx, outerProspectAlias);
      return `(${outerPred})`;
    }
    return linkedProspectExists();
  }

  if (rel === "primary_only") {
    return linkedProspectExists(`AND ${PROSPECT_ALIAS}.is_primary_prospect IS TRUE`);
  }

  if (rel === "none_linked") {
    return `NOT (${linkedProspectExists()})`;
  }

  if (rel === "all_linked") {
    return `(
      EXISTS (
        SELECT 1
        FROM ${MAP_FILTER_PROSPECT_LINKS_TABLE} ${LINK_ALIAS}
        WHERE ${LINK_ALIAS}.property_id = ${PROPERTY_ALIAS}.property_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM ${MAP_FILTER_PROSPECT_LINKS_TABLE} ${LINK_ALIAS}
        INNER JOIN prospects ${PROSPECT_ALIAS}
          ON ${PROSPECT_ALIAS}.prospect_id = ${LINK_ALIAS}.prospect_id
        WHERE ${LINK_ALIAS}.property_id = ${PROPERTY_ALIAS}.property_id
          AND NOT (${predicate})
      )
    )`;
  }

  return linkedProspectExists();
}

function compileGeoPredicate(node, ctx) {
  const bounds = ctx.bounds;
  if (node.fieldKey === "geo.current_viewport" && bounds) {
    return `(
      ${PROPERTY_ALIAS}.latitude BETWEEN ${addParam(ctx, bounds.lat_min)} AND ${addParam(ctx, bounds.lat_max)}
      AND ${PROPERTY_ALIAS}.longitude BETWEEN ${addParam(ctx, bounds.lng_min)} AND ${addParam(ctx, bounds.lng_max)}
    )`;
  }
  if (node.fieldKey === "geo.radius_from_point" && Array.isArray(node.paramIndices) && node.paramIndices.length >= 3) {
    const [latIdx, lngIdx, radiusIdx] = node.paramIndices;
    return `(
      ST_DWithin(
        ST_SetSRID(ST_MakePoint(${PROPERTY_ALIAS}.longitude::double precision, ${PROPERTY_ALIAS}.latitude::double precision), 4326)::geography,
        ST_SetSRID(ST_MakePoint(${paramRef(ctx, lngIdx)}::double precision, ${paramRef(ctx, latIdx)}::double precision), 4326)::geography,
        ${paramRef(ctx, radiusIdx)}::double precision
      )
    )`;
  }
  if (node.fieldKey === "geo.drawn_polygon" && node.paramIndices?.length) {
    return `ST_Contains(
      ST_SetSRID(ST_GeomFromGeoJSON(${paramRef(ctx, node.paramIndices[0])}::text), 4326),
      ST_SetSRID(ST_MakePoint(${PROPERTY_ALIAS}.longitude::double precision, ${PROPERTY_ALIAS}.latitude::double precision), 4326)
    )`;
  }
  if (node.fieldKey === "geo.exclusion_polygon" && node.paramIndices?.length) {
    return `NOT ST_Contains(
      ST_SetSRID(ST_GeomFromGeoJSON(${paramRef(ctx, node.paramIndices[0])}::text), 4326),
      ST_SetSRID(ST_MakePoint(${PROPERTY_ALIAS}.longitude::double precision, ${PROPERTY_ALIAS}.latitude::double precision), 4326)
    )`;
  }
  return "TRUE";
}

function compileFieldPredicate(node, ctx, alias) {
  const field = getRegistryField(node.fieldKey);
  if (!field) throw new Error(`unknown_field:${node.fieldKey}`);
  const col = `${alias}.${field.column}`;
  const op = node.operator;

  if (field.dataType === "derived_presence") {
    return compilePresencePredicate(field, col, op, node, ctx);
  }

  if (op === "is_blank" || op === "is_empty") return `${col} IS NULL`;
  if (op === "is_not_blank" || op === "is_not_empty") return `${col} IS NOT NULL`;

  if (field.dataType === "boolean") {
    if (op === "is_true") return `${col} IS TRUE`;
    if (op === "is_false") return `${col} IS FALSE`;
    if (op === "is_unknown") return `${col} IS NULL`;
  }

  const value = (idx) => paramRef(ctx, idx);

  if (op === "equals") return `${col} = ${value(node.paramIndices[0])}`;
  if (op === "not_equals") return `${col} <> ${value(node.paramIndices[0])}`;
  if (op === "greater_than") return `${col} > ${value(node.paramIndices[0])}`;
  if (op === "greater_than_or_equal") return `${col} >= ${value(node.paramIndices[0])}`;
  if (op === "less_than") return `${col} < ${value(node.paramIndices[0])}`;
  if (op === "less_than_or_equal") return `${col} <= ${value(node.paramIndices[0])}`;
  if (op === "contains") return `${col} ILIKE '%' || ${value(node.paramIndices[0])} || '%'`;
  if (op === "not_contains") return `${col} NOT ILIKE '%' || ${value(node.paramIndices[0])} || '%'`;
  if (op === "starts_with") return `${col} ILIKE ${value(node.paramIndices[0])} || '%'`;
  if (op === "ends_with") return `${col} ILIKE '%' || ${value(node.paramIndices[0])}`;
  if (op === "between") {
    return `${col} BETWEEN ${value(node.paramIndices[0])} AND ${value(node.paramIndices[1])}`;
  }
  if (op === "outside_range") {
    return `${col} NOT BETWEEN ${value(node.paramIndices[0])} AND ${value(node.paramIndices[1])}`;
  }
  if (op === "is_any_of") {
    const refs = node.paramIndices.map((i) => value(i)).join(", ");
    return `${col} IN (${refs})`;
  }
  if (op === "is_none_of") {
    const refs = node.paramIndices.map((i) => value(i)).join(", ");
    return `${col} NOT IN (${refs})`;
  }

  if (field.dataType === "json_text_array" || field.jsonStorageShape === "text_array" || field.jsonStorageShape === "uuid_array") {
    if (op === "contains_any") {
      return `(${node.paramIndices.map((i) => `${col}::jsonb ? ${value(i)}`).join(" OR ")})`;
    }
    if (op === "contains_all") {
      return `(${node.paramIndices.map((i) => `${col}::jsonb ? ${value(i)}`).join(" AND ")})`;
    }
    if (op === "contains_none") {
      return `NOT (${node.paramIndices.map((i) => `${col}::jsonb ? ${value(i)}`).join(" OR ")})`;
    }
  }

  if (field.dataType === "json_object_array" || field.jsonStorageShape === "object_array") {
    if (op === "has_any" || op === "is_not_empty") {
      return `jsonb_array_length(COALESCE(${col}::jsonb, '[]'::jsonb)) > 0`;
    }
    if (op === "is_empty") return `COALESCE(jsonb_array_length(${col}::jsonb), 0) = 0`;
    if (op === "count_greater_than") return `jsonb_array_length(COALESCE(${col}::jsonb, '[]'::jsonb)) > ${value(node.paramIndices[0])}`;
    if (op === "count_less_than") return `jsonb_array_length(COALESCE(${col}::jsonb, '[]'::jsonb)) < ${value(node.paramIndices[0])}`;
    if (op === "count_equals") return `jsonb_array_length(COALESCE(${col}::jsonb, '[]'::jsonb)) = ${value(node.paramIndices[0])}`;
  }

  return "TRUE";
}

function compilePresencePredicate(field, col, op, node, ctx) {
  const hasData = `(${col} IS NOT NULL AND ${col}::text NOT IN ('', '[]', '{}'))`;
  const noData = `(${col} IS NULL OR ${col}::text IN ('', '[]', '{}'))`;
  if (op === "has_data") return hasData;
  if (op === "has_no_data") return noData;
  if (op === "is_true") return hasData;
  if (op === "is_false") return noData;
  if (op === "count_greater_than") return `jsonb_array_length(COALESCE(${col}::jsonb, '[]'::jsonb)) > ${paramRef(ctx, node.paramIndices[0])}`;
  return hasData;
}

export function hasEntityRules(ast, entityType) {
  let found = false;
  const walk = (node) => {
    if (!node || found) return;
    if (node.type === "prospect_rule") { if (entityType === "prospect") found = true; return; }
    if (node.type === "owner_rule") { if (entityType === "master_owner") found = true; return; }
    if (node.type === "group") (node.children || []).forEach(walk);
  };
  walk(ast);
  return found;
}

export function buildMatchingPropertiesCte(propertyPredicateSql, bounds = null, predicateParamCount = 0) {
  let boundsClause = "";
  const extraParams = [];
  if (bounds) {
    const o = predicateParamCount;
    boundsClause = `AND ${PROPERTY_ALIAS}.latitude BETWEEN $${o + 1} AND $${o + 2}
      AND ${PROPERTY_ALIAS}.longitude BETWEEN $${o + 3} AND $${o + 4}`;
    extraParams.push(bounds.lat_min, bounds.lat_max, bounds.lng_min, bounds.lng_max);
  }
  return {
    sql: `
      SELECT DISTINCT
        ${PROPERTY_ALIAS}.property_id,
        ${PROPERTY_ALIAS}.master_owner_id
      FROM properties ${PROPERTY_ALIAS}
      WHERE ${PROPERTY_ALIAS}.latitude IS NOT NULL
        AND ${PROPERTY_ALIAS}.longitude IS NOT NULL
        AND (${propertyPredicateSql})
        ${boundsClause}
    `,
    extraParams,
  };
}

export function buildPropertyCountFromMatchingSql() {
  return `SELECT COUNT(*)::bigint AS count FROM matching_properties`;
}

export function buildProspectCountFromMatchingSql() {
  return `
    SELECT COUNT(DISTINCT ${LINK_ALIAS}.prospect_id)::bigint AS count
    FROM ${MAP_FILTER_PROSPECT_LINKS_TABLE} ${LINK_ALIAS}
    INNER JOIN matching_properties mp ON mp.property_id = ${LINK_ALIAS}.property_id
  `;
}

export function buildOwnerCountFromMatchingSql(ownerPredicateSql = null) {
  if (ownerPredicateSql) {
    return `
      SELECT COUNT(DISTINCT mp.master_owner_id)::bigint AS count
      FROM matching_properties mp
      INNER JOIN master_owners ${OWNER_ALIAS} ON ${OWNER_ALIAS}.master_owner_id = mp.master_owner_id
      WHERE mp.master_owner_id IS NOT NULL
        AND (${ownerPredicateSql})
    `;
  }
  return `
    SELECT COUNT(DISTINCT mp.master_owner_id)::bigint AS count
    FROM matching_properties mp
    WHERE mp.master_owner_id IS NOT NULL
  `;
}

function wrapMatchingCte(propertyPredicateSql, bounds, predicateParamCount, innerSql) {
  const cte = buildMatchingPropertiesCte(propertyPredicateSql, bounds, predicateParamCount);
  return {
    sql: `
      WITH matching_properties AS MATERIALIZED (
        ${cte.sql}
      )
      ${innerSql}
    `,
    extraParams: cte.extraParams,
  };
}

/** Direct SQL builders used by accounting proof comparisons. */
export function buildProspectCountSql(propertyPredicateSql, predicateParamCount = 0) {
  return wrapMatchingCte(
    propertyPredicateSql,
    null,
    predicateParamCount,
    buildProspectCountFromMatchingSql(),
  );
}

export function buildOwnerCountSql(propertyPredicateSql, predicateParamCount = 0) {
  const wrapped = wrapMatchingCte(
    propertyPredicateSql,
    null,
    predicateParamCount,
    buildOwnerCountFromMatchingSql(),
  );
  return wrapped.sql;
}

export function buildPropertyCountSql(propertyPredicateSql, bounds = null, predicateParamCount = 0) {
  return wrapMatchingCte(
    propertyPredicateSql,
    bounds,
    predicateParamCount,
    buildPropertyCountFromMatchingSql(),
  );
}

export function buildUnifiedCountSql(propertyPredicateSql, bounds = null, predicateParamCount = 0) {
  const cte = buildMatchingPropertiesCte(propertyPredicateSql, bounds, predicateParamCount);
  return {
    sql: `
      WITH matching_properties AS MATERIALIZED (
        ${cte.sql}
      )
      SELECT
        (${buildPropertyCountFromMatchingSql().trim()}) AS matching_properties,
        (${buildProspectCountFromMatchingSql().trim()}) AS matching_prospects,
        (${buildOwnerCountFromMatchingSql().trim()}) AS matching_master_owners
    `,
    extraParams: cte.extraParams,
  };
}