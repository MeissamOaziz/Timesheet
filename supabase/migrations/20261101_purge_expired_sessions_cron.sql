-- Finding 8, safe part only (database audit 2026-11-01): expired admin and portal sessions were only deleted on an
-- explicit logout, so dead tokens accumulated in plaintext. A daily job removes rows whose expires_at has passed.
-- Both session resolvers already reject expired tokens, so this cannot log anybody out. The token format is unchanged.
-- Does NOT revoke sessions on password reset, hash tokens or shorten the TTL: those need code changes.
--
-- ROLLBACK:  select cron.unschedule('purge-expired-sessions');

select cron.unschedule('purge-expired-sessions') where exists (select 1 from cron.job where jobname = 'purge-expired-sessions');

select cron.schedule(
  'purge-expired-sessions',
  '40 3 * * *',
  $job$
    delete from public.admin_sessions  where expires_at < now();
    delete from public.portal_sessions where expires_at < now();
  $job$
);
