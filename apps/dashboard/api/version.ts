export default function handler(_req: unknown, res: {
  status: (code: number) => { json: (body: Record<string, unknown>) => void }
}) {
  const commitSha = process.env.VERCEL_GIT_COMMIT_SHA
    || process.env.VITE_COMMIT_SHA
    || process.env.GIT_COMMIT_SHA
    || 'unknown'

  res.status(200).json({
    service: 'dashboard',
    project: process.env.VERCEL_PROJECT_NAME || 'dashboard',
    commit: commitSha,
    commit_short: commitSha === 'unknown' ? commitSha : commitSha.slice(0, 12),
    deployment_id: process.env.VERCEL_DEPLOYMENT_ID || 'unknown',
    env: process.env.VERCEL_ENV || 'development',
    build_time: process.env.VITE_BUILD_TIME || null,
    timestamp: new Date().toISOString(),
  })
}