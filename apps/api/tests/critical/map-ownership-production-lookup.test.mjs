import assert from "node:assert/strict";
import https from "node:https";
import test from "node:test";

const PRODUCTION_PROJECT_REF = "lcppdrmrdfblstpcbgpf";
const MASTER_OWNER_SELECT =
  "master_owner_id,best_phone_1,primary_phone_id,display_name,best_language,agent_persona,agent_family";
const PHONE_SELECT =
  "phone_id,master_owner_id,canonical_e164,canonical_prospect_id,primary_prospect_id,linked_prospect_ids_json";

function productionSupabaseUrl() {
  const explicit = String(process.env.SUPABASE_URL || "").trim();
  if (explicit.includes(PRODUCTION_PROJECT_REF)) return explicit;
  const vite = String(process.env.VITE_SUPABASE_URL || "").trim();
  if (vite.includes(PRODUCTION_PROJECT_REF)) return vite;
  return "";
}

function productionAnonKey() {
  return (
    String(process.env.SUPABASE_ANON_KEY || "").trim() ||
    String(process.env.VITE_SUPABASE_ANON_KEY || "").trim()
  );
}

function productionGet(path, headers) {
  const base = productionSupabaseUrl().replace(/\/$/, "");
  const url = new URL(`${base}${path}`);
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: "GET", headers },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const supabaseUrl = productionSupabaseUrl();
const supabaseKey = productionAnonKey();
const canRunLiveLookup = Boolean(supabaseUrl && supabaseKey);

test(
  "production read-only lookup executes canonical owner/phone selects",
  { skip: !canRunLiveLookup },
  async () => {
    const headers = {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
    };

    const ownerRes = await productionGet(
      `/rest/v1/master_owners?select=${encodeURIComponent(MASTER_OWNER_SELECT)}&limit=1`,
      headers,
    );
    assert.equal(ownerRes.status, 200, ownerRes.body);
    const owners = JSON.parse(ownerRes.body);
    assert.ok(Array.isArray(owners));

    const phoneRes = await productionGet(
      `/rest/v1/phones?select=${encodeURIComponent(PHONE_SELECT)}&limit=1`,
      headers,
    );
    assert.equal(phoneRes.status, 200, phoneRes.body);
    const phones = JSON.parse(phoneRes.body);
    assert.ok(Array.isArray(phones));
  },
);