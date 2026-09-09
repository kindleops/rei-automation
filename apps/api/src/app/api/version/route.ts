import { NextResponse } from 'next/server';

import {
  resolveDeployBuildTimestamp,
  resolveDeployGitSha,
  resolveDeploymentEnv,
  resolveDeploymentHostname,
  resolveDeploymentId,
  resolveDeploymentProject,
  resolveDeploymentProvider,
} from '@/lib/domain/deploy/resolve-deploy-sha.js';
import { QUEUE_RECONCILE_LIFECYCLE_VERSION } from '@/lib/supabase/sms-engine.js';
// Compiled-in build identity. `commit` below is the ENVIRONMENT's claim about
// what should be running; this is what the loaded bundle actually is. The two
// diverged for ~11 hours on 2026-09-09 while this endpoint reported only the
// former, which is why a stale queue runner was invisible.
import { BUILD_SHA, BUILD_TIMESTAMP } from '@/lib/domain/deploy/build-stamp.generated.js';

// MUST be dynamic. Without this Next statically prerenders the route and bakes
// the build-time environment into the response, so every runtime DEPLOYMENT_*
// value is ignored -- a container would report whatever the CI runner had.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const commit = resolveDeployGitSha();
  return NextResponse.json({
    service: 'api',
    project: resolveDeploymentProject(),
    commit,
    git_sha: commit,
    // What the loaded bundle IS, vs `commit`/`git_sha` above (what the
    // environment claims it should be). build_sha_matches_env === false means a
    // stale or half-rolled container is serving this request.
    build_sha: BUILD_SHA,
    build_sha_matches_env:
      BUILD_SHA !== 'unknown' && Boolean(commit) ? BUILD_SHA === commit : null,
    code_build_timestamp: BUILD_TIMESTAMP,
    env: resolveDeploymentEnv(),
    provider: resolveDeploymentProvider(),
    deployment_id: resolveDeploymentId(),
    hostname: resolveDeploymentHostname(),
    build_timestamp: resolveDeployBuildTimestamp(),
    reconcile_lifecycle_version: QUEUE_RECONCILE_LIFECYCLE_VERSION,
    timestamp: new Date().toISOString(),
  });
}