-- Proof Queries for Inbox Thread State

-- 1. Count by status
SELECT status, COUNT(*) 
FROM public.inbox_thread_state 
GROUP BY status
ORDER BY count DESC;

-- 2. Count by stage
SELECT stage, COUNT(*) 
FROM public.inbox_thread_state 
GROUP BY stage
ORDER BY count DESC;

-- 3. Count by priority
SELECT priority, COUNT(*) 
FROM public.inbox_thread_state 
GROUP BY priority
ORDER BY count DESC;

-- 4. Count by automation_status
SELECT automation_status, COUNT(*) 
FROM public.inbox_thread_state 
GROUP BY automation_status
ORDER BY count DESC;

-- 5. Count by is_suppressed
SELECT is_suppressed, COUNT(*) 
FROM public.inbox_thread_state 
GROUP BY is_suppressed
ORDER BY count DESC;

-- 6. Sample 25 threads for visual inspection
SELECT 
  thread_key, 
  status, 
  stage, 
  priority,
  automation_status,
  is_hot_lead,
  is_suppressed,
  last_intent,
  next_action
FROM public.inbox_thread_state 
ORDER BY updated_at DESC
LIMIT 25;