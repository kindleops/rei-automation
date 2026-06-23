export default function handler(req: any, res: any) {
  const commitSha = process.env.VERCEL_GIT_COMMIT_SHA || 'local';
  const projectName = process.env.VERCEL_PROJECT_NAME || 'rei-automation-dashboard';
  const environment = process.env.VERCEL_ENV || 'development';
  
  res.status(200).json({
    service: 'dashboard',
    project: projectName,
    commit: commitSha,
    env: environment,
    timestamp: new Date().toISOString()
  });
}
