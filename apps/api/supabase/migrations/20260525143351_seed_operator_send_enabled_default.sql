-- Seed manual operator send control so missing rows do not disable send-now.
INSERT INTO public.system_control (key, value)
VALUES ('operator_send_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
