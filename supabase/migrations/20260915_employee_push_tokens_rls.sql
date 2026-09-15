-- Supabase's security scanner flagged employee_push_tokens as RLS-disabled-in-public (2026-09-15)
-- -- a real gap: the table was created (20260907_employee_push_tokens.sql) without RLS ever being
-- turned on, unlike every other tenant table in this project. The only two access paths are
-- portal_register_push_token (SECURITY DEFINER, bypasses RLS) and the send-push edge function
-- (uses the service-role key, also bypasses RLS) -- neither is affected by this. Enabling RLS
-- with zero policies just closes the direct anon/authenticated PostgREST hole: right now anyone
-- with the public anon key can read every employee's push token, or delete/tamper with them.
alter table employee_push_tokens enable row level security;
