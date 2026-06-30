const read = (value: unknown, fallback = 'unknown') => {
  const text = String(value ?? '').trim()
  return text && text !== 'local' ? text : fallback
}

export interface BuildIdentity {
  gitSha: string
  gitShaShort: string
  buildTime: string
  deploymentId: string
  project: string
}

export function resolveBuildIdentity(): BuildIdentity {
  const gitSha = read(
    import.meta.env.VITE_COMMIT_SHA,
    read(import.meta.env.VITE_DASHBOARD_GIT_SHA, 'unknown'),
  )
  return {
    gitSha,
    gitShaShort: gitSha === 'unknown' ? gitSha : gitSha.slice(0, 12),
    buildTime: read(import.meta.env.VITE_BUILD_TIME, 'unknown'),
    deploymentId: read(import.meta.env.VITE_DEPLOYMENT_ID, 'unknown'),
    project: read(import.meta.env.VITE_VERCEL_PROJECT, 'dashboard'),
  }
}

export function formatBuildIdentityLine(identity = resolveBuildIdentity()): string {
  return `${identity.gitShaShort} · ${identity.deploymentId} · ${identity.buildTime}`
}