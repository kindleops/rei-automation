import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

function clean(value) {
  return String(value ?? '').trim()
}

function readGitSha(cwd) {
  try {
    return clean(execSync('git rev-parse HEAD', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch {
    return null
  }
}

function readGitBranch(cwd) {
  try {
    return clean(execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch {
    return null
  }
}

function worktreeFingerprint(cwd) {
  const normalized = path.resolve(cwd)
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12)
}

function resolveRepoRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir)
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return path.resolve(startDir)
}

export function buildRuntimeIdentity({
  appName = 'nexus-api',
  cwd = process.cwd(),
  port = null,
  buildTimestamp = null,
} = {}) {
  const repoRoot = resolveRepoRoot(cwd)
  const environment = clean(process.env.NODE_ENV) || 'development'
  const commitSha = readGitSha(repoRoot) || clean(process.env.VERCEL_GIT_COMMIT_SHA) || 'unknown'
  const branch = readGitBranch(repoRoot) || clean(process.env.VERCEL_GIT_COMMIT_REF) || 'unknown'
  const apiPort = port ?? Number(process.env.PORT || 3000)

  return {
    ok: true,
    app_name: appName,
    branch,
    commit_sha: commitSha,
    worktree_id: worktreeFingerprint(repoRoot),
    build_timestamp: buildTimestamp || clean(process.env.BUILD_TIMESTAMP) || new Date().toISOString(),
    environment,
    api_port: Number.isFinite(apiPort) ? apiPort : 3000,
    is_development: environment !== 'production',
  }
}

export function isRuntimeIdentityExposed() {
  return clean(process.env.NODE_ENV) !== 'production'
}