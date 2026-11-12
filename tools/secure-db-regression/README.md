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

4. **function-gate-test.mjs** (offline, whenever a mail or cron function changes). Loads churn-survey, send-period-summary,
   notify-missed-punch and notify-time-off with a stubbed database and mail provider and asserts that the public key, no
   credential and a wrong bearer get 401, that the service key and the cron secret get `{ok:true}` from `auth_probe`, and
   that nothing reaches the mail provider. Browsers never call these functions: they call secure-db actions
   (`notify_request`, `send_period_summary`, `survey_notify`), covered by diff-test groups `notify`, `period`, `survey`,
   and by `tools/notify-secure-db-test.mjs` for the pages. Role rules (manager / co-admin / owner) are the `roles`,
   `joinreq`, `admins-out` and `preauth` groups. The live probe must never send `auth_probe` to a function that is not
   gated yet: for churn-survey and send-period-summary that body runs the whole job.

5. **Private images** (employee photos and company logos, buckets `avatars` and `logos` are private since 2026-11-01).
   diff-test groups `images` (signed urls out, one batched Storage call, per-isolate cache, the `kiosk_bootstrap` action,
   writes mapped back to the stored address and refused unless the object belongs to the caller's own company folder)
   and `images-email` (30 day signed logo in the employee invitation mail). Pages: `tools/private-images-test.mjs`.
   `anon-exposure-check.mjs` also fails if a bare public address of either bucket opens. Rollback of the buckets:
   `update storage.buckets set public = true where id in ('avatars','logos');`
6. **Spreadsheet formula injection** is covered by `tools/export-formula-test.mjs` (index.html exports, real SheetJS) and
   by the CSV attachment of send-period-summary (`csvText`).
7. **AI connector (Claude / ChatGPT)**: the `mcp` function (sign-in service + MCP server) and the secure-db actions
   `mcp_consent_info`, `mcp_consent`, `mcp_list_grants`, `mcp_revoke_grant`, `set_ai_apps`.
   - `tools/mcp-connector-test.mjs` (before deploying either function): loads BOTH functions against an in-memory
     database that enforces the real table rules, and plays the attacks: foreign and look-alike callbacks, altered or
     forged sign-in requests, missing / empty / wrong PKCE verifier, reused and expired codes, a replayed refresh
     token, another tenant's connections, a manager or co-admin flipping the owner's switch, the super admin, a
     suspended or expired account, an account whose subscription ended or dropped below Growth (no tool answers from
     the next call on), oversized and endless uploads, and a scan proving no code or token is ever stored or logged
     in the clear.
     With `MCP_URL=<deployed address>` it sends only requests that must be refused (nothing is created).
   - diff-test group `mcp`: the new actions turn away callers without a session and the connector tables stay
     unreachable through the table path. Run with `mcp` as the group allowed to differ.
   - `tools/ai-apps-test.mjs`: the consent page (`connect.html`) and the "AI apps" card, network stubbed.
   - The mcp_* tables are deliberately NOT in `APP_TABLES`. The trigger function added by
     `20261112_mcp_revoke_trigger.sql` is not callable by anon, so the allowlist stays as it is.

Needs Node 22 or newer (runs the TypeScript directly).
