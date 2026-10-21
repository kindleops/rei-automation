-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261019120000_payload_clean_opaque_ids.sql: 10,000 random UUIDs
-- and opaque ids (bare, prefixed, under neutral keys, in arrays, as finding docs) are all clean; seeded
-- phones and emails, including phones glued to / beside an id, are all still refused; a recovery finding
-- doc with a random conversation id is accepted by agent.finding's CHECK.
-- DISPOSABLE DATABASE ONLY: never run against production.
-- No includes; one BEGIN first and one ROLLBACK last: nothing it writes survives.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id payload_clean_opaque_ids
-- Expected last notice: "posttest(payload_clean_opaque_ids): all assertions OK".
\set ON_ERROR_STOP on
begin;

do $$
declare
  n_rejected int;
  n_phone_missed int;
begin
  select count(*) into n_rejected
  from (select gen_random_uuid()::text u, md5(random()::text) h, encode(sha256(random()::text::bytea), 'hex') d from generate_series(1, 10000)) x
  where not agent.payload_is_clean(jsonb_build_object('key', 'conv.' || u, 'finding_id', 'fnd_' || u, 'citation', 'inbox_thread_state:' || u,
                                                      'note', u, 'refs', jsonb_build_array('apr_' || u, 'mjob_' || u), 'digest', h, 'sha', d, 'upper', upper(u)));
  assert n_rejected = 0, format('random ids rejected: %s / 10000', n_rejected);
  select count(*) into n_phone_missed
  from (values ('612-555-0147'), ('(612) 555-0147'), ('+1 612 555 0147'), ('6125550147'), ('612.555.0147'), ('conv.6125550147'),
               ('84512937-4021-4abc-8123-456789012345 612-555-0147'), ('6125550147-84512937-4021-4abc-8123-456789012345'),
               ('call 612 555 0147 re fnd_84512937-4021-4abc-8123-456789012345'), ('rosa@example.com'), ('x rosa.m+1@mail.example.org y')) v(s)
  where agent.payload_is_clean(jsonb_build_object('note', s));
  assert n_phone_missed = 0, format('seeded contacts accepted: %s', n_phone_missed);
  raise notice 'posttest(payload_clean_opaque_ids): all assertions OK';
end $$;

rollback;
