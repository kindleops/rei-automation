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
    env: resolveDeploymentEnv(),
    provider: resolveDeploymentProvider(),
    deployment_id: resolveDeploymentId(),
    hostname: resolveDeploymentHostname(),
    build_timestamp: resolveDeployBuildTimestamp(),
    reconcile_lifecycle_version: QUEUE_RECONCILE_LIFECYCLE_VERSION,
    timestamp: new Date().toISOString(),
  });
}