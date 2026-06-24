#!/usr/bin/env node
/**
 * Start dev-all in a fully detached session (immune to agent shell teardown).
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOCK_DIR = path.join(ROOT, '.dev-all')
const LOG_FILE = path.join(LOCK_DIR, 'supervisor.log')
const PID_FILE = path.join(LOCK_DIR, 'supervisor.pid')

fs.mkdirSync(LOCK_DIR, { recursive: true })
const logFd = fs.openSync(LOG_FILE, 'a')

const child = spawn(process.execPath, ['scripts/dev-all.mjs'], {
  cwd: ROOT,
  detached: true,
  stdio: ['ignore', logFd, logFd],
  env: process.env,
})

child.unref()
fs.writeFileSync(PID_FILE, `${child.pid}\n`)
console.log(`[start-dev-all-detached] supervisor pid=${child.pid} log=${LOG_FILE}`)