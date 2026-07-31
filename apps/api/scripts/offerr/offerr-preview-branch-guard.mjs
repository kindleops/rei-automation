/**
 * Offerr preview-branch guard — positive proof of Supabase preview-branch
 * identity before any hosted write.
 *
 * WHY THIS EXISTS ON TOP OF offerr-staging-guard.mjs
 * --------------------------------------------------
 * `offerr-staging-guard.mjs` answers "is this target definitely not production,
 * not another product, and explicitly opted into?". That is necessary but not
 * sufficient once the canonical architecture is ONE permanent Supabase project
 * with temporary preview branches inside it:
 *
 *   - A Supabase preview branch has its OWN project ref. The staging guard can
 *     only be told that ref is safe (OFFERR_STAGING_PROJECT_REF); it cannot
 *     prove it.
 *   - A typo'd or stale ref that happens to be a real project would satisfy the
 *     staging guard while pointing somewhere nobody intended.
 *   - The parent project's DEFAULT branch IS production. It is a branch, so
 *     "is a branch" is not by itself a safety property.
 *
 * This guard closes that gap by asking Supabase itself: the target ref must
 * appear in the parent project's branch list AND must not be the default
 * branch. Identity is proven against the control plane, not asserted by env.
 *
 * Refusal classes (all fail closed):
 *   1. The underlying staging guard refuses (production ref, foreign product,
 *      missing opt-in, production runtime designation, missing secrets,
 *      unidentified target).
 *   2. The target ref equals the parent/production project ref.
 *   3. The target ref is the parent's DEFAULT branch (i.e. production).
 *   4. The target ref is not present in the parent's branch list at all.
 *   5. Preview identity cannot be resolved (no CLI, API error, no parent ref).
 *
 * Usage (module):
 *   const identity = await assertOfferrPreviewBranch({ target: process.env.OFFERR_STAGING_DB_URL });
 *
 * Usage (CLI — prints the identity block the runbook requires, exits non-zero
 * on refusal):
 *   node apps/api/scripts/offerr/offerr-preview-branch-guard.mjs
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  assertOfferrStagingTarget,
  extractProjectRef,
  OfferrStagingGuardError,
  PRODUCTION_PROJECT_REFS,
} from './offerr-staging-guard.mjs';

const execFileAsync = promisify(execFile);

/**
 * The canonical parent project. Preview branches are only ever created inside
 * it, so a branch that does not belong to it is not an Offerr preview branch.
 */
export const CANONICAL_PARENT_PROJECT_REF = 'lcppdrmrdfblstpcbgpf';
export const CANONICAL_PARENT_PROJECT_NAME = 'real-estate-automation';

export class OfferrPreviewBranchGuardError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'OfferrPreviewBranchGuardError';
    this.details = details;
  }
}

/**
 * List the parent project's Supabase branches via the CLI.
 * Returns [{ id, name, project_ref, is_default, persistent, status }].
 */
export async function listParentBranches({
  parentRef = CANONICAL_PARENT_PROJECT_REF,
  exec = execFileAsync,
} = {}) {
  let stdout;
  try {
    ({ stdout } = await exec(
      'supabase',
      ['branches', 'list', '--project-ref', parentRef, '-o', 'json'],
      { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
    ));
  } catch (error) {
    throw new OfferrPreviewBranchGuardError(
      'Refusing to run: could not resolve preview-branch identity from the ' +
        `Supabase control plane (${error.shortMessage ?? error.message}). ` +
        'Unverifiable identity is never treated as safe.',
      { classification: 'identity_unresolvable', parent_ref: parentRef },
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new OfferrPreviewBranchGuardError(
      'Refusing to run: the Supabase branch list was not valid JSON, so preview ' +
        'identity could not be proven.',
      { classification: 'identity_unresolvable', parent_ref: parentRef },
    );
  }

  if (!Array.isArray(parsed)) {
    throw new OfferrPreviewBranchGuardError(
      'Refusing to run: unexpected Supabase branch-list shape.',
      { classification: 'identity_unresolvable', parent_ref: parentRef },
    );
  }
  return parsed;
}

/**
 * Assert `target` resolves to a NON-DEFAULT preview branch of the canonical
 * parent project. Throws on every failure path.
 *
 * @returns {Promise<{ok:true, project_ref:string, branch_id:string,
 *   branch_name:string, parent_ref:string, persistent:boolean, status:string}>}
 */
export async function assertOfferrPreviewBranch({
  target,
  env = process.env,
  label = 'offerr-preview-branch',
  requiredSecrets = [],
  parentRef = CANONICAL_PARENT_PROJECT_REF,
  listBranches = listParentBranches,
} = {}) {
  // ── 1. The existing staging guard runs first and unchanged ───────────────
  const staging = assertOfferrStagingTarget({
    target,
    env,
    label,
    allowLocal: false, // a preview branch is never local
    requiredSecrets,
  });

  const projectRef = staging.project_ref ?? extractProjectRef(target);
  if (!projectRef) {
    throw new OfferrPreviewBranchGuardError(
      'Refusing to run: no Supabase project ref could be extracted from the ' +
        'target, so it cannot be proven to be a preview branch.',
      { label, classification: 'identity_unresolvable' },
    );
  }

  // ── 2. Never the parent/production project itself ────────────────────────
  if (projectRef === parentRef || PRODUCTION_PROJECT_REFS.includes(projectRef)) {
    throw new OfferrPreviewBranchGuardError(
      `REFUSING TO RUN AGAINST PRODUCTION. "${projectRef}" is the canonical ` +
        'parent project, not a preview branch.',
      { label, project_ref: projectRef, classification: 'parent_project' },
    );
  }

  // ── 3. Prove membership against the control plane ────────────────────────
  const branches = await listBranches({ parentRef });
  const match = branches.find((b) => b?.project_ref === projectRef);

  if (!match) {
    throw new OfferrPreviewBranchGuardError(
      `Refusing to run: project ref "${projectRef}" is not a branch of the ` +
        `canonical parent project ${CANONICAL_PARENT_PROJECT_NAME} (${parentRef}). ` +
        'Offerr preview verification only ever targets a branch of that project.',
      { label, project_ref: projectRef, classification: 'not_a_branch_of_parent' },
    );
  }

  // ── 4. The default branch IS production ──────────────────────────────────
  if (match.is_default === true) {
    throw new OfferrPreviewBranchGuardError(
      `REFUSING TO RUN AGAINST THE PRODUCTION BRANCH. "${projectRef}" ` +
        `(${match.name}) is the DEFAULT branch of ${parentRef}.`,
      { label, project_ref: projectRef, classification: 'default_branch' },
    );
  }

  return {
    ok: true,
    project_ref: projectRef,
    branch_id: match.id,
    branch_name: match.name,
    parent_ref: parentRef,
    persistent: Boolean(match.persistent),
    status: match.status ?? 'UNKNOWN',
    target_host: staging.target_host,
  };
}

/** The identity block the runbook requires before every hosted write. */
export function printPreviewIdentity(identity, extra = {}) {
  const lines = [
    '── Offerr preview-branch target identity ───────────────────────',
    `  parent project     : ${CANONICAL_PARENT_PROJECT_NAME}`,
    `  parent project ref : ${identity.parent_ref}`,
    `  branch name        : ${identity.branch_name}`,
    `  branch id          : ${identity.branch_id}`,
    `  PREVIEW branch ref : ${identity.project_ref}`,
    `  target host        : ${identity.target_host}`,
    `  is preview branch  : YES (present in parent branch list, is_default=false)`,
    `  is default branch  : NO`,
    `  persistent         : ${identity.persistent ? 'yes' : 'no (ephemeral)'}`,
    `  branch status      : ${identity.status}`,
    `  != lcppdrmrdfblstpcbgpf (production) : confirmed`,
    `  != wwqqwllstapdolkndzzx (ReivestiExchange) : confirmed`,
    `  != lvocccmhnyfoyqnbmmci (SignPro) : confirmed`,
  ];
  for (const [k, v] of Object.entries(extra)) {
    lines.push(`  ${k.padEnd(18)} : ${v}`);
  }
  lines.push('────────────────────────────────────────────────────────────────');
  console.log(lines.join('\n'));
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isDirectRun =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isDirectRun) {
  const target =
    process.env.OFFERR_STAGING_DB_URL ??
    process.env.OFFERR_STAGING_DATABASE_URL ??
    process.env.SUPABASE_URL;

  try {
    const identity = await assertOfferrPreviewBranch({ target });
    printPreviewIdentity(identity, { invoked_as: 'offerr-preview-branch-guard CLI' });
    console.log('PREVIEW BRANCH IDENTITY PROVEN — safe to proceed.');
  } catch (error) {
    if (
      error instanceof OfferrPreviewBranchGuardError ||
      error instanceof OfferrStagingGuardError
    ) {
      console.error(`\n${error.name}: ${error.message}`);
      console.error(`details: ${JSON.stringify(error.details ?? {})}`);
      process.exit(2);
    }
    throw error;
  }
}

export default {
  CANONICAL_PARENT_PROJECT_REF,
  CANONICAL_PARENT_PROJECT_NAME,
  OfferrPreviewBranchGuardError,
  listParentBranches,
  assertOfferrPreviewBranch,
  printPreviewIdentity,
};
