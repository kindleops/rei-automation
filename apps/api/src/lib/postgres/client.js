import pg from "pg";

import { resolveDatabaseUrl } from "./resolve-database-url.js";

const { Pool } = pg;

let pool = null;

function clean(value) {
  return String(value ?? "").trim();
}

export function getDatabaseUrl() {
  return resolveDatabaseUrl();
}

export function hasDatabaseUrl() {
  return Boolean(getDatabaseUrl());
}

export function getPgPool() {
  if (pool) return pool;
  const connectionString = getDatabaseUrl();
  if (!connectionString) {
    throw new Error("database_url_missing");
  }
  pool = new Pool({
    connectionString,
    ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false },
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  return pool;
}

export async function queryWithTimeout(sql, params = [], timeoutMs = 30_000) {
  const client = await getPgPool().connect();
  try {
    await client.query(`SET statement_timeout = ${Math.trunc(timeoutMs)}`);
    const result = await client.query(sql, params);
    return result;
  } finally {
    client.release();
  }
}