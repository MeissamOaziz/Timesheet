# Supabase outage runbook

## Symptom: `PGRST303 "JWT issued at future"`

Requests fail with HTTP 401 and a body like:

```json
{"code":"PGRST303","details":null,"hint":null,"message":"JWT issued at future"}
```

It hits **both** the anon key (admin login, employee portal RPCs) and the service-role
key (every Edge Function), and it is intermittent — the same request can succeed
seconds later. Downstream it looks like unrelated bugs: the kiosk reports "incorrect
PIN" for a correct PIN (the employee list fetch failed), password-reset emails never
arrive, admins can't sign in.

**Cause:** clock skew between PostgREST and the auth/signing layer on Supabase's
infrastructure — the token's `iat` claim reads as being in the future to the verifying
server. It is a platform fault, not an application bug: it reproduces identically with
the legacy `SUPABASE_SERVICE_ROLE_KEY` (HS256 JWT) *and* the new opaque
`SUPABASE_SECRET_KEYS`, which has no `iat` of its own. Supabase has acknowledged it on
status.supabase.com as "401 errors due to JWT rejections".

### Fix (worked 2026-08-26)

**Supabase Dashboard → Project Settings → General → Restart Project.**

That resyncs the clock and resolves it immediately. Try this *first* — before deep
debugging, key rotation, or considering a migration. Verify by re-running a previously
failing request and confirming the database actually changed (e.g. a new row in
`email_codes` after a password-reset request), not just that the HTTP call returned 200.

If a restart doesn't fix it, check status.supabase.com for an active incident and open
a support ticket at supabase.com/dashboard/support/new (support is dashboard-only; there
is no support email inbox).

### What the app does about it now

`friendlyError()` in `index.html` maps `PGRST303` to a plain "Temporary connection
problem, please try again" message instead of showing the raw JSON, and both `supaFetch`
and `DB.rpc` silently retry once after ~1.2s before surfacing anything. A `PGRST303`
arriving as a 401 no longer force-logs-out the user, since it isn't an expired session.

## If Supabase is down long enough to need alternative hosting

The app is portable because it is a "relocate infrastructure" job, not a rewrite:
PostgREST speaks the exact query syntax both HTML clients already use, the Storage API
is the same server `storage-upload` already targets, and the 12 Edge Functions are plain
Deno files that only need new env vars. The plan is to self-host the trimmed Supabase
OSS stack (postgres + kong + postgrest + storage-api + edge-runtime; drop gotrue,
realtime, imgproxy, analytics — this app uses none of them).

Before that is possible, note that **most of the business logic lives only in the live
database, not in git**: ~33 Postgres RPC functions (all auth, session and portal logic),
the RLS policies protecting the employee portal, the pg_cron schedules, and the
per-function `verify_jwt` settings. Export all of it via SQL (`pg_get_functiondef`,
`pg_policies`, `cron.job`) before any migration, and keep the export current — it is the
single biggest recovery risk.

Full step-by-step migration plan (provisioning, restore, parallel testing, cutover,
rollback) was drafted 2026-08-26 and is available in the project chat history if needed.
