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

// ── Preview-branch guard ───────────────────────────────────────────────────
// Under the one-project architecture the parent project's DEFAULT branch IS
// production, so "the target is a Supabase branch" is not a safety property.
// These cases inject the branch list, so they assert the guard's logic without
// touching the network.

import {
  assertOfferrPreviewBranch,
  OfferrPreviewBranchGuardError,
  CANONICAL_PARENT_PROJECT_REF,
} from '../../scripts/offerr/offerr-preview-branch-guard.mjs';

const PREVIEW_REF = 'ktvjkokwcqcgapzztkwu';
const PREVIEW_TARGET = `postgresql://postgres:pw@db.${PREVIEW_REF}.supabase.co:5432/postgres`;

const branchList = () => ([
  { id: 'b-default', name: 'main', project_ref: CANONICAL_PARENT_PROJECT_REF, is_default: true, persistent: true, status: 'MIGRATIONS_FAILED' },
  { id: 'b-preview', name: 'offerr-evaluation-spine-pr-57', project_ref: PREVIEW_REF, is_default: false, persistent: false, status: 'MIGRATIONS_FAILED' },
]);

const previewEnv = {
  [STAGING_OPT_IN_ENV]: 'true',
  OFFERR_STAGING_PROJECT_REF: PREVIEW_REF,
};

test('a genuine preview branch of the canonical parent is accepted', async () => {
  const identity = await assertOfferrPreviewBranch({
    target: PREVIEW_TARGET, env: previewEnv, listBranches: async () => branchList(),
  });
  assert.equal(identity.ok, true);
  assert.equal(identity.project_ref, PREVIEW_REF);
  assert.equal(identity.branch_name, 'offerr-evaluation-spine-pr-57');
  assert.equal(identity.parent_ref, CANONICAL_PARENT_PROJECT_REF);
  assert.equal(identity.persistent, false);
});

test('the parent project itself is refused as production', async () => {
  await assert.rejects(
    assertOfferrPreviewBranch({
      target: `postgresql://postgres:pw@db.${CANONICAL_PARENT_PROJECT_REF}.supabase.co:5432/postgres`,
      env: { ...previewEnv, OFFERR_STAGING_PROJECT_REF: CANONICAL_PARENT_PROJECT_REF },
      listBranches: async () => branchList(),
    }),
    (error) => /PRODUCTION/i.test(error.message),
  );
});

test('the parent DEFAULT branch is refused even when reached by its own ref', async () => {
  // Distinct from the production-ref check: this asserts the is_default branch
  // of the control-plane listing is rejected on its own merits.
  const defaultBranchRef = 'aaaaaaaaaaaaaaaaaaaa';
  await assert.rejects(
    assertOfferrPreviewBranch({
      target: `postgresql://postgres:pw@db.${defaultBranchRef}.supabase.co:5432/postgres`,
      env: { ...previewEnv, OFFERR_STAGING_PROJECT_REF: defaultBranchRef },
      listBranches: async () => ([
        { id: 'b1', name: 'main', project_ref: defaultBranchRef, is_default: true, persistent: true, status: 'OK' },
      ]),
    }),
    (error) => error instanceof OfferrPreviewBranchGuardError
      && error.details.classification === 'default_branch',
  );
});

test('a real project that is not a branch of the parent is refused', async () => {
  const strangerRef = 'bbbbbbbbbbbbbbbbbbbb';
  await assert.rejects(
    assertOfferrPreviewBranch({
      target: `postgresql://postgres:pw@db.${strangerRef}.supabase.co:5432/postgres`,
      env: { ...previewEnv, OFFERR_STAGING_PROJECT_REF: strangerRef },
      listBranches: async () => branchList(),
    }),
    (error) => error.details.classification === 'not_a_branch_of_parent',
  );
});

test('an unresolvable control plane fails closed rather than open', async () => {
  await assert.rejects(
    assertOfferrPreviewBranch({
      target: PREVIEW_TARGET, env: previewEnv,
      listBranches: async () => { throw new OfferrPreviewBranchGuardError('boom', { classification: 'identity_unresolvable' }); },
    }),
    (error) => error.details.classification === 'identity_unresolvable',
  );
});

test('preview-branch guard still requires the staging opt-in and refuses local targets', async () => {
  await assert.rejects(
    assertOfferrPreviewBranch({
      target: PREVIEW_TARGET, env: { OFFERR_STAGING_PROJECT_REF: PREVIEW_REF },
      listBranches: async () => branchList(),
    }),
    (error) => new RegExp(STAGING_OPT_IN_ENV).test(error.message),
  );
  await assert.rejects(
    assertOfferrPreviewBranch({
      target: 'postgresql://postgres@127.0.0.1:5432/db', env: previewEnv,
      listBranches: async () => branchList(),
    }),
    (error) => /allowLocal is false/.test(error.message),
  );
});
