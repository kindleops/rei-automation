// Read-only Postgres access for the round-10 safety scripts (2026-10-08).
// - DATABASE_URL from the environment (never printed).
// - One session: default_transaction_read_only=on, statement_timeout=30s.
// - phoneRef(): a phone is only ever printed as a short salted SHA-256 ref.
// - roSupabase(): the tiny supabase-js subset the canonical
//   cancelSupabasePendingOutbound needs for its DRY RUN (select/eq/in/limit);
//   every write method throws, so the dry run cannot write.
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pg = require("pg");

export async function connectReadOnly() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required (pass it via env; it is never printed)");
    process.exit(2);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("set statement_timeout='30s'; set default_transaction_read_only=on;");
  return client;
}

const SALT = "lc-r10-2026-10-08";
export function phoneRef(phone) {
  const d = String(phone ?? "").replace(/\D/g, "").slice(-10);
  if (!d) return "none";
  return crypto.createHash("sha256").update(`${SALT}:${d}`).digest("hex").slice(0, 12);
}

/** Every stored spelling of one US phone. */
export function phoneVariants(phone) {
  const d = String(phone ?? "").replace(/\D/g, "").slice(-10);
  if (d.length !== 10) return [];
  return [`+1${d}`, `1${d}`, d, `+${"1"}${d}`].filter((v, i, a) => a.indexOf(v) === i);
}

export function e164(phone) {
  const d = String(phone ?? "").replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `+1${d}` : null;
}

export function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

export function writeOut(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/${name}`, body);
}

export const csv = (v) => {
  const t = String(v ?? "");
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

const IDENT = /^[a-z_][a-z0-9_]*$/;
export function roSupabase(client) {
  const deny = () => {
    throw new Error("read-only adapter: writes are not allowed");
  };
  return {
    from(table) {
      if (!IDENT.test(table)) throw new Error("bad table");
      const where = [];
      const params = [];
      let cols = "*";
      let lim = 1000;
      const chain = {
        select(c = "*") {
          cols = c === "*" ? "*" : c.split(",").map((x) => x.trim()).filter((x) => IDENT.test(x)).join(",");
          return chain;
        },
        eq(c, v) {
          if (!IDENT.test(c)) throw new Error("bad column");
          params.push(v);
          where.push(`${c}::text = $${params.length}::text`);
          return chain;
        },
        in(c, vs) {
          if (!IDENT.test(c)) throw new Error("bad column");
          params.push((vs || []).map(String));
          where.push(`${c}::text = any($${params.length}::text[])`);
          return chain;
        },
        limit(n) {
          lim = Math.max(1, Math.min(5000, Number(n) || 1000));
          return chain.then((r) => r);
        },
        update: deny,
        insert: deny,
        upsert: deny,
        delete: deny,
        then(resolve, reject) {
          const sql = `select ${cols} from ${table}${where.length ? ` where ${where.join(" and ")}` : ""} limit ${lim}`;
          return client
            .query(sql, params)
            .then((r) => ({ data: r.rows, error: null }), (e) => ({ data: null, error: e }))
            .then(resolve, reject);
        },
      };
      return chain;
    },
    rpc: deny,
  };
}
