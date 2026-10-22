#!/usr/bin/env python3
"""Read-only regression measurement for the Entity Graph contact-discovery fix.
Sample: seeded 2,000 campaign_target_graph properties (all states) + seeded 600 'missing_phone' properties.
For each property, build ALL property-phone associations from existing data and classify them; compare with what the
graph currently exposes (campaign_target_graph.canonical_e164). Outputs counts only (no phone numbers).

READ-ONLY. Connection comes from libpq env (PGHOST/PGUSER/PGDATABASE + ~/.pgpass, or PGSERVICE);
no credentials in this file. The session is forced read-only before any query.

  python3 contact_discovery_regression.py --out before.json
  python3 contact_discovery_regression.py --visible-relation public.property_contact_candidates:phone_e164 --out after-YYYYMMDD.json
  python3 contact_discovery_regression.py --compare baseline-20261008.json after-YYYYMMDD.json
"""
import argparse, collections, json, os, re, sys
d10 = lambda p: (re.sub(r"\D", "", p or "")[-10:] or None) if p and len(re.sub(r"\D", "", p)) >= 10 else None


def q(cur, sql, params=None):
    cur.execute(sql, params); cols = [c[0] for c in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def run(cur, label, sample_sql, visible_relation=None):
    props = [r["property_id"] for r in q(cur, sample_sql)]
    graph = collections.defaultdict(set); gmeta = {}
    for r in q(cur, "select property_id, canonical_e164, identity_alignment, queue_block_reason from public.campaign_target_graph where property_id = any(%s)", (props,)):
        if d10(r["canonical_e164"]): graph[r["property_id"]].add(d10(r["canonical_e164"]))
        gmeta[r["property_id"]] = r
    if visible_relation:  # AFTER: what the new read model exposes (schema.relation:phone_column)
        rel, col = visible_relation.split(":")
        if not re.fullmatch(r"[a-z_]+\.[a-z_0-9]+", rel) or not re.fullmatch(r"[a-z_0-9]+", col):
            raise SystemExit("--visible-relation must be schema.relation:phone_column")
        graph = collections.defaultdict(set)
        for r in q(cur, f"select property_id, {col} p from {rel} where property_id = any(%s)", (props,)):
            if d10(r["p"]): graph[r["property_id"]].add(d10(r["p"]))
    res = {r["property_id"]: r for r in q(cur, "select property_id, owner_resolution_status from seller.property_owner_resolution_v1 where property_id = any(%s)", (props,))}
    A = collections.defaultdict(lambda: collections.defaultdict(set))  # prop -> phone -> {evidence}
    for r in q(cur, "select property_id, legal_phone, legal_phone_type, legal_phone_role, reach_phone, reach_phone_role, excluded_vendor_dnc from seller.property_best_contact_v1 where property_id = any(%s)", (props,)):
        if d10(r["legal_phone"]): A[r["property_id"]][d10(r["legal_phone"])].add(f"best_contact_legal:{r['legal_phone_role']}")
        if d10(r["reach_phone"]): A[r["property_id"]][d10(r["reach_phone"])].add(f"best_contact_reach:{r['reach_phone_role']}")
    for r in q(cur, """select trim(x) pid, p.likely_owner, p.likely_renting, p.sms_eligible, p.rank_position, e->>'canonical_e164' e164, e->>'phone_type' ptype
                       from public.prospects p, unnest(string_to_array(p.linked_property_ids_text, ',')) x,
                            jsonb_array_elements(coalesce(p.phones_json, '[]'::jsonb)) e
                       where trim(x) = any(%s)""", (props,)):
        tag = "prospect_" + ("likely_owner" if r["likely_owner"] else ("likely_renter" if r["likely_renting"] else "other")) + f"_{r['ptype'] or 'U'}"
        if d10(r["e164"]): A[r["pid"]][d10(r["e164"])].add(tag)
    for src, sql in (("hist_queue", "select property_id, to_phone_number p, queue_status s from public.send_queue where property_id = any(%s)"),
                     ("hist_target", "select property_id, to_phone_number p, target_status s from public.campaign_targets where property_id = any(%s)"),
                     ("hist_message", "select property_id, coalesce(to_phone_number, from_phone_number) p, direction s from public.message_events where property_id = any(%s)")):
        for r in q(cur, sql, (props,)):
            if d10(r["p"]): A[r["property_id"]][d10(r["p"])].add(f"{src}:{r['s']}")
    allph = {p for v in A.values() for p in v}
    supp = {d10(r["p"]) for r in q(cur, "select coalesce(phone_e164, phone_number) p from public.sms_suppression_list where coalesce(is_active,true)")}
    wrong = {d10(r["p"]) for r in q(cur, "select canonical_e164 p from public.phones where wrong_number_at is not null")}

    def cls(prop, ph, ev):
        if ph in supp or ph in wrong: return "suppressed_or_wrong_number"
        if any(e.startswith("hist_message:out") or e in ("hist_queue:delivered", "hist_queue:sent") for e in ev): return "historical_contacted"
        if any(e.startswith("hist_queue:") and (e.split(":")[1].startswith("paused") or e.split(":")[1].startswith("blocked") or e.split(":")[1] in ("scheduled", "queued")) for e in ev): return "held_in_queue"
        if ph in graph.get(prop, set()) and (gmeta.get(prop, {}).get("identity_alignment") == "verified"): return "confirmed_owner_phone(vendor_name_exact)"
        if any(e.startswith("best_contact_legal") for e in ev) and (res.get(prop, {}).get("owner_resolution_status") == "confirmed"): return "confirmed_owner_phone(vendor_name_exact)"
        if any(e.startswith("prospect_likely_owner") for e in ev):
            st = res.get(prop, {}).get("owner_resolution_status")
            return "vendor_associated_owner_phone(resolution_" + (st or "missing") + ")"
        if any(e.startswith("best_contact_reach") for e in ev): return "reach_phone_non_owner_role"
        if any(e.startswith("prospect_likely_renter") for e in ev): return "renter_or_occupant_phone"
        if any(e.startswith("prospect_other") for e in ev): return "unresolved_prospect_phone"
        if any(e.startswith("hist_target") or e.startswith("hist_queue") for e in ev): return "historical_target_only"
        return "other"

    rows = []
    for prop, phones in A.items():
        for ph, ev in phones.items():
            visible = ph in graph.get(prop, set())
            rows.append({"prop": prop, "ph": ph, "visible_now": visible, "class": cls(prop, ph, ev),
                         "wireless": any(e.endswith("_W") for e in ev)})
    new = [r for r in rows if not r["visible_now"]]
    props_gain = {r["prop"] for r in new}
    props_missing_now = {p for p in props if not graph.get(p)}
    return {
        "label": label, "sampled_properties": len(props),
        "properties_with_no_graph_phone_now": len(props_missing_now),
        "of_those_with_any_candidate_after_fix": len(props_missing_now & set(A)),
        "property_phone_associations_total": len(rows),
        "newly_visible_associations": len(new), "newly_visible_distinct_phones": len({r["ph"] for r in new}),
        "properties_gaining_any_association": len(props_gain),
        "newly_visible_by_class": dict(collections.Counter(r["class"] for r in new).most_common()),
        "newly_visible_wireless_vendor_owner_class": sum(1 for r in new if r["wireless"] and r["class"].startswith("vendor_associated")),
        "currently_visible_by_class": dict(collections.Counter(r["class"] for r in rows if r["visible_now"]).most_common()),
    }


def compare(before_path, after_path):
    """Acceptance: AFTER must expose at least the BEFORE hidden associations per sample."""
    before = {r["label"]: r for r in json.load(open(before_path))}
    after = {r["label"]: r for r in json.load(open(after_path))}
    ok = True
    for label, b in before.items():
        a = after.get(label)
        if not a:
            print(f"FAIL {label}: missing from AFTER"); ok = False; continue
        exposed_after = a["property_phone_associations_total"] - a["newly_visible_associations"]
        need = b["property_phone_associations_total"]
        flag = "PASS" if exposed_after >= need else "FAIL"
        ok &= flag == "PASS"
        print(f"{flag} {label}: exposed {exposed_after} / baseline associations {need}; still hidden {a['newly_visible_associations']}")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="contact_discovery_regression.json")
    ap.add_argument("--compare", nargs=2, metavar=("BEFORE", "AFTER"))
    ap.add_argument("--visible-relation", help="AFTER run: e.g. public.property_contact_candidates:phone_e164")
    args = ap.parse_args()
    if args.compare:
        sys.exit(compare(*args.compare))
    import psycopg2
    c = psycopg2.connect(options="-c default_transaction_read_only=on -c statement_timeout=900000")
    c.set_session(readonly=True); cur = c.cursor()
    out = [run(cur, "seeded_2000_all_graph", "select property_id from public.campaign_target_graph order by md5(property_id||'rg20261008') limit 2000", args.visible_relation),
           run(cur, "seeded_600_missing_phone", "select property_id from public.campaign_target_graph where queue_block_reason='missing_phone' order by md5(property_id||'seed20261008') limit 600", args.visible_relation)]
    json.dump(out, open(args.out, "w"), indent=1)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
