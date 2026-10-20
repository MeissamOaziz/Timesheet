# secure-db regression kit

`secure-db` is the only door to customer data (every punch, report and login goes through it), so
nothing is deployed without both of these.

1. **diff-test.mjs** (before deploying). Loads the deployed code and the edited file side by side,
   against an emulated database, sends both the same 60+ requests (kiosk punches and reads, admin
   reads and writes, paged reports, actions, refusals) and compares every response and every
   database call. A change is only acceptable if the differences are the ones you intended.
2. **live-smoke.mjs** (before and after deploying). Read-only calls and writes that must be refused,
   against the real function and the four live sites. Nothing is created. Diff the two outputs.

Needs Node 22 or newer (runs the TypeScript directly).
