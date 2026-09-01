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
    // Commissioning diagnostic. BOOLEANS ONLY -- never a secret value.
    // `supabase_url_is_placeholder` is the decisive bit: true means the
    // Worker -> Container env forwarding did not deliver SUPABASE_URL and the
    // client fell back to https://placeholder.supabase.co, which fails DNS.
    // False with a failing query means the env arrived and the problem is
    // container egress/DNS instead.
    env_probe: {
      supabase_url_present: Boolean(process.env.SUPABASE_URL),
      supabase_url_is_placeholder: String(process.env.SUPABASE_URL || '')
        .includes('placeholder.supabase.co'),
      supabase_service_role_key_present: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      runtime_state_backend: process.env.RUNTIME_STATE_BACKEND || null,
      node_env: process.env.NODE_ENV || null,
    },
    build_timestamp: resolveDeployBuildTimestamp(),
    reconcile_lifecycle_version: QUEUE_RECONCILE_LIFECYCLE_VERSION,
    timestamp: new Date().toISOString(),
  });
}