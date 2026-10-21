-- PROPOSED ONLY — ROLLBACK for PROPOSED_20261019120000_payload_clean_opaque_ids.sql.
-- Restores agent.payload_string_violation BYTE-FOR-BYTE as PROPOSED_20261010120000_agent_s3_persistence.sql
-- created it (and drops the marker comment). Note: rows written while the fix was applied keep their
-- id tokens; under the restored body an UPDATE of such a row re-runs its CHECK and is refused again
-- (the pre-fix behaviour). Nothing is deleted.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$
begin
  if obj_description('agent.payload_string_violation(text,text,integer)'::regprocedure, 'pg_proc') is distinct from 'payload_clean_opaque_ids@1' then
    raise exception 'rollback precondition: not applied';
  end if;
end $$;
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

comment on function agent.payload_string_violation(text, text, int) is null;
revoke all on function agent.payload_string_violation(text, text, int) from public, anon, authenticated;
commit;
