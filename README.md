# PunchClock Pro

Web-based employee time clock for small businesses, served at https://www.punchclock.ca.

- **Kiosk**: a shared tablet, phone or PC per site where staff clock in and out with a PIN.
- **Admin dashboard**: employees, sites, schedules, reports (PDF, Excel, CSV), activity log, geofencing.
- **Employee portal** (`employee.html`): schedule, hours, time off and remote clock-in.
- **Backend**: Supabase (Postgres plus edge functions). Data is stored per company in the cloud; every
  company's data is separated, and admins only see their own company.

This repository is public and GitHub Pages publishes every tracked file, so it holds only the site
itself, the database migrations, the edge function source and test tooling. Operational notes,
plans and anything that names customers live in a private repository, not here.

Contents: `index.html` (app), `employee.html` (portal), `supabase/` (functions and migrations),
`tools/` (tests and screenshot tooling, see `tools/README.md`), `docs/` (public-safe developer notes).

Security issues: please email support@punchclock.ca rather than opening a public issue.
