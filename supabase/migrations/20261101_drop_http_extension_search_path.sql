-- Findings 17, 23, 24 (database audit 2026-11-01).
--
-- 1. The `http` extension (outbound HTTP from SQL, 19 functions executable by anon at the SQL level) is not used:
--    no public function, trigger or cron command references it (the 5 cron jobs that call edge functions use pg_net,
--    net.http_post), no table column uses its types. Dropped. Re-create with:  create extension http with schema extensions;
-- 2. function_search_path_mutable advisor warning on the invoker trigger function public.employee_portal_lowercase_email.
--
-- NOT changeable from the postgres role (checked in a rolled-back simulation): cron.schedule/unschedule and net.http_*
-- execute grants, the net.* table grants and net schema usage. Those objects are owned by supabase_admin and the grants
-- are PUBLIC grants made by the platform; REVOKE as postgres is a silent no-op. Not reachable over REST (PostgREST exposes
-- only public and graphql_public), and anon has no USAGE on the cron schema at all. Reported to the owner.

drop extension if exists http;

alter function public.employee_portal_lowercase_email() set search_path = public, pg_temp;
