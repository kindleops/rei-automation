/**
 * Shared helpers for the Sender Routing 2.0 ops scripts. READ-ONLY by
 * construction: the Supabase client is wrapped so insert / update / upsert /
 * delete / rpc throw before any request is made. The TextGrid read is a GET of
 * IncomingPhoneNumbers only (no POST, no number configuration).
 */
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

const WRITE_METHODS = new Set(["insert", "update", "upsert", "delete"]);

export function readOnlyClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing (.env.local)");
  const sb = createClient(url, key, { auth: { persistSession: false } });
  return new Proxy(sb, {
    get(target, prop) {
      if (prop === "rpc") return () => { throw new Error("read-only script: rpc refused"); };
      if (prop !== "from") return Reflect.get(target, prop);
      return (table) => {
        const builder = target.from(table);
        return new Proxy(builder, {
          get(b, method) {
            if (WRITE_METHODS.has(method)) return () => { throw new Error(`read-only script: ${String(method)} on ${table} refused`); };
            const v = Reflect.get(b, method);
            return typeof v === "function" ? v.bind(b) : v;
          },
        });
      };
    },
  });
}

/** TextGrid IncomingPhoneNumbers via GET. null when credentials are absent. */
export async function readTextgridInventory() {
  const sid = process.env.TEXTGRID_ACCOUNT_SID;
  const tok = process.env.TEXTGRID_AUTH_TOKEN;
  if (!sid || !tok) return null;
  const auth = "Basic " + Buffer.from(`${sid}:${tok}`).toString("base64");
  let url = `https://api.textgrid.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PageSize=100`;
  const out = [];
  for (let page = 0; page < 10 && url; page += 1) {
    const res = await fetch(url, { method: "GET", headers: { Authorization: auth } });
    if (!res.ok) throw new Error(`textgrid_inventory_read_failed_${res.status}`);
    const body = await res.json();
    for (const n of body?.incoming_phone_numbers || []) {
      out.push({ phone_number: n.phone_number, friendly_name: n.friendly_name || null, sms_url: n.sms_url || null, campaign: n.campaignId || null, status_callback: n.status_callback || null, provider_status: n.status || null });
    }
    url = body?.next_page_uri ? `https://api.textgrid.com${body.next_page_uri}` : null;
  }
  return out;
}

export async function readAll(sb, table, select, filter = (q) => q) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await filter(sb.from(table).select(select)).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

export function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : true;
}

export function writeOut(file, data) {
  if (!file) return;
  fs.mkdirSync(file.replace(/\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 1));
}

/** The owner's pasted TextGrid console, 2026-10-02 (17 numbers). */
export const OWNER_PASTE_2026_10_02 = Object.freeze((() => {
  const all = ["+12818458577", "+13058975670", "+13173494612", "+13234104544", "+13235589881", "+14693131600", "+14702936385", "+14702936402", "+14704920588", "+16125092382", "+16125092623", "+16128060495", "+17042405818", "+17866052999", "+18138947553", "+19048774448", "+19804589889"];
  const noWebhook = new Set(["+13173494612", "+18138947553"]);
  const noCampaign = new Set(["+14702936385", "+14702936402"]);
  return all.map((phone_number) => ({
    phone_number,
    sms_url: noWebhook.has(phone_number) ? null : "https://ops.leadcommand.ai/api/webhooks/textgrid/inbound",
    campaign: noCampaign.has(phone_number) ? null : "CHM4NL2",
  }));
})());
