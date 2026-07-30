/**
 * Offerr staging guard — refusal-matrix regression tests.
 *
 * The guard is the only thing standing between a fixture run and a production
 * database, so every refusal branch is asserted explicitly. A guard that
 * silently starts returning ok is the single worst regression in this feature.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PRODUCTION_PROJECT_REFS,
  FOREIGN_PRODUCT_PROJECT_REFS,
  STAGING_OPT_IN_ENV,
  ENVIRONMENT_DESIGNATION_ENVS,
  OfferrStagingGuardError,
  extractProjectRef,
  isLocalTarget,
  assertOfferrStagingTarget,
} from '../../scripts/offerr/offerr-staging-guard.mjs';

const PROD_REF = 'lcppdrmrdfblstpcbgpf';
const LOCAL_TARGET = 'postgresql://postgres:pw@127.0.0.1:55432/offerr_verify';
const STAGING_REF = 'abcdefghijklmnopqrst';
const STAGING_TARGET = `postgresql://postgres:pw@db.${STAGING_REF}.supabase.co:5432/postgres`;

/** Minimal env that would otherwise pass, so each test isolates one refusal. */
function okEnv(extra = {}) {
  return { [STAGING_OPT_IN_ENV]: 'true', ...extra };
}

function refusal(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(
      error instanceof OfferrStagingGuardError,
      `expected OfferrStagingGuardError, got ${error?.name}: ${error?.message}`,
    );
    return error;
  }
  assert.fail('guard returned ok where it must have refused');
}

test('the production ref is registered and refused outright', () => {
  assert.ok(PRODUCTION_PROJECT_REFS.includes(PROD_REF));

  const error = refusal(() =>
    assertOfferrStagingTarget({
      target: `postgresql://postgres:pw@db.${PROD_REF}.supabase.co:5432/postgres`,
      env: okEnv({ OFFERR_STAGING_PROJECT_REF: PROD_REF }),
    }),
  );
  assert.equal(error.details.classification, 'production');
  assert.match(error.message, /REFUSING TO RUN AGAINST PRODUCTION/);
});

test('a production ref embedded in a pooler host is still refused', () => {
  const error = refusal(() =>
    assertOfferrStagingTarget({
      target: `postgresql://postgres.${PROD_REF}:pw@aws-0-us-west-1.pooler.supabase.com:6543/postgres`,
      env: okEnv(),
    }),
  );
  assert.equal(error.details.classification, 'production');
});

test('other products are not valid Offerr staging targets', () => {
  for (const [ref, product] of Object.entries(FOREIGN_PRODUCT_PROJECT_REFS)) {
    const error = refusal(() =>
      assertOfferrStagingTarget({
        target: `https://${ref}.supabase.co`,
        env: okEnv({ OFFERR_STAGING_PROJECT_REF: ref }),
      }),
    );
    assert.equal(error.details.classification, 'foreign_product');
    assert.match(error.message, new RegExp(product));
  }
});

test('a missing opt-in refuses even a perfectly safe local target', () => {
  const error = refusal(() =>
    assertOfferrStagingTarget({ target: LOCAL_TARGET, env: {} }),
  );
  assert.match(error.message, new RegExp(STAGING_OPT_IN_ENV));
});

test('opt-in must be exactly "true", not merely present', () => {
  for (const value of ['1', 'yes', 'TRUE ', 'false', '']) {
    if (value.trim().toLowerCase() === 'true') continue;
    refusal(() =>
      assertOfferrStagingTarget({
        target: LOCAL_TARGET,
        env: { [STAGING_OPT_IN_ENV]: value },
      }),
    );
  }
});

test('every production environment designation is refused, even on a local target', () => {
  for (const name of ENVIRONMENT_DESIGNATION_ENVS) {
    for (const value of ['production', 'PROD', 'Live']) {
      const error = refusal(() =>
        assertOfferrStagingTarget({
          target: LOCAL_TARGET,
          env: okEnv({ [name]: value }),
        }),
      );
      assert.equal(error.details.classification, 'production_environment');
      assert.equal(error.details.environment_var, name);
    }
  }
});

test('non-production environment designations do not block a safe run', () => {
  const verdict = assertOfferrStagingTarget({
    target: LOCAL_TARGET,
    env: okEnv({ NODE_ENV: 'test', VERCEL_ENV: 'preview', APP_ENV: 'staging' }),
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.classification, 'local_container');
});

test('declared-required secrets must be present and non-empty', () => {
  const error = refusal(() =>
    assertOfferrStagingTarget({
      target: LOCAL_TARGET,
      env: okEnv({ PRESENT_SECRET: 'x', BLANK_SECRET: '   ' }),
      requiredSecrets: ['PRESENT_SECRET', 'BLANK_SECRET', 'ABSENT_SECRET'],
    }),
  );
  assert.equal(error.details.classification, 'missing_secrets');
  assert.deepEqual(error.details.missing_secrets, ['BLANK_SECRET', 'ABSENT_SECRET']);
});

test('satisfied required secrets allow the run to proceed', () => {
  const verdict = assertOfferrStagingTarget({
    target: LOCAL_TARGET,
    env: okEnv({ INTERNAL_API_SECRET: 'staging-secret' }),
    requiredSecrets: ['INTERNAL_API_SECRET'],
  });
  assert.equal(verdict.ok, true);
});

test('an empty target is refused rather than defaulted', () => {
  refusal(() => assertOfferrStagingTarget({ target: '', env: okEnv() }));
  refusal(() => assertOfferrStagingTarget({ target: undefined, env: okEnv() }));
});

test('an unrecognised Supabase project is refused until declared', () => {
  const error = refusal(() =>
    assertOfferrStagingTarget({ target: STAGING_TARGET, env: okEnv() }),
  );
  assert.equal(error.details.classification, 'unverified');
});

test('a declared ref that does not match the target is refused', () => {
  const error = refusal(() =>
    assertOfferrStagingTarget({
      target: STAGING_TARGET,
      env: okEnv({ OFFERR_STAGING_PROJECT_REF: 'tsrqponmlkjihgfedcba' }),
    }),
  );
  assert.equal(error.details.classification, 'mismatch');
});

test('a positively declared staging project is accepted', () => {
  const verdict = assertOfferrStagingTarget({
    target: STAGING_TARGET,
    env: okEnv({ OFFERR_STAGING_PROJECT_REF: STAGING_REF }),
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.classification, 'declared_staging_project');
  assert.equal(verdict.project_ref, STAGING_REF);
  assert.ok(!verdict.target_host.includes('pw'), 'credentials must not leak into logs');
});

test('a non-Supabase, non-local host is refused as unidentified', () => {
  const error = refusal(() =>
    assertOfferrStagingTarget({
      target: 'postgresql://postgres:pw@db.internal.example.com:5432/postgres',
      env: okEnv(),
    }),
  );
  assert.equal(error.details.classification, 'unidentified');
});

test('allowLocal=false refuses a local target', () => {
  const error = refusal(() =>
    assertOfferrStagingTarget({ target: LOCAL_TARGET, env: okEnv(), allowLocal: false }),
  );
  assert.equal(error.details.classification, 'local');
});

test('extractProjectRef and isLocalTarget behave as the guard assumes', () => {
  assert.equal(extractProjectRef(`https://${STAGING_REF}.supabase.co`), STAGING_REF);
  assert.equal(extractProjectRef(STAGING_TARGET), STAGING_REF);
  assert.equal(extractProjectRef('postgresql://postgres@127.0.0.1:5432/db'), null);

  assert.equal(isLocalTarget(LOCAL_TARGET), true);
  assert.equal(isLocalTarget('postgresql://u@localhost/db'), true);
  assert.equal(isLocalTarget(STAGING_TARGET), false);
});
