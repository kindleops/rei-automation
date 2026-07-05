#!/usr/bin/env node
/**
 * Idempotent rebuild of map_filter_property_prospect_links from canonical JSON.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, "../..");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (!match) continue;
    out[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = {
  ...loadEnvFile(path.join(apiRoot, ".env.local")),
  ...loadEnvFile(path.join(apiRoot, ".env")),
  ...process.env,
};
for (const [key, value] of Object.entries(env)) {
  if (value && !process.env[key]) process.env[key] = value;
}

const { queryWithTimeout } = await import("../../src/lib/postgres/client.js");

const result = await queryWithTimeout("SELECT public.rebuild_map_filter_property_prospect_links() AS stats", [], 600_000);
console.log(JSON.stringify(result.rows[0]?.stats || {}, null, 2));