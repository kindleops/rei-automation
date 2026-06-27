import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';

function resolveDeploySha() {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA;
  if (process.env.DEPLOY_GIT_SHA) return process.env.DEPLOY_GIT_SHA;
  try {
    const fromFile = readFileSync(join(process.cwd(), '.deploy-sha'), 'utf8').trim();
    if (fromFile && fromFile !== 'unknown') return fromFile;
  } catch {
    // fall through
  }
  return 'local';
}

export async function GET() {
  const commit = resolveDeploySha();
  return NextResponse.json({
    service: 'api',
    project: process.env.VERCEL_PROJECT_NAME || 'rei-automation-api',
    commit,
    env: process.env.VERCEL_ENV || 'development',
    deployment_id: process.env.VERCEL_DEPLOYMENT_ID || null,
    timestamp: new Date().toISOString(),
  });
}