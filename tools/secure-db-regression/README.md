# secure-db regression kit

`secure-db` is the only door to customer data (every punch, report and login goes through it), so
nothing is deployed without both of these.

1. **diff-test.mjs** (before deploying). Loads the deployed code and the edited file side by side,
   against an emulated database, sends both the same 60+ requests (kiosk punches and reads, admin
   reads and writes, paged reports, actions, refusals) and compares every response and every
   database call. A change is only acceptable if the differences are the ones you intended.
2. **live-smoke.mjs** (before and after deploying). Read-only calls and writes that must be refused,
   against the real function and up to four live sites. Nothing is created. Diff the two outputs.
   The kiosk site ids are credentials and are not kept in this public repo: pass them in the
   `SMOKE_SITE_IDS` environment variable (comma-separated, up to four; the owner keeps the list in
   the private claude-ops repo under `docs-private/`). Without it the script uses synthetic ids and
   still runs, but the per-site lines are then not a meaningful comparison.
3. **anon-exposure-check.mjs** (after every migration, and before a release that adds a table or a function).
   Asserts that the public anon key reaches no table (every anon GET is refused), cannot list the avatars
   and logos buckets, and that the set of functions anon may execute equals
   `anon-function-allowlist.txt` (exactly the `rpc('...')` calls in index.html and employee.html). With
   `SUPABASE_SERVICE_ROLE_KEY` set it also reads `public.security_audit_snapshot()` and fails if any public table
   carries an anon/authenticated/PUBLIC privilege, lacks row level security, if `authenticated` can execute a
   function, if default privileges would hand future objects to anon, if storage.objects has a SELECT policy, or
   if the `http` extension is installed. Prints names and counts only. A new browser-callable function means
   a deliberate `grant execute ... to anon` plus a line in the allowlist.

Needs Node 22 or newer (runs the TypeScript directly).
