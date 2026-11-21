-- Referral program: run the catch-up job (stripe-handler referral_reconcile) once a day. NOT APPLIED.
-- Owner-approved addition (2026-11-20). Design and go-live order: docs/referral-program.md.
--
-- Apply ONLY after stripe-handler has been deployed with the referral_reconcile action (go-live checklist): before that
-- the call just answers "Unknown action" every night.
--
-- What it does: a credit left undone by a failed webhook step is delivered the next night instead of waiting for that
-- customer's next payment or a manual run, and a waiting credit older than 12 months is closed the night after it
-- expires. A run with nothing to do changes nothing (tools/referral-test.mjs, "reconcile with nothing to do").
--
-- Same pattern as the other jobs that call edge functions (20261101_cron_secret_gate.sql): the job reads the shared
-- cron_secret from internal_secrets at run time, so no key is stored in cron.job.command and none is in git.
-- 08:25 UTC = 03:25 in Toronto in winter (04:25 in summer), away from the other night jobs (03:15 to 03:50 UTC).
-- The timeout is raised from pg_net's 5 s default: a night with many open referrals makes several Stripe calls.
--
-- Last result:
--   select status, return_message, start_time from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'referral-reconcile-daily') order by start_time desc limit 5;
--   (that only says the request was queued; the answer itself, {"ok":true,"referrals":..,"waiting":..,"errors":..},
--    is in net._http_response for about 6 hours, and in the stripe-handler logs as "referral_reconcile: ...")
--
-- Rollback:
--   select cron.unschedule('referral-reconcile-daily');

select cron.schedule(
  'referral-reconcile-daily',
  '25 8 * * *',
  $cmd$
  select net.http_post(
    url := 'https://uziwymrwaeojhqaagqcm.supabase.co/functions/v1/stripe-handler/referral_reconcile',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select value from public.internal_secrets where key = 'cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) as request_id;
  $cmd$
);
