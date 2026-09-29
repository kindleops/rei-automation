-- The email read-model views are server-side only. A plain view runs with its
-- owner's privileges and bypasses RLS, and Supabase grants new views to anon /
-- authenticated by default — so without this the public anon key could read
-- recipient addresses and engagement history. Make them security_invoker (RLS
-- of the underlying tables applies) and revoke client roles outright.
alter view public.email_message_engagement set (security_invoker = true);
alter view public.email_address_health set (security_invoker = true);
alter view public.email_touch_attribution set (security_invoker = true);
revoke all on public.email_message_engagement, public.email_address_health, public.email_touch_attribution from anon, authenticated;
revoke all on function public.email_metrics(text, timestamptz, timestamptz, text) from public, anon, authenticated;
revoke all on function public.email_queue_claim(integer, text, timestamptz) from public, anon, authenticated;
revoke all on function public.email_queue_reap_stuck(interval) from public, anon, authenticated;
revoke all on public.email_threads, public.email_inbound_messages, public.email_attachments, public.email_links from anon, authenticated;
