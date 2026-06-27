-- Treat queue_processor_mode=on/enabled/active as live for atomic claim gates.
CREATE OR REPLACE FUNCTION public.queue_processor_mode_normalized()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE lower(COALESCE(public.queue_system_control_text('queue_processor_mode'), 'off'))
    WHEN 'live' THEN 'live'
    WHEN 'on' THEN 'live'
    WHEN 'enabled' THEN 'live'
    WHEN 'active' THEN 'live'
    WHEN 'automatic' THEN 'live'
    WHEN 'safe' THEN 'safe'
    ELSE 'off'
  END;
$$;