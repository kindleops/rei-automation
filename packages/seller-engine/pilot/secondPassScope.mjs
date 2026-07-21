import { deterministicId } from '../lib/hash.mjs';

export const sqlLiteral = (value) =>
  `'${String(value).replaceAll("'", "''")}'`;

export function inClause(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return 'select null::text where false';
  }
  return ids.map(sqlLiteral).join(',');
}

export function requireNonEmptyPartition(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error(
      'second-pass unavailable: representative partition is empty',
    );
  }
  return ids;
}

export function scoreVintageScope({
  propertyId,
  asOf,
  engineVersion,
}) {
  for (const [name, value] of Object.entries({
    propertyId,
    asOf,
    engineVersion,
  })) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`second-pass missing required ${name}`);
    }
  }

  const fsId = deterministicId(
    'fsnap',
    propertyId,
    asOf,
    engineVersion,
  );

  const fsWhere = [
    `fs.id = ${sqlLiteral(fsId)}`,
    `fs.property_id = ${sqlLiteral(propertyId)}`,
    `fs.as_of = ${sqlLiteral(asOf)}::timestamptz`,
    `fs.engine_version_id = ${sqlLiteral(engineVersion)}`,
  ].join(' and ');

  const scoreWhere = [
    `ss.feature_snapshot_id = ${sqlLiteral(fsId)}`,
    `ss.engine_version_id = ${sqlLiteral(engineVersion)}`,
  ].join(' and ');

  return {
    fsId,
    fsWhere,
    scoreWhere,
  };
}
