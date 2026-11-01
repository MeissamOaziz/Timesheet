# New table checklist (Supabase, from 2026-10-30)

From Oct 30, 2026 Supabase no longer grants Data API access automatically to tables created in `public`
(new projects, preview branches and local `supabase db reset` first; existing tables keep what they have).
A migration that creates a table must say who may touch it, in the same migration.

Since 2026-11-01 this project enforces the same rule itself: `anon` and `authenticated` hold NO privilege on any
table, view or sequence in `public`, and the default privileges for objects created by `postgres` no longer
grant tables, sequences or functions to `anon`, `authenticated` or PUBLIC. A new object is therefore closed
by default and only `service_role` (and `postgres`) can use it. Row level security is the second lock, not the only one.
(Objects created by the `supabase_admin` role keep the platform default grants and cannot be changed from the `postgres`
role: create everything through migrations / the SQL editor, which run as `postgres`.)

PunchClock tables are only ever read and written by the `secure-db` edge function (service key), with
row level security on and no policies. So the template is:

```sql
create table public.example ( ... );

alter table public.example enable row level security;      -- always, no exceptions

-- Only the service key needs access. Do NOT grant to anon / authenticated.
grant select, insert, update, delete on public.example to service_role;
-- A serial / identity column also needs its sequence:
-- grant usage, select on sequence public.example_id_seq to service_role;
```

Then:
1. Add the table name to `PROTECTED_TABLES` / `APP_TABLES` in `supabase/functions/secure-db/index.ts`
   (anything not listed is refused with 403).
2. Run the Supabase security advisor and the regression kit (`tools/secure-db-regression`), including
   `anon-exposure-check.mjs` (any public table with an anon/authenticated privilege or without RLS fails it).
3. Functions (`create function ... security definer`): new functions are closed by default (no PUBLIC, anon or
   authenticated execute). Still write `revoke all on function ... from public, anon, authenticated;` and
   `grant execute on function ... to service_role;` in the migration so it reads the same on every project.
4. A function the BROWSER calls with the anon key (an `rpc('...')` in index.html or employee.html) is the only reason to
   `grant execute on function public.<name>(<arg types>) to anon;`. It must be `security definer` with a pinned
   `search_path`, must check a session token or one-time token itself, and must be added to
   `tools/secure-db-regression/anon-function-allowlist.txt`. `anon-exposure-check.mjs` fails when the live set and the
   file differ in either direction.
5. Never create a SELECT policy on `storage.objects` for a public bucket: public buckets serve direct object URLs without
   one, and the policy only adds anonymous listing of every file name.
6. Never install the `http` extension or grant anything on `cron` / `net` to client roles; cron jobs that call edge
   functions read the shared secret from `internal_secrets` at run time (see `20261101_cron_secret_gate.sql`).
