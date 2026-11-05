# Admin push notifications (PunchClock Crew Admin app) - server side

Status: applied and deployed 2026-11-05 (migration, send-push v3, notify-time-off v10, notify-missed-punch v8, punch-alerts v10). Simulation passed (rolled back); post-deploy probes passed.

## What it does
Owners, co-admins and managers who install the admin app get a push notification on their phone for:
- a new time off request that needs review (`notify-time-off`, "submitted" path),
- a new missed punch request that needs review (`notify-missed-punch`, "submitted" path),
- the forgot-to-clock-out and daily-overtime alerts (`punch-alerts`).

Recipients are exactly the people who get the matching email, computed by the same code: account owner, active co-admins,
managers of the request's site (alerts: the owner/co-admin/manager team, managers limited to their sites), honouring
`admins.mute_approval_emails` (requests) and `admins.mute_manager_alerts` (alerts). An employee who is also an admin does not
get the approver push for their own request. Alert pushes ride on the existing `sent_alerts` dedupe, so a push is sent only
when an email would be.

## Design
- `public.admin_push_tokens` (token primary key, admin_id references admins on delete cascade, platform, device_label,
  created_at, last_seen_at). RLS on, no policies, grants to `service_role` only. Nothing in a browser reads it.
- `admin_register_push_token(p_session, p_token, p_platform, p_label)` and `admin_unregister_push_token(p_session, p_token)`:
  called by the app with the public key; the admin id comes ONLY from the admin session token
  (`admin_sessions`, unexpired, admin `status = 'active'`, admin account not expired). NULL, empty and malformed input is
  refused. Token must look like an Expo push token, platform `ios` or `android`, label cleaned and at most 60 characters.
  Both return a boolean and never echo the token.
- Last signer owns a token (on a shared phone the previous admin stops getting that device's pushes). At most 10 devices per
  admin, the least recently seen are dropped.
- `send-push` accepts `admin_ids` (UUIDs, same filtering and 200 cap as `employee_ids`) next to or instead of
  `employee_ids`. Still service key or cron secret only. Admin token reads are ordered and paged (PostgREST 1000-row cap).
- Lock-screen text is minimal: employee name and dates (or IN/OUT and time), or "N alerts" plus the company name. No reason
  text, no email addresses. Payload `data`: `{type: 'time_off' | 'missed_punch', id: <request id>, v: 1}` or
  `{type: 'alert', v: 1}`. The app must re-fetch through its normal authenticated path, never trust the payload.
- Every push is backgrounded (`EdgeRuntime.waitUntil`) and swallowed on failure: an email result is never affected.

## Deploy order
1. Apply `supabase/migrations/20261105_admin_push_tokens.sql`.
2. Run `tools/admin-push-sim.sql` (rolled back; success is the error text `SIM OK (rolled back)`).
3. Run `node tools/secure-db-regression/anon-exposure-check.mjs` (allowlist is now 51 functions) and the Supabase security
   advisor (`get_advisors`).
4. Deploy `send-push` (full file through the Supabase MCP, then read back and compare). Verify with the probes below.
5. Deploy `notify-time-off`, `notify-missed-punch`, `punch-alerts` (each full file, read back, compare).
The order matters only for tidiness: a caller deployed before `send-push` just gets a 400 it ignores, and `send-push`
deployed before the migration finds no table and sends nothing.

## Harmless probes after deploy (no push, no email, counts only)
- `send-push` with `{"action":"auth_probe"}` and the service key returns `{"ok":true}`; with no key or the anon key, 401.
- `send-push` with `{"admin_ids":["not-a-uuid"],"title":"x","body":"x"}` returns 400 (no valid ids).
- Anon key `GET /rest/v1/admin_push_tokens?select=*&limit=1` returns 401 (permission denied), never rows.
- Anon key `POST /rest/v1/rpc/admin_register_push_token` with a junk session (for example 64 `a` characters), a well-formed
  Expo-shaped token, platform `ios` returns `false`. The same for `admin_unregister_push_token`. (A real session is not
  needed or wanted for these probes.)
- Anon key cannot call `_resolve_admin_push_session` (permission denied or not found).
- `anon-exposure-check.mjs` passes.
- Watch the edge function logs for `send-push` and the three callers for the next hour.

## Known limits
- A token is removed only when the app signs out (`admin_unregister_push_token`), when another admin signs in on the
  device, when the admin is deleted, or by the 10-device cap. A stale token of a deactivated admin is never selected
  because the callers only pick active admins. Expo delivery receipts are not polled (same v1 gap as employee push).
- Session tokens are 256-bit random, so the register/unregister session check is not attempt-throttled; the per-admin cap
  bounds what a valid session can write.
- Managers: the approver set for requests is computed from `manager_sites` of the request's site, as for the email.

## Rollback
- Functions: redeploy the previous versions of the four edge functions (the caller changes are additive; without them
  nothing pushes to admins). The employee push is untouched.
- Database (only if needed; nothing else depends on it):
  ```sql
  drop function if exists public.admin_register_push_token(text, text, text, text);
  drop function if exists public.admin_unregister_push_token(text, text);
  drop function if exists public._resolve_admin_push_session(text);
  drop table if exists public.admin_push_tokens;
  ```
  and remove the two names from `tools/secure-db-regression/anon-function-allowlist.txt` in the same change (the exposure
  check fails in both directions otherwise).
