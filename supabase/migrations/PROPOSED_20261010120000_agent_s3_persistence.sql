-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED ONLY. NOT APPLIED. Owner review/authorization required (release
-- plan gate A: tmp/briefs/agent-s3-rc-20261009.md).
--
-- LeadCommand Global AI Agent — S3 MINIMUM durable persistence (2026-10-09).
-- The smallest schema that lets the existing S1/S3 runtime (runs, the one event
-- stream, research jobs/tasks, findings, conflicts) persist in Postgres through
-- the SAME repository interface the in-memory and local file stores implement
-- (apps/api/src/lib/agent/runtime/pg-store.js). Quick Scan stays $0 and AI stays
-- disabled: there is NO ledger, price book, approval, artifact or model table
-- here, and the adapter refuses any transaction that writes those.
--
-- SUPERSEDES (for these objects) PROPOSED_20261008200000_agent_schema.sql
-- (agent.run / agent.run_event / agent.tool_call). That S1 proposal must be
-- rebased onto this file before it is ever applied; the pretest refuses to run
-- if agent.run already exists.
--
-- REUSED, not duplicated (audit 10-09, see the release plan):
--   public.idempotency_ledger  tool-call idempotency (scope 'agent.tool'); its
--                              30-day retention purge already runs daily.
-- EVALUATED, not reused:
--   public.run_locks           the run lease must change in the SAME transaction
--                              as task state + events (fenced by the store_head
--                              row lock); run_locks is a separate durability
--                              domain with its own transaction.
--   public.automation_events   the canonical automation bus: workflows react to
--                              it; research activity there would trigger
--                              consumers and it has no per-run gapless seq.
--   public.wf_runs / wf_*      pin immutable automation graphs (DR §0).
--
-- Access: service_role (the API) writes; authenticated users READ their own
-- org's rows via agent.operator_membership (owner role reads every org);
-- anon reads nothing. Today the API reaches Postgres as service_role behind the
-- Worker's OPS_ALLOWED_USER_IDS allowlist; membership rows mirror that
-- allowlist (user_id = Supabase auth uid = x-ops-user-id), so the policies
-- tighten automatically when named-user identity (S7) lets the browser or a
-- user-scoped client read directly.
--
-- Hard data guarantee: agent.payload_is_clean() is a CHECK on every jsonb
-- column — no phone numbers, emails, message bodies, SMS text, model thinking
-- or credentials can be stored, independent of the JS sanitizer.
-- ════════════════════════════════════════════════════════════════════════════

begin;

create schema if not exists agent;
revoke all on schema agent from public, anon, authenticated;
grant usage on schema agent to service_role, authenticated;   -- authenticated: RLS-scoped reads only (not exposed via PostgREST in S3)

-- FUTURE OBJECTS (L6): a per-schema default cannot cancel a database-wide
-- default grant, so every later migration that adds a table / function /
-- sequence to schema agent MUST REVOKE from PUBLIC, anon, authenticated and
-- grant agent_api / service_role explicitly, exactly as below.
-- Supabase installs default privileges that GRANT tables/functions/sequences to
-- anon + authenticated in exposed schemas, and PostgreSQL grants EXECUTE on
-- every new function to PUBLIC. Neither may apply here: every grant in this
-- schema is explicit (bottom of file).
alter default privileges in schema agent revoke all on tables from public, anon, authenticated;
alter default privileges in schema agent revoke all on sequences from public, anon, authenticated;
alter default privileges in schema agent revoke all on functions from public, anon, authenticated;

-- ── sanitizer (defense in depth; the JS sanitizer runs first) ────────────────
-- agent.payload_violation(value, parent_key) returns NULL when clean, else a
-- short reason code. agent.payload_is_clean() is the CHECK used on every jsonb
-- column. Rules (security review M2, 10-09):
--   * every subtree is scanned; nothing is ever skipped
--   * KEY NAMES are scanned: body/content/message keys, contact-value keys,
--     credential-like keys (token|secret|password|…|*_key except an allowlist),
--     model thinking — and a key that itself contains a phone/email
--   * contact keys (phone, phones, email, …) may only hold a count/flag
--   * strings: non-ASCII digits, emails, JWTs, bearer/secret-key prefixes,
--     phone-like digit runs (10–15 digits with up to 3 separators between
--     digits; letters before/after do not hide them), base64 that decodes to a
--     phone or email
--   * numbers with 10–15 integer digits (bare phones, incl. negatives)
--   * the ONLY exemption: from the phone-run check, for SCALAR values of a
--     strict identifier shape under identifier keys (UUID-shaped ids, 64-hex
--     digests under hash/idempotency keys, court case numbers) and ISO-8601
--     timestamps. Property ids are never stored raw in jsonb: the store encodes
--     them (pid_<digits as letters g–p>), and raw digits under property-id keys
--     are REFUSED, so a phone can never pass as a property id.
--   * zero-width characters are removed and NFKC applied before matching; any
--     non-ASCII digit (Unicode Nd, or anything NFKC folds to a digit) is refused;
--     keys must be ASCII
--   * INHERENT LIMITS (documented, not closable by pattern matching): a phone or
--     name written in words ("two one four …") or split across several fields,
--     a person's name in free text under a neutral key, and encodings other than
--     base64/base64url (hex of a phone looks like a digest). The JS projections
--     (PII-free tool outputs) remain the primary control; this CHECK is the net.
create or replace function agent.payload_norm_key(k text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select lower(regexp_replace(regexp_replace(coalesce(k, ''), '([a-z0-9])([A-Z])', '\1_\2', 'g'), '[^A-Za-z0-9]+', '_', 'g'))
$$;

create or replace function agent.payload_b64_decode(s text)
returns text
language plpgsql
immutable
parallel safe
set search_path = pg_catalog
as $$
declare t text;
begin
  -- standard or url-safe base64, padding optional; NULL when it is not valid UTF-8 text
  if s is null or length(s) < 12 or length(s) > 8192 or s !~ '^[A-Za-z0-9+/_-]+={0,2}$' then return null; end if;
  t := translate(rtrim(s, '='), '-_', '+/');
  t := t || repeat('=', (4 - length(t) % 4) % 4);
  return convert_from(decode(t, 'base64'), 'UTF8');
exception when others then
  return null;
end
$$;

create or replace function agent.payload_string_violation(s_in text, nk text, depth int default 0)
returns text
language plpgsql
immutable
parallel safe
set search_path = pg_catalog, agent
as $$
declare
  phone_run constant text := '[0-9](?:[[:space:]().,:/_+·–—-]{0,4}[0-9]){9,14}';
  email_re constant text := '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}';
  -- every Unicode Nd digit outside ASCII (generated from the Unicode tables, 70 ranges)
  nd_non_ascii constant text := '[\u0660-\u0669\u06f0-\u06f9\u07c0-\u07c9\u0966-\u096f\u09e6-\u09ef\u0a66-\u0a6f\u0ae6-\u0aef\u0b66-\u0b6f\u0be6-\u0bef\u0c66-\u0c6f\u0ce6-\u0cef\u0d66-\u0d6f\u0de6-\u0def\u0e50-\u0e59\u0ed0-\u0ed9\u0f20-\u0f29\u1040-\u1049\u1090-\u1099\u17e0-\u17e9\u1810-\u1819\u1946-\u194f\u19d0-\u19d9\u1a80-\u1a89\u1a90-\u1a99\u1b50-\u1b59\u1bb0-\u1bb9\u1c40-\u1c49\u1c50-\u1c59\ua620-\ua629\ua8d0-\ua8d9\ua900-\ua909\ua9d0-\ua9d9\ua9f0-\ua9f9\uaa50-\uaa59\uabf0-\uabf9\uff10-\uff19\U000104a0-\U000104a9\U00010d30-\U00010d39\U00010d40-\U00010d49\U00011066-\U0001106f\U000110f0-\U000110f9\U00011136-\U0001113f\U000111d0-\U000111d9\U000112f0-\U000112f9\U00011450-\U00011459\U000114d0-\U000114d9\U00011650-\U00011659\U000116c0-\U000116c9\U000116d0-\U000116e3\U00011730-\U00011739\U000118e0-\U000118e9\U00011950-\U00011959\U00011bf0-\U00011bf9\U00011c50-\U00011c59\U00011d50-\U00011d59\U00011da0-\U00011da9\U00011f50-\U00011f59\U00016130-\U00016139\U00016a60-\U00016a69\U00016ac0-\U00016ac9\U00016b50-\U00016b59\U00016d70-\U00016d79\U0001ccf0-\U0001ccf9\U0001d7ce-\U0001d7ff\U0001e140-\U0001e149\U0001e2f0-\U0001e2f9\U0001e4f0-\U0001e4f9\U0001e5f1-\U0001e5fa\U0001e950-\U0001e959\U0001fbf0-\U0001fbf9]';
  s text;
  decoded text;
  exempt boolean := false;
begin
  if s_in is null then return null; end if;
  -- zero-width / invisible characters can never split a match
  s := regexp_replace(s_in, '[­​-‍⁠﻿]', '', 'g');
  if s ~ nd_non_ascii then return 'non_ascii_digits'; end if;
  -- NFKC folds full-width, math-bold, superscript, circled … digits to ASCII: any such fold is refused
  if length(regexp_replace(normalize(s, NFKC), '[^0-9]', '', 'g')) <> length(regexp_replace(s, '[^0-9]', '', 'g')) then return 'non_ascii_digits'; end if;
  s := normalize(s, NFKC);
  if s ~ email_re then return 'email'; end if;
  if s ~ '(^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}' then return 'jwt'; end if;
  if s ~* '(^|[^A-Za-z0-9])((sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9_-]{16,}|sb_(secret|publishable)_[A-Za-z0-9_-]{8,}|bearer[[:space:]]+[A-Za-z0-9._~+/-]{8,}|github_pat_[A-Za-z0-9_]{20,})'
     or s ~ '(^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}'
     or s ~ '(^|[^A-Z0-9])(AKIA|ASIA)[A-Z0-9]{16}([^A-Z0-9]|$)' then return 'credential'; end if;
  -- the single exemption, phone-run check only (property ids are NEVER stored raw in jsonb: the
  -- store encodes them as pid_<letters>, so no digit-run exemption exists for them)
  exempt :=
       s ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,9})?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)?)?$'
    or (nk ~ '(^id$|_id$|_ids$|^requested_by$|^operator$)' and s ~ '^([a-z]{1,12}_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    or (nk ~ '(^|_)(hash|idempotency_key)$' and s ~ '^[0-9a-f]{32,128}$')
    -- court case numbers (public record) always carry a letter court code, e.g. 2024-012345-CA-01
    or (nk = 'case_number' and s ~ '^[0-9]{2,4}-[0-9]{3,8}-[A-Z]{1,4}(-[0-9]{1,4})?$');
  if not exempt and s ~ phone_run then return 'phone'; end if;
  -- base64 / base64url that decodes to a phone, email or credential — two levels deep
  if depth < 2 and s !~ '^[0-9a-f]+$' then
    decoded := agent.payload_b64_decode(s);
    if decoded is not null and decoded <> s then
      if agent.payload_string_violation(decoded, '', depth + 1) is not null then return 'base64_contact'; end if;
    end if;
  end if;
  return null;
end
$$;

create or replace function agent.payload_violation(j jsonb, parent_key text default null)
returns text
language plpgsql
immutable
parallel safe
set search_path = pg_catalog, agent
as $$
declare
  k text;
  nk text;
  v jsonb;
  r text;
  pk constant text := agent.payload_norm_key(parent_key);
  key_allow constant text[] := array['key','idempotency_key','section_key','sort_key','lock_key','name_key','finding_key','cache_key','dedupe_key','scope_key'];
begin
  if j is null then return null; end if;
  case jsonb_typeof(j)
    when 'object' then
      for k, v in select * from jsonb_each(j) loop
        if k ~ '[^\x01-\x7f]' then return 'key_non_ascii'; end if;   -- NFKC + ASCII-only keys (no homoglyph / invisible keys)
        nk := agent.payload_norm_key(normalize(k, NFKC));
        r := agent.payload_string_violation(k, '');
        if r is not null then return 'key_' || r; end if;
        -- brief claims carry a deterministic restatement in `text` (contract BriefClaim.text); its content is still scanned
        if (nk ~ '^(body|text|content|contents|message|messages|msg|message_body|message_text|latest_message_body|sms|sms_body|sms_text|preview|snippet|transcript|raw|raw_text|raw_html|html|email_body|note_text|reply|reply_text)$'
            or nk ~ '(^|_)(body|transcript)($|_)')
           and not (nk = 'text' and pk = 'claims') then return 'key_message_body'; end if;
        if nk ~ '^(phones_json|emails_json|canonical_e164|e164|seller_phone|best_phone|best_email|phone_raw|mobile|cell|cell_phone|mobile_phone|landline)$' or nk ~ '(^|_)e164($|_)' then return 'key_contact_value'; end if;
        if nk ~ '^(thinking|thinking_text|reasoning|chain_of_thought)$' then return 'key_thinking'; end if;
        if nk ~ '(^|_)(token|secret|secrets|password|passwd|pwd|passphrase|authorization|auth|cookie|cookies|session|jwt|bearer|credential|credentials|apikey|signature)($|_)'
           or (nk ~ '_key$' and not (nk = any (key_allow))) or nk = 'api_key' then return 'key_credential'; end if;
        if nk ~ '^(phone|phone_number|phones|email|email_address|emails)$' and jsonb_typeof(v) not in ('number','boolean','null') then return 'key_contact_value'; end if;
        r := agent.payload_violation(v, k);
        if r is not null then return r; end if;
      end loop;
    when 'array' then
      for v in select * from jsonb_array_elements(j) loop
        r := agent.payload_violation(v, parent_key);  -- elements inherit the parent key; subtrees are never skipped
        if r is not null then return r; end if;
      end loop;
    when 'string' then
      if pk ~ '(^|_)property_ids?$' and (j #>> '{}') !~ '^pid_[g-p]{1,20}$' then return 'property_id_not_encoded'; end if;
      if pk ~ '_refs$' and (j #>> '{}') ~ '^property:' and (j #>> '{}') !~ '^property:pid_[g-p]{1,20}$' then return 'property_ref_not_encoded'; end if;
      return agent.payload_string_violation(j #>> '{}', pk);
    when 'number' then
      if (j #>> '{}') ~ '^-?[0-9]{10,15}(\.[0-9]+)?$' then return 'phone_number_value'; end if;
    else
      null;
  end case;
  return null;
end
$$;

create or replace function agent.payload_is_clean(j jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog, agent
as $$ select agent.payload_violation(j, null) is null $$;

comment on function agent.payload_is_clean(jsonb) is
  'CHECK guard (security review M2): rejects phones (incl. separators, prefixes, international, non-ASCII digits, base64, bare numbers), emails, JWTs/secret keys, message-body / contact-value / credential / thinking KEYS anywhere. Only scalar identifier-shaped values under identifier keys (and ISO timestamps) are exempt, and only from the phone-run check.';

-- ── tenancy / access ────────────────────────────────────────────────────────
create table agent.org (
  org_id uuid primary key,
  name text not null check (length(name) between 1 and 120),
  created_at timestamptz not null default now()
);

create table agent.operator_membership (
  org_id uuid not null references agent.org(org_id) on delete cascade,
  user_id uuid not null,                       -- Supabase auth uid (= Worker x-ops-user-id)
  role text not null default 'operator' check (role in ('operator','owner')),
  added_at timestamptz not null default now(),
  added_by text not null,
  primary key (org_id, user_id)
);
create index operator_membership_user_idx on agent.operator_membership (user_id);

create or replace function agent.can_read_org(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, agent
as $$
  select coalesce(auth.uid() is not null and exists (
    select 1 from agent.operator_membership m
     where m.user_id = auth.uid() and (m.org_id = p_org or m.role = 'owner')
  ), false)
$$;

-- ── the store head: one row serializes every writer (FOR UPDATE) ─────────────
create table agent.store_head (
  id smallint primary key check (id = 1),
  generation bigint not null default 0 check (generation >= 0),
  event_id bigint not null default 0 check (event_id >= 0),     -- global cursor counter
  updated_at timestamptz not null default now()
);
insert into agent.store_head (id) values (1);

-- ── runs (sessions) ─────────────────────────────────────────────────────────
create table agent.run (
  run_id text primary key check (run_id ~ '^run_[A-Za-z0-9_-]{8,80}$'),
  org_id uuid not null references agent.org(org_id),
  operator_id text not null check (length(operator_id) between 1 and 128),
  kind text not null check (kind in ('conversation','task','research')),
  depth text check (depth is null or depth in ('quick','deep','diligence')),
  state text not null check (state in ('created','planning','awaiting_plan_approval','running','waiting_tool',
    'awaiting_approval','needs_input','paused','completed','completed_partial','budget_exhausted','cancelled',
    'failed','failed_retryable','expired')),
  budget_cap_usd numeric(10,4) not null check (budget_cap_usd >= 0),
  accrued_usd numeric(12,6) not null default 0 check (accrued_usd >= 0),
  lease_owner text,
  lease_until timestamptz,
  heartbeat_at timestamptz,
  cancel_requested_at timestamptz,
  last_seq integer not null default 0 check (last_seq >= 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  ended_at timestamptz,
  -- retention: set when this run's evidence (events, findings, tasks) was purged;
  -- the API then reports "evidence expired on <date>", never a complete run
  evidence_expired_at timestamptz,
  evidence_expiry jsonb check (agent.payload_is_clean(evidence_expiry)),
  gen bigint not null,
  doc jsonb not null check (agent.payload_is_clean(doc)),
  constraint run_expiry_only_terminal check (evidence_expired_at is null or ended_at is not null),
  -- S3: AI is disabled and Quick Scan is $0 BY STRUCTURE
  constraint run_quick_is_zero check (depth is distinct from 'quick' or (budget_cap_usd = 0 and accrued_usd = 0)),
  constraint run_s3_no_spend check (accrued_usd = 0),
  constraint run_terminal_has_end check (
    (state in ('completed','completed_partial','budget_exhausted','cancelled','failed','expired')) = (ended_at is not null)),
  constraint run_lease_pair check ((lease_owner is null) = (lease_until is null)),
  -- Gate B: a run belongs to a NAMED operator (the verified Supabase user), never a
  -- shared secret, principal, service or system identity (mirrors run-service SHARED_IDENTITY_RE)
  constraint run_operator_named check (operator_id !~* '^(principal:|system:|service[:_-]?|service_role$|anon$|authenticated$|ops[-_]dashboard|shared[:_-])')
);
create index run_org_created_idx on agent.run (org_id, created_at desc);
create index run_gen_idx on agent.run (org_id, gen);
create index run_active_idx on agent.run (state, lease_until) where ended_at is null;

-- ── the one event stream (append-only) ──────────────────────────────────────
create table agent.run_event (
  event_id bigint primary key check (event_id > 0),            -- global, monotonic: SSE id + replay cursor
  run_id text not null references agent.run(run_id) on delete cascade,
  org_id uuid not null references agent.org(org_id),
  seq integer not null check (seq > 0),                        -- per run, gapless
  type text not null check (type ~ '^[a-z_]+(\.[a-z_]+)*$'),
  at timestamptz not null,
  attempt integer not null default 1 check (attempt >= 1),
  visibility text not null default 'operator' check (visibility in ('operator','internal')),
  property_id text,
  task_id text,
  tool_call_id text,
  -- Gate B actor stamp: the run's named operator; run_event_guard re-checks equality
  actor_user_id text not null check (length(actor_user_id) between 1 and 128),
  payload jsonb not null check (agent.payload_is_clean(payload)),
  fixture boolean not null default false check (fixture = false),  -- fixtures never enter the durable store
  unique (run_id, seq)
);
create index run_event_run_idx on agent.run_event (run_id, event_id);
create index run_event_org_idx on agent.run_event (org_id, event_id);
-- a retried task never duplicates attempt N (S1 rule: task./source./observation. are task-scoped)
create unique index run_event_task_attempt_uq on agent.run_event (run_id, task_id, type, attempt)
  where task_id is not null and (type like 'task.%' or type like 'source.%' or type like 'observation.%');

create or replace function agent.run_event_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, agent
as $$
declare
  v_max_seq integer;
  v_max_id bigint;
  v_run_org uuid;
  v_run_actor text;
begin
  if tg_op = 'INSERT' then
    -- ordering is DB-enforced: every insert serializes on the store head (L3)
    perform 1 from agent.store_head where id = 1 for update;
    select coalesce(max(seq), 0) into v_max_seq from agent.run_event where run_id = new.run_id;
    if new.seq <> v_max_seq + 1 then
      raise exception 'run_event seq gap: run % expected seq %, got %', new.run_id, v_max_seq + 1, new.seq
        using errcode = 'check_violation';
    end if;
    select coalesce(max(event_id), 0) into v_max_id from agent.run_event;
    if new.event_id <= v_max_id then
      raise exception 'run_event event_id must be monotonic: % <= %', new.event_id, v_max_id
        using errcode = 'check_violation';
    end if;
    select org_id, operator_id into v_run_org, v_run_actor from agent.run where run_id = new.run_id;
    if v_run_org is distinct from new.org_id then
      raise exception 'run_event org mismatch' using errcode = 'check_violation';
    end if;
    if v_run_actor is distinct from new.actor_user_id then
      raise exception 'run_event actor mismatch: an event is stamped with its run''s operator' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  -- DELETE is allowed ONLY to the table owner: that is the identity inside the
  -- SECURITY DEFINER retention / delete-on-request functions (and the FK cascade
  -- they trigger). No API role (agent_api, service_role) is or can become the
  -- owner; there is no session setting that unlocks this. The owner itself is
  -- break-glass only (it could also DISABLE TRIGGER) — the API never connects as it.
  if tg_op = 'DELETE' and current_user = (select pg_get_userbyid(c.relowner) from pg_class c where c.oid = tg_relid) then
    return old;
  end if;
  raise exception 'agent.run_event is append-only (% refused for %)', tg_op, current_user using errcode = 'insufficient_privilege';
end
$$;
create trigger run_event_guard_ins before insert on agent.run_event for each row execute function agent.run_event_guard();
create trigger run_event_guard_mut before update or delete on agent.run_event for each row execute function agent.run_event_guard();
create trigger run_event_no_truncate before truncate on agent.run_event for each statement execute function agent.run_event_guard();

-- ── research job (1:1 extension of a research run) + tasks (checkpoints) ─────
create table agent.research_job (
  job_id text primary key,
  run_id text not null unique references agent.run(run_id) on delete cascade,
  org_id uuid not null references agent.org(org_id),
  depth text not null check (depth in ('quick','deep','diligence')),
  state text not null check (state in ('draft','queued','running','paused','synthesizing','completed','completed_partial',
    'budget_exhausted','cancelled','failed','expired')),
  scope_hash text not null check (scope_hash ~ '^[0-9a-f]{64}$'),
  property_ids text[] not null check (cardinality(property_ids) between 1 and 50),
  created_at timestamptz not null,
  ended_at timestamptz,
  gen bigint not null,
  doc jsonb not null check (agent.payload_is_clean(doc)),
  constraint research_job_s3_quick_only check (depth = 'quick')   -- S3: only $0 Quick Scan exists
);
create index research_job_gen_idx on agent.research_job (org_id, gen);

create table agent.research_task (
  task_id text primary key,
  job_id text not null references agent.research_job(job_id) on delete cascade,
  run_id text not null references agent.run(run_id) on delete cascade,
  org_id uuid not null references agent.org(org_id),
  property_id text not null,
  tool text not null,
  finding_type text not null,
  state text not null check (state in ('planned','skipped_fresh','queued','running','succeeded','blocked','unavailable',
    'needs_input','failed','cancelled','budget_stopped')),
  attempt integer not null check (attempt >= 1),
  billable boolean not null default false check (billable = false),
  output jsonb check (agent.payload_is_clean(output)),        -- projected tool output = the resume checkpoint
  gen bigint not null,
  doc jsonb not null check (agent.payload_is_clean(doc)),
  unique (job_id, property_id, tool)                           -- one task per property × tool: no duplicate work
);
create index research_task_run_idx on agent.research_task (run_id, state);
create index research_task_gen_idx on agent.research_task (org_id, gen);

-- ── tool calls (audit of every executed read) ───────────────────────────────
create table agent.tool_call (
  tool_call_id text primary key,
  run_id text not null references agent.run(run_id) on delete cascade,
  org_id uuid not null references agent.org(org_id),
  tool text not null,
  tier text not null check (tier = 'T0'),                      -- S3: reads only
  state text not null,
  created_at timestamptz not null,
  gen bigint not null,
  doc jsonb not null check (agent.payload_is_clean(doc))
);
create index tool_call_run_idx on agent.tool_call (run_id);
create index tool_call_gen_idx on agent.tool_call (org_id, gen);

-- ── property-scoped findings + evidence references ──────────────────────────
create table agent.finding (
  finding_id text primary key,
  run_id text not null references agent.run(run_id) on delete cascade,
  org_id uuid not null references agent.org(org_id),
  property_id text not null,
  finding_type text not null,
  key text not null,
  evidence_status text not null check (evidence_status in ('county_confirmed','recorded','vendor_reported','licensed_provider',
    'model_inference','unverified','stale','unavailable','blocked','internal_record','derived')),
  source_class text not null check (source_class in ('official_public_record','internal_record','third_party_vendor',
    'derived_inferred','unavailable_blocked')),
  source_id text not null,
  citation text,
  basis_finding_ids text[] not null default '{}',
  value jsonb check (agent.payload_is_clean(value)),
  is_negative_claim boolean not null default false,
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  retrieved_at timestamptz not null,
  observed_at text,
  -- Gate B actor stamp: the run's named operator; finding_actor_guard re-checks equality
  actor_user_id text not null check (length(actor_user_id) between 1 and 128),
  gen bigint not null,
  doc jsonb not null check (agent.payload_is_clean(doc)),
  unique (run_id, property_id, finding_type, key),
  -- blocked / unavailable carry NO value and are never absence
  constraint finding_no_value check (evidence_status not in ('unavailable','blocked') or (value is null and confidence = 0)),
  constraint finding_not_absence check (is_negative_claim = false),
  constraint finding_class_status check (
    (source_class = 'official_public_record' and evidence_status in ('county_confirmed','recorded')) or
    (source_class = 'internal_record' and evidence_status = 'internal_record') or
    (source_class = 'third_party_vendor' and evidence_status in ('vendor_reported','licensed_provider','stale')) or
    (source_class = 'derived_inferred' and evidence_status in ('derived','model_inference','unverified')) or
    (source_class = 'unavailable_blocked' and evidence_status in ('unavailable','blocked'))),
  constraint finding_no_model_s3 check (evidence_status <> 'model_inference')   -- AI disabled in S3
);
create or replace function agent.finding_actor_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, agent
as $$
begin
  if new.actor_user_id is distinct from (select r.operator_id from agent.run r where r.run_id = new.run_id) then
    raise exception 'finding actor mismatch: a finding is stamped with its run''s operator' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger finding_actor_guard before insert or update on agent.finding
  for each row execute function agent.finding_actor_guard();
create index finding_property_idx on agent.finding (org_id, property_id, finding_type);
create index finding_run_idx on agent.finding (run_id);
create index finding_gen_idx on agent.finding (org_id, gen);

create table agent.finding_conflict (
  conflict_group_id text primary key,
  run_id text not null references agent.run(run_id) on delete cascade,
  org_id uuid not null references agent.org(org_id),
  property_id text not null,
  rule text not null,
  resolution_state text not null check (resolution_state in ('open','resolved_by_rule','resolved_by_operator')),
  gen bigint not null,
  doc jsonb not null check (agent.payload_is_clean(doc)),
  -- decisive only when the evidence supports it: an open conflict names no winner
  constraint conflict_open_has_no_winner check (resolution_state <> 'open' or (doc -> 'best_supported') is null or jsonb_typeof(doc -> 'best_supported') = 'null')
);
create index finding_conflict_run_idx on agent.finding_conflict (run_id);
create index finding_conflict_gen_idx on agent.finding_conflict (org_id, gen);

-- ── retention + delete-on-request ───────────────────────────────────────────
create table agent.retention_policy (
  id smallint primary key check (id = 1),
  event_days integer not null default 180 check (event_days between 7 and 730),
  finding_days integer not null default 180 check (finding_days between 7 and 730),
  run_days integer not null default 365 check (run_days between 30 and 1825),
  updated_at timestamptz not null default now(),
  updated_by text not null default 'migration'
);
insert into agent.retention_policy (id) values (1);

create table agent.deletion_log (
  id bigserial primary key,
  org_id uuid,
  run_id text,
  kind text not null check (kind in ('retention','retention_run','request')),
  requested_by text not null,
  reason text check (reason is null or length(reason) <= 240),
  counts jsonb not null check (agent.payload_is_clean(counts)),
  gen bigint,                                   -- store generation: caches evict deleted runs
  at timestamptz not null default now()
);
create index deletion_log_gen_idx on agent.deletion_log (gen) where gen is not null;

-- Retention: only TERMINAL runs age out; in-flight runs are never touched.
--   events / tasks / tool calls  past event_days   → deleted; the run row is MARKED
--   findings / conflicts         past finding_days → deleted; the run row is MARKED
--   whole run                    past run_days     → deleted (deletion_log row per run)
-- A marked run keeps its summary (state, title, timestamps) plus
-- evidence_expired_at + evidence_expiry {events, findings, conflicts, tasks, reason}
-- so the API can say "evidence expired on <date>". Idempotent. Bumps the store
-- generation so every instance's cache sees the change.
create or replace function agent.purge_expired(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare
  pol agent.retention_policy%rowtype;
  v_gen bigint;
  r record;
  n_events bigint := 0; n_findings bigint := 0; n_conflicts bigint := 0; n_tasks bigint := 0; n_runs bigint := 0; n_marked bigint := 0;
  e bigint; f bigint; c bigint; t bigint;
  x jsonb;
begin
  select * into pol from agent.retention_policy where id = 1;
  select generation + 1 into v_gen from agent.store_head where id = 1 for update;   -- serialize with every writer
  for r in
    select run_id, org_id, ended_at, evidence_expiry from agent.run
     where ended_at is not null
       and (ended_at < p_now - make_interval(days => least(pol.event_days, pol.finding_days)))
     order by ended_at
  loop
    if r.ended_at < p_now - make_interval(days => pol.run_days) then
      delete from agent.run where run_id = r.run_id;
      n_runs := n_runs + 1;
      insert into agent.deletion_log (org_id, run_id, kind, requested_by, counts, gen)
      values (r.org_id, r.run_id, 'retention_run', 'agent.purge_expired', jsonb_build_object('runs', 1), v_gen);
      continue;
    end if;
    e := 0; f := 0; c := 0; t := 0;
    if r.ended_at < p_now - make_interval(days => pol.event_days) then
      delete from agent.run_event where run_id = r.run_id; get diagnostics e = row_count;
      delete from agent.tool_call where run_id = r.run_id;
      delete from agent.research_task where run_id = r.run_id; get diagnostics t = row_count;
    end if;
    if r.ended_at < p_now - make_interval(days => pol.finding_days) then
      delete from agent.finding where run_id = r.run_id; get diagnostics f = row_count;
      delete from agent.finding_conflict where run_id = r.run_id; get diagnostics c = row_count;
    end if;
    if e + f + c + t > 0 then
      n_events := n_events + e; n_findings := n_findings + f; n_conflicts := n_conflicts + c; n_tasks := n_tasks + t; n_marked := n_marked + 1;
      x := jsonb_build_object(
             'events_purged', coalesce((r.evidence_expiry ->> 'events_purged')::bigint, 0) + e,
             'findings_purged', coalesce((r.evidence_expiry ->> 'findings_purged')::bigint, 0) + f,
             'conflicts_purged', coalesce((r.evidence_expiry ->> 'conflicts_purged')::bigint, 0) + c,
             'tasks_purged', coalesce((r.evidence_expiry ->> 'tasks_purged')::bigint, 0) + t,
             'reason', 'retention_policy',
             'event_days', pol.event_days, 'finding_days', pol.finding_days);
      update agent.run
         set evidence_expired_at = coalesce(evidence_expired_at, p_now),
             evidence_expiry = x,
             doc = doc || jsonb_build_object('evidence_expired_at', to_jsonb(coalesce(evidence_expired_at, p_now)), 'evidence_expiry', x),
             gen = v_gen
       where run_id = r.run_id;
    end if;
  end loop;
  if n_events + n_findings + n_conflicts + n_tasks + n_runs > 0 then
    update agent.store_head set generation = v_gen, updated_at = now() where id = 1;
    insert into agent.deletion_log (kind, requested_by, counts, gen)
    values ('retention', 'agent.purge_expired', jsonb_build_object('events', n_events, 'findings', n_findings, 'conflicts', n_conflicts, 'tasks', n_tasks, 'runs', n_runs, 'runs_marked', n_marked), v_gen);
  end if;
  return jsonb_build_object('events', n_events, 'findings', n_findings, 'conflicts', n_conflicts, 'tasks', n_tasks, 'runs', n_runs, 'runs_marked', n_marked);
end
$$;

-- Delete-on-request: removes one run and everything under it (cascade). Refuses
-- an in-flight run (cancel it first) so a live dispatcher never loses its rows.
create or replace function agent.delete_run(p_run_id text, p_requested_by text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare
  r agent.run%rowtype;
  c jsonb;
  v_gen bigint;
begin
  if coalesce(trim(p_requested_by), '') = '' then return jsonb_build_object('ok', false, 'reason', 'requested_by_required'); end if;
  select generation + 1 into v_gen from agent.store_head where id = 1 for update;
  select * into r from agent.run where run_id = p_run_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'run_not_found'); end if;
  if r.ended_at is null then return jsonb_build_object('ok', false, 'reason', 'run_in_flight'); end if;
  c := jsonb_build_object(
    'events', (select count(*) from agent.run_event where run_id = p_run_id),
    'findings', (select count(*) from agent.finding where run_id = p_run_id),
    'tasks', (select count(*) from agent.research_task where run_id = p_run_id));
  delete from agent.run where run_id = p_run_id;
  update agent.store_head set generation = v_gen, updated_at = now() where id = 1;
  insert into agent.deletion_log (org_id, run_id, kind, requested_by, reason, counts, gen) values (r.org_id, p_run_id, 'request', p_requested_by, p_reason, c, v_gen);
  return jsonb_build_object('ok', true, 'counts', c);
end
$$;

-- Membership sync with the Worker allowlist (OPS_ALLOWED_USER_IDS). Upserts the
-- given members, demotes/removes everyone else in the org. service_role only.
create or replace function agent.sync_operator_membership(p_org uuid, p_operator_ids uuid[], p_owner_ids uuid[], p_added_by text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare n_removed bigint; n_upserted bigint;
begin
  if coalesce(trim(p_added_by), '') = '' then raise exception 'added_by required'; end if;
  if not exists (select 1 from agent.org where org_id = p_org) then raise exception 'unknown org %', p_org; end if;
  delete from agent.operator_membership m
   where m.org_id = p_org and not (m.user_id = any (coalesce(p_operator_ids, '{}') || coalesce(p_owner_ids, '{}')));
  get diagnostics n_removed = row_count;
  insert into agent.operator_membership (org_id, user_id, role, added_by)
  select p_org, x.u, case when bool_or(x.is_owner) then 'owner' else 'operator' end, p_added_by
    from (select unnest(coalesce(p_operator_ids, '{}')) as u, false as is_owner
          union all select unnest(coalesce(p_owner_ids, '{}')), true) x
   where x.u is not null
   group by x.u
  on conflict (org_id, user_id) do update set role = excluded.role, added_by = excluded.added_by, added_at = now();
  get diagnostics n_upserted = row_count;
  return jsonb_build_object('upserted', n_upserted, 'removed', n_removed);
end
$$;

-- ── cross-server research concurrency (DB-enforced) ─────────────────────────
-- At most max_active_research_jobs research runs may hold a live lease at once,
-- across every worker/instance. The cap is lower-only (CHECK ≤ 2). Every lease
-- write already holds the store_head row lock; the advisory lock makes the
-- count safe even for a writer that bypassed the store.
create table agent.runtime_limits (
  id smallint primary key check (id = 1),
  max_active_research_jobs integer not null default 2 check (max_active_research_jobs between 1 and 2),
  updated_at timestamptz not null default now(),
  updated_by text not null default 'migration'
);
insert into agent.runtime_limits (id) values (1);

create or replace function agent.research_slot_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, agent
as $$
declare v_cap integer; v_active integer; v_now timestamptz := clock_timestamp();
begin
  -- fires on EVERY insert/update (L1): kind, ended_at, state or lease changes all re-check
  if new.kind <> 'research' or new.lease_owner is null or new.ended_at is not null or new.lease_until <= v_now then return new; end if;
  -- the count below is only sound under READ COMMITTED (each statement sees the latest commits)
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'research slot guard requires READ COMMITTED (got %)', current_setting('transaction_isolation') using errcode = 'check_violation';
  end if;
  -- the same owner keeping/renewing a lease that is still live is not a new slot
  if tg_op = 'UPDATE' and old.kind = 'research' and old.ended_at is null and old.lease_owner = new.lease_owner and old.lease_until > v_now then return new; end if;
  perform pg_advisory_xact_lock(hashtext('agent.research_slots'));
  select max_active_research_jobs into v_cap from agent.runtime_limits where id = 1;
  select count(*) into v_active from agent.run
   where kind = 'research' and run_id <> new.run_id and ended_at is null
     and lease_owner is not null and lease_until > v_now;
  if v_active >= v_cap then
    raise exception 'research slot limit: % active research jobs (cap %)', v_active, v_cap using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger run_research_slot_guard before insert or update on agent.run
  for each row execute function agent.research_slot_guard();

-- EXECUTE: explicit revoke on EVERY agent function (incl. SECURITY DEFINER), then
-- grant only what each caller needs.
revoke all on function agent.payload_is_clean(jsonb) from public, anon, authenticated;
revoke all on function agent.payload_violation(jsonb, text) from public, anon, authenticated;
revoke all on function agent.payload_string_violation(text, text, int) from public, anon, authenticated;
revoke all on function agent.payload_norm_key(text) from public, anon, authenticated;
revoke all on function agent.payload_b64_decode(text) from public, anon, authenticated;
revoke all on function agent.can_read_org(uuid) from public, anon, authenticated;
revoke all on function agent.run_event_guard() from public, anon, authenticated;
revoke all on function agent.research_slot_guard() from public, anon, authenticated;
revoke all on function agent.finding_actor_guard() from public, anon, authenticated;
revoke all on function agent.purge_expired(timestamptz) from public, anon, authenticated;
revoke all on function agent.delete_run(text, text, text) from public, anon, authenticated;
revoke all on function agent.sync_operator_membership(uuid, uuid[], uuid[], text) from public, anon, authenticated;
grant execute on function agent.payload_is_clean(jsonb), agent.payload_violation(jsonb, text), agent.payload_string_violation(text, text, int), agent.payload_norm_key(text), agent.payload_b64_decode(text) to service_role;
grant execute on function agent.can_read_org(uuid) to authenticated, service_role;   -- evaluated inside the read policies
grant execute on function agent.purge_expired(timestamptz) to service_role;
grant execute on function agent.delete_run(text, text, text) to service_role;
grant execute on function agent.sync_operator_membership(uuid, uuid[], uuid[], text) to service_role;

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table agent.org enable row level security;
alter table agent.operator_membership enable row level security;
alter table agent.store_head enable row level security;
alter table agent.run enable row level security;
alter table agent.run_event enable row level security;
alter table agent.research_job enable row level security;
alter table agent.research_task enable row level security;
alter table agent.tool_call enable row level security;
alter table agent.finding enable row level security;
alter table agent.finding_conflict enable row level security;
alter table agent.retention_policy enable row level security;
alter table agent.deletion_log enable row level security;
alter table agent.runtime_limits enable row level security;
-- FORCE: even the table owner is subject to RLS (only BYPASSRLS roles —
-- service_role, and Supabase's postgres — write; the pretest verifies both)
do $$ declare t text; begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'agent' and c.relkind = 'r' loop
    execute format('alter table agent.%I force row level security', t);
  end loop;
end $$;

revoke all on all tables in schema agent from public, anon, authenticated, service_role;
revoke all on all sequences in schema agent from public, anon, authenticated, service_role;

-- ── API roles (M1: least privilege; no DELETE / TRUNCATE for anyone but the owner) ──
-- agent_api: the dedicated, NON-OWNER role the API connects as (LOGIN + password
-- are enabled at apply time by PROPOSED_20261010120000_agent_s3_persistence_api_login.sql;
-- the password never lives in the repo). NOINHERIT, no BYPASSRLS: it reaches
-- rows only through the agent_api_* policies below.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'agent_api') then
    create role agent_api nologin noinherit nobypassrls nocreatedb nocreaterole;
  end if;
end $$;
grant usage on schema agent to agent_api;

-- the one append-only stream: read + append, nothing else
grant select, insert on agent.run_event to agent_api, service_role;
-- runtime state: read / insert / update (never delete — the runtime never deletes)
grant select, insert, update on agent.run, agent.research_job, agent.research_task, agent.tool_call, agent.finding, agent.finding_conflict to agent_api, service_role;
grant select, update on agent.store_head to agent_api, service_role;
grant select on agent.org, agent.operator_membership, agent.retention_policy, agent.runtime_limits, agent.deletion_log to agent_api, service_role;
-- owner-path config/admin tables: service_role may manage membership + limits (lower-only CHECKs still apply)
grant insert, update, delete on agent.operator_membership to service_role;
grant update on agent.retention_policy, agent.runtime_limits to service_role;
grant usage on all sequences in schema agent to service_role;
grant execute on function agent.payload_is_clean(jsonb), agent.payload_violation(jsonb, text), agent.payload_string_violation(text, text, int), agent.payload_norm_key(text), agent.payload_b64_decode(text) to agent_api;

-- SECURITY DEFINER functions reachable through PUBLIC (gate-B finding 4): every
-- role, agent_api included, inherits PUBLIC's EXECUTE + schema USAGE. Any such
-- function the applying role owns, outside schema agent, loses PUBLIC EXECUTE
-- and is re-granted explicitly to the roles that relied on it — so agent_api can
-- call none of them. Recorded for the rollback. Production 10-09: none qualify
-- (the only PUBLIC-executable definer functions are PostGIS st_estimatedextent,
-- owned by supabase_admin, read-only — allowlisted in the pretest + pg-store).
create table agent.public_execute_revoked (
  signature text primary key,
  regranted_to text[] not null,
  at timestamptz not null default now()
);
do $$
declare f record;
begin
  for f in
    select p.oid, p.oid::regprocedure::text sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where p.prosecdef
       and n.nspname not in ('agent', 'pg_catalog', 'information_schema')
       and pg_get_userbyid(p.proowner) = current_user
       and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')
       and exists (select 1 from aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a where a.grantee = 0 and a.privilege_type = 'USAGE')
  loop
    execute format('revoke execute on function %s from public', f.sig);
    execute format('grant execute on function %s to anon, authenticated, service_role', f.sig);
    insert into agent.public_execute_revoked (signature, regranted_to) values (f.sig, array['anon','authenticated','service_role']);
  end loop;
end $$;
revoke all on agent.public_execute_revoked from public, anon, authenticated;
alter table agent.public_execute_revoked enable row level security;
alter table agent.public_execute_revoked force row level security;

-- reused tool idempotency ledger: agent_api sees ONLY its own scope
grant select, insert, update, delete on public.idempotency_ledger to agent_api;
create policy idempotency_ledger_agent_api_scope on public.idempotency_ledger
  for all to agent_api using (scope = 'agent.tool') with check (scope = 'agent.tool');

-- agent_api row access — SINGLE-TENANT: these policies are using (true). Today
-- there is one org and the store binds every query to it. BEFORE A SECOND ORG
-- EXISTS, replace them with per-org policies (e.g. org_id = the org bound to the
-- connection via a role-per-org or a verified claim) — tracked as an S4 gate.
do $$ declare t text; begin
  foreach t in array array['run','run_event','research_job','research_task','tool_call','finding','finding_conflict','store_head','org','operator_membership','retention_policy','runtime_limits','deletion_log'] loop
    execute format('create policy agent_api_select on agent.%I for select to agent_api using (true)', t);
  end loop;
  foreach t in array array['run','run_event','research_job','research_task','tool_call','finding','finding_conflict'] loop
    execute format('create policy agent_api_insert on agent.%I for insert to agent_api with check (true)', t);
  end loop;
  foreach t in array array['run','research_job','research_task','tool_call','finding','finding_conflict','store_head'] loop
    execute format('create policy agent_api_update on agent.%I for update to agent_api using (true) with check (true)', t);
  end loop;
end $$;

-- authenticated: read-only, own org (owner: all orgs). No write grant exists.
grant select on agent.run, agent.run_event, agent.research_job, agent.research_task, agent.finding, agent.finding_conflict to authenticated;
grant select on agent.operator_membership to authenticated;

create policy run_read on agent.run for select to authenticated using (agent.can_read_org(org_id));
create policy run_event_read on agent.run_event for select to authenticated using (agent.can_read_org(org_id) and visibility = 'operator');
create policy research_job_read on agent.research_job for select to authenticated using (agent.can_read_org(org_id));
create policy research_task_read on agent.research_task for select to authenticated using (agent.can_read_org(org_id));
create policy finding_read on agent.finding for select to authenticated using (agent.can_read_org(org_id));
create policy finding_conflict_read on agent.finding_conflict for select to authenticated using (agent.can_read_org(org_id));
create policy membership_read_own on agent.operator_membership for select to authenticated using (user_id = auth.uid());

-- The single LeadCommand org (single-tenant today). Membership rows are added
-- at apply time (gate B) from OPS_ALLOWED_USER_IDS — not seeded here.
insert into agent.org (org_id, name) values ('00000000-0000-4000-8000-00000000a001', 'LeadCommand');

commit;
