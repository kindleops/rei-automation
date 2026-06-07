ALTER VIEW public.canonical_inbox_threads
  SET (security_invoker = true);

ALTER VIEW public.canonical_inbox_counts
  SET (security_invoker = true);
