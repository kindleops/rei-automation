#!/usr/bin/env node
// Reconcile production's reader objects with the REVIEWED reader links 1–5.
//
//   node scripts/db/reader-reconcile.mjs <production-inventory.json> [--json]
//
// The production inventory is the output of scripts/db/reader-reconcile.sql (read-only catalog metadata). The expected
// inventories (scripts/db/reader-reconcile-expected/) come from the same query on a disposable PostgreSQL 17 where the
// reviewed files of bc94ff83 were applied: after link 1, and after links 1–5. Nothing here connects to a database.
//
// Verdict per link: "absent" (outstanding: apply it), "identical" (already in production exactly as reviewed: do not
// re-apply), "partial" (some of its objects present, some missing) or "divergent" (an object exists with another
// definition, attribute or grant). Partial and divergent stop the activation until the owner reviews the differences:
// nothing is dropped, revoked or replaced to force an apply.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const load = (p) => { const t = readFileSync(p, 'utf8').trim(); const j = JSON.parse(t.startsWith('{') ? t : t.slice(t.indexOf('{'))); return j.reader_inventory ?? j; };
const args = process.argv.slice(2); const asJson = args.includes('--json'); const file = args.find((a) => !a.startsWith('--'));
if (!file) { console.error('usage: node scripts/db/reader-reconcile.mjs <production-inventory.json> [--json]'); process.exit(2); }
const prod = load(file);
const exp1 = load(join(here, 'reader-reconcile-expected', 'after-link-1.json'));
const exp14 = load(join(here, 'reader-reconcile-expected', 'after-links-1-4.json'));
const history = JSON.parse(readFileSync(join(here, 'reader-reconcile-expected', 'link1-history.json'), 'utf8')).by_md5;
const versionOf = (md5) => (history[md5] ?? []).map((v) => `${v.commit} (${v.date})`).filter((v, i, a) => a.indexOf(v) === i).join(', ');
// the inventory's identity, without its timestamp: an owner approval names this, and a re-read must match it
const fingerprint = createHash('sha256').update(JSON.stringify({ ...prod, taken_at: undefined })).digest('hex').slice(0, 16);
const effects = []; // what applying the REVIEWED link 1 would change on objects that already exist
const expAll = load(join(here, 'reader-reconcile-expected', 'after-links-1-5.json'));

// which link creates (or last redefines) each function; the two pre-existing reads are only granted by link 1
const LINK = {
  lc_mcp_reader_self_check: 1, lc_mcp_operator_role: 1, lc_mcp_ops_finding: 1, lc_mcp_ops_research_valuation_snapshot: 1,
  lc_mcp_action_center: 1, lc_mcp_thread_hold_status: 1, lc_mcp_followup_intent_health: 1,
  lc_reachable_egress_indirect: 1, lc_egress_platform_allowlists: 1,
  lc_mcp_pipeline_counts: 2, lc_mcp_conversation_signals: 2,
  lc_mcp_lead_conversation: 5, lc_mcp_conversation_worklist: 5, // created by 2, redefined by 5 (full history)
  lc_mcp_corpus_census: 3, lc_mcp_lead_screen: 3,
  lc_mcp_thread_followups: 4, lc_mcp_thread_execution_log: 4, lc_mcp_thread_offers: 4, lc_mcp_thread_contact_eligibility: 4, lc_mcp_operator_tasks: 4,
};
const PREEXISTING = new Set(['campaign_entity_contact_review_flags', 'entity_graph_property_records']);
const bySig = (inv) => new Map((inv.functions ?? []).map((f) => [f.signature, f]));
const prodF = bySig(prod); const expF = bySig(expAll); const exp14F = bySig(exp14);
const findings = []; const add = (link, object, state, detail) => findings.push({ link, object, state, detail });

// ---- the role (link 1) ---------------------------------------------------------------------------------------------
const er = exp1.role; const pr = prod.role;
if (!pr) add(1, 'role lc_mcp_reader', 'absent', 'not in production');
else {
  const attrs = ['rolcanlogin', 'rolinherit', 'rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls'];
  const bad = attrs.filter((a) => pr[a] !== er[a]);
  add(1, 'role lc_mcp_reader attributes', bad.length ? 'divergent' : 'identical', bad.length ? bad.map((a) => `${a}=${pr[a]} (reviewed: ${er[a]})`).join(', ') : 'NOLOGIN, NOINHERIT, no superuser/createdb/createrole/replication/BYPASSRLS');
  const memberOf = JSON.stringify(pr.member_of ?? []); add(1, 'role lc_mcp_reader is a member of', memberOf === JSON.stringify(er.member_of ?? []) ? 'identical' : 'divergent', memberOf);
  const members = new Set(pr.members ?? []); const wantMembers = new Set(er.members ?? []);
  const missingM = [...wantMembers].filter((m) => !members.has(m)); const extraM = [...members].filter((m) => !wantMembers.has(m));
  add(1, 'roles that may SET ROLE lc_mcp_reader', missingM.length || extraM.length ? 'divergent' : 'identical', `production: ${[...members].join(', ') || 'none'}${missingM.length ? `; missing: ${missingM.join(', ')}` : ''}${extraM.length ? `; extra: ${extraM.join(', ')}` : ''}`);
  const ps = new Set(pr.settings ?? []); const es = er.settings ?? [];
  const missingS = es.filter((s) => !ps.has(s)); const extraS = [...ps].filter((s) => !es.includes(s));
  if (missingS.length) effects.push(`role lc_mcp_reader: ALTER ROLE SET ${missingS.join(', ')}`);
  if (extraS.length) effects.push(`role lc_mcp_reader: settings not in the reviewed file stay as they are (${extraS.join(', ')}); link 1 sets only its own`);
  if (missingM.length) effects.push(`GRANT lc_mcp_reader TO ${missingM.join(', ')}`);
  if (extraM.length) effects.push(`roles ${extraM.join(', ')} keep their membership (link 1 revokes none)`);
  add(1, 'role settings', missingS.length ? (ps.size ? 'divergent' : 'partial') : extraS.length ? 'divergent' : 'identical', `production: ${[...ps].join(', ') || 'none'}${missingS.length ? `; missing: ${missingS.join(', ')}` : ''}${extraS.length ? `; extra: ${extraS.join(', ')}` : ''}`);
}

// ---- functions -----------------------------------------------------------------------------------------------------
for (const [sig, e] of expF) {
  const name = e.name; if (PREEXISTING.has(name)) continue;
  const link = LINK[name] ?? '?'; const p = prodF.get(sig);
  if (!p) {
    const other = [...prodF.values()].filter((x) => x.name === name);
    add(link, `function ${sig}`, other.length ? 'divergent' : 'absent', other.length ? `another signature exists: ${other.map((x) => x.signature).join('; ')}` : 'not in production');
    if (link === 5) add(2, `function ${sig} (created by link 2)`, other.length ? 'divergent' : 'absent', 'not in production');
    continue;
  }
  const diffs = [];
  if (link === 5) {
    // created by link 2, redefined by link 5: link 2's definition means "link 2 applied, link 5 outstanding"
    const e4 = exp14F.get(sig);
    if (p.def_md5 === e.def_md5) add(2, `function ${sig} (created by link 2)`, 'identical', 'present; link 5 redefinition also present');
    else if (e4 && p.def_md5 === e4.def_md5) { add(2, `function ${sig}`, 'identical', 'link 2 definition'); add(5, `function ${sig}`, 'absent', 'link 2 definition: the full-history redefinition is outstanding'); continue; }
    else diffs.push('definition differs from both the link-2 and the link-5 reviewed definitions');
  } else if (p.def_md5 !== e.def_md5) {
    const v = versionOf(p.def_md5);
    diffs.push(v ? `definition is an earlier reviewed version: ${v}` : 'definition matches no version of the reviewed file');
    if (link === 1) effects.push(`replace ${sig}: ${v ? `version ${v}` : 'an unknown definition'} → the reviewed one (CREATE OR REPLACE)`);
  }
  for (const k of ['security_definer', 'volatility', 'config']) if (p[k] !== e[k]) diffs.push(`${k}=${p[k]} (reviewed: ${e[k]})`);
  if (p.reader_can_execute !== e.reader_can_execute) diffs.push(`lc_mcp_reader EXECUTE=${p.reader_can_execute} (reviewed: ${e.reader_can_execute})`);
  if (p.acl !== e.acl) {
    diffs.push(`ACL ${p.acl} (reviewed: ${e.acl})`);
    const lose = ['anon', 'authenticated', 'service_role'].filter((r) => new RegExp(`(^|[{,])${r}=X`).test(p.acl)).concat(/(^|[{,])=X\//.test(p.acl) ? ['PUBLIC'] : []);
    if (link === 1 && lose.length) effects.push(`${sig}: EXECUTE revoked from ${lose.join(', ')} (link 1 restricts it to lc_mcp_reader): confirm nothing calls it as those roles`);
  }
  add(link, `function ${sig}`, diffs.length ? 'divergent' : 'identical', diffs.join('; ') || 'same definition, attributes and ACL');
}
for (const [sig, p] of prodF) if (!expF.has(sig) && !PREEXISTING.has(p.name)) add(LINK[p.name] ?? '?', `function ${sig}`, 'divergent', 'in production, not in the reviewed files (another version?)');
for (const name of PREEXISTING) {
  const p = [...prodF.values()].find((x) => x.name === name);
  add(1, `existing read ${name}: lc_mcp_reader EXECUTE`, !p ? 'absent' : p.reader_can_execute ? 'identical' : 'absent', !p ? 'the function itself is not in production (optional source)' : `granted: ${p.reader_can_execute}`);
}

// ---- table privileges and policies (link 1) -------------------------------------------------------------------------
const pt = new Map((prod.reader_table_privileges ?? []).map((t) => [t.relname, t]));
const et = new Map((exp1.reader_table_privileges ?? []).map((t) => [t.relname, t]));
const nonSelect = [...pt.values()].filter((t) => t.reader_privileges !== 'SELECT');
if (nonSelect.length) add(1, 'lc_mcp_reader table privileges', 'divergent', `non-SELECT privileges: ${nonSelect.map((t) => `${t.relname}(${t.reader_privileges})`).join(', ')}`);
const missingT = [...et.keys()].filter((t) => !pt.has(t)); const extraT = [...pt.keys()].filter((t) => !et.has(t));
add(1, 'lc_mcp_reader SELECT grants', pt.size === 0 ? 'absent' : missingT.length ? 'partial' : 'identical',
  `${pt.size} relations granted in production${missingT.length ? `; not granted (absent in production, or link 1 incomplete): ${missingT.join(', ')}` : ''}${extraT.length ? `; also granted (production-only relations of the inventory): ${extraT.join(', ')}` : ''}`);
const pp = new Map((prod.reader_policies ?? []).map((p) => [p.relname, p]));
const ep = new Map((exp1.reader_policies ?? []).map((p) => [p.relname, p]));
const badPol = [...pp.values()].filter((p) => p.cmd !== 'r' || !p.permissive || JSON.stringify(p.roles) !== '["lc_mcp_reader"]' || p.using_expr !== 'true');
if (badPol.length) add(1, 'lc_mcp_reader_select policies', 'divergent', badPol.map((p) => `${p.relname}: cmd ${p.cmd}, roles ${JSON.stringify(p.roles)}, using ${p.using_expr}`).join('; '));
const missingP = [...ep.keys()].filter((t) => !pp.has(t));
add(1, 'lc_mcp_reader_select policies', pp.size === 0 ? 'absent' : missingP.length ? 'partial' : 'identical', `${pp.size} in production${missingP.length ? `; missing on: ${missingP.join(', ')}` : ''}`);
if (prod.reader_create_on_public) add(1, 'CREATE on schema public', 'divergent', 'lc_mcp_reader may CREATE in public (the reviewed role may not)');
if ((prod.objects_owned_by_reader ?? []).length) add(1, 'objects owned by lc_mcp_reader', 'divergent', prod.objects_owned_by_reader.join(', '));

// ---- verdict per link ------------------------------------------------------------------------------------------------
const verdict = {};
for (const link of [1, 2, 3, 4, 5]) {
  const f = findings.filter((x) => x.link === link);
  const st = new Set(f.map((x) => x.state));
  verdict[link] = st.has('divergent') ? 'divergent' : st.size === 1 && st.has('identical') ? 'identical' : st.size === 1 && st.has('absent') ? 'absent' : st.has('identical') || st.has('partial') ? 'partial' : 'absent';
}
// link 2's two functions are redefined by link 5; its other two decide link 2 on their own
const plan = [];
for (const link of [1, 2, 3, 4, 5]) {
  const v = verdict[link];
  plan.push(v === 'absent' ? `link ${link}: OUTSTANDING: apply the reviewed file` : v === 'identical' ? `link ${link}: ALREADY IN PRODUCTION as reviewed: do not re-apply` : `link ${link}: ${v.toUpperCase()}: STOP; the owner reviews the differences below before anything is applied`);
}
for (const f of findings) if (f.link === 1 && f.state === 'absent') effects.push(`create: ${f.object}`);
const out = { production: { server_version: prod.server_version, database: prod.database, taken_at: prod.taken_at, migration_history: prod.migration_history, fingerprint }, verdict, plan, link1_completion_effects: verdict[1] === 'identical' || verdict[1] === 'absent' ? [] : effects, findings };
if (asJson) { console.log(JSON.stringify(out, null, 2)); process.exit(Object.values(verdict).some((v) => v === 'partial' || v === 'divergent') ? 1 : 0); }
console.log(`# Reader reconciliation\n\nProduction ${prod.database} (PostgreSQL ${prod.server_version}), inventory taken ${prod.taken_at}. Migration history rows naming the reader: ${(prod.migration_history ?? []).length}.\n`);
console.log(`Inventory fingerprint: \`${fingerprint}\`\n`);
console.log('## Verdict\n'); for (const p of plan) console.log(`- ${p}`);
if (out.link1_completion_effects.length) { console.log('\n## What applying the reviewed link 1 would change here (for the owner\'s review)\n'); for (const e of out.link1_completion_effects) console.log(`- ${e}`); console.log(`\nTo approve exactly this, the owner sets LINK1_COMPLETION_APPROVED=${fingerprint} for scripts/db/reader-activation.sh; a different production state does not match it.`); }
console.log('\n## Every object\n\n| Link | Object | State | Detail |\n|---|---|---|---|');
for (const f of findings.sort((a, b) => String(a.link).localeCompare(String(b.link)))) console.log(`| ${f.link} | ${f.object} | ${f.state} | ${String(f.detail).replace(/\|/g, '\\|')} |`);
process.exit(Object.values(verdict).some((v) => v === 'partial' || v === 'divergent') ? 1 : 0);
