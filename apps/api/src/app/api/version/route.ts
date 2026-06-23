import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    service: 'api',
    project: process.env.VERCEL_PROJECT_NAME || 'rei-automation-api',
    commit: process.env.VERCEL_GIT_COMMIT_SHA || 'local',
    env: process.env.VERCEL_ENV || 'development',
    timestamp: new Date().toISOString(),
  });
}
