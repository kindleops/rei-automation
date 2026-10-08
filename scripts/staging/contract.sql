with t(name) as (select unnest(array['acquisition_opportunities','acquisition_opportunity_history','closing_activity_events','closing_cases','closing_milestones','closing_title_issues','email_attachments','email_inbound_messages','email_queue','email_senders','email_suppression','email_threads','external_seller_intake_submissions','inbox_thread_state','notification_events','offerr_evaluation_requests','offerr_evaluations','ops_operators','seller_offers','system_control']::name[]))
select kind, item from (
  select 'col' kind, c.relname||'.'||a.attname||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' notnull' else '' end item
  from t join pg_class c on c.relname=t.name and c.relnamespace='public'::regnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
  union all select 'con', c.relname||' '||k.conname||' '||pg_get_constraintdef(k.oid) from t join pg_class c on c.relname=t.name and c.relnamespace='public'::regnamespace join pg_constraint k on k.conrelid=c.oid
  union all select 'idx', c.relname||' '||regexp_replace(pg_get_indexdef(i.indexrelid),'^CREATE (UNIQUE )?INDEX \S+ ON ','') from t join pg_class c on c.relname=t.name and c.relnamespace='public'::regnamespace join pg_index i on i.indrelid=c.oid
  union all select 'trg', c.relname||' '||tg.tgname from t join pg_class c on c.relname=t.name and c.relnamespace='public'::regnamespace join pg_trigger tg on tg.tgrelid=c.oid and not tg.tgisinternal
  union all select 'rls', c.relname||' '||c.relrowsecurity from t join pg_class c on c.relname=t.name and c.relnamespace='public'::regnamespace
  union all select 'pol', p.tablename||' '||p.policyname||' '||p.cmd||' '||array_to_string(p.roles,',') from pg_policies p join t on t.name=p.tablename where p.schemaname='public'
  union all select 'anon', c.relname||' '||coalesce((select string_agg(privilege_type,',' order by privilege_type) from information_schema.role_table_grants g where g.table_schema='public' and g.table_name=c.relname and g.grantee='anon'),'-') from t join pg_class c on c.relname=t.name and c.relnamespace='public'::regnamespace
) x order by 1,2
