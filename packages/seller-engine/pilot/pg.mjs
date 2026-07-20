// Ephemeral NON-PRODUCTION Postgres for the one-batch pilot. Two backends:
//  - native: local cluster under var/pilot/pgdata, unix socket only
//  - docker: postgres:16 container bound to 127.0.0.1:5544, data under var/pilot
// Either way: no TCP exposure beyond localhost, no shared credentials,
// structurally incapable of touching production.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PILOT_DIR = join(PKG, 'var', 'pilot');
export const PGDATA = join(PILOT_DIR, 'pgdata');
export const SOCKDIR = join(PILOT_DIR, 'sock');
export const DB = 'seller_pilot';
const CONTAINER = 'seller-pilot-pg';
const PORT = 5544;

let mode = null; // 'native' | 'docker'

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stderr || r.stdout}`);
  }
  return r;
}

const haveNativeServer = () => spawnSync('postgres', ['--version'], { encoding: 'utf8' }).status === 0;

function connArgs(db = DB) {
  return mode === 'native'
    ? ['-h', SOCKDIR, '-d', db]
    : ['-h', '127.0.0.1', '-p', String(PORT), '-U', 'postgres', '-d', db];
}

export function ensureCluster() {
  mkdirSync(PILOT_DIR, { recursive: true });
  if (haveNativeServer()) {
    mode = 'native';
    mkdirSync(SOCKDIR, { recursive: true });
    if (!existsSync(join(PGDATA, 'PG_VERSION'))) {
      mkdirSync(PGDATA, { recursive: true });
      sh('initdb', ['-D', PGDATA, '-E', 'UTF8', '--auth=trust', '--no-instructions']);
    }
    if (sh('pg_ctl', ['-D', PGDATA, 'status'], { allowFail: true }).status !== 0) {
      sh('pg_ctl', ['-D', PGDATA, '-l', join(PILOT_DIR, 'pg.log'), '-w', 'start', '-o',
        `-c listen_addresses='' -k ${SOCKDIR} -c fsync=off -c synchronous_commit=off -c maintenance_work_mem=512MB -c max_wal_size=4GB`]);
    }
  } else {
    mode = 'docker';
    const running = sh('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER], { allowFail: true });
    if (running.stdout?.trim() !== 'true') {
      if (running.status === 0) sh('docker', ['start', CONTAINER]);
      else {
        sh('docker', ['run', '-d', '--name', CONTAINER,
          '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
          '-p', `127.0.0.1:${PORT}:5432`,
          '-v', `${join(PILOT_DIR, 'docker-pgdata')}:/var/lib/postgresql/data`,
          'postgres:16',
          '-c', 'fsync=off', '-c', 'synchronous_commit=off',
          '-c', 'maintenance_work_mem=512MB', '-c', 'max_wal_size=4GB']);
      }
    }
    // wait for readiness
    for (let i = 0; i < 60; i += 1) {
      if (sh('psql', [...connArgs('postgres'), '-Atqc', 'select 1'], { allowFail: true }).stdout?.trim() === '1') break;
      spawnSync('sleep', ['1']);
      if (i === 59) throw new Error('pilot postgres container did not become ready');
    }
  }
  const has = psql(`select 1 from pg_database where datname='${DB}'`, { db: 'postgres', allowFail: true });
  if (!has.includes('1')) {
    psql(`create database ${DB}`, { db: 'postgres' });
  }
  return { mode, db: DB };
}

export function stopCluster() {
  if (mode === 'native') sh('pg_ctl', ['-D', PGDATA, '-m', 'fast', 'stop'], { allowFail: true });
  else sh('docker', ['stop', CONTAINER], { allowFail: true });
}

export function psql(sql, { db = DB, allowFail = false } = {}) {
  if (!mode) ensureCluster();
  const r = sh('psql', [...connArgs(db), '-v', 'ON_ERROR_STOP=1', '-Atq', '-c', sql], { allowFail: true });
  if (r.status !== 0 && !allowFail) throw new Error(`psql failed for: ${sql.slice(0, 200)}…\n${r.stderr}`);
  return (r.stdout ?? '').trim();
}

export function psqlFile(path, { db = DB } = {}) {
  if (!mode) ensureCluster();
  const r = sh('psql', [...connArgs(db), '-v', 'ON_ERROR_STOP=1', '-q', '-f', path], { allowFail: true });
  return { ok: r.status === 0, out: r.stdout, err: r.stderr };
}

export function one(sql) { return psql(sql); }
export function num(sql) { return Number(psql(sql) || 0); }

// COPY csv rows (array of already-CSV-encoded lines) into table via psql stdin.
// Backpressure-aware: wide prospect rows overflow the subprocess socket buffer
// (ENOBUFS) if written without waiting for drain.
export function copyIn(table, columns, csvLines, { db = DB } = {}) {
  if (!mode) ensureCluster();
  return new Promise((resolve, reject) => {
    const p = spawn('psql', [...connArgs(db), '-v', 'ON_ERROR_STOP=1', '-q', '-c',
      `\\copy ${table} (${columns.join(',')}) from pstdin with (format csv)`]);
    let err = '';
    let failed = false;
    p.stderr.on('data', (d) => { err += d; });
    p.stdin.on('error', (e) => { failed = true; reject(new Error(`copy ${table} stdin: ${e.message}`)); });
    p.on('close', (code) => { if (!failed) (code === 0 ? resolve(csvLines.length) : reject(new Error(`copy ${table}: ${err}`))); });
    let i = 0;
    const pump = () => {
      while (i < csvLines.length) {
        if (failed) return;
        const ok = p.stdin.write(csvLines[i++] + '\n');
        if (!ok) { p.stdin.once('drain', pump); return; }
      }
      p.stdin.end();
    };
    pump();
  });
}

// quoted CSV fields legally contain embedded newlines; COPY parses the stream,
// not lines, so no character mangling is needed beyond quote doubling
export const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  return `"${s.replaceAll('"', '""')}"`;
};
export const pgArray = (arr) => {
  if (!Array.isArray(arr) || arr.length === 0) return '{}';
  return `{${arr.map((x) => `"${String(x).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(',')}}`;
};
