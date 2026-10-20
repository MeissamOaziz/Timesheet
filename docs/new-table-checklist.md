# New table checklist (Supabase, from 2026-10-30)

From Oct 30, 2026 Supabase no longer grants Data API access automatically to tables created in `public`
(new projects, preview branches and local `supabase db reset` first; existing tables keep what they have).
A migration that creates a table must say who may touch it, in the same migration.

PunchClock tables are only ever read and written by the `secure-db` edge function (service key), with
row level security on and no policies. So the template is:

```sql
create table public.example ( ... );

alter table public.example enable row level security;      -- always, no exceptions

-- Only the service key needs access. Do NOT grant to anon / authenticated.
grant select, insert, update, delete on public.example to service_role;
```

Then:
1. Add the table name to `PROTECTED_TABLES` / `APP_TABLES` in `supabase/functions/secure-db/index.ts`
   (anything not listed is refused with 403).
2. Run the Supabase security advisor and the regression kit (`tools/secure-db-regression`).
3. Functions (`create function ... security definer`) are executable by everyone by default: add
   `revoke all on function ... from public, anon, authenticated;` and grant only what is needed.

Status of the existing projects (checked 2026-10-20): PunchClock and OazizWebPortal already hold their
grants, so nothing changes for the tables they have. `pronto-imbianchino` is paused (nothing to do until
it is restored; check its grants then).
