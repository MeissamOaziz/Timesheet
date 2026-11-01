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

Needs Node 22 or newer (runs the TypeScript directly).
