-- Finding 6 (database audit 2026-11-01): defence in depth for the public schema.
-- Nothing in the apps reads or writes a table with the public anon key: admin and kiosk data go through
-- the secure-db edge function (service role), the portal calls SECURITY DEFINER functions (owned by postgres,
-- unaffected by these revokes). Until now anon and authenticated held full privileges on every table and
-- RLS was the only barrier. After this migration a table that is created or altered with RLS off, or that
-- gets a stray permissive policy, is still not reachable with the public key.
--
-- ROLLBACK (exact previous state; 3 tables never had anon/authenticated grants):
--   grant all on all tables in schema public to anon, authenticated;
--   grant all on all sequences in schema public to anon, authenticated;
--   revoke all on public.auth_attempts, public.portal_sessions, public.processed_webhook_events from anon, authenticated;
--   alter default privileges for role postgres in schema public grant all on tables to anon, authenticated;
--   alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated;

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- Future objects created by postgres (migrations, SQL editor) are no longer granted to anon/authenticated.
-- service_role keeps its default grant; new tables still need RLS plus an explicit service_role GRANT
-- (docs/new-table-checklist.md).
alter default privileges for role postgres in schema public revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;

-- service_role and postgres must keep everything (secure-db, cron, edge functions).
grant all on all tables    in schema public to service_role, postgres;
grant all on all sequences in schema public to service_role, postgres;
