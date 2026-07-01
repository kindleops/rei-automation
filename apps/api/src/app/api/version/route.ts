import { NextResponse } from 'next/server';

import {
  resolveDeployBuildTimestamp,
  resolveDeployGitSha,
} from '@/lib/domain/deploy/resolve-deploy-sha.js';
import { QUEUE_RECONCILE_LIFECYCLE_VERSION } from '@/lib/supabase/sms-engine.js';

export async function GET() {
  const commit = resolveDeployGitSha();
  return NextResponse.json({
    service: 'api',
    project: process.env.VERCEL_PROJECT_NAME || 'rei-automation-api',
    commit,
    git_sha: commit,
    env: process.env.VERCEL_ENV || 'development',
    deployment_id: process.env.VERCEL_DEPLOYMENT_ID || null,
    hostname: process.env.VERCEL_URL || null,
    build_timestamp: resolveDeployBuildTimestamp(),
    reconcile_lifecycle_version: QUEUE_RECONCILE_LIFECYCLE_VERSION,
    timestamp: new Date().toISOString(),
  });
}