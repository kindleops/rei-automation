import {
  getRegistryField,
  PIPELINE_DISPLAY_FIELD_REGISTRY,
} from '@/lib/domain/opportunity/pipeline-display-field-registry.js';

function clean(value) {
  return String(value ?? '').trim();
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(clean(value).toLowerCase());
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function applyClause(query, clause) {
  if (!clause || typeof clause !== 'object') return query;
  const fieldKey = clean(clause.field);
  const op = clean(clause.operator || clause.op).toLowerCase();
  const value = clause.value;
  const field = getRegistryField(fieldKey);
  if (!field?.filterable || !field.filterExpression) return query;

  const col = field.filterExpression;

  if (op === 'is_known' || op === 'is_not_empty') {
    return query.not(col, 'is', null);
  }
  if (op === 'is_unknown' || op === 'is_empty') {
    return query.is(col, null);
  }

  if (field.dataType === 'select') {
    if (op === 'is' || op === 'equals') return query.eq(col, value);
    if (op === 'is_not' || op === 'not_equals') return query.neq(col, value);
    if (op === 'is_any_of' && Array.isArray(value)) return query.in(col, value);
    if (op === 'is_none_of' && Array.isArray(value)) return query.not(col, 'in', `(${value.join(',')})`);
    return query;
  }

  if (['number', 'currency', 'score', 'percent'].includes(field.dataType)) {
    if (op === 'gt' || op === 'greater_than') return query.gt(col, num(value));
    if (op === 'gte' || op === 'greater_or_equal') return query.gte(col, num(value));
    if (op === 'lt' || op === 'less_than') return query.lt(col, num(value));
    if (op === 'lte' || op === 'less_or_equal') return query.lte(col, num(value));
    if (op === 'between' && Array.isArray(value) && value.length === 2) {
      return query.gte(col, num(value[0])).lte(col, num(value[1]));
    }
    return query;
  }

  if (['datetime', 'date'].includes(field.dataType)) {
    const now = new Date();
    if (op === 'before') return query.lt(col, value);
    if (op === 'after') return query.gt(col, value);
    if (op === 'between' && Array.isArray(value) && value.length === 2) {
      return query.gte(col, value[0]).lte(col, value[1]);
    }
    if (op === 'today') {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start.getTime() + 86400000);
      return query.gte(col, start.toISOString()).lt(col, end.toISOString());
    }
    if (op === 'overdue') return query.lt(col, now.toISOString());
    if (op === 'within_next_days') {
      const days = num(value) ?? 7;
      const end = new Date(now.getTime() + days * 86400000);
      return query.gte(col, now.toISOString()).lte(col, end.toISOString());
    }
    if (op === 'within_last_days') {
      const days = num(value) ?? 7;
      const start = new Date(now.getTime() - days * 86400000);
      return query.gte(col, start.toISOString()).lte(col, now.toISOString());
    }
    return query;
  }

  const str = clean(value);
  if (!str) return query;
  if (op === 'equals') return query.eq(col, str);
  if (op === 'contains') return query.ilike(col, `%${str}%`);
  if (op === 'starts_with') return query.ilike(col, `${str}%`);
  return query;
}

function applyFilterGroup(query, group) {
  if (!group || typeof group !== 'object') return query;
  const logic = clean(group.logic || 'and').toLowerCase();
  const clauses = Array.isArray(group.clauses) ? group.clauses : [];

  if (clauses.length === 0) return query;

  for (const clause of clauses) {
    if (clause.clauses) {
      query = applyFilterGroup(query, clause);
      continue;
    }
    query = applyClause(query, clause);
  }

  if (logic === 'or' && clauses.length > 1) {
    const parts = clauses
      .filter((c) => !c.clauses)
      .map((c) => {
        const field = getRegistryField(c.field);
        if (!field?.filterExpression) return null;
        const col = field.filterExpression;
        const op = clean(c.operator || c.op).toLowerCase();
        const val = c.value;
        if (op === 'is' || op === 'equals') return `${col}.eq.${val}`;
        if (op === 'contains') return `${col}.ilike.%${val}%`;
        if (op === 'is_known') return `${col}.not.is.null`;
        return null;
      })
      .filter(Boolean);
    if (parts.length > 0) query = query.or(parts.join(','));
  }

  return query;
}

export function applyRegistryFilters(query, params = {}) {
  const filterJson = parseJson(params.filter_json ?? params.filters_json ?? params.advanced_filters);
  if (!filterJson) return query;
  return applyFilterGroup(query, filterJson);
}

export function applyRegistrySorts(query, params = {}) {
  const sorts = parseJson(params.sorts ?? params.sort_json, null);
  if (Array.isArray(sorts) && sorts.length > 0) {
    let next = query;
    for (const sort of sorts) {
      const fieldKey = clean(sort.field);
      const field = getRegistryField(fieldKey);
      if (!field?.sortable || !field.sortExpression) continue;
      const ascending = sort.direction !== 'desc';
      const nullsFirst = sort.nulls === 'first';
      next = next.order(field.sortExpression, { ascending, nullsFirst });
    }
    return next;
  }

  const orderBy = clean(params.order_by);
  if (orderBy) {
    const field = getRegistryField(orderBy) ?? Object.values(PIPELINE_DISPLAY_FIELD_REGISTRY).find((f) => f.sortExpression === orderBy);
    const col = field?.sortExpression ?? orderBy;
    const ascending = !truthy(params.descending) && !truthy(params.desc);
    const nullsFirst = clean(params.nulls) === 'first';
    return query.order(col, { ascending, nullsFirst: nullsFirst || false });
  }

  return query.order('last_activity_at', { ascending: false, nullsFirst: false });
}