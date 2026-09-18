/**
 * WHO DO WE ACTUALLY HAVE A NUMBER FOR? (§6, §7)
 *
 * The outreach destination is resolved HERE, server-side, from
 * `buyer_contacts_v2` — never from the request body. That is not defensive
 * style, it is the rule the brief states outright: a client must not be able to
 * name the recipient of a real SMS. The old `send-buyer-blast.js` took its
 * numbers from a Podio-sourced `top_candidates[].phones` blob handed in by the
 * caller, which is precisely the shape that lets a stale payload text a stranger.
 *
 * WHAT THE PRODUCTION DATA SAYS TODAY (measured 2026-09-18, not assumed):
 *
 *   public.buyer_entities_v2        26,390 rows
 *   contact_enrichment_status       'not_started' on 26,390 of 26,390
 *   public.buyer_contacts_v2        0 rows
 *
 * So no buyer in production currently has a reachable phone number. The honest
 * consequence is that preflight reports every selected buyer as
 * `no_contact_on_record` and nothing can be queued — which is the correct
 * product behaviour, and is why the outreach sheet is built to show blocked
 * reasons rather than a Send button that would need a fabricated recipient to
 * mean anything. Buyer contact enrichment is the missing capability; this
 * module is the seam it will fill, and the moment it does, outreach works with
 * no further change here.
 */
import { supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { normalizePhone } from "@/lib/providers/textgrid.js";

const CONTACTS_TABLE = "buyer_contacts_v2";

const clean = (value) => String(value ?? "").trim();

/**
 * Best contact per buyer: verified before unverified, primary before secondary,
 * higher confidence before lower. A do-not-contact row is NOT skipped over in
 * favour of a second number for the same buyer — the flag is about the buyer's
 * wishes, not about that one row.
 */
function rankContact(row) {
  return (
    (row.is_verified === true ? 100 : 0) +
    (row.is_primary === true ? 50 : 0) +
    Math.max(0, Math.min(25, Number(row.confidence_score) || 0))
  );
}

export function chooseBuyerContact(rows = []) {
  const usable = rows.filter((row) => normalizePhone(row.phone_e164 ?? row.phone));
  if (usable.length === 0) return null;
  if (usable.some((row) => row.do_not_contact === true)) {
    return { do_not_contact: true, phone: null };
  }
  const best = [...usable].sort((a, b) => rankContact(b) - rankContact(a))[0];
  return {
    do_not_contact: false,
    phone: normalizePhone(best.phone_e164 ?? best.phone),
    contact_name: clean(best.contact_name) || null,
    contact_id: best.id ?? null,
  };
}

/**
 * Attach a resolved destination to each selected buyer.
 *
 * Buyers with no number come back carrying `blocked_reason` so the operator is
 * told which of their selection is unreachable and why, rather than watching
 * the count silently shrink (§20).
 */
export async function resolveBuyerContacts(buyers = [], deps = {}) {
  const db = deps.supabase || defaultSupabase;
  const keys = [...new Set(buyers.map((b) => clean(b.buyer_key)).filter(Boolean))];
  if (keys.length === 0) return { ok: true, buyers: [] };

  let rows = [];
  try {
    if (typeof deps.loadBuyerContacts === "function") {
      rows = (await deps.loadBuyerContacts(keys)) || [];
    } else {
      const { data, error } = await db
        .from(CONTACTS_TABLE)
        .select("id,buyer_key,contact_name,phone,phone_e164,is_primary,is_verified,confidence_score,do_not_contact")
        .in("buyer_key", keys);
      if (error) throw error;
      rows = data || [];
    }
  } catch (error) {
    // Unreadable contact data is not permission to guess a number.
    return { ok: false, reason: "buyer_contacts_unreadable", detail: error?.message || null, buyers: [] };
  }

  const byKey = new Map();
  for (const row of rows) {
    const key = clean(row.buyer_key);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }

  return {
    ok: true,
    buyers: buyers.map((buyer) => {
      const key = clean(buyer.buyer_key);
      const contact = chooseBuyerContact(byKey.get(key) || []);

      // Anything the caller sent as a destination is discarded on purpose.
      const { to_phone_number: _ignored, phone: _ignored2, ...rest } = buyer;

      if (!contact) return { ...rest, buyer_key: key, to_phone_number: null, blocked_reason: "no_contact_on_record" };
      if (contact.do_not_contact) {
        return { ...rest, buyer_key: key, to_phone_number: null, blocked_reason: "buyer_do_not_contact" };
      }
      return { ...rest, buyer_key: key, to_phone_number: contact.phone, contact_name: contact.contact_name };
    }),
  };
}
