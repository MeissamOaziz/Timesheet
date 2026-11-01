-- 2026-11-01: shared secret for server-to-server calls to the mail/push/alert edge functions.
--
-- Why: send-onboarding, send-weekly-digest, send-owner-digest, send-push and punch-alerts have
-- verify_jwt=false and used to run for anyone who could reach the URL. They now require
-- `Authorization: Bearer <service-role key | internal_secrets.cron_secret>` and return 401 otherwise.
-- pg_cron used to send the PUBLIC anon JWT (authorises nothing) or nothing at all; each job now
-- reads cron_secret at run time, so no secret is stored in cron.job.command and none is in git.
--
-- The secret value is generated inside the database and is never selected, logged or committed.
-- Rotate with:  update public.internal_secrets set value = encode(extensions.gen_random_bytes(32),'hex') where key = 'cron_secret';
-- (the functions cache it per isolate, so a rotation takes effect as isolates recycle; the cron
-- commands read it fresh on every run).

insert into public.internal_secrets (key, value)
values ('cron_secret', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (key) do nothing;

-- Same job names, schedules and bodies as before; only the headers change.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'onboarding-drip-daily'),
  command := $cmd$
  SELECT net.http_post(
    url := 'https://uziwymrwaeojhqaagqcm.supabase.co/functions/v1/send-onboarding',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select value from public.internal_secrets where key = 'cron_secret')),
    body := '{}'::jsonb
  );
  $cmd$);

select cron.alter_job(
  (select jobid from cron.job where jobname = 'send-weekly-digest'),
  command := $cmd$
  select net.http_post(
    url := 'https://uziwymrwaeojhqaagqcm.supabase.co/functions/v1/send-weekly-digest',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select value from public.internal_secrets where key = 'cron_secret')),
    body := '{}'::jsonb
  );
  $cmd$);

select cron.alter_job(
  (select jobid from cron.job where jobname = 'punch-alerts-6h'),
  command := $cmd$
  SELECT net.http_post(
    url := 'https://uziwymrwaeojhqaagqcm.supabase.co/functions/v1/punch-alerts',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select value from public.internal_secrets where key = 'cron_secret')),
    body := '{}'::jsonb
  );
  $cmd$);

-- churn-survey and send-period-summary are ALSO called from the browser (survey page, Payroll
-- recipients "send test", employee-hours "send manual"), so their code is not gated yet. These two
-- jobs are switched to the cron secret now so that gating them later does not need a cron change;
-- until then the header is simply ignored by the function.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'churn-survey-daily'),
  command := $cmd$
  SELECT net.http_post(
    url := 'https://uziwymrwaeojhqaagqcm.supabase.co/functions/v1/churn-survey',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select value from public.internal_secrets where key = 'cron_secret')),
    body := '{}'::jsonb
  );
  $cmd$);

select cron.alter_job(
  (select jobid from cron.job where jobname = 'send-period-summary-hourly'),
  command := $cmd$
  select net.http_post(
    url := 'https://uziwymrwaeojhqaagqcm.supabase.co/functions/v1/send-period-summary',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select value from public.internal_secrets where key = 'cron_secret')),
    body := '{}'::jsonb
  ) as request_id;
  $cmd$);
