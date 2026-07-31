/**
 * Offerr comp-intelligence — provider-independent schema drift check.
 *
 * Answers one question before anyone trusts a hosted V3-enabled result:
 *
 *   "Does this database still present the contract the Offerr comp path
 *    was written against?"
 *
 * STRICTLY READ-ONLY. The connection is opened with
 * default_transaction_read_only=on and every statement runs inside an explicit
 * READ ONLY transaction, so the SERVER refuses any write regardless of what
 * this script asks for. It never creates, alters or repairs anything — a drift
 * checker that mutates schema is a migration tool wearing a disguise.
 *
 * The contract is NOT hard-coded here. It is read from
 *   apps/api/supabase/contracts/offerr-comp-intelligence/schema-contract.json
 * so there is exactly one source of truth.
 *
 * Usage:
 *   OFFERR_SCHEMA_CHECK_DATABASE_URL='postgresql://...' \
 *     node apps/api/scripts/offerr/offerr-schema-drift-check.mjs
 *
 * Exit codes: 0 = compatible, 1 = drift detected, 2 = could not check.
 * Machine-readable output: --json emits { ok, failures: [{ code, ... }] }.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONTRACT_PATH = path.resolve(
  HERE, '../../supabase/contracts/offerr-comp-intelligence/schema-contract.json',
);

export function loadContract(contractPath = CONTRACT_PATH) {
  return JSON.parse(fs.readFileSync(contractPath, 'utf8'));
}

/**
 * Every failure this check can emit. Stable, machine-readable, and asserted by
 * tests so a rename cannot silently break an operator's alerting.
 */
export const FAILURE_CODES = Object.freeze([
  'missing_properties_table',
  'missing_comp_table',
  'missing_comp_view',
  'missing_buyer_entity_table',
  'missing_comp_rpc',
  'comp_rpc_signature_mismatch',
  'comp_rpc_result_contract_mismatch',
  'schema_contract_version_mismatch',
  'missing_required_column',
  'missing_required_index',
  'missing_offerr_table',
  'missing_offerr_feature_flag',
  'grant_posture_mismatch',
]);

const RELATION_FAILURE = {
  'public.properties': 'missing_properties_table',
  'public.buyer_comp_raw_v2': 'missing_comp_table',
  'public.buyer_entities_v2': 'missing_buyer_entity_table',
  'public.v_recent_sold_comps': 'missing_comp_view',
};

/**
 * Run the contract check against an already-connected read-only client.
 *
 * Exported separately from the CLI so tests can drive it directly.
 *
 * @param {{ query: Function }} client
 * @param {object} contract parsed schema-contract.json
 * @returns {Promise<{ ok: boolean, failures: object[], checks: object[] }>}
 */
export async function checkSchemaContract(client, contract) {
  const failures = [];
  const checks = [];
  const fail = (code, detail) => failures.push({ code, ...detail });
  const pass = (label) => checks.push({ label, ok: true });

  const q = async (sql, params = []) => (await client.query(sql, params)).rows;

  // ── 1. Relations exist ──────────────────────────────────────────────────
  const relnames = [
    ...Object.keys(contract.tables ?? {}),
    ...Object.keys(contract.views ?? {}),
  ];
  const present = new Set(
    (await q(
      `SELECT 'public.' || c.relname AS qualified
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p')`,
    )).map((r) => r.qualified),
  );
  for (const rel of relnames) {
    if (present.has(rel)) pass(`relation ${rel} exists`);
    else fail(RELATION_FAILURE[rel] ?? 'missing_comp_table', { relation: rel });
  }

  // ── 2. Required columns exist with the expected type ────────────────────
  const columnRows = await q(
    `SELECT table_name, column_name, udt_name
       FROM information_schema.columns
      WHERE table_schema = 'public'`,
  );
  const colTypes = new Map(columnRows.map((r) => [`${r.table_name}.${r.column_name}`, r.udt_name]));

  const specs = { ...(contract.tables ?? {}), ...(contract.views ?? {}) };
  for (const [rel, spec] of Object.entries(specs)) {
    if (!present.has(rel)) continue; // already reported as a missing relation
    const bare = rel.replace(/^public\./, '');
    for (const [col, expectedType] of Object.entries(spec.required_columns ?? {})) {
      const actual = colTypes.get(`${bare}.${col}`);
      if (actual === undefined) {
        fail('missing_required_column', { relation: rel, column: col, expected_type: expectedType });
      } else if (actual !== expectedType) {
        fail('missing_required_column', {
          relation: rel, column: col, expected_type: expectedType, actual_type: actual,
          detail: 'column present but type drifted',
        });
      }
    }
    pass(`${rel} required columns (${Object.keys(spec.required_columns ?? {}).length})`);
  }

  // ── 3. Required indexes exist ───────────────────────────────────────────
  const indexNames = new Set(
    (await q(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`)).map((r) => r.indexname),
  );
  for (const [rel, spec] of Object.entries(contract.tables ?? {})) {
    for (const idx of spec.required_indexes ?? []) {
      if (indexNames.has(idx)) pass(`index ${idx} exists`);
      else fail('missing_required_index', { relation: rel, index: idx });
    }
  }

  // ── 4. The comp RPC: existence, signature, result contract ──────────────
  const rpc = contract.rpc;
  const rpcRows = await q(
    `SELECT p.oid,
            pg_get_function_identity_arguments(p.oid) AS identity_args,
            pg_get_function_result(p.oid)             AS result,
            l.lanname                                 AS language,
            CASE p.provolatile WHEN 'i' THEN 'IMMUTABLE' WHEN 's' THEN 'STABLE' ELSE 'VOLATILE' END AS volatility,
            p.prosecdef                               AS security_definer
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_language  l ON l.oid = p.prolang
      WHERE n.nspname = $1 AND p.proname = $2`,
    [rpc.schema, rpc.name],
  );

  if (!rpcRows.length) {
    fail('missing_comp_rpc', { function: `${rpc.schema}.${rpc.name}` });
  } else {
    const fn = rpcRows[0];
    if (fn.identity_args !== rpc.identity_arguments) {
      fail('comp_rpc_signature_mismatch', {
        expected: rpc.identity_arguments, actual: fn.identity_args,
      });
    } else {
      pass('comp RPC signature matches the canonical contract');
    }

    // Compare the RETURNS TABLE(...) column contract name-by-name and
    // type-by-type. A renamed or retyped output column silently corrupts
    // normalizeCandidate, so this is the highest-value check in the file.
    const inner = String(fn.result).replace(/^TABLE\(/, '').replace(/\)$/, '');
    const actualCols = inner.split(', ').map((part) => {
      const i = part.indexOf(' ');
      return { name: part.slice(0, i), type: part.slice(i + 1) };
    });
    const expectedCols = rpc.result_columns;
    if (actualCols.length !== expectedCols.length) {
      fail('comp_rpc_result_contract_mismatch', {
        expected_column_count: expectedCols.length, actual_column_count: actualCols.length,
      });
    } else {
      const diffs = expectedCols
        .map((e, i) => (e.name !== actualCols[i].name || e.type !== actualCols[i].type
          ? { position: i, expected: e, actual: actualCols[i] } : null))
        .filter(Boolean);
      if (diffs.length) fail('comp_rpc_result_contract_mismatch', { differences: diffs });
      else pass(`comp RPC returns the canonical ${expectedCols.length}-column contract`);
    }

    if (fn.volatility === 'VOLATILE') {
      // A VOLATILE comp RPC would mean retrieval is no longer guaranteed
      // side-effect free.
      fail('comp_rpc_signature_mismatch', {
        detail: 'comp RPC is VOLATILE; the canonical contract is STABLE (read-only)',
        expected_volatility: rpc.volatility, actual_volatility: fn.volatility,
      });
    } else {
      pass(`comp RPC volatility is ${fn.volatility} (read-only)`);
    }
  }

  // ── 5. Schema-contract version ──────────────────────────────────────────
  if (present.has('public.comp_intelligence_schema_contract')
      || (await q(`SELECT to_regclass('public.comp_intelligence_schema_contract') IS NOT NULL AS ok`))[0].ok) {
    const rows = await q(
      `SELECT version FROM public.comp_intelligence_schema_contract WHERE contract_name = $1`, [contract.name],
    );
    const found = rows[0]?.version ?? null;
    if (found !== contract.schema_contract_version) {
      fail('schema_contract_version_mismatch', {
        expected: contract.schema_contract_version, actual: found,
      });
    } else {
      pass(`schema contract version ${found}`);
    }
  } else {
    fail('schema_contract_version_mismatch', {
      expected: contract.schema_contract_version, actual: null,
      detail: 'public.comp_intelligence_schema_contract is absent — database was not bootstrapped from the contract',
    });
  }

  // ── 6. Offerr spine tables + feature flag ───────────────────────────────
  for (const t of contract.offerr_spine.tables) {
    if (present.has(`public.${t}`)) pass(`offerr table ${t} exists`);
    else fail('missing_offerr_table', { table: t });
  }
  const flagTableExists = present.has(contract.offerr_spine.flag_table);
  if (!flagTableExists) {
    fail('missing_offerr_feature_flag', {
      detail: `${contract.offerr_spine.flag_table} is absent`, flag: contract.offerr_spine.feature_flag,
    });
  } else {
    const rows = await q(
      `SELECT value FROM ${contract.offerr_spine.flag_table} WHERE key = $1`,
      [contract.offerr_spine.feature_flag],
    );
    if (!rows.length) fail('missing_offerr_feature_flag', { flag: contract.offerr_spine.feature_flag });
    else pass(`feature flag ${contract.offerr_spine.feature_flag} present (value=${rows[0].value})`);
  }

  // ── 7. Grant posture: the comp corpus must not be writable by anon ──────
  // Advisory but load-bearing: an anon-writable comp corpus invalidates every
  // read-only guarantee the evaluation path claims.
  const writableByAnon = await q(
    `SELECT table_name, grantee, privilege_type
       FROM information_schema.role_table_grants
      WHERE table_schema = 'public'
        AND grantee IN ('anon')
        AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
        AND table_name IN ('buyer_comp_raw_v2','buyer_entities_v2')`,
  );
  if (writableByAnon.length) {
    fail('grant_posture_mismatch', {
      detail: 'anon holds write privileges on the comp corpus',
      grants: writableByAnon.map((r) => `${r.table_name}:${r.privilege_type}`),
    });
  } else {
    pass('anon holds no write privilege on the comp corpus');
  }

  return { ok: failures.length === 0, failures, checks };
}

async function main() {
  const target = process.env.OFFERR_SCHEMA_CHECK_DATABASE_URL
    || process.env.OFFERR_VERIFY_DATABASE_URL
    || '';
  const asJson = process.argv.includes('--json');

  if (!target) {
    console.error('OFFERR_SCHEMA_CHECK_DATABASE_URL (or OFFERR_VERIFY_DATABASE_URL) is required');
    return 2;
  }

  const contract = loadContract();
  const client = new pg.Client({
    connectionString: target,
    // Server-enforced read-only: a write attempt fails with SQLSTATE 25006.
    options: '-c default_transaction_read_only=on',
    statement_timeout: 30_000,
  });

  await client.connect();
  let result;
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    result = await checkSchemaContract(client, contract);
    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }

  if (asJson) {
    console.log(JSON.stringify({ ok: result.ok, failures: result.failures }, null, 2));
  } else {
    console.log(`\nOfferr comp-intelligence schema drift check — contract ${contract.schema_contract_version}`);
    console.log(`  target: ${target.replace(/:[^:@/]*@/, ':***@')}`);
    console.log(`  read-only: enforced by the server (default_transaction_read_only=on)\n`);
    for (const c of result.checks) console.log(`  PASS  ${c.label}`);
    if (result.failures.length) {
      console.log('\n  DRIFT DETECTED:');
      for (const f of result.failures) {
        const { code, ...rest } = f;
        console.log(`  FAIL  ${code}  ${JSON.stringify(rest)}`);
      }
    }
    console.log(`\n  ${result.ok ? 'COMPATIBLE' : `${result.failures.length} DRIFT FAILURE(S)`}\n`);
  }
  return result.ok ? 0 : 1;
}

// Only run the CLI when executed directly, so tests can import the checker.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error('FATAL:', error?.message ?? error);
      process.exit(2);
    });
}

export default { checkSchemaContract, loadContract, FAILURE_CODES, CONTRACT_PATH };
