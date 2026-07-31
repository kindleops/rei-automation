/**
 * Offerr staging guard — hard failure before any Offerr staging write.
 *
 * Every Offerr fixture/verification script MUST call assertOfferrStagingTarget()
 * before opening a connection. The guard is deliberately paranoid and does NOT
 * rely on naming conventions:
 *
 *   1. Any target whose project ref is a KNOWN PRODUCTION ref is refused.
 *   2. Any target belonging to a DIFFERENT PRODUCT (ReivestiExchange, SignPro)
 *      is refused — another product's project is not rei-automation staging.
 *   3. An explicit opt-in env var (ALLOW_OFFERR_STAGING_FIXTURES=true) is
 *      required, so an inherited shell env can never silently authorize a run.
 *   4. An environment that DESIGNATES ITSELF production (NODE_ENV,
 *      VERCEL_ENV, APP_ENV, ...) is refused regardless of which database the
 *      target string points at. A correct ref on a production runtime is
 *      still a production execution.
 *   5. Declared-required staging secrets must be present. A half-configured
 *      run is refused before it can half-apply anything.
 *   6. A target that cannot be positively identified is refused. Unknown is
 *      never treated as safe.
 *
 * The guard throws OfferrStagingGuardError. Callers must not catch and continue.
 */

/**
 * Supabase project refs identified as PRODUCTION for rei-automation.
 * Verified 2026-07-30 against `supabase projects list`, supabase/.temp/
 * linked-project.json, docs/backend/acquisition_engine_v3_audit.md and
 * apps/dashboard/PRODUCTION_SMS_LAUNCH_CHECKLIST.md.
 */
export const PRODUCTION_PROJECT_REFS = Object.freeze(['lcppdrmrdfblstpcbgpf']);

/**
 * Projects that belong to other products. They are not production for
 * rei-automation, but they are equally invalid as an Offerr staging target.
 */
export const FOREIGN_PRODUCT_PROJECT_REFS = Object.freeze({
  wwqqwllstapdolkndzzx: 'ReivestiExchange',
  lvocccmhnyfoyqnbmmci: 'SignPro',
});

export const STAGING_OPT_IN_ENV = 'ALLOW_OFFERR_STAGING_FIXTURES';

/**
 * Environment variables that designate the *runtime* environment. If any of
 * them says production, the run is refused even when the database target
 * itself looks like staging — Offerr fixtures must never execute from a
 * production runtime.
 */
export const ENVIRONMENT_DESIGNATION_ENVS = Object.freeze([
  'NODE_ENV',
  'VERCEL_ENV',
  'APP_ENV',
  'APP_ENVIRONMENT',
  'ENVIRONMENT',
  'DEPLOY_ENV',
  'OFFERR_ENVIRONMENT',
]);

/** Values that mean "this is production". Compared case-insensitively. */
export const PRODUCTION_ENVIRONMENT_VALUES = Object.freeze([
  'production',
  'prod',
  'live',
]);

export class OfferrStagingGuardError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'OfferrStagingGuardError';
    this.details = details;
  }
}

/**
 * Extract a Supabase project ref from a Supabase URL or a Postgres connection
 * string. Returns null when the target is not a Supabase host (e.g. a local
 * container), which the caller must then classify explicitly.
 */
export function extractProjectRef(target) {
  const value = String(target ?? '').trim();
  if (!value) return null;
  // https://<ref>.supabase.co  |  postgresql://...@db.<ref>.supabase.co:5432/postgres
  const match =
    value.match(/https?:\/\/([a-z0-9]{20})\.supabase\.(co|in)/i) ??
    value.match(/@(?:db|aws-[a-z0-9-]+)\.([a-z0-9]{20})\.supabase\./i) ??
    value.match(/\b([a-z0-9]{20})\.supabase\./i);
  return match ? match[1].toLowerCase() : null;
}

/** True when the host is unambiguously local/loopback. */
export function isLocalTarget(target) {
  const value = String(target ?? '').trim().toLowerCase();
  if (!value) return false;
  return (
    value.includes('127.0.0.1') ||
    value.includes('localhost') ||
    value.includes('@0.0.0.0') ||
    value.includes('host.docker.internal') ||
    value.startsWith('/') // unix socket
  );
}

/**
 * Assert that `target` is a legitimate, explicitly authorized Offerr staging
 * destination. Throws OfferrStagingGuardError otherwise.
 *
 * @param {object}  options
 * @param {string}  options.target       Supabase URL or Postgres connection string.
 * @param {object}  [options.env]        Environment (defaults to process.env).
 * @param {string}  [options.label]      Human label for logs.
 * @param {boolean} [options.allowLocal] Permit a local container target (default true).
 * @param {string[]} [options.requiredSecrets] Env var names that must be present
 *   and non-empty before the run is allowed to proceed.
 * @returns {{ ok: true, classification: string, project_ref: string|null, target_host: string }}
 */
export function assertOfferrStagingTarget({
  target,
  env = process.env,
  label = 'offerr-staging',
  allowLocal = true,
  requiredSecrets = [],
} = {}) {
  const raw = String(target ?? '').trim();

  if (!raw) {
    throw new OfferrStagingGuardError(
      'Refusing to run: no Offerr staging target was supplied. ' +
        'Set an explicit target; the guard never falls back to a default connection.',
      { label },
    );
  }

  // ── 1. Explicit opt-in (checked before anything else) ────────────────────
  const optIn = String(env?.[STAGING_OPT_IN_ENV] ?? '').trim().toLowerCase();
  if (optIn !== 'true') {
    throw new OfferrStagingGuardError(
      `Refusing to run: ${STAGING_OPT_IN_ENV} is not set to "true". ` +
        'Offerr staging fixtures require an explicit, deliberate opt-in.',
      { label, opt_in_present: Boolean(optIn) },
    );
  }

  // ── 1b. Runtime environment designation — absolute refusal ───────────────
  // A staging ref reached from a production runtime is still a production
  // execution. Refuse before any target classification work.
  for (const name of ENVIRONMENT_DESIGNATION_ENVS) {
    const value = String(env?.[name] ?? '').trim().toLowerCase();
    if (value && PRODUCTION_ENVIRONMENT_VALUES.includes(value)) {
      throw new OfferrStagingGuardError(
        `REFUSING TO RUN FROM A PRODUCTION ENVIRONMENT. ${name}="${value}" ` +
          'designates this runtime as production. Offerr staging fixtures and ' +
          'verification must never execute from a production environment, ' +
          'regardless of which database the target points at.',
        { label, environment_var: name, environment_value: value, classification: 'production_environment' },
      );
    }
  }

  // ── 1c. Required staging secrets must all be present ─────────────────────
  // A half-configured run is refused before it can half-apply anything.
  const missingSecrets = (Array.isArray(requiredSecrets) ? requiredSecrets : [])
    .filter((name) => !String(env?.[name] ?? '').trim());
  if (missingSecrets.length > 0) {
    throw new OfferrStagingGuardError(
      `Refusing to run: required staging secret(s) missing or empty: ` +
        `${missingSecrets.join(', ')}. Offerr staging runs fail closed rather ` +
        'than proceeding with partial configuration.',
      { label, missing_secrets: missingSecrets, classification: 'missing_secrets' },
    );
  }

  const projectRef = extractProjectRef(raw);
  const host = safeHost(raw);

  // ── 2. Known production refs — absolute refusal ──────────────────────────
  if (projectRef && PRODUCTION_PROJECT_REFS.includes(projectRef)) {
    throw new OfferrStagingGuardError(
      `REFUSING TO RUN AGAINST PRODUCTION. Project ref "${projectRef}" is the ` +
        'rei-automation PRODUCTION Supabase project. Offerr staging fixtures and ' +
        'verification must never target it under any circumstance.',
      { label, project_ref: projectRef, classification: 'production' },
    );
  }

  // A production ref anywhere in the string (e.g. an embedded pooler host)
  // is also fatal, even if the ref regex did not match the host form.
  for (const prodRef of PRODUCTION_PROJECT_REFS) {
    if (raw.toLowerCase().includes(prodRef)) {
      throw new OfferrStagingGuardError(
        `REFUSING TO RUN AGAINST PRODUCTION. The target string contains the ` +
          `production project ref "${prodRef}".`,
        { label, project_ref: prodRef, classification: 'production' },
      );
    }
  }

  // ── 3. Other products are not rei-automation staging ─────────────────────
  if (projectRef && FOREIGN_PRODUCT_PROJECT_REFS[projectRef]) {
    throw new OfferrStagingGuardError(
      `Refusing to run: project ref "${projectRef}" belongs to ` +
        `${FOREIGN_PRODUCT_PROJECT_REFS[projectRef]}, a different product. ` +
        'Another product\'s project is not a valid Offerr staging target.',
      { label, project_ref: projectRef, classification: 'foreign_product' },
    );
  }

  // ── 4. Classify what remains ─────────────────────────────────────────────
  if (isLocalTarget(raw)) {
    if (!allowLocal) {
      throw new OfferrStagingGuardError(
        'Refusing to run: a local target was supplied but allowLocal is false.',
        { label, classification: 'local' },
      );
    }
    return { ok: true, classification: 'local_container', project_ref: null, target_host: host };
  }

  if (projectRef) {
    // A Supabase project that is neither production nor a known foreign
    // product. Require it to be named explicitly as the staging ref so an
    // unrecognised project can never be adopted by accident.
    const declared = String(env?.OFFERR_STAGING_PROJECT_REF ?? '').trim().toLowerCase();
    if (!declared) {
      throw new OfferrStagingGuardError(
        `Refusing to run: project ref "${projectRef}" is not a recognised Offerr ` +
          'staging project. Set OFFERR_STAGING_PROJECT_REF to the same ref to ' +
          'confirm you have positively identified it as non-production staging.',
        { label, project_ref: projectRef, classification: 'unverified' },
      );
    }
    if (declared !== projectRef) {
      throw new OfferrStagingGuardError(
        `Refusing to run: target project ref "${projectRef}" does not match ` +
          `OFFERR_STAGING_PROJECT_REF ("${declared}").`,
        { label, project_ref: projectRef, classification: 'mismatch' },
      );
    }
    return {
      ok: true,
      classification: 'declared_staging_project',
      project_ref: projectRef,
      target_host: host,
    };
  }

  throw new OfferrStagingGuardError(
    'Refusing to run: the Offerr staging target could not be positively ' +
      'identified as local or as a declared staging Supabase project. ' +
      'Unknown targets are never treated as safe.',
    { label, classification: 'unidentified', target_host: host },
  );
}

/** Host for logging, with any credentials stripped. */
function safeHost(target) {
  const value = String(target ?? '');
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
  } catch {
    return value.replace(/\/\/[^@]*@/, '//***@').slice(0, 120);
  }
}

/** Print the identity block the runbook requires before every staging write. */
export function printTargetIdentity(verdict, extra = {}) {
  const lines = [
    '── Offerr staging target identity ──────────────────────────────',
    `  classification    : ${verdict.classification}`,
    `  project ref       : ${verdict.project_ref ?? '(not a Supabase project)'}`,
    `  target host       : ${verdict.target_host}`,
    `  is production     : NO (guard refuses production refs)`,
    `  opt-in env        : ${STAGING_OPT_IN_ENV}=true`,
  ];
  for (const [k, v] of Object.entries(extra)) {
    lines.push(`  ${k.padEnd(18)}: ${v}`);
  }
  lines.push('────────────────────────────────────────────────────────────────');
  console.log(lines.join('\n'));
}

export default {
  PRODUCTION_PROJECT_REFS,
  FOREIGN_PRODUCT_PROJECT_REFS,
  STAGING_OPT_IN_ENV,
  ENVIRONMENT_DESIGNATION_ENVS,
  PRODUCTION_ENVIRONMENT_VALUES,
  OfferrStagingGuardError,
  extractProjectRef,
  isLocalTarget,
  assertOfferrStagingTarget,
  printTargetIdentity,
};
